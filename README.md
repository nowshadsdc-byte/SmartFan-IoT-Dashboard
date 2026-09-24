# SmartFan IoT Dashboard

A Next.js dashboard for monitoring and controlling ESP8266/NodeMCU fans. Device data lives in SQLite (Prisma); devices talk to a Socket.IO **IoT hub**; the browser reaches the hub through **Caddy** on the same origin.

```
                         ┌─ /socket.io/?token=…  (ESP8266, no basic auth) ─▶ iot-hub:3003
Everything ──▶ Caddy :5050 ─┼─ /socket.io/* (browser, basic auth, + x-hub-secret) ─▶ iot-hub:3003
                         └─ everything else (basic auth) ─▶ frontend:3000
iot-hub ──▶ SQLite (shared volume)
```

## Deploy to a VPS (Docker Compose)

1. **Clone** the repo on the server and `cd` into it.
2. **Create `.env`** from the template and fill it in:
   ```bash
   cp .env.example .env
   openssl rand -hex 24   # use for DEVICE_TOKEN
   openssl rand -hex 24   # use for HUB_INTERNAL_SECRET
   ```
   `DEVICE_TOKEN` and `HUB_INTERNAL_SECRET` must be at least 16 characters, or the hub refuses to start.
3. **Generate the dashboard password hash** and put it in `.env` as `DASHBOARD_PASSWORD_HASH`:
   ```bash
   docker run --rm -it caddy:2-alpine caddy hash-password
   ```
   Keep the hash in **single quotes** in `.env` (`DASHBOARD_PASSWORD_HASH='$2a$14$…'`) so Compose does not expand the `$` characters. Set `DASHBOARD_USER` too.
4. The whole stack is served on **port 5050** (plain HTTP): `http://<host>:5050`.
5. **Start everything:**
   ```bash
   docker compose up -d --build
   ```
   A one-shot `migrate` service runs `prisma db push` first, so a fresh volume gets its tables automatically.
6. **Open the firewall** for port **5050** — both on the host and in the cloud provider's security group:
   ```bash
   sudo ufw allow 5050/tcp
   ```
   Ports 3000 and 3003 are **not** published; everything goes through Caddy.

| Service | Exposure | Purpose |
| --- | --- | --- |
| `caddy` | **5050 (public)** | Basic auth for the web UI, routes `/socket.io/*` to the hub and the rest to the frontend; device connections (`?token=`) skip basic auth |
| `frontend` | internal `:3000` | Next.js dashboard + REST API |
| `iot-hub` | internal `:3003` | Devices (protected by `DEVICE_TOKEN`) and dashboards (protected by `x-hub-secret`, added by Caddy) |
| `migrate` | one-shot | Creates/updates the SQLite schema |
| `esp-simulator` | profile `dev` only | 4 simulated devices |

All services share the `iot-data` volume (`/app/data/dev.db`, WAL mode).

### Simulator (dev only)

The simulator is not started in production. To run it:

```bash
docker compose --profile dev up -d --build
```

For a single scripted device (no Docker needed, needs `bun`):

```bash
bun scripts/fake-device.ts ws://HOST:5050 <DEVICE_TOKEN> AA:BB:CC:DD:EE:01
```

## Security model

- **Hub sockets must authenticate** (`io.use`): a **device** presents `DEVICE_TOKEN` (`?token=` query or `auth.token`); a **dashboard** presents header `x-hub-secret` = `HUB_INTERNAL_SECRET`, which Caddy adds on browser `/socket.io/*` requests (after basic auth; it strips any client-sent copy from device requests) and the Next.js server sends via `extraHeaders`. Anything else is rejected. Comparison is constant-time.
- Devices may only emit `device:register`, `telemetry`, `command:ack` — and only for the `deviceId` they registered on that socket. Dashboards may only emit `subscribe`, `fan:command`, `device:config:update`. Everything else is ignored and logged.
- All socket payloads and REST bodies are validated (finite numbers in range, length-limited strings, enums); invalid payloads are dropped with a log line.
- The dashboard and REST API are behind Caddy `basic_auth`. Secrets live only in `.env` (git-ignored).

## Device protocol (fixed contract — ESP8266 firmware depends on it)

**Connect** (Socket.IO v4 / EIO=4, websocket transport only, `arduinoWebSockets` `SocketIOclient`):

```text
ws://<VPS_IP>:5050/socket.io/?EIO=4&transport=websocket&token=<DEVICE_TOKEN>
```

The device clock may be wrong: `timestamp` fields from devices are optional/informational; the server uses its own time for storage and `lastSeenAt`.

### Device → hub

**`device:register`** — identified by `macAddress` (upsert):

```json
{ "macAddress": "AA:BB:CC:DD:EE:FF", "name": "fan-4fde0a", "location": "Unknown",
  "firmwareVersion": "1.0.0", "ipAddress": "192.168.0.101" }
```

The hub replies with the same event name `{ "ok": true, "deviceId": "<database id>" }`, immediately followed by `device:config`. (`fan:state` is also still emitted for backward compatibility.) Commands queued while the device was offline are then delivered as `fan:command` events and marked `sent`.

**`telemetry`** — sent every `heartbeatIntervalSec`; also the heartbeat:

```json
{ "deviceId": "<database id>", "temperature": 29.6, "humidity": 79.8,
  "fanStatus": "off", "mode": "auto", "sensorOk": true, "gasLevel": null,
  "rssi": -64, "uptimeSeconds": 120 }
```

If `sensorOk` is `false`, `temperature`/`humidity` may be `null`: no `SensorReading` row is stored, but `lastSeenAt`, `status`, `fanStatus`, `rssi`, `uptimeSeconds`, `sensorOk` are still updated. Telemetry updates `fanStatus` but **never** `mode`, `desiredFanStatus` or the thresholds. Telemetry arriving less than 1 s after the previous one is ignored.

**`command:ack`**

```json
{ "commandId": "<id>", "deviceId": "<database id>", "success": true, "fanStatus": "on", "mode": "manual" }
```

### Hub → device

**`device:config`** — after register, after any config/mode change and after any fan command:

```json
{ "deviceId": "<database id>", "mode": "auto", "desiredFanStatus": "off",
  "tempOn": 32, "tempOff": 30, "heartbeatIntervalSec": 10 }
```

In `manual` mode the device sets the fan to `desiredFanStatus`; in `auto` mode it applies the thresholds with hysteresis itself (so it keeps working when the server is unreachable).

**`fan:command`** — `{ "deviceId": "<database id>", "action": "on" | "off" | "auto", "commandId": "<id>" }`. The device replies with `command:ack`.

### Hub → dashboards

`snapshot`, `telemetry`, `device:status`, `fan:state`, `command:ack`, plus **`device:config`** (same payload as above), broadcast whenever config/mode/desired state changes.

### Heartbeat timeout

A device is marked offline after `max(30 s, 3 × heartbeatIntervalSec)` without telemetry (or immediately on disconnect).

## Dashboard REST API

Requests go through Caddy, so they need basic auth (`curl -u admin:password …`). Replace `<ID>` with a device id from `GET /api/devices`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/devices` | List devices (includes `mode`, `desiredFanStatus`, thresholds, `gasLevel`, `sensorOk`) |
| GET | `/api/devices/<ID>` | Device + latest reading |
| GET | `/api/devices/<ID>/history?range=1h\|6h\|24h\|7d` | Sensor history |
| GET | `/api/devices/<ID>/health` | Health metrics |
| GET | `/api/devices/<ID>/commands?limit=20` | Command log |
| GET | `/api/stats` | Aggregated KPIs |
| **POST** | `/api/devices/<ID>/fan` | Body `{"action":"on"\|"off"\|"auto"}`. `on`/`off` → manual mode + `desiredFanStatus`; `auto` → auto mode. Persisted immediately. **200** `status:"sent"` if delivered to the online device, **202** `status:"queued"` if the device (or the hub) is offline |
| **GET** | `/api/devices/<ID>/config` | `{ config: { deviceId, mode, desiredFanStatus, tempOn, tempOff, heartbeatIntervalSec } }` |
| **PUT** | `/api/devices/<ID>/config` | Body `{ tempOn?, tempOff?, heartbeatIntervalSec? }`. Saved, then pushed to the device as `device:config`. **400** if invalid |

Config rules: `0 <= tempOff < tempOn <= 60`, `tempOn - tempOff >= 1`, `5 <= heartbeatIntervalSec <= 300`.

```bash
curl -u admin:password -X PUT http://HOST:5050/api/devices/<ID>/config \
  -H 'Content-Type: application/json' -d '{"tempOn":34,"tempOff":30}'
```

### Command lifecycle

`queued` → `sent` → `acknowledged` | `failed`. One `CommandLog` row per command. A command still `sent` after 30 s without an ack becomes `failed` (`"no ack"`).

## Housekeeping

- Sensor readings older than 30 days (`READING_RETENTION_DAYS`) are deleted hourly by the hub.
- SQLite runs in WAL mode with a busy timeout in both the hub and the web app.

## Local development (without Docker)

```bash
bun install
cp .env.example .env            # set DATABASE_URL to a local file, IOT_HUB_URL=http://localhost:3003
bun run db:push
bun run dev                     # dashboard on :3000

cd mini-services/iot-hub && bun install && bunx prisma generate --schema ../../prisma/schema.prisma
DEVICE_TOKEN=… HUB_INTERNAL_SECRET=… DATABASE_URL=… bun run dev      # hub on :3003
```

Locally there is no Caddy, so the browser's same-origin `/socket.io/` path is not proxied to the hub; use `docker compose` for the full stack, or add a `next.config.ts` rewrite for development.
