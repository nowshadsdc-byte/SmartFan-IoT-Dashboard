// Shared contracts for the Smart Fan IoT platform.
// Used by: Next.js frontend, Next.js API routes, IoT hub (mini-service), ESP8266 simulator.

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

export interface SensorReadingDTO {
  id: string;
  deviceId: string;
  temperature: number;
  humidity: number;
  fanStatus: FanStatus;
  rssi: number;
  uptimeSeconds: number;
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

// WebSocket event names
export const IoTEvents = {
  // device -> hub
  DeviceRegister: "device:register",
  Telemetry: "telemetry",
  CommandAck: "command:ack",
  // dashboard -> hub
  Subscribe: "subscribe",
  FanCommand: "fan:command",
  // hub -> dashboard
  TelemetryBroadcast: "telemetry",
  DeviceStatus: "device:status",
  FanState: "fan:state",
  CommandAckBroadcast: "command:ack",
  InitialSnapshot: "snapshot",
  // hub -> device
  FanCommandToDevice: "fan:command",
} as const;

export interface DeviceRegisterPayload {
  deviceId: string;
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
