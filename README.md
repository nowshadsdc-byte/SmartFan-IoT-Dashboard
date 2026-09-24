# SmartFan IoT Dashboard

SmartFan IoT is a Next.js dashboard for monitoring ESP8266/NodeMCU fans. It stores device data in SQLite and communicates with devices through the Socket.IO IoT hub.

## Run With Docker

```powershell
docker compose up --build -d
```

Dashboard URL:

```text
http://localhost:3000
```

Stop the application:

```powershell
docker compose down
```

The SQLite database is stored in the persistent Docker volume `frontend_iot-data`.

## Services

| Service | Address | Purpose |
| --- | --- | --- |
| Next.js dashboard/API | `http://localhost:3000` | Web UI and REST API |
| IoT hub | `http://localhost:3003` | Socket.IO gateway for devices |
| ESP simulator health server | `http://localhost:3004` | Simulator status only |

The current `docker-compose.yml` starts the dashboard only. The IoT hub and ESP simulator must be started separately for live device communication.

## Dashboard REST API

Replace `<DEVICE_ID>` with the database device ID returned by `device:register` or `GET /api/devices`.

### List devices

```http
GET http://localhost:3000/api/devices
```

Returns all devices ordered by name.

### Get device details

```http
GET http://localhost:3000/api/devices/<DEVICE_ID>
```

### Get sensor history

```http
GET http://localhost:3000/api/devices/<DEVICE_ID>/history?range=1h
```

Supported ranges are `1h`, `6h`, `24h`, and `7d`.

### Get device health

```http
GET http://localhost:3000/api/devices/<DEVICE_ID>/health
```

### Get command history

```http
GET http://localhost:3000/api/devices/<DEVICE_ID>/commands?limit=20
```

### Get dashboard statistics

```http
GET http://localhost:3000/api/stats
```

The response includes `avgTemperature` and `avgHumidity`. These values are calculated from the latest readings of online devices only.

Example response:

```json
{
  "totalDevices": 1,
  "onlineDevices": 1,
  "offlineDevices": 0,
  "fansOn": 0,
  "fansOff": 1,
  "avgTemperature": 27.35,
  "avgHumidity": 58.42,
  "lastActivityAt": "2026-09-24T12:30:00.000Z"
}
```

### Control a fan

```http
POST http://localhost:3000/api/devices/<DEVICE_ID>/fan
Content-Type: application/json
```

Request body:

```json
{
  "action": "on"
}
```

The `action` value must be `on` or `off`. This endpoint forwards the command to the IoT hub and returns `503 hub unreachable` when the hub is unavailable.

PowerShell example:

```powershell
Invoke-RestMethod `
  -Uri "http://localhost:3000/api/devices/<DEVICE_ID>/fan" `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"action":"on"}'
```

## NodeMCU Socket.IO Protocol

The NodeMCU connects to the IoT hub, not directly to the Next.js dashboard:

```text
http://<SERVER_IP>:3003
```

For example, if the hub runs on a computer at `192.168.1.100`:

```text
http://192.168.1.100:3003
```

The Socket.IO path is `/socket.io/` and the preferred transport is WebSocket.

### 1. Register the device

After connecting, emit `device:register`:

```json
{
  "deviceId": "esp8266-001",
  "name": "Living Room Fan",
  "macAddress": "AA:BB:CC:DD:EE:01",
  "location": "Living Room",
  "firmwareVersion": "1.0.0",
  "ipAddress": "192.168.1.50"
}
```

The hub replies on `device:register`:

```json
{
  "ok": true,
  "deviceId": "database-generated-device-id"
}
```

Use the returned `deviceId` for telemetry and command acknowledgements. The device is identified and upserted by `macAddress`.

### 2. Send telemetry

Emit `telemetry` about every five seconds:

```json
{
  "deviceId": "database-generated-device-id",
  "temperature": 27.35,
  "humidity": 58.42,
  "fanStatus": "off",
  "rssi": -60,
  "uptimeSeconds": 120,
  "timestamp": "2026-09-24T12:30:00.000Z"
}
```

The hub persists the reading, updates the current device state, and broadcasts telemetry to dashboard clients.

### 3. Receive fan commands

Listen for `fan:command`:

```json
{
  "deviceId": "database-generated-device-id",
  "action": "on",
  "commandId": "unique-command-id"
}
```

Set the physical fan state according to `action`, then acknowledge the command.

### 4. Acknowledge a fan command

Emit `command:ack`:

```json
{
  "commandId": "unique-command-id",
  "deviceId": "database-generated-device-id",
  "success": true,
  "fanStatus": "on",
  "timestamp": "2026-09-24T12:30:00.000Z"
}
```

The hub updates the command log and broadcasts the acknowledgement to dashboard clients.

### 5. Receive the current fan state

The hub may send `fan:state` after registration or when the desired state changes:

```json
{
  "deviceId": "database-generated-device-id",
  "fanStatus": "off",
  "timestamp": "2026-09-24T12:30:00.000Z"
}
```

## Socket.IO Event Summary

| Direction | Event | Purpose |
| --- | --- | --- |
| NodeMCU -> hub | `device:register` | Register or reconnect a device |
| NodeMCU -> hub | `telemetry` | Send temperature, humidity, fan state, RSSI, and uptime |
| NodeMCU -> hub | `command:ack` | Confirm a fan command |
| Hub -> NodeMCU | `fan:command` | Request fan `on` or `off` |
| Hub -> NodeMCU | `fan:state` | Send the current desired fan state |
| Hub -> dashboard | `telemetry` | Broadcast live telemetry |
| Hub -> dashboard | `device:status` | Broadcast online/offline status |
| Hub -> dashboard | `fan:state` | Broadcast fan state changes |
| Hub -> dashboard | `command:ack` | Broadcast command results |

## Start the IoT Services Locally

Run the hub and simulator in separate terminals:

```powershell
cd mini-services/iot-hub
bun install
bun run dev
```

```powershell
cd mini-services/esp-simulator
bun install
bun run dev
```

The simulator connects to `http://localhost:3003`, registers simulated devices, and sends telemetry automatically.