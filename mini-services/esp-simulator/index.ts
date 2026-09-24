// ESP8266 Device Simulator — Smart Fan Monitoring platform
//
// Spawns 4 simulated ESP8266 devices that speak the SAME protocol as the real firmware:
// websocket-only Socket.IO, device token in the query string, register → device:config →
// telemetry every heartbeatIntervalSec, fan:command + command:ack, and local auto-mode
// control with hysteresis. Dev/test client only — production runs no simulator.
//
// Env: HUB_URL (default http://localhost:3003), DEVICE_TOKEN (required).
//
// Every ~90s, one random device goes offline for 15s to demonstrate
// online/offline transitions.

import { io, Socket } from "socket.io-client";
import { createServer } from "http";

const HUB_URL = process.env.HUB_URL ?? "http://localhost:3003";
const DEVICE_TOKEN = process.env.DEVICE_TOKEN ?? "";
if (!DEVICE_TOKEN) {
  console.error("[sim] DEVICE_TOKEN env var is required");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Device definitions
// ---------------------------------------------------------------------------

interface DeviceConfig {
  name: string;
  macAddress: string;
  location: string;
  baseTemperature: number; // °C
  baseHumidity: number; // %
  firmwareVersion: string;
  ipAddress: string; // reported to the hub on device:register
}

const DEVICE_CONFIGS: DeviceConfig[] = [
  {
    name: "Fan-LivingRoom-01",
    macAddress: "A1:B2:C3:D4:E5:01",
    location: "Living Room",
    baseTemperature: 24,
    baseHumidity: 50,
    firmwareVersion: "1.2.0",
    ipAddress: "192.168.1.11",
  },
  {
    name: "Fan-Bedroom-02",
    macAddress: "A1:B2:C3:D4:E5:02",
    location: "Bedroom",
    baseTemperature: 22,
    baseHumidity: 45,
    firmwareVersion: "1.2.0",
    ipAddress: "192.168.1.12",
  },
  {
    name: "Fan-Kitchen-03",
    macAddress: "A1:B2:C3:D4:E5:03",
    location: "Kitchen",
    baseTemperature: 28,
    baseHumidity: 60,
    firmwareVersion: "1.1.5",
    ipAddress: "192.168.1.13",
  },
  {
    name: "Fan-Garage-04",
    macAddress: "A1:B2:C3:D4:E5:04",
    location: "Garage",
    baseTemperature: 18,
    baseHumidity: 70,
    firmwareVersion: "1.1.5",
    ipAddress: "192.168.1.14",
  },
];

// ---------------------------------------------------------------------------
// Simulated device state machine
// ---------------------------------------------------------------------------

type FanStatus = "on" | "off";
type Mode = "auto" | "manual";

interface SimulatedDevice {
  config: DeviceConfig;
  socket: Socket | null;
  deviceId: string | null; // assigned by the hub on register
  // server-owned config, received via device:config
  mode: Mode;
  desiredFanStatus: FanStatus;
  tempOn: number;
  tempOff: number;
  heartbeatIntervalSec: number;
  // actual state
  fanStatus: FanStatus;
  temperature: number;
  humidity: number;
  rssi: number;
  uptimeSeconds: number;
  registerSeq: number; // incremented each time we connect
  intentionallyOffline: boolean; // when simulating a brief outage
  telemetryTimer: ReturnType<typeof setInterval> | null;
}

function createSimulatedDevice(config: DeviceConfig): SimulatedDevice {
  return {
    config,
    socket: null,
    deviceId: null,
    mode: "auto",
    desiredFanStatus: "off",
    tempOn: 32,
    tempOff: 30,
    heartbeatIntervalSec: 10,
    fanStatus: "off",
    temperature: config.baseTemperature,
    humidity: config.baseHumidity,
    rssi: -55,
    uptimeSeconds: 0,
    registerSeq: 0,
    intentionallyOffline: false,
    telemetryTimer: null,
  };
}

const devices: SimulatedDevice[] = DEVICE_CONFIGS.map(createSimulatedDevice);

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

function randomWalk(current: number, step: number, min: number, max: number) {
  const delta = (Math.random() - 0.5) * 2 * step;
  return clamp(current + delta, min, max);
}

function randomRssi() {
  // -40 (strong) to -75 (weak)
  return -Math.floor(40 + Math.random() * 35);
}

// ---------------------------------------------------------------------------
// Physics + on-device control logic
// ---------------------------------------------------------------------------

/** What the firmware does on its own: manual → follow desired state, auto → thresholds with hysteresis. */
function applyControl(d: SimulatedDevice) {
  if (d.mode === "manual") {
    d.fanStatus = d.desiredFanStatus;
  } else if (d.temperature >= d.tempOn) {
    d.fanStatus = "on";
  } else if (d.temperature <= d.tempOff) {
    d.fanStatus = "off";
  }
}

function stepTelemetry(d: SimulatedDevice, dtSec: number) {
  // The room warms toward ambient (base + 5°C); a running fan cools it ~0.1°C/s.
  const ambient = d.config.baseTemperature + 5;
  const drift = d.fanStatus === "on" ? -0.1 * dtSec : Math.sign(ambient - d.temperature) * 0.05 * dtSec;
  d.temperature = clamp(randomWalk(d.temperature + drift, 0.3, 10, 45), 10, 45);
  d.humidity = clamp(randomWalk(d.humidity, 2, 20, 90), 20, 90);
  d.rssi = randomRssi();
  d.uptimeSeconds += dtSec;
  applyControl(d);
}

// ---------------------------------------------------------------------------
// Socket connection (mirrors the real ESP8266 firmware)
// ---------------------------------------------------------------------------

function connectDevice(d: SimulatedDevice) {
  if (d.socket) {
    try {
      d.socket.disconnect();
    } catch {
      // ignore
    }
    d.socket = null;
  }

  // websocket only, token in the query string — exactly like arduinoWebSockets SocketIOclient
  const socket = io(HUB_URL, {
    query: { token: DEVICE_TOKEN },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 5000,
    transports: ["websocket"],
  });
  d.socket = socket;
  d.registerSeq += 1;
  const mySeq = d.registerSeq;

  socket.on("connect", () => {
    console.log(`[sim] ${d.config.name} connected (socket=${socket.id})`);
    socket.emit("device:register", {
      macAddress: d.config.macAddress,
      name: d.config.name,
      location: d.config.location,
      firmwareVersion: d.config.firmwareVersion,
      ipAddress: d.config.ipAddress,
    });
  });

  socket.on("device:register", (ack: any) => {
    if (mySeq !== d.registerSeq) return;
    if (ack && ack.ok && ack.deviceId) {
      d.deviceId = ack.deviceId;
      console.log(`[sim] ${d.config.name} registered as deviceId=${d.deviceId}`);
    }
  });

  // Server-owned config: mode, desired fan state, thresholds, heartbeat interval.
  socket.on("device:config", (cfg: any) => {
    if (mySeq !== d.registerSeq || !cfg || cfg.deviceId !== d.deviceId) return;
    d.mode = cfg.mode === "manual" ? "manual" : "auto";
    d.desiredFanStatus = cfg.desiredFanStatus === "on" ? "on" : "off";
    d.tempOn = cfg.tempOn;
    d.tempOff = cfg.tempOff;
    const intervalChanged = d.heartbeatIntervalSec !== cfg.heartbeatIntervalSec || !d.telemetryTimer;
    d.heartbeatIntervalSec = cfg.heartbeatIntervalSec;
    console.log(
      `[sim] ${d.config.name} config: mode=${d.mode} desired=${d.desiredFanStatus} on>=${d.tempOn} off<=${d.tempOff} hb=${d.heartbeatIntervalSec}s`
    );
    applyControl(d);
    if (intervalChanged) startTelemetry(d);
  });

  // Legacy event, ignored by this firmware: device:config carries everything.
  socket.on("fan:state", () => {});

  socket.on("fan:command", (payload: any) => {
    if (mySeq !== d.registerSeq || !payload) return;
    if (payload.action === "auto") {
      d.mode = "auto";
    } else if (payload.action === "on" || payload.action === "off") {
      d.mode = "manual";
      d.desiredFanStatus = payload.action;
    } else {
      return;
    }
    applyControl(d);
    console.log(
      `[sim] ${d.config.name} received fan:command action=${payload.action} cmd=${payload.commandId}`
    );
    socket.emit("command:ack", {
      commandId: payload.commandId,
      deviceId: d.deviceId,
      success: true,
      fanStatus: d.fanStatus,
      mode: d.mode,
    });
  });

  socket.on("disconnect", (reason: string) => {
    console.log(`[sim] ${d.config.name} disconnected: ${reason}`);
    if (d.telemetryTimer) {
      clearInterval(d.telemetryTimer);
      d.telemetryTimer = null;
    }
  });

  socket.on("connect_error", (err: Error) => {
    console.warn(`[sim] ${d.config.name} connect_error: ${err.message}`);
  });
}

function startTelemetry(d: SimulatedDevice) {
  if (d.telemetryTimer) clearInterval(d.telemetryTimer);
  sendTelemetry(d);
  d.telemetryTimer = setInterval(() => sendTelemetry(d), d.heartbeatIntervalSec * 1000);
}

function sendTelemetry(d: SimulatedDevice) {
  if (!d.socket || !d.socket.connected || !d.deviceId) return;
  if (d.intentionallyOffline) return;
  stepTelemetry(d, d.heartbeatIntervalSec);
  d.socket.emit("telemetry", {
    deviceId: d.deviceId,
    temperature: parseFloat(d.temperature.toFixed(2)),
    humidity: parseFloat(d.humidity.toFixed(1)),
    fanStatus: d.fanStatus,
    mode: d.mode,
    sensorOk: true,
    gasLevel: null,
    rssi: d.rssi,
    uptimeSeconds: Math.floor(d.uptimeSeconds),
  });
}

// ---------------------------------------------------------------------------
// Optional: simulate one device going offline briefly every ~90s
// ---------------------------------------------------------------------------

let outageTimer: ReturnType<typeof setInterval> | null = null;

function scheduleRandomOutage() {
  outageTimer = setInterval(() => {
    const d = devices[Math.floor(Math.random() * devices.length)];
    if (!d.socket || !d.socket.connected) return; // already disconnected
    d.intentionallyOffline = true;
    console.log(
      `[sim] ${d.config.name} simulating brief offline for 15s (dashboard demo)`
    );
    // stop sending telemetry + drop the socket so the hub marks offline
    if (d.telemetryTimer) {
      clearInterval(d.telemetryTimer);
      d.telemetryTimer = null;
    }
    try {
      d.socket.disconnect();
    } catch {
      // ignore
    }
    // bring it back after 15s
    setTimeout(() => {
      d.intentionallyOffline = false;
      console.log(`[sim] ${d.config.name} coming back online`);
      connectDevice(d);
    }, 15_000);
  }, 90_000);
}

// ---------------------------------------------------------------------------
// Tiny health HTTP server (port 3004) — useful for sanity checks
// ---------------------------------------------------------------------------

const PORT = 3004;
const healthServer = createServer((_req, res) => {
  const summary = devices.map((d) => ({
    name: d.config.name,
    macAddress: d.config.macAddress,
    location: d.config.location,
    ipAddress: d.config.ipAddress,
    deviceId: d.deviceId,
    connected: !!(d.socket && d.socket.connected),
    fanStatus: d.fanStatus,
    mode: d.mode,
    temperature: parseFloat(d.temperature.toFixed(2)),
    humidity: parseFloat(d.humidity.toFixed(1)),
    rssi: d.rssi,
    uptimeSeconds: d.uptimeSeconds,
  }));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, service: "esp-simulator", port: PORT, devices: summary }));
});

healthServer.listen(PORT, () => {
  console.log(`ESP8266 simulator health server on port ${PORT}`);
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

for (const d of devices) {
  connectDevice(d);
}

scheduleRandomOutage();

console.log(`ESP8266 simulator started with ${devices.length} devices → hub ${HUB_URL}`);

// Graceful shutdown
function shutdown(signal: string) {
  console.log(`[sim] received ${signal}, shutting down...`);
  if (outageTimer) clearInterval(outageTimer);
  for (const d of devices) {
    if (d.telemetryTimer) clearInterval(d.telemetryTimer);
    if (d.socket) {
      try {
        d.socket.disconnect();
      } catch {
        // ignore
      }
    }
  }
  healthServer.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
