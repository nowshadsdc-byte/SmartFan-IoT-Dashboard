// Helpers for Next.js API routes:
// - DTO mappers (Device/SensorReading/CommandLog -> ISO-string DTOs)
// - forwardFanCommand: fire-and-forget delivery of fan command to IoT hub via socket.io-client

import { io } from "socket.io-client";
import type {
  CommandLogDTO,
  DeviceDTO,
  FanCommandPayload,
  FanStatus,
  SensorReadingDTO,
} from "@/lib/iot-contracts";
import { IoTEvents } from "@/lib/iot-contracts";

const HUB_URL = "http://localhost:3003";

// ---- DTO mappers ----------------------------------------------------------

type DeviceRow = {
  id: string;
  name: string;
  macAddress: string;
  location: string;
  firmwareVersion: string;
  ipAddress: string;
  status: string;
  fanStatus: string;
  temperature: number;
  humidity: number;
  rssi: number;
  uptimeSeconds: number;
  lastSeenAt: Date;
  registeredAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

type ReadingRow = {
  id: string;
  deviceId: string;
  temperature: number;
  humidity: number;
  fanStatus: string;
  rssi: number;
  uptimeSeconds: number;
  createdAt: Date;
};

type CommandRow = {
  id: string;
  deviceId: string;
  action: string;
  status: string;
  source: string;
  error: string | null;
  createdAt: Date;
  sentAt: Date | null;
  ackedAt: Date | null;
};

export function toDeviceDTO(d: DeviceRow): DeviceDTO {
  return {
    id: d.id,
    name: d.name,
    macAddress: d.macAddress,
    location: d.location,
    firmwareVersion: d.firmwareVersion,
    ipAddress: d.ipAddress,
    status: (d.status === "online" ? "online" : "offline") as DeviceDTO["status"],
    fanStatus: (d.fanStatus === "on" ? "on" : "off") as FanStatus,
    temperature: d.temperature,
    humidity: d.humidity,
    rssi: d.rssi,
    uptimeSeconds: d.uptimeSeconds,
    lastSeenAt: d.lastSeenAt.toISOString(),
    registeredAt: d.registeredAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

export function toSensorReadingDTO(r: ReadingRow): SensorReadingDTO {
  return {
    id: r.id,
    deviceId: r.deviceId,
    temperature: r.temperature,
    humidity: r.humidity,
    fanStatus: (r.fanStatus === "on" ? "on" : "off") as FanStatus,
    rssi: r.rssi,
    uptimeSeconds: r.uptimeSeconds,
    createdAt: r.createdAt.toISOString(),
  };
}

export function toCommandLogDTO(c: CommandRow): CommandLogDTO {
  return {
    id: c.id,
    deviceId: c.deviceId,
    action: (c.action === "on" ? "on" : "off") as "on" | "off",
    status: c.status as CommandLogDTO["status"],
    source: c.source,
    error: c.error,
    createdAt: c.createdAt.toISOString(),
    sentAt: c.sentAt ? c.sentAt.toISOString() : null,
    ackedAt: c.ackedAt ? c.ackedAt.toISOString() : null,
  };
}

// ---- Hub forwarding -------------------------------------------------------

export interface ForwardResult {
  ok: boolean;
  error?: string;
}

/**
 * Fire-and-forget delivery of a fan command to the IoT hub (port 3003).
 * Connects via socket.io-client (path "/"), emits the `fan:command` event,
 * then disconnects. Resolves within ~800ms regardless of outcome so the
 * API stays responsive.
 */
export function forwardFanCommand(payload: FanCommandPayload): Promise<ForwardResult> {
  return new Promise<ForwardResult>((resolve) => {
    let settled = false;
    let socket: ReturnType<typeof io> | null = null;
    let failTimer: ReturnType<typeof setTimeout> | null = null;
    let disconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: ForwardResult) => {
      if (settled) return;
      settled = true;
      if (failTimer) clearTimeout(failTimer);
      if (disconnectTimer) clearTimeout(disconnectTimer);
      try {
        socket?.disconnect();
      } catch {
        /* noop */
      }
      resolve(result);
    };

    try {
      socket = io(HUB_URL, {
        path: "/",
        reconnection: false,
        timeout: 800,
        transports: ["websocket"],
        forceNew: true,
      });
    } catch {
      finish({ ok: false, error: "hub unreachable" });
      return;
    }

    // Hard timeout — never block the API longer than 800ms.
    failTimer = setTimeout(() => finish({ ok: false, error: "hub unreachable" }), 800);

    socket.on("connect", () => {
      try {
        socket?.emit(IoTEvents.FanCommand, payload);
      } catch {
        finish({ ok: false, error: "emit failed" });
        return;
      }
      // Give the hub a brief moment to process the emit before disconnecting.
      disconnectTimer = setTimeout(() => finish({ ok: true }), 500);
    });

    socket.on("connect_error", () => finish({ ok: false, error: "hub unreachable" }));
    socket.on("error", () => finish({ ok: false, error: "hub unreachable" }));
  });
}
