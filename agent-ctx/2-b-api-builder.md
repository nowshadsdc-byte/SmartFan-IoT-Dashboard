# Task 2-b — Next.js API routes (api-builder)

## Scope
Built all Next.js 16 App Router route handlers under `src/app/api/` for the
Smart Fan Monitoring IoT platform.

## Files created (all in main Next.js project at `/home/z/my-project`)
- `src/lib/iot-hub-client.ts` — DTO mappers + `forwardFanCommand` helper
- `src/app/api/stats/route.ts` — `GET /api/stats`
- `src/app/api/devices/route.ts` — `GET /api/devices`
- `src/app/api/devices/[id]/route.ts` — `GET /api/devices/[id]`
- `src/app/api/devices/[id]/history/route.ts` — `GET /api/devices/[id]/history?range=`
- `src/app/api/devices/[id]/fan/route.ts` — `POST /api/devices/[id]/fan`
- `src/app/api/devices/[id]/health/route.ts` — `GET /api/devices/[id]/health`
- `src/app/api/devices/[id]/commands/route.ts` — `GET /api/devices/[id]/commands?limit=`

## Key implementation notes
- All route handlers use the Next 16 async params signature:
  `{ params }: { params: Promise<{ id: string }> }` then `await params`.
- DTOs typed against `src/lib/iot-contracts.ts` (`DeviceDTO`, `SensorReadingDTO`,
  `CommandLogDTO`, `FanCommandPayload`, `IoTEvents`). Date fields converted to
  ISO strings via shared mappers in `iot-hub-client.ts`.
- `POST /api/devices/[id]/fan`:
  - Generates `commandId = crypto.randomUUID()`.
  - Creates `CommandLog` row with `status="pending"`, `source="dashboard"`.
  - Calls `forwardFanCommand(...)` (helper). On success → updates row to
    `status="sent"`, returns 200 with `{ commandId, deviceId, action,
    status: "sent", createdAt }`. On hub unreachable → updates row to
    `status="failed"` + `error="hub unreachable"`, returns 503 with the
    same body but `status: "failed"`.
  - Bad action body → 400 `{ error: "invalid_action" }`.
- `forwardFanCommand` (in `src/lib/iot-hub-client.ts`):
  - `io("http://localhost:3003", { path: "/", reconnection: false,
    timeout: 800, transports: ["websocket"], forceNew: true })`.
  - On `connect`: emits `fan:command` then disconnects after 500ms (success).
  - Hard 800ms timeout / `connect_error` / `error` → resolve `{ ok: false,
    error: "hub unreachable" }`. Never blocks the API longer than 800ms.

## Verification
- `bun run lint` → clean (no errors/warnings).
- `curl /api/stats` → 200 `{totalDevices:0,onlineDevices:0,offlineDevices:0,fansOn:0,fansOff:0,avgTemperature:0,avgHumidity:0,lastActivityAt:null}`.
- `curl /api/devices` → 200 `{devices:[]}`.
- 404 paths for nonexistent device on detail/history/health/commands/fan → all return 404 `{error:"device_not_found"}`.
- Bad action POST → 400 `{error:"invalid_action",message:'action must be "on" or "off"'}`.

## Status
Complete. No blockers. Happy-path POST fan command + populated history will be
exercised once the ESP8266 simulator registers devices via the IoT hub.
