// IoT Hub — Smart Fan Monitoring platform
// Socket.io server on port 3003. Receives telemetry from simulated ESP8266 devices,
// broadcasts to dashboard clients, persists to the shared SQLite DB via Prisma.
//
// This is an independent bun project but reuses the shared DB schema and contracts
// already defined in the main project. The contracts are duplicated here for
// self-containment (the mini-service cannot import from the main project's src).

import { createServer } from "http";
import { Server, Socket } from "socket.io";
import { PrismaClient, Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// Shared contracts (mirrored from src/lib/iot-contracts.ts of the main project)
// ---------------------------------------------------------------------------

export type DeviceStatus = "online" | "offline";
export type FanStatus = "on" | "off";
export type CommandAction = "on" | "off";
export type CommandStatus = "pending" | "sent" | "acknowledged" | "failed";

export interface DeviceDTO {
  id: string;
  name: string;
  macAddress: string;
  location: string;
  firmwareVersion: string;
  ipAddress: string;
  status: DeviceStatus;
  fanStatus: FanStatus;
  temperature: number;
  humidity: number;
  rssi: number;
  uptimeSeconds: number;
  lastSeenAt: string; // ISO
  registeredAt: string; // ISO
  updatedAt: string; // ISO
}

export interface DeviceRegisterPayload {
  deviceId: string;
  name: string;
  macAddress: string;
  location: string;
  firmwareVersion: string;
  ipAddress: string;
}

export interface TelemetryPayload {
  deviceId: string;
  temperature: number;
  humidity: number;
  fanStatus: FanStatus;
  rssi: number;
  uptimeSeconds: number;
  timestamp: string; // ISO
}

export interface FanCommandPayload {
  deviceId: string;
  action: CommandAction;
  commandId: string;
}

export interface CommandAckPayload {
  commandId: string;
  deviceId: string;
  success: boolean;
  fanStatus: FanStatus;
  timestamp: string;
}

export interface DeviceStatusPayload {
  deviceId: string;
  status: DeviceStatus;
  lastSeenAt: string;
}

export interface FanStatePayload {
  deviceId: string;
  fanStatus: FanStatus;
  timestamp: string;
}

export interface SnapshotPayload {
  devices: DeviceDTO[];
}

// Event names (kept as string literals — same as IoTEvents in the main project)
const EV = {
  DeviceRegister: "device:register",
  Telemetry: "telemetry",
  CommandAck: "command:ack",
  Subscribe: "subscribe",
  FanCommand: "fan:command",
  DeviceStatus: "device:status",
  FanState: "fan:state",
  InitialSnapshot: "snapshot",
} as const;

// ---------------------------------------------------------------------------
// Prisma setup
// ---------------------------------------------------------------------------

const db = new PrismaClient({
  log: ["error", "warn"],
});

// SQLite with multiple processes can throw SQLITE_BUSY under write contention.
// Wrap writes in a small retry helper.
async function withBusyRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      // P2034 = transaction conflict / write conflict in SQLite
      if (err.code === "P2034" || /busy|locked|sqlite_busy/i.test(err.message)) {
        await new Promise((r) => setTimeout(r, 50));
        return await fn();
      }
    }
    if (err instanceof Error && /busy|locked|sqlite_busy/i.test(err.message)) {
      await new Promise((r) => setTimeout(r, 50));
      return await fn();
    }
    throw err;
  }
}

function toDeviceDTO(d: any): DeviceDTO {
  return {
    id: d.id,
    name: d.name,
    macAddress: d.macAddress,
    location: d.location,
    firmwareVersion: d.firmwareVersion,
    ipAddress: d.ipAddress,
    status: d.status as DeviceStatus,
    fanStatus: d.fanStatus as FanStatus,
    temperature: d.temperature,
    humidity: d.humidity,
    rssi: d.rssi,
    uptimeSeconds: d.uptimeSeconds,
    lastSeenAt: d.lastSeenAt ? new Date(d.lastSeenAt).toISOString() : new Date().toISOString(),
    registeredAt: d.registeredAt ? new Date(d.registeredAt).toISOString() : new Date().toISOString(),
    updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Socket metadata
// ---------------------------------------------------------------------------

type SocketKind = "unknown" | "device" | "dashboard";

interface SocketMeta {
  kind: SocketKind;
  deviceId?: string; // for device sockets
  lastTelemetryAt?: number; // ms epoch — used by heartbeat
}

function metaOf(socket: Socket): SocketMeta {
  if (!socket.data) socket.data = {};
  return socket.data as SocketMeta;
}

// in-memory registry for fast fan-command forwarding
const deviceSocketsByDeviceId = new Map<string, Socket>();

// ---------------------------------------------------------------------------
// HTTP + Socket.io server setup
// ---------------------------------------------------------------------------

// NOTE: we do not attach a custom HTTP request listener here — socket.io
// attaches its own and any custom listener that returns without responding
// can interfere with polling transport. The hub exposes a tiny health
// endpoint via a separate listener added AFTER socket.io, that only
// responds to plain GET / requests (no socket.io query strings).
const httpServer = createServer();

const io = new Server(httpServer, {
  path: "/", // REQUIRED so Caddy can forward browser connections via the gateway
  cors: { origin: "*" },
  pingTimeout: 60000,
  pingInterval: 25000,
});

const PORT = 3003;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function broadcastToDashboards(event: string, payload: any) {
  for (const socket of io.sockets.sockets.values()) {
    const m = metaOf(socket);
    if (m.kind === "dashboard") {
      socket.emit(event, payload);
    }
  }
}

async function markDeviceOffline(deviceId: string) {
  try {
    const updated = await withBusyRetry(() =>
      db.device.update({
        where: { id: deviceId },
        data: { status: "offline", lastSeenAt: new Date() },
      })
    );
    const payload: DeviceStatusPayload = {
      deviceId,
      status: "offline",
      lastSeenAt: updated.lastSeenAt.toISOString(),
    };
    broadcastToDashboards(EV.DeviceStatus, payload);
    console.log(`[hub] device ${deviceId} marked offline (heartbeat timeout)`);
  } catch (err) {
    console.error(`[hub] markDeviceOffline(${deviceId}) failed:`, err);
  }
}

async function getAllDevicesDTO(): Promise<DeviceDTO[]> {
  const rows = await db.device.findMany({ orderBy: { name: "asc" } });
  return rows.map(toDeviceDTO);
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

io.on("connection", (socket: Socket) => {
  const m = metaOf(socket);
  m.kind = "unknown";
  console.log(`[hub] socket connected: ${socket.id}`);

  // --- Device → hub --------------------------------------------------------
  socket.on(EV.DeviceRegister, async (raw: any) => {
    try {
      const payload = raw as DeviceRegisterPayload;
      if (!payload || !payload.macAddress) {
        socket.emit("error", { message: "device:register requires macAddress" });
        return;
      }
      const now = new Date();
      const data = {
        name: payload.name ?? `Device-${payload.macAddress}`,
        macAddress: payload.macAddress,
        location: payload.location ?? "Unknown",
        firmwareVersion: payload.firmwareVersion ?? "1.0.0",
        ipAddress: payload.ipAddress ?? socket.handshake.address ?? "0.0.0.0",
        status: "online" as const,
        lastSeenAt: now,
      };

      const upserted = await withBusyRetry(() =>
        db.device.upsert({
          where: { macAddress: payload.macAddress },
          create: data,
          update: {
            name: data.name,
            location: data.location,
            firmwareVersion: data.firmwareVersion,
            ipAddress: data.ipAddress,
            status: "online",
            lastSeenAt: now,
          },
        })
      );

      // associate this socket with the actual deviceId from the DB
      m.kind = "device";
      m.deviceId = upserted.id;
      m.lastTelemetryAt = Date.now();
      deviceSocketsByDeviceId.set(upserted.id, socket);

      // reply to the device with the real deviceId
      socket.emit(EV.DeviceRegister, { ok: true, deviceId: upserted.id });

      // broadcast status online to dashboards
      const statusPayload: DeviceStatusPayload = {
        deviceId: upserted.id,
        status: "online",
        lastSeenAt: upserted.lastSeenAt.toISOString(),
      };
      broadcastToDashboards(EV.DeviceStatus, statusPayload);

      // also push the current desired fanStatus back to the device
      const fanState: FanStatePayload = {
        deviceId: upserted.id,
        fanStatus: (upserted.fanStatus as FanStatus) ?? "off",
        timestamp: now.toISOString(),
      };
      socket.emit(EV.FanState, fanState);

      console.log(
        `[hub] device registered: id=${upserted.id} mac=${payload.macAddress} name=${payload.name}`
      );
    } catch (err) {
      console.error("[hub] device:register error:", err);
      socket.emit("error", { message: "device:register failed" });
    }
  });

  socket.on(EV.Telemetry, async (raw: any) => {
    try {
      const payload = raw as TelemetryPayload;
      if (!payload || !payload.deviceId) {
        return;
      }
      const now = new Date();
      m.lastTelemetryAt = Date.now();

      // fetch previous fanStatus to detect changes
      const prev = await db.device.findUnique({
        where: { id: payload.deviceId },
        select: { fanStatus: true },
      });

      // persist a reading
      await withBusyRetry(() =>
        db.sensorReading.create({
          data: {
            deviceId: payload.deviceId,
            temperature: payload.temperature,
            humidity: payload.humidity,
            fanStatus: payload.fanStatus,
            rssi: payload.rssi,
            uptimeSeconds: payload.uptimeSeconds,
          },
        })
      );

      // update cached device telemetry
      const updated = await withBusyRetry(() =>
        db.device.update({
          where: { id: payload.deviceId },
          data: {
            temperature: payload.temperature,
            humidity: payload.humidity,
            fanStatus: payload.fanStatus,
            rssi: payload.rssi,
            uptimeSeconds: payload.uptimeSeconds,
            status: "online",
            lastSeenAt: now,
          },
        })
      );

      // broadcast full telemetry to dashboards
      broadcastToDashboards(EV.Telemetry, {
        ...payload,
        lastSeenAt: updated.lastSeenAt.toISOString(),
        status: "online",
      });

      // if fanStatus changed, also broadcast a fan:state event
      if (prev && (prev.fanStatus as FanStatus) !== payload.fanStatus) {
        const fanState: FanStatePayload = {
          deviceId: payload.deviceId,
          fanStatus: payload.fanStatus,
          timestamp: now.toISOString(),
        };
        broadcastToDashboards(EV.FanState, fanState);
      }
    } catch (err) {
      console.error("[hub] telemetry error:", err);
    }
  });

  socket.on(EV.CommandAck, async (raw: any) => {
    try {
      const payload = raw as CommandAckPayload;
      if (!payload || !payload.commandId) return;
      const now = new Date();

      // update command log (best-effort — the dashboard's commandId should
      // match a row we created on fan:command, but ignore missing-row errors
      // here so we still broadcast the ack to dashboards).
      try {
        await withBusyRetry(() =>
          db.commandLog.update({
            where: { id: payload.commandId },
            data: {
              status: payload.success ? "acknowledged" : "failed",
              ackedAt: now,
            },
          })
        );
      } catch (err: any) {
        // P2025 = no record found — log but continue so we still broadcast ack
        console.warn(
          `[hub] command:ack could not update CommandLog ${payload.commandId}:`,
          err?.code ?? err?.message ?? err
        );
      }

      // update device fanStatus
      if (payload.deviceId) {
        await withBusyRetry(() =>
          db.device
            .update({
              where: { id: payload.deviceId },
              data: { fanStatus: payload.fanStatus, lastSeenAt: now, status: "online" },
            })
            .catch(() => {
              // device may have been deleted; ignore
            })
        );
      }

      // broadcast ack to dashboards
      broadcastToDashboards(EV.CommandAck, payload);
      console.log(
        `[hub] command ack: id=${payload.commandId} success=${payload.success} fan=${payload.fanStatus}`
      );
    } catch (err) {
      console.error("[hub] command:ack error:", err);
    }
  });

  // --- Dashboard → hub -----------------------------------------------------
  socket.on(EV.Subscribe, async () => {
    m.kind = "dashboard";
    // reply with a snapshot of all devices from DB
    try {
      const devices = await getAllDevicesDTO();
      const snapshot: SnapshotPayload = { devices };
      socket.emit(EV.InitialSnapshot, snapshot);
      console.log(`[hub] dashboard subscribed: ${socket.id} (devices: ${devices.length})`);
    } catch (err) {
      console.error("[hub] subscribe snapshot error:", err);
    }
  });

  socket.on(EV.FanCommand, async (raw: any) => {
    try {
      const payload = raw as FanCommandPayload;
      if (!payload || !payload.deviceId || !payload.action || !payload.commandId) {
        socket.emit("error", { message: "fan:command requires deviceId, action, commandId" });
        return;
      }
      // fetch device for current state
      const device = await db.device.findUnique({
        where: { id: payload.deviceId },
      });
      if (!device) {
        socket.emit("error", { message: `device ${payload.deviceId} not found` });
        return;
      }

      // create command log row — use the dashboard-provided commandId as the
      // row id so we can correlate the ack that comes back from the device.
      const now = new Date();
      try {
        await withBusyRetry(() =>
          db.commandLog.create({
            data: {
              id: payload.commandId,
              deviceId: payload.deviceId,
              action: payload.action,
              status: "sent",
              source: "dashboard",
              sentAt: now,
            },
          })
        );
      } catch (err: any) {
        // ignore duplicate-id race (e.g., dashboard retried with the same id)
        console.warn(
          `[hub] fan:command could not create CommandLog ${payload.commandId}:`,
          err?.code ?? err?.message ?? err
        );
      }

      const deviceSocket = deviceSocketsByDeviceId.get(payload.deviceId);
      if (!deviceSocket) {
        // device offline → mark failed, broadcast failure ack
        try {
          await withBusyRetry(() =>
            db.commandLog.update({
              where: { id: payload.commandId },
              data: { status: "failed", error: "device offline", ackedAt: now },
            })
          );
        } catch (err: any) {
          // ignore missing-row race
          console.warn(
            `[hub] fan:command offline could not update CommandLog ${payload.commandId}:`,
            err?.code ?? err?.message ?? err
          );
        }
        const ackPayload: CommandAckPayload = {
          commandId: payload.commandId,
          deviceId: payload.deviceId,
          success: false,
          fanStatus: (device.fanStatus as FanStatus) ?? "off",
          timestamp: now.toISOString(),
        };
        broadcastToDashboards(EV.CommandAck, ackPayload);
        console.log(`[hub] fan:command device offline: ${payload.deviceId}`);
        return;
      }

      // forward command to the device socket
      deviceSocket.emit(EV.FanCommand, {
        deviceId: payload.deviceId,
        action: payload.action,
        commandId: payload.commandId,
      });
      console.log(
        `[hub] fan:command forwarded: device=${payload.deviceId} action=${payload.action} cmd=${payload.commandId}`
      );
    } catch (err) {
      console.error("[hub] fan:command error:", err);
    }
  });

  // --- Disconnect ----------------------------------------------------------
  socket.on("disconnect", async () => {
    const m2 = metaOf(socket);
    if (m2.kind === "device" && m2.deviceId) {
      const deviceId = m2.deviceId;
      deviceSocketsByDeviceId.delete(deviceId);
      try {
        const updated = await withBusyRetry(() =>
          db.device.update({
            where: { id: deviceId },
            data: { status: "offline", lastSeenAt: new Date() },
          })
        );
        const payload: DeviceStatusPayload = {
          deviceId,
          status: "offline",
          lastSeenAt: updated.lastSeenAt.toISOString(),
        };
        broadcastToDashboards(EV.DeviceStatus, payload);
        console.log(`[hub] device disconnected: ${deviceId}`);
      } catch (err) {
        console.error(`[hub] disconnect device update failed:`, err);
      }
    } else if (m2.kind === "dashboard") {
      console.log(`[hub] dashboard disconnected: ${socket.id}`);
    } else {
      console.log(`[hub] socket disconnected: ${socket.id}`);
    }
  });

  socket.on("error", (err: any) => {
    console.error(`[hub] socket error (${socket.id}):`, err);
  });
});

// ---------------------------------------------------------------------------
// Heartbeat: every 15s, check each registered device socket for stale telemetry
// ---------------------------------------------------------------------------

setInterval(async () => {
  const now = Date.now();
  const STALE_MS = 60_000;
  for (const [deviceId, socket] of deviceSocketsByDeviceId.entries()) {
    const m = metaOf(socket);
    const last = m.lastTelemetryAt ?? 0;
    if (now - last > STALE_MS) {
      console.warn(`[hub] heartbeat: device ${deviceId} stale (lastSeen ${now - last}ms ago)`);
      // remove from registry so we don't keep processing
      deviceSocketsByDeviceId.delete(deviceId);
      m.kind = "unknown";
      m.deviceId = undefined;
      await markDeviceOffline(deviceId);
    }
  }
}, 15_000);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

httpServer.listen(PORT, () => {
  console.log(`IoT hub running on port ${PORT}`);
  // Attach a tiny health endpoint AFTER socket.io has installed its listeners.
  // Only respond to plain GET / (no socket.io query strings) so we don't
  // interfere with polling transport.
  httpServer.on("request", (req, res) => {
    const url = req.url ?? "/";
    if (
      url.startsWith("/socket.io/") ||
      url.includes("EIO=") ||
      url.includes("transport=")
    ) {
      return; // let socket.io's earlier-attached listener respond
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "iot-hub", port: PORT }));
  });
});

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`[hub] received ${signal}, shutting down...`);
  try {
    // mark all currently online devices offline (best effort)
    const online = await db.device.findMany({ where: { status: "online" } });
    if (online.length) {
      await db.device.updateMany({
        where: { id: { in: online.map((d) => d.id) } },
        data: { status: "offline", lastSeenAt: new Date() },
      });
    }
  } catch (err) {
    console.error("[hub] shutdown update failed:", err);
  }
  io.close();
  httpServer.close(() => {
    void db.$disconnect().finally(() => process.exit(0));
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Catch-all for any uncaught errors so we have a record of what killed us.
process.on("uncaughtException", (err) => {
  console.error("[hub] UNCAUGHT EXCEPTION:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[hub] UNHANDLED REJECTION:", err);
});
