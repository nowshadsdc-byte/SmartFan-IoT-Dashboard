"use client";

import { create } from "zustand";
import type {
  DeviceDTO,
  TelemetryPayload,
  DeviceStatusPayload,
  FanStatePayload,
  SnapshotPayload,
  CommandAckPayload,
} from "@/lib/iot-contracts";

/**
 * Aggregated global stats returned by GET /api/stats.
 * The dashboard polls this every 10s as a fallback to the WS stream.
 */
export interface DashboardStats {
  totalDevices: number;
  onlineDevices: number;
  offlineDevices: number;
  fansOn: number;
  fansOff: number;
  avgTemperature: number;
  avgHumidity: number;
  lastActivityAt: string | null;
}

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

interface IotState {
  /** Full device list — single source of truth for the dashboard. */
  devices: DeviceDTO[];
  /** Aggregated KPI strip. */
  stats: DashboardStats | null;
  /** WebSocket connection status for the header pill. */
  connection: ConnectionState;
  /** True while the initial GET /api/devices is in-flight. */
  loading: boolean;
  /** Set when the initial fetch fails (network / 5xx). */
  error: string | null;
  /** ISO timestamp of the last telemetry received — drives the "LIVE" pulse. */
  lastEventAt: number | null;

  // ---- Actions ----
  setDevices: (devices: DeviceDTO[]) => void;
  applySnapshot: (payload: SnapshotPayload) => void;
  applyTelemetry: (payload: TelemetryPayload) => void;
  applyDeviceStatus: (payload: DeviceStatusPayload) => void;
  applyFanState: (payload: FanStatePayload) => void;
  applyCommandAck: (payload: CommandAckPayload) => void;
  setStats: (stats: DashboardStats | null) => void;
  setConnection: (state: ConnectionState) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  /** Recompute KPI stats from the current device list — used as a fast fallback
   *  between polls so the strip stays in sync with WS events. */
  recomputeStats: () => void;
}

/**
 * Merge a telemetry payload into an existing device entry, preserving
 * fields that aren't part of the telemetry frame (name, location, etc.).
 */
function mergeTelemetryIntoDevice(
  device: DeviceDTO,
  t: TelemetryPayload,
): DeviceDTO {
  return {
    ...device,
    temperature: t.temperature,
    humidity: t.humidity,
    fanStatus: t.fanStatus,
    rssi: t.rssi,
    uptimeSeconds: t.uptimeSeconds,
    // Telemetry implies the device is reachable.
    status: "online",
    lastSeenAt: t.timestamp,
    updatedAt: t.timestamp,
  };
}

export const useIotStore = create<IotState>((set, get) => ({
  devices: [],
  stats: null,
  connection: "disconnected",
  loading: true,
  error: null,
  lastEventAt: null,

  setDevices: (devices) => {
    set({ devices });
    get().recomputeStats();
  },

  applySnapshot: (payload) => {
    set({ devices: payload.devices, lastEventAt: Date.now() });
    get().recomputeStats();
  },

  applyTelemetry: (payload) => {
    const devices = get().devices;
    const idx = devices.findIndex((d) => d.id === payload.deviceId);
    if (idx === -1) {
      // Device not yet in state — wait for next snapshot, ignore the frame.
      return;
    }
    const next = devices.slice();
    next[idx] = mergeTelemetryIntoDevice(next[idx], payload);
    set({ devices: next, lastEventAt: Date.now() });
    get().recomputeStats();
  },

  applyDeviceStatus: (payload) => {
    const devices = get().devices;
    const idx = devices.findIndex((d) => d.id === payload.deviceId);
    if (idx === -1) return;
    const next = devices.slice();
    next[idx] = {
      ...next[idx],
      status: payload.status,
      lastSeenAt: payload.lastSeenAt ?? next[idx].lastSeenAt,
      updatedAt: payload.lastSeenAt ?? next[idx].updatedAt,
    };
    set({ devices: next, lastEventAt: Date.now() });
    get().recomputeStats();
  },

  applyFanState: (payload) => {
    const devices = get().devices;
    const idx = devices.findIndex((d) => d.id === payload.deviceId);
    if (idx === -1) return;
    const next = devices.slice();
    next[idx] = {
      ...next[idx],
      fanStatus: payload.fanStatus,
      updatedAt: payload.timestamp,
    };
    set({ devices: next, lastEventAt: Date.now() });
    get().recomputeStats();
  },

  applyCommandAck: (payload) => {
    const devices = get().devices;
    const idx = devices.findIndex((d) => d.id === payload.deviceId);
    if (idx === -1) return;
    const next = devices.slice();
    next[idx] = {
      ...next[idx],
      fanStatus: payload.fanStatus,
      // A successful ack means the device responded → it's online.
      status: payload.success ? "online" : next[idx].status,
      lastSeenAt: payload.timestamp,
      updatedAt: payload.timestamp,
    };
    set({ devices: next, lastEventAt: Date.now() });
    get().recomputeStats();
  },

  setStats: (stats) => set({ stats }),

  setConnection: (connection) => set({ connection }),

  setLoading: (loading) => set({ loading }),

  setError: (error) => set({ error }),

  recomputeStats: () => {
    const devices = get().devices;
    if (devices.length === 0) {
      // Keep server-provided stats until the device list lands.
      return;
    }
    const online = devices.filter((d) => d.status === "online");
    const fansOn = devices.filter((d) => d.fanStatus === "on").length;
    const avgTemperature =
      online.length > 0
        ? online.reduce((s, d) => s + (d.temperature ?? 0), 0) / online.length
        : 0;
    const avgHumidity =
      online.length > 0
        ? online.reduce((s, d) => s + (d.humidity ?? 0), 0) / online.length
        : 0;
    const lastActivityAt = devices
      .map((d) => d.lastSeenAt)
      .filter(Boolean)
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))[0];

    set({
      stats: {
        totalDevices: devices.length,
        onlineDevices: online.length,
        offlineDevices: devices.length - online.length,
        fansOn,
        fansOff: devices.length - fansOn,
        avgTemperature: Number(avgTemperature.toFixed(1)),
        avgHumidity: Number(avgHumidity.toFixed(1)),
        lastActivityAt: lastActivityAt ?? null,
      },
    });
  },
}));

/** Convenience selector for a single device by id. */
export function selectDeviceById(id: string | null | undefined): DeviceDTO | null {
  if (!id) return null;
  const devices = useIotStore.getState().devices;
  return devices.find((d) => d.id === id) ?? null;
}
