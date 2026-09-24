// IoT Hub — Smart Fan Monitoring platform
// Socket.IO server (default path "/socket.io/") on port 3003. Real ESP8266 devices
// (device token, ws://) and the dashboard (Caddy-injected x-hub-secret) connect here.
// Persists to the shared SQLite DB via Prisma and broadcasts to dashboards.
//
// Independent bun project: the contracts below are a verbatim mirror of
// src/lib/iot-contracts.ts — change both together.

import { createServer } from "http";
import { createHash, timingSafeEqual } from "crypto";
import { Server, Socket } from "socket.io";
import { PrismaClient, Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// Shared contracts (mirrored from src/lib/iot-contracts.ts of the main project)
// ---------------------------------------------------------------------------

export type DeviceStatus = "online" | "offline";
export type FanStatus = "on" | "off";
export type CommandAction = "on" | "off" | "auto";
export type CommandStatus = "queued" | "sent" | "acknowledged" | "failed";
export type DeviceMode = "auto" | "manual";

export interface DeviceDTO {
  id: string;
  name: string;
  macAddress: string;
  location: string;
  firmwareVersion: string;
  ipAddress: string;
  status: DeviceStatus;
  fanStatus: FanStatus; // ACTUAL state reported by the device
  mode: DeviceMode;
  desiredFanStatus: FanStatus; // what the user asked for in manual mode
  tempOn: number;
  tempOff: number;
  heartbeatIntervalSec: number;
  temperature: number;
  humidity: number;
  rssi: number;
  uptimeSeconds: number;
  gasLevel: number | null;
  sensorOk: boolean;
  lastSeenAt: string; // ISO
  registeredAt: string; // ISO
  updatedAt: string; // ISO
}

export interface SensorReadingDTO {
  id: string;
  deviceId: string;
  temperature: number;
  humidity: number;
  fanStatus: FanStatus;
  rssi: number;
  uptimeSeconds: number;
  gasLevel: number | null;
  createdAt: string; // ISO
}

export interface CommandLogDTO {
  id: string;
  deviceId: string;
  action: CommandAction;
  status: CommandStatus;
  source: string;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
  ackedAt: string | null;
}

export interface TelemetryPayload {
  deviceId: string;
  temperature: number | null; // null when sensorOk is false
  humidity: number | null;
  fanStatus: FanStatus;
  mode?: DeviceMode; // informational only; the server never stores it from telemetry
  sensorOk?: boolean; // default true
  gasLevel?: number | null;
  rssi: number;
  uptimeSeconds: number;
  timestamp?: string; // ISO; optional/informational from devices, always set on hub broadcasts
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
  mode?: DeviceMode;
  timestamp?: string; // ISO; optional from devices, always set on hub broadcasts
}

/** Hub -> device and hub -> dashboards: the server-owned control config. */
export interface DeviceConfigPayload {
  deviceId: string;
  mode: DeviceMode;
  desiredFanStatus: FanStatus;
  tempOn: number;
  tempOff: number;
  heartbeatIntervalSec: number;
}

/** Dashboard -> hub: change thresholds / heartbeat. Fields are optional (partial update). */
export interface DeviceConfigUpdatePayload {
  deviceId: string;
  tempOn?: number;
  tempOff?: number;
  heartbeatIntervalSec?: number;
}

/** Socket.IO acknowledgement returned to the caller of `fan:command` / `device:config:update`. */
export interface HubAck {
  ok: boolean;
  status?: "sent" | "queued";
  error?: string;
}

// WebSocket event names
export const IoTEvents = {
  // device -> hub
  DeviceRegister: "device:register",
  Telemetry: "telemetry",
  CommandAck: "command:ack",
  // dashboard -> hub
  Subscribe: "subscribe",
  FanCommand: "fan:command",
  DeviceConfigUpdate: "device:config:update",
  // hub -> dashboard
  TelemetryBroadcast: "telemetry",
  DeviceStatus: "device:status",
  FanState: "fan:state",
  CommandAckBroadcast: "command:ack",
  InitialSnapshot: "snapshot",
  // hub -> device
  FanCommandToDevice: "fan:command",
  // hub -> device AND hub -> dashboards
  DeviceConfig: "device:config",
} as const;

export interface DeviceRegisterPayload {
  name: string;
  macAddress: string;
  location: string;
  firmwareVersion: string;
  ipAddress: string;
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

// Event names (same object as IoTEvents in the main project)
const EV = IoTEvents;

// ---------------------------------------------------------------------------
// Environment / secrets
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 3003);
const DEVICE_TOKEN = process.env.DEVICE_TOKEN ?? "";
const HUB_INTERNAL_SECRET = process.env.HUB_INTERNAL_SECRET ?? "";
const READING_RETENTION_DAYS = Math.max(1, Number(process.env.READING_RETENTION_DAYS ?? 30) || 30);

for (const [name, value] of [
  ["DEVICE_TOKEN", DEVICE_TOKEN],
  ["HUB_INTERNAL_SECRET", HUB_INTERNAL_SECRET],
] as const) {
  if (value.length < 16) {
    console.error(`[hub] FATAL: ${name} is missing or shorter than 16 characters. Refusing to start.`);
    process.exit(1);
  }
}

/** Constant-time string comparison (hash both sides so lengths never leak). */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

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

/** WAL + busy timeout: the hub and the web app share one SQLite file. */
async function configureSqlite() {
  await db.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
  await db.$queryRawUnsafe("PRAGMA busy_timeout=5000;");
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
    mode: (d.mode === "manual" ? "manual" : "auto") as DeviceMode,
    desiredFanStatus: (d.desiredFanStatus === "on" ? "on" : "off") as FanStatus,
    tempOn: d.tempOn,
    tempOff: d.tempOff,
    heartbeatIntervalSec: d.heartbeatIntervalSec,
    temperature: d.temperature,
    humidity: d.humidity,
    rssi: d.rssi,
    uptimeSeconds: d.uptimeSeconds,
    gasLevel: d.gasLevel ?? null,
    sensorOk: d.sensorOk,
    lastSeenAt: d.lastSeenAt ? new Date(d.lastSeenAt).toISOString() : new Date().toISOString(),
    registeredAt: d.registeredAt ? new Date(d.registeredAt).toISOString() : new Date().toISOString(),
    updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : new Date().toISOString(),
  };
}

function toConfigPayload(d: any): DeviceConfigPayload {
  return {
    deviceId: d.id,
    mode: d.mode === "manual" ? "manual" : "auto",
    desiredFanStatus: d.desiredFanStatus === "on" ? "on" : "off",
    tempOn: d.tempOn,
    tempOff: d.tempOff,
    heartbeatIntervalSec: d.heartbeatIntervalSec,
  };
}

// ---------------------------------------------------------------------------
// Validation helpers (payloads come from the public internet — never trust them)
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const isInt = (v: unknown, min: number, max: number): v is number => isNum(v, min, max) && Number.isInteger(v);
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isFan = (v: unknown): v is FanStatus => v === "on" || v === "off";
const isId = (v: unknown): v is string => isStr(v, 64);
const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i;

// Same rules as src/lib/config-validation.ts (mirrored — keep in sync).
interface ConfigInput {
  tempOn: number;
  tempOff: number;
  heartbeatIntervalSec: number;
}
function validateConfig(c: ConfigInput): string | null {
  if (!isNum(c.tempOn, -Infinity, 60)) return "tempOn must be a number <= 60";
  if (!isNum(c.tempOff, 0, Infinity)) return "tempOff must be a number >= 0";
  if (c.tempOff >= c.tempOn) return "tempOff must be lower than tempOn";
  if (c.tempOn - c.tempOff < 1) return "tempOn must be at least 1 °C above tempOff";
  if (!isInt(c.heartbeatIntervalSec, 5, 300)) return "heartbeatIntervalSec must be a whole number between 5 and 300";
  return null;
}

// ---------------------------------------------------------------------------
// Socket metadata & registry
// ---------------------------------------------------------------------------

type Role = "device" | "dashboard";

interface SocketMeta {
  role: Role;
  deviceId?: string; // device sockets, set on successful device:register
  heartbeatSec: number; // cached device interval, refreshed on config change
  lastActivityAt: number; // ms epoch — drives the heartbeat timeout
  lastTelemetryAcceptedAt: number; // ms epoch — flood protection
  lastFanStatus?: FanStatus;
}

function metaOf(socket: Socket): SocketMeta {
  return socket.data as SocketMeta;
}

// registered device sockets, keyed by database device id
const deviceSockets = new Map<string, Socket>();

const DASHBOARD_ROOM = "dashboards";

const staleMs = (heartbeatSec: number) => Math.max(30_000, 3 * heartbeatSec * 1000);
const COMMAND_ACK_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// HTTP + Socket.io server setup
// ---------------------------------------------------------------------------

// Plain-HTTP health endpoint. socket.io answers everything under /socket.io/
// itself and only falls through to this listener for other paths.
const httpServer = createServer((req, res) => {
  const url = req.url ?? "/";
  if (url.startsWith("/socket.io/")) return;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, service: "iot-hub", port: PORT }));
});

/** Decide the role of a connection attempt, or null to reject it. */
function authenticate(token: unknown, secret: unknown): Role | null {
  if (typeof token === "string" && token && safeEqual(token, DEVICE_TOKEN)) return "device";
  if (typeof secret === "string" && secret && safeEqual(secret, HUB_INTERNAL_SECRET)) return "dashboard";
  return null;
}

const io = new Server(httpServer, {
  // default path "/socket.io/"; websocket-only clients (ESP8266) are supported
  transports: ["websocket", "polling"],
  pingTimeout: 20000,
  pingInterval: 10000,
  maxHttpBufferSize: 64 * 1024,
});

// Every socket must authenticate (device token OR dashboard proxy secret) and gets a role.
// The token may arrive in the query string (ESP8266) or in `auth` (socket.io-client); both are
// only visible at the Socket.IO connect step, so this middleware is where connections are rejected.
io.use((socket, next) => {
  const auth = socket.handshake.auth as Rec | undefined;
  const q = socket.handshake.query.token;
  const token = typeof auth?.token === "string" ? auth.token : typeof q === "string" ? q : "";
  const role = authenticate(token, socket.handshake.headers["x-hub-secret"]);

  if (!role) {
    console.warn(`[hub] rejected unauthenticated socket from ${socket.handshake.address}`);
    return next(new Error("unauthorized"));
  }
  socket.data = {
    role,
    heartbeatSec: 10,
    lastActivityAt: Date.now(),
    lastTelemetryAcceptedAt: 0,
  } satisfies SocketMeta;
  next();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function broadcastToDashboards(event: string, payload: any) {
  io.to(DASHBOARD_ROOM).emit(event, payload);
}

async function getAllDevicesDTO(): Promise<DeviceDTO[]> {
  const rows = await db.device.findMany({ orderBy: { name: "asc" } });
  return rows.map(toDeviceDTO);
}

async function broadcastSnapshot() {
  try {
    const snapshot: SnapshotPayload = { devices: await getAllDevicesDTO() };
    broadcastToDashboards(EV.InitialSnapshot, snapshot);
  } catch (err) {
    console.error("[hub] broadcastSnapshot failed:", err);
  }
}

/** Push the persisted config to the device (if online) and to every dashboard. */
function pushConfig(row: any) {
  const payload = toConfigPayload(row);
  const sock = deviceSockets.get(row.id);
  if (sock) {
    metaOf(sock).heartbeatSec = row.heartbeatIntervalSec;
    sock.emit(EV.DeviceConfig, payload);
  }
  broadcastToDashboards(EV.DeviceConfig, payload);
}

/** Runs an event handler only for the right role; anything else is ignored and logged. */
function handle(
  socket: Socket,
  event: string,
  role: Role,
  fn: (raw: unknown, ack?: (r: HubAck) => void) => Promise<void> | void
) {
  socket.on(event, async (raw: unknown, ack?: unknown) => {
    const cb = typeof ack === "function" ? (ack as (r: HubAck) => void) : undefined;
    if (metaOf(socket).role !== role) {
      console.warn(`[hub] ignored "${event}" from ${metaOf(socket).role} socket ${socket.id}`);
      cb?.({ ok: false, error: "forbidden" });
      return;
    }
    try {
      await fn(raw, cb);
    } catch (err) {
      console.error(`[hub] ${event} error:`, err);
      cb?.({ ok: false, error: "internal_error" });
    }
  });
}

async function markDeviceOffline(deviceId: string, reason: string) {
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
    console.log(`[hub] device ${deviceId} marked offline (${reason})`);
  } catch (err) {
    console.error(`[hub] markDeviceOffline(${deviceId}) failed:`, err);
  }
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

io.on("connection", (socket: Socket) => {
  const m = metaOf(socket);
  console.log(`[hub] ${m.role} socket connected: ${socket.id}`);

  // --- Device → hub --------------------------------------------------------
  handle(socket, EV.DeviceRegister, "device", async (raw) => {
    if (!isRec(raw) || typeof raw.macAddress !== "string" || !MAC_RE.test(raw.macAddress)) {
      console.warn(`[hub] device:register dropped: invalid macAddress (socket ${socket.id})`);
      return;
    }
    const mac = raw.macAddress.toUpperCase();
    const optStr = (v: unknown, max: number, fallback: string) =>
      v === undefined || v === null || v === "" ? fallback : isStr(v, max) ? v : null;
    const name = optStr(raw.name, 64, `fan-${mac.slice(-8).replace(/:/g, "").toLowerCase()}`);
    const location = optStr(raw.location, 64, "Unknown");
    const firmwareVersion = optStr(raw.firmwareVersion, 32, "1.0.0");
    const ipAddress = optStr(raw.ipAddress, 45, socket.handshake.address || "0.0.0.0");
    if (name === null || location === null || firmwareVersion === null || ipAddress === null) {
      console.warn(`[hub] device:register dropped: invalid field (socket ${socket.id})`);
      return;
    }

    // A socket may only ever act as one device.
    if (m.deviceId) {
      const current = await db.device.findUnique({ where: { id: m.deviceId }, select: { macAddress: true } });
      if (current && current.macAddress !== mac) {
        console.warn(`[hub] device:register ignored: socket ${socket.id} already bound to another device`);
        return;
      }
    }

    const now = new Date();
    // Config columns (mode, desiredFanStatus, thresholds, interval) are never touched here.
    const upserted = await withBusyRetry(() =>
      db.device.upsert({
        where: { macAddress: mac },
        create: { name, macAddress: mac, location, firmwareVersion, ipAddress, status: "online", lastSeenAt: now },
        update: { name, location, firmwareVersion, ipAddress, status: "online", lastSeenAt: now },
      })
    );

    // Replace any previous socket of this device (its disconnect handler will then not mark it offline).
    const old = deviceSockets.get(upserted.id);
    deviceSockets.set(upserted.id, socket);
    if (old && old !== socket) old.disconnect(true);

    m.deviceId = upserted.id;
    m.heartbeatSec = upserted.heartbeatIntervalSec;
    m.lastActivityAt = Date.now();
    m.lastTelemetryAcceptedAt = 0;
    m.lastFanStatus = upserted.fanStatus as FanStatus;

    // 1. registration reply, 2. current config
    socket.emit(EV.DeviceRegister, { ok: true, deviceId: upserted.id });
    socket.emit(EV.DeviceConfig, toConfigPayload(upserted));

    // Legacy: desired fan state for the simulator / old firmware.
    const desired: FanStatus = upserted.mode === "manual" ? (upserted.desiredFanStatus as FanStatus) : (upserted.fanStatus as FanStatus);
    const fanState: FanStatePayload = { deviceId: upserted.id, fanStatus: desired, timestamp: now.toISOString() };
    socket.emit(EV.FanState, fanState);

    // Commands queued while the device was offline → delivered now (state is already in the config above).
    const queued = await db.commandLog.findMany({
      where: { deviceId: upserted.id, status: "queued" },
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    if (queued.length) {
      await withBusyRetry(() =>
        db.commandLog.updateMany({
          where: { id: { in: queued.map((c) => c.id) }, status: "queued" },
          data: { status: "sent", sentAt: now },
        })
      );
      for (const c of queued) {
        socket.emit(EV.FanCommand, { deviceId: upserted.id, action: c.action, commandId: c.id });
      }
      socket.emit(EV.DeviceConfig, toConfigPayload(upserted));
    }

    broadcastToDashboards(EV.DeviceStatus, {
      deviceId: upserted.id,
      status: "online",
      lastSeenAt: now.toISOString(),
    } satisfies DeviceStatusPayload);
    void broadcastSnapshot(); // lets dashboards pick up new devices / renamed / new firmware

    console.log(
      `[hub] device registered: id=${upserted.id} mac=${mac} name=${name} (delivered ${queued.length} queued command(s))`
    );
  });

  handle(socket, EV.Telemetry, "device", async (raw) => {
    if (!isRec(raw) || !isId(raw.deviceId)) return void console.warn("[hub] telemetry dropped: bad deviceId");
    if (raw.deviceId !== m.deviceId) {
      return void console.warn(`[hub] telemetry dropped: deviceId mismatch on socket ${socket.id}`);
    }
    const sensorOk = raw.sensorOk === undefined ? true : raw.sensorOk;
    const temperature = raw.temperature ?? null;
    const humidity = raw.humidity ?? null;
    const gasLevel = raw.gasLevel ?? null;
    if (
      typeof sensorOk !== "boolean" ||
      !(temperature === null || isNum(temperature, -60, 150)) ||
      !(humidity === null || isNum(humidity, 0, 100)) ||
      !(gasLevel === null || isInt(gasLevel, 0, 65535)) ||
      !isFan(raw.fanStatus) ||
      !isInt(raw.rssi, -150, 20) ||
      !isInt(raw.uptimeSeconds, 0, 1e9) ||
      !(raw.mode === undefined || raw.mode === "auto" || raw.mode === "manual")
    ) {
      return void console.warn(`[hub] telemetry dropped: invalid payload from ${m.deviceId}`);
    }
    const deviceId = m.deviceId;
    const fanStatus = raw.fanStatus;
    const rssi = raw.rssi;
    const uptimeSeconds = raw.uptimeSeconds;

    // Flood protection: any telemetry proves liveness, but persist at most 1/s.
    const nowMs = Date.now();
    const sinceLast = nowMs - m.lastTelemetryAcceptedAt;
    m.lastActivityAt = nowMs;
    if (sinceLast < 1000) return;
    m.lastTelemetryAcceptedAt = nowMs;

    // Server time is authoritative — the ESP8266 clock may be wrong.
    const now = new Date(nowMs);
    const hasReading = sensorOk && temperature !== null && humidity !== null;

    // Never touches mode / desiredFanStatus / thresholds.
    const deviceData = {
      fanStatus,
      rssi,
      uptimeSeconds,
      gasLevel,
      sensorOk,
      status: "online",
      lastSeenAt: now,
      ...(hasReading ? { temperature, humidity } : {}),
    };
    const updated = await withBusyRetry(async () => {
      if (hasReading) {
        const [, dev] = await db.$transaction([
          db.sensorReading.create({
            data: { deviceId, temperature, humidity, fanStatus, rssi, uptimeSeconds, gasLevel },
          }),
          db.device.update({ where: { id: deviceId }, data: deviceData }),
        ]);
        return dev;
      }
      return db.device.update({ where: { id: deviceId }, data: deviceData });
    });

    broadcastToDashboards(EV.Telemetry, {
      deviceId,
      temperature: hasReading ? temperature : null,
      humidity: hasReading ? humidity : null,
      fanStatus,
      sensorOk,
      gasLevel,
      rssi,
      uptimeSeconds,
      timestamp: now.toISOString(),
      lastSeenAt: updated.lastSeenAt.toISOString(),
      status: "online",
    });

    if (m.lastFanStatus !== fanStatus) {
      m.lastFanStatus = fanStatus;
      broadcastToDashboards(EV.FanState, {
        deviceId,
        fanStatus,
        timestamp: now.toISOString(),
      } satisfies FanStatePayload);
    }
  });

  handle(socket, EV.CommandAck, "device", async (raw) => {
    if (
      !isRec(raw) ||
      !isId(raw.commandId) ||
      !isId(raw.deviceId) ||
      typeof raw.success !== "boolean" ||
      !isFan(raw.fanStatus) ||
      !(raw.mode === undefined || raw.mode === "auto" || raw.mode === "manual")
    ) {
      return void console.warn(`[hub] command:ack dropped: invalid payload (socket ${socket.id})`);
    }
    if (raw.deviceId !== m.deviceId) {
      return void console.warn(`[hub] command:ack dropped: deviceId mismatch on socket ${socket.id}`);
    }
    const deviceId = m.deviceId;
    const { commandId, success, fanStatus } = raw;
    const now = new Date();
    m.lastActivityAt = Date.now();

    // Only this device's own command rows can be updated.
    const res = await withBusyRetry(() =>
      db.commandLog.updateMany({
        where: { id: commandId, deviceId, status: { not: "acknowledged" } },
        data: {
          status: success ? "acknowledged" : "failed",
          ackedAt: now,
          error: success ? null : "device reported failure",
        },
      })
    );
    if (res.count === 0) console.warn(`[hub] command:ack for unknown/settled command ${commandId}`);

    // Only the actual fan state; mode/desired/thresholds stay server-owned.
    await withBusyRetry(() =>
      db.device.update({
        where: { id: deviceId },
        data: { fanStatus, lastSeenAt: now, status: "online" },
      })
    );
    m.lastFanStatus = fanStatus;

    const ack: CommandAckPayload = { commandId, deviceId, success, fanStatus, mode: raw.mode, timestamp: now.toISOString() };
    broadcastToDashboards(EV.CommandAck, ack);
    broadcastToDashboards(EV.FanState, { deviceId, fanStatus, timestamp: now.toISOString() } satisfies FanStatePayload);
    console.log(`[hub] command ack: id=${commandId} success=${success} fan=${fanStatus}`);
  });

  // --- Dashboard → hub -----------------------------------------------------
  handle(socket, EV.Subscribe, "dashboard", async () => {
    void socket.join(DASHBOARD_ROOM);
    const devices = await getAllDevicesDTO();
    socket.emit(EV.InitialSnapshot, { devices } satisfies SnapshotPayload);
    console.log(`[hub] dashboard subscribed: ${socket.id} (devices: ${devices.length})`);
  });

  handle(socket, EV.FanCommand, "dashboard", async (raw, ack) => {
    if (
      !isRec(raw) ||
      !isId(raw.deviceId) ||
      !isId(raw.commandId) ||
      !(raw.action === "on" || raw.action === "off" || raw.action === "auto")
    ) {
      console.warn("[hub] fan:command dropped: invalid payload");
      return void ack?.({ ok: false, error: "invalid payload" });
    }
    const { deviceId, commandId, action } = raw;

    // 1. Persist desired state immediately (idempotent with what the API route already wrote).
    let device;
    try {
      device = await withBusyRetry(() =>
        db.device.update({
          where: { id: deviceId },
          data: action === "auto" ? { mode: "auto" } : { mode: "manual", desiredFanStatus: action },
        })
      );
    } catch {
      return void ack?.({ ok: false, error: "device_not_found" });
    }

    // 2. Reuse the CommandLog row created by the API; create it only if missing.
    const existing = await db.commandLog.findUnique({ where: { id: commandId } });
    if (existing && existing.deviceId !== deviceId) {
      console.warn(`[hub] fan:command dropped: command ${commandId} belongs to another device`);
      return void ack?.({ ok: false, error: "command/device mismatch" });
    }
    if (!existing) {
      await withBusyRetry(() =>
        db.commandLog.create({
          data: { id: commandId, deviceId, action, status: "queued", source: "dashboard" },
        })
      );
    }

    // 3. Deliver now if the device is online, otherwise it stays queued until it registers.
    const deviceSocket = deviceSockets.get(deviceId);
    if (deviceSocket) {
      await withBusyRetry(() =>
        db.commandLog.updateMany({
          where: { id: commandId, status: "queued" },
          data: { status: "sent", sentAt: new Date() },
        })
      );
      deviceSocket.emit(EV.FanCommand, { deviceId, action, commandId });
      pushConfig(device);
      console.log(`[hub] fan:command sent: device=${deviceId} action=${action} cmd=${commandId}`);
      ack?.({ ok: true, status: "sent" });
    } else {
      broadcastToDashboards(EV.DeviceConfig, toConfigPayload(device));
      console.log(`[hub] fan:command queued (device offline): device=${deviceId} action=${action} cmd=${commandId}`);
      ack?.({ ok: true, status: "queued" });
    }
  });

  handle(socket, EV.DeviceConfigUpdate, "dashboard", async (raw, ack) => {
    if (
      !isRec(raw) ||
      !isId(raw.deviceId) ||
      !(raw.tempOn === undefined || typeof raw.tempOn === "number") ||
      !(raw.tempOff === undefined || typeof raw.tempOff === "number") ||
      !(raw.heartbeatIntervalSec === undefined || typeof raw.heartbeatIntervalSec === "number")
    ) {
      console.warn("[hub] device:config:update dropped: invalid payload");
      return void ack?.({ ok: false, error: "invalid payload" });
    }
    const current = await db.device.findUnique({ where: { id: raw.deviceId } });
    if (!current) return void ack?.({ ok: false, error: "device_not_found" });

    const merged: ConfigInput = {
      tempOn: (raw.tempOn as number | undefined) ?? current.tempOn,
      tempOff: (raw.tempOff as number | undefined) ?? current.tempOff,
      heartbeatIntervalSec: (raw.heartbeatIntervalSec as number | undefined) ?? current.heartbeatIntervalSec,
    };
    const problem = validateConfig(merged);
    if (problem) {
      console.warn(`[hub] device:config:update rejected: ${problem}`);
      return void ack?.({ ok: false, error: problem });
    }

    const updated = await withBusyRetry(() => db.device.update({ where: { id: current.id }, data: merged }));
    pushConfig(updated);
    console.log(`[hub] config updated: device=${current.id} ${JSON.stringify(merged)}`);
    ack?.({ ok: true, status: deviceSockets.has(current.id) ? "sent" : "queued" });
  });

  // --- Disconnect ----------------------------------------------------------
  socket.on("disconnect", async (reason) => {
    const md = metaOf(socket);
    if (md.role === "device" && md.deviceId) {
      // Skip if a newer socket already replaced this one.
      if (deviceSockets.get(md.deviceId) !== socket) return;
      deviceSockets.delete(md.deviceId);
      await markDeviceOffline(md.deviceId, `disconnected: ${reason}`);
    } else {
      console.log(`[hub] ${md.role} socket disconnected: ${socket.id}`);
    }
  });

  socket.on("error", (err: any) => {
    console.error(`[hub] socket error (${socket.id}):`, err);
  });
});

// ---------------------------------------------------------------------------
// Background sweeps
// ---------------------------------------------------------------------------

// Every 5s: (a) devices silent longer than max(30s, 3 × their heartbeat interval)
// are dropped/marked offline, (b) commands still "sent" after 30s become failed.
setInterval(async () => {
  const now = Date.now();
  for (const [deviceId, socket] of deviceSockets.entries()) {
    const md = metaOf(socket);
    if (now - md.lastActivityAt > staleMs(md.heartbeatSec)) {
      console.warn(`[hub] heartbeat: device ${deviceId} silent for ${now - md.lastActivityAt}ms`);
      deviceSockets.delete(deviceId);
      socket.disconnect(true);
      await markDeviceOffline(deviceId, "heartbeat timeout");
    }
  }

  try {
    const cutoff = new Date(now - COMMAND_ACK_TIMEOUT_MS);
    const timedOut = await db.commandLog.findMany({ where: { status: "sent", sentAt: { lt: cutoff } } });
    if (timedOut.length) {
      await withBusyRetry(() =>
        db.commandLog.updateMany({
          where: { id: { in: timedOut.map((c) => c.id) }, status: "sent" },
          data: { status: "failed", error: "no ack", ackedAt: new Date() },
        })
      );
      for (const c of timedOut) {
        const dev = await db.device.findUnique({ where: { id: c.deviceId }, select: { fanStatus: true } });
        broadcastToDashboards(EV.CommandAck, {
          commandId: c.id,
          deviceId: c.deviceId,
          success: false,
          fanStatus: (dev?.fanStatus as FanStatus) ?? "off",
          timestamp: new Date().toISOString(),
        } satisfies CommandAckPayload);
        console.warn(`[hub] command ${c.id} failed: no ack`);
      }
    }
  } catch (err) {
    console.error("[hub] command timeout sweep failed:", err);
  }
}, 5_000);

// Hourly: retention for the sensor time series.
async function purgeOldReadings() {
  try {
    const cutoff = new Date(Date.now() - READING_RETENTION_DAYS * 86_400_000);
    const res = await withBusyRetry(() => db.sensorReading.deleteMany({ where: { createdAt: { lt: cutoff } } }));
    if (res.count) console.log(`[hub] retention: deleted ${res.count} readings older than ${READING_RETENTION_DAYS}d`);
  } catch (err) {
    console.error("[hub] retention purge failed:", err);
  }
}
setInterval(purgeOldReadings, 3_600_000);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start() {
  await configureSqlite();
  // No sockets survive a restart, so nothing can still be online.
  await db.device.updateMany({ where: { status: "online" }, data: { status: "offline" } });
  void purgeOldReadings();
  httpServer.listen(PORT, () => console.log(`IoT hub running on port ${PORT}`));
}

start().catch((err) => {
  console.error("[hub] FATAL: startup failed:", err);
  process.exit(1);
});

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`[hub] received ${signal}, shutting down...`);
  try {
    await db.device.updateMany({
      where: { status: "online" },
      data: { status: "offline", lastSeenAt: new Date() },
    });
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
