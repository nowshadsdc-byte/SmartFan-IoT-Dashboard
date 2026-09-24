// Shared contracts for the Smart Fan IoT platform.
// Used by: Next.js frontend, Next.js API routes, IoT hub (mini-service), ESP8266 simulator.

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
