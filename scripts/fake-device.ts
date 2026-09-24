// Fake ESP8266 for testing the hub without hardware.
//
//   bun scripts/fake-device.ts ws://HOST:3003 <DEVICE_TOKEN> AA:BB:CC:DD:EE:01
//
// Behaves like the real firmware: websocket-only Socket.IO (EIO=4), token in the
// query string, register → receive device:config → telemetry every heartbeatIntervalSec,
// handles fan:command (ack + mode change), and runs auto mode locally with hysteresis.

import { io } from "socket.io-client";

const [, , hubUrl, token, mac] = process.argv;
if (!hubUrl || !token || !mac) {
  console.error("Usage: bun scripts/fake-device.ts ws://HOST:3003 <DEVICE_TOKEN> AA:BB:CC:DD:EE:01");
  process.exit(1);
}

type Fan = "on" | "off";
type Mode = "auto" | "manual";

let deviceId: string | null = null;
let mode: Mode = "auto";
let desired: Fan = "off";
let tempOn = 32;
let tempOff = 30;
let heartbeatSec = 10;
let fan: Fan = "off";
let temperature = 29.5;
let humidity = 60;
const bootedAt = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// path defaults to "/socket.io/"; the token goes in the query string like on the ESP8266
const socket = io(hubUrl.replace(/^ws/, "http"), {
  transports: ["websocket"],
  query: { token },
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});

/** Same rule the firmware applies: manual → desired state; auto → thresholds with hysteresis. */
function control() {
  if (mode === "manual") fan = desired;
  else if (temperature >= tempOn) fan = "on";
  else if (temperature <= tempOff) fan = "off";
}

function sendTelemetry() {
  if (!deviceId || !socket.connected) return;
  // fake physics: warm up slowly, cool down while the fan runs
  temperature += fan === "on" ? -0.4 : 0.3;
  temperature += (Math.random() - 0.5) * 0.4;
  humidity = Math.min(95, Math.max(20, humidity + (Math.random() - 0.5) * 2));
  control();
  socket.emit("telemetry", {
    deviceId,
    temperature: Number(temperature.toFixed(1)),
    humidity: Number(humidity.toFixed(1)),
    fanStatus: fan,
    mode,
    sensorOk: true,
    gasLevel: null,
    rssi: -60 - Math.floor(Math.random() * 10),
    uptimeSeconds: Math.floor((Date.now() - bootedAt) / 1000),
  });
  log(`telemetry T=${temperature.toFixed(1)} fan=${fan} mode=${mode}`);
}

function restartTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(sendTelemetry, heartbeatSec * 1000);
}

socket.on("connect", () => {
  log("connected, registering", mac);
  socket.emit("device:register", {
    macAddress: mac,
    name: `fake-${mac.slice(-5).replace(":", "")}`,
    location: "Test bench",
    firmwareVersion: "fake-1.0.0",
    ipAddress: "127.0.0.1",
  });
});

socket.on("device:register", (ack: { ok: boolean; deviceId?: string }) => {
  if (ack?.ok && ack.deviceId) {
    deviceId = ack.deviceId;
    log("registered, deviceId =", deviceId);
  }
});

socket.on("device:config", (cfg) => {
  log("device:config", JSON.stringify(cfg));
  mode = cfg.mode;
  desired = cfg.desiredFanStatus;
  tempOn = cfg.tempOn;
  tempOff = cfg.tempOff;
  const changed = cfg.heartbeatIntervalSec !== heartbeatSec || !timer;
  heartbeatSec = cfg.heartbeatIntervalSec;
  control();
  if (changed) {
    restartTimer();
    sendTelemetry(); // first telemetry right after config
  }
});

socket.on("fan:command", (cmd) => {
  log("fan:command", JSON.stringify(cmd));
  if (cmd.action === "auto") mode = "auto";
  else if (cmd.action === "on" || cmd.action === "off") {
    mode = "manual";
    desired = cmd.action;
  }
  control();
  socket.emit("command:ack", { commandId: cmd.commandId, deviceId, success: true, fanStatus: fan, mode });
});

socket.on("fan:state", () => {}); // legacy, ignored
socket.on("disconnect", (reason) => log("disconnected:", reason));
socket.on("connect_error", (err) => log("connect_error:", err.message));

process.on("SIGINT", () => {
  socket.disconnect();
  process.exit(0);
});
