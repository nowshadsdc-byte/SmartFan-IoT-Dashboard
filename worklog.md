# Smart Fan Monitoring and Remote Control Platform - Worklog

This file tracks all work done by the main assistant and subagents.

## Project Overview
A web-based IoT platform to monitor and remotely control fans attached to ESP8266 devices.
Features: device list, online/offline status, fan ON/OFF status, real-time temp/humidity,
remote fan ON/OFF control, last-seen, sensor history, connection info, device health.

## Architecture
- **Frontend**: Next.js 16 page at `/` - dashboard with cards, charts, fan controls, WS for live updates
- **API routes** (Next.js, port 3000 via gateway):
  - `GET  /api/devices` - list devices
  - `GET  /api/devices/[id]` - device detail + latest reading
  - `GET  /api/devices/[id]/history?range=...` - sensor history
  - `POST /api/devices/[id]/fan` - turn fan ON/OFF (body: `{ action: "on" | "off" }`)
  - `GET  /api/devices/[id]/health` - device health metrics
  - `GET  /api/stats` - global stats for header
- **WebSocket mini-service** (port 3003, `mini-services/iot-hub`):
  - Receives telemetry from devices, broadcasts to dashboard clients
  - Receives fan-control commands from dashboard, forwards to the target device socket
  - Stores telemetry into the SQLite DB via Prisma
  - Events (device → hub): `telemetry`, `device:register`, `command:ack`
  - Events (dashboard → hub): `subscribe`, `fan:command`
  - Events (hub → dashboard): `telemetry`, `device:status`, `fan:state`, `command:ack`
  - Events (hub → device): `fan:command`
- **ESP8266 simulator mini-service** (port 3004, `mini-services/esp-simulator`):
  - Spawns N simulated ESP8266 devices that connect to the IoT hub via socket.io
  - Periodically sends temperature/humidity telemetry
  - Listens for `fan:command` and acknowledges with `command:ack` + state change
- **Database**: Prisma + SQLite. Models: Device, SensorReading, CommandLog

## Shared event/data contracts
- Device object: `{ id, name, macAddress, location, status: "online"|"offline", fanStatus: "on"|"off", temperature, humidity, lastSeenAt, rssi, firmwareVersion, ipAddress, uptimeSeconds }`
- Telemetry payload (device → hub): `{ deviceId, temperature, humidity, fanStatus, rssi, uptimeSeconds, timestamp }`
- Fan command (dashboard → hub → device): `{ deviceId, action: "on"|"off", commandId }`
- Command ack (device → hub → dashboard): `{ commandId, deviceId, success, fanStatus, timestamp }`


---

## Task 2-b — Next.js API routes (agent: api-builder)

### Scope
Built all Next.js 16 App Router route handlers under `src/app/api/` for the
Smart Fan Monitoring platform. All responses are JSON via `NextResponse.json`,
all Date fields are converted to ISO strings, all DB calls wrapped in try/catch
with 500 fallback.

### Files created
- `src/lib/iot-hub-client.ts` — shared helpers:
  - `toDeviceDTO`, `toSensorReadingDTO`, `toCommandLogDTO` mappers
    (Prisma row → ISO-string DTO, with strict enum coercion).
  - `forwardFanCommand(payload)` — fire-and-forget socket.io-client
    connection to `http://localhost:3003` (path `/`, websocket transport),
    emits `fan:command`, disconnects after 500ms on success, hard 800ms
    timeout on failure. Resolves `{ ok, error? }`. Never blocks the API
    longer than 800ms.
- `src/app/api/stats/route.ts` — `GET /api/stats` → global counts/averages.
  Averages computed over online devices only (0 fallback). `lastActivityAt`
  = max `lastSeenAt` across all devices, or null.
- `src/app/api/devices/route.ts` — `GET /api/devices` → all devices
  ordered by `name ASC`, mapped to `DeviceDTO[]`.
- `src/app/api/devices/[id]/route.ts` — `GET /api/devices/[id]` →
  `{ device: DeviceDTO, latestReading: SensorReadingDTO | null }`, 404 if
  missing. Uses Next 16 `params: Promise<{id}>` (awaited).
- `src/app/api/devices/[id]/history/route.ts` —
  `GET /api/devices/[id]/history?range=1h|6h|24h|7d`. Default 1h. Cap 500
  points; if more, downsample by taking every Nth (step =
  ceil(len/500)). Ordered by `createdAt ASC`. 404 if device missing.
- `src/app/api/devices/[id]/fan/route.ts` — `POST /api/devices/[id]/fan`
  body `{ action: "on" | "off" }`. Validates device (404). Generates
  `commandId = crypto.randomUUID()`. Creates `CommandLog` with
  `status="pending"`, `source="dashboard"`. Forwards to hub via helper. On
  success: updates to `status="sent"`, returns 200 with `{ commandId,
  deviceId, action, status: "sent", createdAt }`. On hub unreachable:
  updates to `status="failed"` + `error="hub unreachable"`, returns 503
  with the same body but `status: "failed"`. Bad action body → 400.
- `src/app/api/devices/[id]/health/route.ts` —
  `GET /api/devices/[id]/health` → `{ device, health: { status,
  lastSeenAgoSeconds, signalQuality, uptimeSeconds, firmwareVersion,
  ipAddress, recentReadingsCount, avgRssi, message } }`.
  `signalQuality` mapped from rssi: >=−50 excellent, −50..−60 good,
  −60..−70 fair, else poor. `recentReadingsCount`/`avgRssi` over last 1h.
  `status` = online | stale | offline with friendly `message`.
- `src/app/api/devices/[id]/commands/route.ts` —
  `GET /api/devices/[id]/commands?limit=20` → recent `CommandLogDTO[]`,
  `createdAt DESC`, limit 20 (clamp 1..100, default 20). 404 if missing.

### Conventions used
- `import { db } from "@/lib/db"` everywhere.
- `NextResponse` from `next/server`.
- Route params use the Next 16 async signature: `{ params }: { params: Promise<{ id: string }> }` then `await params`.
- DTOs typed against `src/lib/iot-contracts.ts` (`DeviceDTO`, `SensorReadingDTO`, `CommandLogDTO`, `FanCommandPayload`, `IoTEvents`).
- DB errors logged via `console.error` with route tag, return `{ error: "internal_error" }` 500.
- 404 body: `{ error: "device_not_found" }`.
- No tests written. `src/app/page.tsx` untouched. `mini-services/` untouched.

### Verification
- `bun run lint` — clean (no errors/warnings in any of the new files).
- `curl /api/stats` → 200 `{totalDevices:0,...,lastActivityAt:null}`.
- `curl /api/devices` → 200 `{devices:[]}`.
- `curl /api/devices/nonexistent` → 404 `{error:"device_not_found"}`.
- `curl /api/devices/nonexistent/health` → 404.
- `curl /api/devices/nonexistent/history?range=24h` → 404.
- `curl /api/devices/nonexistent/commands` → 404.
- `POST /api/devices/nonexistent/fan {"action":"on"}` → 404.
- `POST /api/devices/nonexistent/fan {"action":"bogus"}` → 400 `{error:"invalid_action"}`.
- (Happy-path POST fan command + history with real data will be exercised
  once the ESP8266 simulator mini-service registers devices via the hub —
  the helper is in place and fire-and-forget per spec.)

### Open items / dependencies
- The POST fan-command happy path can only be fully verified once the
  IoT hub (port 3003) is running. The route handles hub-unreachable by
  marking the command `failed` and returning 503, so it degrades
  gracefully in the meantime.

---

## Task 3 — Real-time Dashboard Frontend (agent: frontend-dashboard)

### Scope
Built the ONLY user-visible page (`/`, `src/app/page.tsx`) for the SmartFan
IoT platform — a real-time monitoring & remote-control dashboard. Sticky
header (title + live clock + WS connection pill + Refresh), 6-card KPI strip,
responsive device grid (1/2/3 cols), sensor history chart with device picker
+ range + metric tabs, recent-readings table, device detail Sheet with health
+ commands + mini chart, and a sticky footer. Live updates via socket.io;
sonner toasts on command acks. Skeletons / empty state / error retry wired up.
No indigo/blue; emerald / rose / amber / teal + chart palette.

### Files created (all under `/home/z/my-project`)
- `src/hooks/use-iot-store.ts` — Zustand store. Single source of truth:
  `devices`, `stats`, `connection`, `loading`, `error`, `lastEventAt`.
  Actions merge WS frames into the device list by id (`applySnapshot`,
  `applyTelemetry`, `applyDeviceStatus`, `applyFanState`, `applyCommandAck`)
  and `recomputeStats` re-derives KPIs from the live device list as a fast
  fallback between `/api/stats` polls. UI state (chart's selected device id)
  is never lost across telemetry updates.
- `src/hooks/use-iot-socket.tsx` — socket.io-client hook. Connects to
  `io("/?XTransformPort=3003", { transports:["websocket","polling"],
  reconnection:true })` so Caddy can route to the IoT hub on port 3003.
  On `connect` emits `subscribe`. Wires `snapshot` / `telemetry` /
  `device:status` / `fan:state` / `command:ack` into the store; on
  `command:ack` shows a sonner toast ("Fan turned ON for Living Room" /
  "Command failed for Kitchen") with the device name resolved from the store.
- `src/components/iot/fan-icon.tsx` — animated Lucide `Fan`. Spins
  continuously (framer-motion `rotate: 360` infinite loop) when the fan is ON.
- `src/components/iot/live-indicator.tsx` — pulsing dot used in the header &
  footer. Emerald "LIVE" when WS connected, amber "RECONNECTING…" otherwise.
- `src/components/iot/stats-strip.tsx` — 6 KPI cards: Total Devices, Online
  (emerald), Fans Running, Avg Temperature (rose ≥30, amber 25–30), Avg
  Humidity (teal), Last Activity (`formatDistanceToNowStrict`). Skeletons
  while loading.
- `src/components/iot/device-card.tsx` — single device card. Name + location
  (MapPin); emerald Online / rose Offline badge with pulsing dot; prominent
  Fan ON/OFF pill with spinning FanIcon when on; large temperature with
  color hints; humidity; RSSI dBm + 4-bar signal indicator; uptime ("Xh Ym");
  relative last-seen; emerald "Turn ON" + outline "Turn OFF" buttons with
  in-flight spinner and sonner toast on `POST /api/devices/[id]/fan` (correct
  disabled state when already on/off or device offline); "Details" button
  opens the Sheet.
- `src/components/iot/history-chart.tsx` — tabbed sensor history card with
  device Select (auto-picks first online device), range ToggleGroup
  (1h/6h/24h/7d), Temperature/Humidity metric toggle, animated recharts
  AreaChart (temp, `--chart-1` + gradient) / LineChart (humidity,
  `--chart-3`) inside `ChartContainer`. Tooltip, axis labels, legend.
  Effective device id is derived via `useMemo` (no `setState` in effect).
- `src/components/iot/readings-table.tsx` — recent-readings Table (time,
  temp, humidity, fan-status badge, RSSI). Sticky header, `max-h-96
  overflow-y-auto`, `.custom-scroll` scrollbar (defined inline in page.tsx).
- `src/components/iot/device-detail-dialog.tsx` — right-side Sheet with:
  health banner (signal-quality colored badge + message with
  ShieldCheck/ShieldAlert/ShieldX); info grid (firmware, IP, MAC, registered,
  last seen, uptime, readings-1h, status); mini `HistoryChart` (locked
  device, default 6h); recent-commands Table with status-badge tone by
  state (acknowledged/pending/failed/sent).
- `src/app/page.tsx` — composes everything. Root wrapper
  `min-h-screen flex flex-col bg-background`. Sticky header (SmartFan IoT +
  Fan icon, live clock updating every second, `LiveIndicator`, Refresh
  button). Stats strip → device grid (`AnimatePresence` + `motion.div` for
  fade/slide-in). History + readings section (`lg:grid-cols-3`, chart
  spans 2). Loading skeletons, empty state, error Alert with retry. Sticky
  footer (`mt-auto`) with "SmartFan IoT Platform • ESP8266 + Next.js" + year.
  Inline `<style>` defines `.custom-scroll` for the readings/commands
  tables. Mounts a Sonner Toaster directly (so `command:ack` toasts work
  regardless of the layout's existing radix Toaster).

### Conventions used
- `'use client'` everywhere (page is client-side, hooks are client-side).
- All WS event handlers type payloads against `IoTEvents` in
  `src/lib/iot-contracts.ts` — no duplicated string literals.
- All fetch effects use `AbortController` + an async IIFE so `setState`
  calls live inside promise callbacks (not the effect body) — satisfies
  `react-hooks/set-state-in-effect` rule from the Next 16 lint config.
- `POST /api/devices/[id]/fan` body `{ action: "on"|"off" }`, shows sonner
  toast on success/failure, disables buttons while in-flight, optimistically
  relies on the WS `fan:state` / `command:ack` broadcast for the final state.
- Colors: emerald (online/on), rose (offline / hot temp), amber (warning),
  teal (humidity), chart-1 (temp), chart-3 (humidity). No indigo/blue.
- Sticky-footer pattern: root `min-h-screen flex flex-col`, `main` is
  `flex-1`, `footer` has `mt-auto` — verified via agent-browser.
- Touch targets ≥ 44px: fan buttons `h-10`, sheet rows padded generously.
- No edits to `src/app/api/`, `mini-services/`, `src/lib/iot-contracts.ts`,
  or `src/app/globals.css`. The Sonner Toaster is mounted inside page.tsx
  instead of layout.tsx (which is owned by the scaffold).

### Verification
- `bun run lint` → clean (0 errors, 0 warnings) across all new files.
- `agent-browser open http://localhost:81/` (via the gateway so WS works):
  - Header renders title + Fan icon, live clock (ticking every second),
    `LiveIndicator` showing LIVE when hub is up / RECONNECTING when down,
    Refresh button (spinner while in-flight).
  - Stats strip renders 6 KPI cards with correct numbers (4 devices, 4
    online, 1 fan on, avg temp 22.8°C, avg humidity 56%, last activity
    "17 seconds ago").
  - Device grid renders 4 cards (Fan-Bedroom-02, Fan-Garage-04,
    Fan-Kitchen-03, Fan-LivingRoom-01) with status badges, fan pill,
    temperature color hint, signal bars, uptime, last-seen, and ON/OFF +
    Details buttons (correct disabled states).
  - Device detail Sheet opens with health banner, info grid, mini history
    chart (range toggles + temp/humidity tabs work), recent commands table.
  - Clicking "Turn ON" → POST `/api/devices/[id]/fan` fired, sonner toast
    shown, button spinner during in-flight, fan state updated once the
    WS `command:ack` arrived.
  - `command:ack` toast correctly resolved the device name from the store.
  - Mobile viewport (390×844): all cards stack single-column, header wraps,
    footer stays sticky.
  - Sticky footer pinned to viewport bottom on short pages and pushed down
    naturally when the device grid / detail sheet overflowed.
- Resilience: when the IoT hub (port 3003) was temporarily down, the
  dashboard fell back to 10s `/api/stats` polling, the header showed
  RECONNECTING, and POST `/api/devices/[id]/fan` showed an error toast
  (the API route returned 503 because the hub was unreachable — expected).
- Screenshots saved in `/home/z/my-project/screenshots/` (desktop, mobile,
  LIVE state, RECONNECTING state, detail Sheet, post-command state).

### Open items / dependencies
- WS connectivity end-to-end depends on the IoT hub (port 3003, Task 1)
  staying up. When the hub is down, the dashboard degrades gracefully
  (RECONNECTING pill + 10s stats polling fallback). Hub stability is owned
  by the backend agent.
- ESP8266 simulator (port 3004) must be running and emitting telemetry for
  the dashboard to show live temperature/humidity updates and feed the
  history chart. If it isn't running, the dashboard correctly shows the
  last DB-persisted state.

## Task 2-a — IoT Hub (port 3003) + ESP8266 Simulator (port 3004)

**Agent**: GLM Code (subagent)
**Task ID**: 2-a
**Status**: ✅ Done — both services running and verified end-to-end

### Files created
- `mini-services/iot-hub/package.json` — bun project, dev script `bun --hot index.ts`, deps: `socket.io`, `@prisma/client` (the @prisma/client is resolved from the main project's node_modules by walking up the directory tree; the generated Prisma client lives at `/home/z/my-project/node_modules/.prisma/client/`).
- `mini-services/iot-hub/.env` — `DATABASE_URL=file:/home/z/my-project/db/custom.db`
- `mini-services/iot-hub/tsconfig.json` — ESNext + bun-types
- `mini-services/iot-hub/index.ts` — full hub implementation (~630 lines, includes mirrored contract types so the mini-service is self-contained)
- `mini-services/esp-simulator/package.json` — bun project, dev script `bun --hot index.ts`, deps: `socket.io-client`
- `mini-services/esp-simulator/tsconfig.json` — ESNext + bun-types
- `mini-services/esp-simulator/index.ts` — full simulator implementation (~270 lines)

### What the hub does
- Socket.io server on port 3003, `path: "/"`, `cors: { origin: "*" }`, pingTimeout 60s / pingInterval 25s.
- Two socket kinds: **device** (identified by `device:register`) and **dashboard** (identified by `subscribe`).
- Event handlers exactly per the task spec:
  - `device:register` → Prisma `device.upsert` by `macAddress` (sets `status="online"`, `lastSeenAt=now`, `ipAddress`, `firmwareVersion`, `location`, `name`); replies `{ ok: true, deviceId }` to the device socket with the **real DB-assigned** `deviceId`; broadcasts `device:status` online to dashboards; emits `fan:state` back to the device with the desired `fanStatus` so the simulator can sync on reconnect.
  - `telemetry` → persists a `SensorReading` row, updates cached device fields (`temperature`, `humidity`, `fanStatus`, `rssi`, `uptimeSeconds`, `status=online`, `lastSeenAt=now`), broadcasts `telemetry` to dashboards with normalized `lastSeenAt`; also broadcasts `fan:state` if `fanStatus` changed since the previous reading.
  - `command:ack` → updates the matching `CommandLog` row (`status = "acknowledged" | "failed"`, `ackedAt=now`), updates device `fanStatus`, broadcasts `command:ack` to dashboards. P2025 (no row found) is logged but does NOT block the broadcast (the row was created in `fan:command` using the dashboard's `commandId` as the row id, so the lookup should normally succeed).
  - `subscribe` → marks socket as a dashboard, replies with a `snapshot` event containing all devices from DB mapped to `DeviceDTO` shape.
  - `fan:command` → creates a `CommandLog` row with `id = payload.commandId`, `status="sent"`, `sentAt=now`; looks up the device socket in `deviceSocketsByDeviceId` Map; if found, forwards `fan:command` to the device socket (same payload); if not found, marks the command `status="failed"` with `error="device offline"` and broadcasts a `command:ack` failure to dashboards.
  - `disconnect` → if a device socket, updates device `status="offline"`, broadcasts `device:status` offline to dashboards; removes the socket from the in-memory registry.
- Heartbeat: every 15 s, walks `deviceSocketsByDeviceId`; if a device hasn't sent telemetry in 60 s, marks it offline in the DB and broadcasts `device:status` offline.
- DB write contention: `withBusyRetry()` helper retries once on `PrismaClientKnownRequestError` codes P2034 / SQLITE_BUSY / SQLITE_LOCKED with a 50 ms back-off.
- Tiny health endpoint: `GET /` returns `{ ok: true, service: "iot-hub", port: 3003 }`. **Important**: attached as a separate listener AFTER socket.io's listeners and only responds when the request URL does NOT look like a socket.io request (no `EIO=`, no `transport=`, no `/socket.io/` prefix). Responding to socket.io polling requests from a custom `createServer` listener breaks polling transport — see "Gotchas" below.
- Uncaught-exception and unhandled-rejection handlers added so crashes leave a log line.
- Graceful shutdown on SIGTERM/SIGINT: marks all currently-online devices offline before exit.

### What the simulator does
- Spawns 4 simulated ESP8266 devices with fixed identities (so the dashboard always shows the same set):
  - `Fan-LivingRoom-01` / MAC `A1:B2:C3:D4:E5:01` / Living Room / base 24 °C / 50 % humidity
  - `Fan-Bedroom-02`   / MAC `A1:B2:C3:D4:E5:02` / Bedroom   / base 22 °C / 45 %
  - `Fan-Kitchen-03`   / MAC `A1:B2:C3:D4:E5:03` / Kitchen   / base 28 °C / 60 %
  - `Fan-Garage-04`    / MAC `A1:B2:C3:D4:E5:04` / Garage    / base 18 °C / 70 %
- Each device is a `socket.io-client` connecting directly to `http://localhost:3003` with `path: "/"`, `transports: ["websocket"]`, exponential reconnect backoff (1 s → 5 s).
- On `connect`, emits `device:register`. Stores the `deviceId` returned by the hub in the ack for all subsequent events.
- Sends `telemetry` every 5 s. Telemetry values:
  - Temperature: random walk (±0.5 °C, clamp 10–40). When fan is ON, temperature cools by ~0.3 °C per tick toward `base − 4 °C` floor; when fan is OFF, drifts back toward base.
  - Humidity: random walk (±2 %, clamp 20–90).
  - RSSI: random −40 to −75.
  - `uptimeSeconds`: increments by 5 per tick (persists per-device in memory; resets when the simulator process restarts).
- Listens for `fan:command` → updates local `fanStatus`, emits `command:ack` `{ commandId, deviceId, success: true, fanStatus, timestamp }`.
- Listens for `fan:state` from the hub (sent on `device:register`) → syncs local `fanStatus` to the desired state on (re)connect (so a fan that was turned ON before a disconnect comes back ON).
- Every ~90 s, picks a random device, drops its socket for 15 s, then reconnects. This exercises the hub's `disconnect` → `device:status` offline → reconnect → `device:register` → `device:status` online flow for the dashboard demo.
- Tiny health HTTP server on port 3004 returning a JSON snapshot of all 4 simulated devices (name, mac, deviceId, connected, fanStatus, temperature, humidity, rssi, uptimeSeconds).

### How they're started (verified)
- The processes are started with: `cd <service-dir> && nohup setsid bun index.ts > /tmp/<service>.log 2>&1 < /dev/null & disown`.
- Logs live at `/tmp/iot-hub.log` and `/tmp/esp-sim.log` (outside each service's CWD; this avoids `bun --hot` watching the log file and restarting the worker on every write — see Gotchas).
- The `dev` scripts in both `package.json` files are `bun --hot index.ts` per the project rules; the live instances are started with plain `bun index.ts` for stability (see Gotchas — `bun --hot`'s restart-on-CWD-file-change killed the worker when our tooling wrote/deleted files in the service folder).

### Verification (end-to-end test)
A throwaway dashboard client (subscribed, sent `fan:command` to `Fan-LivingRoom-01`, then disconnected) produced this trace — proving the full round-trip works:

```
[dash] connected as cJZ3MRAj5LNNhRMJAAAF
[dash] snapshot: 4 devices
[dash] sending fan:command: 8c701712-... device=cmudnuhrq0002j8jjboqo60r7
[dash] command:ack: 8c701712-... success=true fan=on
[dash] telemetry from cmudnuhrn0000j8jjlxvynnn4 fan=off t=28.27
[dash] telemetry from cmudnuhrq0003j8jjebo146rv fan=off t=18.33
[dash] telemetry from cmudnuhrp0001j8jjbtwq4kxm fan=off t=22.41
[dash] telemetry from cmudnuhrq0002j8jjboqo60r7 fan=on t=24.71   ← cooling
[dash] disconnect: io client disconnect
```

After ~70 s of steady running the DB showed:
- All 4 devices `status=online` with live telemetry (Fan-LivingRoom 23.99 °C / 55.6 %, Bedroom 21.96 °C / 43.2 %, Kitchen 27.79 °C / 62.2 %, Garage 18.48 °C / 74.0 %).
- `175` SensorReading rows persisted (telemetry every 5 s × 4 devices × ~22 ticks).
- CommandLog rows in states `acknowledged`, `failed` (`error: "device offline"` / `"hub unreachable"`), and older `sent` rows (from before the commandId-as-row-id fix).

### Gotchas (important for the next agent / for restarts)
1. **Don't put a custom HTTP request listener in `createServer(cb)` for socket.io servers.** When `new Server(httpServer, { path: "/" })` is created, socket.io attaches its own request listener. A `createServer` listener that returns without responding to URLs containing `EIO=` / `transport=` will silently break polling transport — `socket.io-client` then loops with `xhr poll error` and never connects. The fix used here: build `createServer()` with no listener, attach socket.io, then add the health endpoint as a *second* `request` listener that no-ops on socket.io-style URLs.
2. **Don't write log files inside the service folder when using `bun --hot`.** `bun --hot` watches files in the CWD; when the service writes to `service.log` (or when tooling writes/deletes files in the CWD), `bun --hot` restarts the worker. With socket.io bound to port 3003, the restart race occasionally fails with `EADDRINUSE` and the worker dies. Fix: write logs to `/tmp/...` (outside the CWD) and start the live instances with plain `bun index.ts`. The `dev` script keeps `bun --hot index.ts` for normal development.
3. **Long-running background processes in this sandbox need `nohup setsid ... < /dev/null & disown`.** Plain `&` or `setsid` alone left the processes vulnerable to SIGHUP / session teardown between bash tool invocations — they died within ~30 s. With `nohup setsid ... < /dev/null & disown`, both services have been observed stable for 60+ seconds and continuing.
4. **`@prisma/client` resolution.** The mini-service's own `node_modules/@prisma/client` only contains the package stub, not the generated client (the generated client lives at `node_modules/.prisma/client/` next to wherever `@prisma/client` is installed). Instead of installing a separate copy and running `prisma generate` against an `output` override, the iot-hub's `node_modules/@prisma/client` was deleted; bun then walks up the directory tree and finds the main project's `@prisma/client` plus its generated `node_modules/.prisma/client/`. The main project's `prisma generate` had already populated that location, so no extra generation step is needed in the mini-service.
5. **Stable `deviceId`s across simulator restarts.** The hub upserts by `macAddress`, so the DB-assigned cuid for each MAC is stable. The simulator stores the `deviceId` returned by the hub in its `device:register` ack and uses it for all subsequent `telemetry` / `command:ack` events. If a future agent restarts the simulator, the same DB rows are reused (no duplicate devices).
6. **`commandId` must be the CommandLog row id.** The dashboard generates a UUID `commandId`; the hub uses that UUID as the `CommandLog.id` on create so the `command:ack` handler can `update({ where: { id: payload.commandId } })` and find the row. Without this, the ack lookup throws P2025 (no record found). The current code logs P2025 as a warning but still broadcasts the ack to dashboards so the UI doesn't get stuck.

### Currently running process PIDs (will change on restart)
- IoT hub on port 3003 — started by this agent, log at `/tmp/iot-hub.log`.
- ESP8266 simulator on port 3004 — started by this agent, log at `/tmp/esp-sim.log`.

To restart cleanly:
```bash
# kill anything on the ports
for p in $(ss -tlnp 2>/dev/null | grep -E ':3003|:3004' | grep -oP 'pid=\K[0-9]+'); do kill -9 $p; done
pkill -9 -f 'bun.*index'   # caution: this also kills the Next.js dev server if it matches
# restart
cd /home/z/my-project/mini-services/iot-hub       && nohup setsid bun index.ts > /tmp/iot-hub.log  2>&1 < /dev/null & disown
cd /home/z/my-project/mini-services/esp-simulator && nohup setsid bun index.ts > /tmp/esp-sim.log 2>&1 < /dev/null & disown
```

---

## Task 2-a — Re-verification pass + small spec-alignment fix (agent: GLM Code)

**Task ID**: 2-a (re-run)
**Status**: ✅ Done — both services running, verified end-to-end (4 devices online,
telemetry flowing, fan command round-trip acknowledged).

### Context
The original Task 2-a work was already shipped by an earlier agent (see the section
above). The user re-issued Task 2-a; this pass re-read the existing implementation
against the spec, fixed one minor deviation, restarted both services with a more
robust detach pattern (the prior `nohup setsid ... & disown` was observed to die
within ~60 s in this session — see Gotchas below), and re-ran the end-to-end
verification suite.

### Spec-alignment fix applied
- `mini-services/esp-simulator/index.ts` — added an explicit `ipAddress` field to
  `DeviceConfig` so each simulated device reports the spec-mandated
  `192.168.1.<N+10>` (`192.168.1.11` … `192.168.1.14`) on `device:register`,
  instead of the previously-hardcoded `127.0.0.1`. The hub already had the
  `socket.handshake.address` fallback but the simulator should not have relied on
  that — the spec explicitly says the simulator passes its own IP. The health
  endpoint on port 3004 now also exposes `ipAddress` per device in its summary
  payload. (Firmware versions remain varied — `1.2.0` for Living Room + Bedroom,
  `1.1.5` for Kitchen + Garage — for a richer health-status demo; spec only
  mandated `"1.2.0"` as a starting value, the variation is more realistic and the
  dashboard's health card surfaces it.)

No other source changes were needed — the existing implementation already matches
the spec on every other point (path: "/", cors "*", pingTimeout 60s /
pingInterval 25s, upsert by macAddress, fan:state reply on register, telemetry
broadcast + sensorReading persistence, command:ack updates CommandLog by id,
fan:command creates CommandLog with id=commandId, heartbeat 15s/60s, etc.).

### Process-startup change (more robust detach)
Previous run used `nohup setsid bun index.ts > log 2>&1 < /dev/null & disown`
which died after ~60 s in this sandbox session. The new pattern that has been
verified stable:

```bash
cd /home/z/my-project/mini-services/iot-hub
setsid --fork bash -c 'exec bun index.ts >> /tmp/iot-hub.log 2>&1' < /dev/null > /dev/null 2>&1

cd /home/z/my-project/mini-services/esp-simulator
setsid --fork bash -c 'exec bun index.ts >> /tmp/esp-sim.log 2>&1' < /dev/null > /dev/null 2>&1
```

`setsid --fork` creates a new session AND forks into the background in one call;
combined with `exec` (so `bun` replaces the bash subshell, no orphan bash
lingers) and the doubly-redirected stdio (`< /dev/null > /dev/null 2>&1` for
the wrapper, `>> /tmp/...log 2>&1` for the bun process itself), the resulting
process is `ppid=1`, its own session leader, its own process-group leader, with
no controlling terminal — i.e. fully detached and immune to SIGHUP / session
teardown when the bash tool exits. Verified with `ps -eo pid,ppid,sid,pgid,cmd`:
both `bun index.ts` processes had `ppid=1 sid=<own> pgid=<own>` and stayed alive
across multiple sequential bash tool invocations.

### Verification (all green)
After clean restart of both services, with logs at `/tmp/iot-hub.log` and
`/tmp/esp-sim.log`:

1. **Hub boot**: `IoT hub running on port 3003` logged.
2. **Simulator boot**: `ESP8266 simulator started with 4 devices → hub
   http://localhost:3003` and `ESP8266 simulator health server on port 3004`.
3. **All 4 devices register** (one log line per device on each side):
   - `Fan-Garage-04` / `A1:B2:C3:D4:E5:04` → deviceId `cmudnuhrq0003j8jjebo146rv`
   - `Fan-Kitchen-03` / `A1:B2:C3:D4:E5:03` → deviceId `cmudnuhrn0000j8jjlxvynnn4`
   - `Fan-Bedroom-02` / `A1:B2:C3:D4:E5:02` → deviceId `cmudnuhrp0001j8jjbtwq4kxm`
   - `Fan-LivingRoom-01` / `A1:B2:C3:D4:E5:01` → deviceId `cmudnuhrq0002j8jjboqo60r7`
4. **`curl http://localhost:3000/api/devices`** → 200, 4 devices, all
   `status=online`, all `fanStatus=off`, all reporting the spec-defined
   `ipAddress` (`192.168.1.11` … `.14`), each with live temperature / humidity /
   rssi / uptime (Telemetry every 5s was landing in the DB:
   `up=10s → 40s → 60s` over three sequential checks).
5. **`curl http://localhost:3000/api/stats`** →
   `{totalDevices:4, onlineDevices:4, offlineDevices:0, fansOn:0, fansOff:4,
   avgTemperature:23.27, avgHumidity:55.43, lastActivityAt:<recent ISO>}`.
6. **Fan command round-trip** (via the Next.js API route, not direct WS):
   - `POST /api/devices/cmudnuhrq0002j8jjboqo60r7/fan {"action":"on"}`
     → 200 `{status:"sent", commandId:"9c467b13-…"}`.
   - 60 ms later the matching `CommandLog` row's `status` had flipped to
     `acknowledged` with `ackedAt` populated (the device had acked and the hub
     had updated the row).
   - The device's `fanStatus` flipped `off → on` in the DB and was visible via
     `GET /api/devices/<id>` immediately after.
   - `POST /api/devices/<id>/fan {"action":"off"}` → restored `fanStatus=off`.
7. **Service stability**: 1 minute after start, both processes still had
   `ppid=1` and were still serving on their ports; telemetry `uptimeSeconds`
   had climbed to 60s — i.e. the hub kept receiving telemetry for the whole
   minute and the simulator kept sending it.

### Currently running process PIDs (will change on next restart)
- IoT hub on port 3003 — PID 8279 (ppid 1, own session).
- ESP8266 simulator on port 3004 — PID 8291 (ppid 1, own session).
- Logs at `/tmp/iot-hub.log` and `/tmp/esp-sim.log`.

### Gotchas added in this pass
7. **`nohup setsid … & disown` is NOT always sufficient in this sandbox.** In
   this session the pattern from the previous worklog died after ~60 s. Switching
   to `setsid --fork bash -c 'exec …' < /dev/null > /dev/null 2>&1` produced
   processes with `ppid=1` (orphaned to init) and `sid=pgid=<own>` (own session)
   that survived across multiple sequential bash tool invocations. The
   difference is subtle but important: `setsid` without `--fork` keeps the
   calling shell as the parent until it exits, and the `disown` only takes
   effect after the shell's job-control table is processed; with `--fork`, the
   new session leader is reparented to PID 1 *immediately* and the calling
   shell's exit cannot affect it. The double stdio redirection (`< /dev/null
   > /dev/null 2>&1` for the wrapper, `>> log 2>&1` inside for the bun process)
   keeps both the wrapper bash and bun from inheriting the bash tool's stdout
   pipe (which closes when the bash tool returns, generating SIGPIPE).


---
Task ID: 4 (main orchestrator)
Agent: main
Task: End-to-end self-verification with Agent Browser + final polish

Work Log:
- Verified all 3 services running: Next.js (3000), IoT hub (3003), ESP8266 simulator (3004)
- Confirmed API health: /api/stats returns 4 devices online, /api/devices returns 4 devices with telemetry, /api/devices/[id]/health returns signal quality + message
- Opened dashboard via Caddy gateway (port 81) — LIVE indicator green, telemetry refreshing every 5s, "Last seen X seconds ago" on all cards
- Tested golden path: clicked "Turn fan ON for Fan-LivingRoom-01" → toast "Fan ON command sent" → toast "Fan turned ON — Command acknowledged by device" → ON button disabled, OFF button enabled
- Tested reverse: clicked "Turn fan OFF" → full round-trip ack → OFF button disabled, ON button enabled
- Opened device details Sheet: shows Sensor history chart (1h/6h/24h/7d ranges, Temp/Humidity toggle), connection info (Firmware, IP, MAC, Registered, Uptime, Readings 1h, Status), health banner (Signal: Excellent), and Recent commands table (Action/Status/Source/When with the acknowledged ON command)
- Verified sticky footer at bottom of page (not floating) via full-page screenshot + VLM
- Verified mobile responsive (390px): single column, no overflow, readable cards, footer at bottom, touch targets ≥44px
- Checked dev.log: zero errors/warnings (only prisma queries + 200 responses)
- Updated layout.tsx metadata: title now "SmartFan IoT — Monitoring & Remote Control" (was "Z.ai Code Scaffold")

Stage Summary:
- All 11 requested dashboard features verified working end-to-end via Agent Browser:
  1. View connected IoT devices ✅ (4 devices shown)
  2. View device online/offline status ✅ (online badges with pulsing dots)
  3. View fan ON/OFF status ✅ (fan pill + spinning icon when ON)
  4. View real-time temperature ✅ (updates every 5s via WS)
  5. View real-time humidity ✅ (updates every 5s via WS)
  6. Turn fan ON remotely ✅ (POST → hub → device → ack → toast)
  7. Turn fan OFF remotely ✅ (same round-trip)
  8. View last device communication time ✅ (relative "X seconds ago")
  9. View sensor data history ✅ (chart + table with 1h/6h/24h/7d ranges)
  10. View device connection info ✅ (firmware, IP, MAC, registered, uptime in details Sheet)
  11. Monitor device health ✅ (signal quality, health message, readings count)
- Real-time data flow confirmed: ESP8266 simulator → IoT hub (3003) → Caddy gateway (81) → browser dashboard
- No console/runtime errors. Layout clean on desktop + mobile. Sticky footer working.
