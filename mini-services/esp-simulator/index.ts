// ESP8266 Device Simulator — Smart Fan Monitoring platform
//
// Spawns 4 simulated ESP8266 devices, each a socket.io-client that connects
// directly to the local IoT hub (server-to-server, NOT through Caddy).
// Each device registers itself, then sends telemetry every 5s. It listens
// for `fan:command` events and acks them. While a fan is ON, the simulated
// temperature drops slowly toward a floor; while OFF, drifts back toward base.
//
// Every ~90s, one random device goes offline for 15s to demonstrate
// online/offline transitions.

import { io, Socket } from "socket.io-client";
import { createServer } from "http";

const HUB_URL = "http://localhost:3003";
const SOCKET_PATH = "/";

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

interface SimulatedDevice {
  config: DeviceConfig;
  socket: Socket | null;
  deviceId: string | null; // assigned by the hub on register
  fanStatus: FanStatus;
  temperature: number;
  humidity: number;
  rssi: number;
  uptimeSeconds: number;
  lastTelemetryAt: number;
  registerSeq: number; // incremented each time we register
  intentionallyOffline: boolean; // when simulating a brief outage
  telemetryTimer: ReturnType<typeof setInterval> | null;
}

function createSimulatedDevice(config: DeviceConfig): SimulatedDevice {
  return {
    config,
    socket: null,
    deviceId: null,
    fanStatus: "off",
    temperature: config.baseTemperature,
    humidity: config.baseHumidity,
    rssi: -55,
    uptimeSeconds: 0,
    lastTelemetryAt: 0,
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

function makeCommandId() {
  // unique enough
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 8)
  );
}

// ---------------------------------------------------------------------------
// Telemetry computation
// ---------------------------------------------------------------------------

function stepTelemetry(d: SimulatedDevice) {
  // Cooling effect when fan is ON; drift toward base when OFF
  if (d.fanStatus === "on") {
    // cool down toward floor (base - 4°C)
    const floor = d.config.baseTemperature - 4;
    if (d.temperature > floor) {
      d.temperature = clamp(d.temperature - 0.3, floor, 40);
    }
  } else {
    // drift back toward base
    if (d.temperature < d.config.baseTemperature) {
      d.temperature = clamp(d.temperature + 0.2, 10, d.config.baseTemperature + 1);
    } else if (d.temperature > d.config.baseTemperature) {
      d.temperature = clamp(d.temperature - 0.1, d.config.baseTemperature - 1, 40);
    }
  }
  // small random walk on top
  d.temperature = clamp(randomWalk(d.temperature, 0.5, 10, 40), 10, 40);
  // humidity drift
  d.humidity = clamp(randomWalk(d.humidity, 2, 20, 90), 20, 90);
  d.rssi = randomRssi();
  d.uptimeSeconds += 5;
}

// ---------------------------------------------------------------------------
// Connection lifecycle
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

  const socket = io(HUB_URL, {
    path: SOCKET_PATH,
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
    // Register device
    const payload = {
      deviceId: d.deviceId ?? d.config.macAddress, // hub will return the real id
      name: d.config.name,
      macAddress: d.config.macAddress,
      location: d.config.location,
      firmwareVersion: d.config.firmwareVersion,
      ipAddress: d.config.ipAddress,
    };
    socket.emit("device:register", payload);
  });

  socket.on("device:register", (ack: any) => {
    // Guard against late events from a previous socket instance
    if (mySeq !== d.registerSeq) return;
    if (ack && ack.ok && ack.deviceId) {
      d.deviceId = ack.deviceId;
      console.log(`[sim] ${d.config.name} registered as deviceId=${d.deviceId}`);
      // start telemetry timer
      if (d.telemetryTimer) clearInterval(d.telemetryTimer);
      // send one immediately
      sendTelemetry(d);
      d.telemetryTimer = setInterval(() => sendTelemetry(d), 5000);
    }
  });

  socket.on("fan:state", (payload: any) => {
    if (mySeq !== d.registerSeq) return;
    if (payload && payload.deviceId === d.deviceId && payload.fanStatus) {
      // sync local state with hub's desired state (e.g., on reconnect)
      if (d.fanStatus !== payload.fanStatus) {
        d.fanStatus = payload.fanStatus;
        console.log(
          `[sim] ${d.config.name} fan synced from hub: ${payload.fanStatus}`
        );
      }
    }
  });

  socket.on("fan:command", (payload: any) => {
    if (mySeq !== d.registerSeq) return;
    if (!payload) return;
    // Update local fan state
    d.fanStatus = payload.action === "on" ? "on" : "off";
    console.log(
      `[sim] ${d.config.name} received fan:command action=${payload.action} cmd=${payload.commandId}`
    );
    // Ack
    const ack = {
      commandId: payload.commandId,
      deviceId: d.deviceId,
      success: true,
      fanStatus: d.fanStatus,
      timestamp: new Date().toISOString(),
    };
    socket.emit("command:ack", ack);
  });

  socket.on("disconnect", (reason: string) => {
    console.log(`[sim] ${d.config.name} disconnected: ${reason}`);
    if (d.telemetryTimer) {
      clearInterval(d.telemetryTimer);
      d.telemetryTimer = null;
    }
  });

  socket.on("connect_error", (err: Error) => {
    // quiet log to avoid spam during hub restarts
    console.warn(`[sim] ${d.config.name} connect_error: ${err.message}`);
  });
}

function sendTelemetry(d: SimulatedDevice) {
  if (!d.socket || !d.socket.connected || !d.deviceId) return;
  if (d.intentionallyOffline) return;
  stepTelemetry(d);
  const payload = {
    deviceId: d.deviceId,
    temperature: parseFloat(d.temperature.toFixed(2)),
    humidity: parseFloat(d.humidity.toFixed(1)),
    fanStatus: d.fanStatus,
    rssi: d.rssi,
    uptimeSeconds: d.uptimeSeconds,
    timestamp: new Date().toISOString(),
  };
  d.lastTelemetryAt = Date.now();
  d.socket.emit("telemetry", payload);
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
