// Helpers for Next.js API routes:
// - DTO mappers (Device/SensorReading/CommandLog -> ISO-string DTOs)
// - forwardFanCommand / notifyConfigUpdate: short-lived socket.io-client calls into the IoT hub

import { io } from "socket.io-client";
import type {
  CommandLogDTO,
  DeviceDTO,
  DeviceConfigUpdatePayload,
  DeviceMode,
  FanCommandPayload,
  FanStatus,
  HubAck,
  SensorReadingDTO,
} from "@/lib/iot-contracts";
import { IoTEvents } from "@/lib/iot-contracts";

const HUB_URL = process.env.IOT_HUB_URL || "http://localhost:3003";

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
  mode: string;
  desiredFanStatus: string;
  tempOn: number;
  tempOff: number;
  heartbeatIntervalSec: number;
  temperature: number;
  humidity: number;
  rssi: number;
  uptimeSeconds: number;
  gasLevel: number | null;
  sensorOk: boolean;
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
  gasLevel: number | null;
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
    gasLevel: r.gasLevel ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

export function toCommandLogDTO(c: CommandRow): CommandLogDTO {
  return {
    id: c.id,
    deviceId: c.deviceId,
    action: (c.action === "on" || c.action === "auto" ? c.action : "off") as CommandLogDTO["action"],
    status: c.status as CommandLogDTO["status"],
    source: c.source,
    error: c.error,
    createdAt: c.createdAt.toISOString(),
    sentAt: c.sentAt ? c.sentAt.toISOString() : null,
    ackedAt: c.ackedAt ? c.ackedAt.toISOString() : null,
  };
}

// ---- Hub calls --------------------------------------------------------------

export interface ForwardResult {
  ok: boolean;
  /** Present when ok: "sent" if delivered to an online device, "queued" if the device is offline. */
  status?: "sent" | "queued";
  error?: string;
}

/** Hard cap for any hub call — hub-unreachable is a normal, handled case. */
const HUB_TIMEOUT_MS = 800;

/**
 * Emit one event to the hub over a short-lived socket and resolve with the
 * hub's acknowledgement. Authenticates as a dashboard via the shared
 * `x-hub-secret` header. Resolves within ~800ms regardless of outcome.
 */
function callHub(event: string, payload: unknown): Promise<ForwardResult> {
  return new Promise<ForwardResult>((resolve) => {
    let settled = false;
    let socket: ReturnType<typeof io> | null = null;
    let failTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: ForwardResult) => {
      if (settled) return;
      settled = true;
      if (failTimer) clearTimeout(failTimer);
      try {
        socket?.disconnect();
      } catch {
        /* noop */
      }
      resolve(result);
    };

    try {
      socket = io(HUB_URL, {
        reconnection: false,
        timeout: HUB_TIMEOUT_MS,
        transports: ["websocket"],
        forceNew: true,
        extraHeaders: { "x-hub-secret": process.env.HUB_INTERNAL_SECRET ?? "" },
      });
    } catch {
      finish({ ok: false, error: "hub unreachable" });
      return;
    }

    failTimer = setTimeout(() => finish({ ok: false, error: "hub unreachable" }), HUB_TIMEOUT_MS);

    socket.on("connect", () => {
      try {
        socket?.emit(event, payload, (ack: HubAck | undefined) => {
          if (ack?.ok) finish({ ok: true, status: ack.status === "sent" ? "sent" : "queued" });
          else finish({ ok: false, error: ack?.error ?? "hub rejected the request" });
        });
      } catch {
        finish({ ok: false, error: "emit failed" });
      }
    });

    socket.on("connect_error", () => finish({ ok: false, error: "hub unreachable" }));
    socket.on("error", () => finish({ ok: false, error: "hub unreachable" }));
  });
}

/**
 * Deliver a fan command (`on` | `off` | `auto`) to the hub. The DB row
 * (`commandId`) must already exist; the hub updates its status.
 */
export function forwardFanCommand(payload: FanCommandPayload): Promise<ForwardResult> {
  return callHub(IoTEvents.FanCommand, payload);
}

/** Tell the hub a device's config changed in the DB so it can push `device:config`. */
export function notifyConfigUpdate(payload: DeviceConfigUpdatePayload): Promise<ForwardResult> {
  return callHub(IoTEvents.DeviceConfigUpdate, payload);
}
