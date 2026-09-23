# Task 3 — Real-time Dashboard Frontend (frontend-dashboard)

## Scope
Built the ONLY user-visible page (`/`, `src/app/page.tsx`) for the SmartFan IoT
platform — a real-time monitoring & remote-control dashboard with KPI strip,
device grid, sensor history chart, recent-readings table, device detail sheet,
live WebSocket updates, sonner toasts, sticky header/footer, and full
responsive + accessibility polish.

## Files created (all under `/home/z/my-project`)
- `src/hooks/use-iot-store.ts` — Zustand store. Single source of truth for the
  dashboard: `devices`, `stats`, `connection`, `loading`, `error`,
  `lastEventAt`. Actions: `setDevices`, `applySnapshot`,
  `applyTelemetry`, `applyDeviceStatus`, `applyFanState`, `applyCommandAck`,
  `setStats`, `setConnection`, `setLoading`, `setError`, `recomputeStats`
  (re-derives KPIs from the device list as a fast fallback between polls).
  Merges WS frames by `deviceId`, never loses UI state across re-renders.
- `src/hooks/use-iot-socket.tsx` — socket.io-client connection hook. Connects
  to `io("/?XTransformPort=3003", { transports:["websocket","polling"],
  reconnection: true })` so Caddy can route to the IoT hub on port 3003. On
  `connect` it emits `subscribe`. Wires `snapshot` / `telemetry` /
  `device:status` / `fan:state` / `command:ack` events into the store. On
  `command:ack` it shows a sonner toast ("Fan turned ON for Living Room" /
  "Command failed for Kitchen") with the device name resolved from the store.
- `src/components/iot/fan-icon.tsx` — animated Lucide `Fan` icon. Spins
  continuously (framer-motion `rotate: 360` infinite loop) when the fan is ON.
- `src/components/iot/live-indicator.tsx` — pulsing dot used in the header &
  footer. Emerald "LIVE" when WS connected, amber "RECONNECTING…" otherwise.
- `src/components/iot/stats-strip.tsx` — 6 KPI cards (Total Devices, Online,
  Fans Running, Avg Temperature, Avg Humidity, Last Activity). Each with a
  Lucide icon, semantic colors (emerald=online/on, rose=temp, teal=humidity,
  amber=warning), and relative-time via `formatDistanceToNowStrict`.
- `src/components/iot/device-card.tsx` — single device card. Name + location
  (MapPin), emerald Online / rose Offline badge with pulsing dot, prominent
  Fan ON/OFF pill with spinning FanIcon when on, large temperature with
  color hints (rose ≥30°C, amber 25–30), humidity, RSSI dBm + 4-bar signal
  indicator, uptime ("Xh Ym"), relative last-seen, "Turn ON" (emerald) and
  "Turn OFF" (outline) buttons with in-flight spinner and sonner toast on
  `POST /api/devices/[id]/fan`, and a "Details" button that opens the sheet.
- `src/components/iot/history-chart.tsx` — tabbed sensor history card with
  device Select (defaults to first online device), range ToggleGroup
  (1h / 6h / 24h / 7d), Temperature/Humidity metric toggle, and an animated
  recharts AreaChart (temp) / LineChart (humidity) inside `ChartContainer`
  with axis labels, custom tooltip, legend, and chart-palette colors.
  `chartDeviceId` is lifted to the page via `onDeviceChange` so it stays
  stable across telemetry updates and the readings table stays in sync.
- `src/components/iot/readings-table.tsx` — recent-readings table for the
  selected device (time, temp, humidity, fan-status badge, RSSI). Sticky
  header, `max-h-96 overflow-y-auto`, custom scrollbar style (defined inline
  in `page.tsx` because globals.css is owned by another agent).
- `src/components/iot/device-detail-dialog.tsx` — right-side Sheet with:
  health banner (signal-quality colored badge + message with ShieldCheck /
  ShieldAlert / ShieldX), info grid (firmware, IP, MAC, registered, last
  seen, uptime, readings-1h, status), mini `HistoryChart` (locked device,
  default 6h), and a scrollable recent-commands table (action, status badge
  with tone by state, source, acked/sent time).
- `src/app/page.tsx` — composes everything. Root wrapper is
  `min-h-screen flex flex-col bg-background`. Sticky header (SmartFan IoT
  title + Fan icon, live clock updating every second, `LiveIndicator`,
  Refresh button). Stats strip → device grid (`AnimatePresence` +
  `motion.div` for fade/slide-in, 1 col mobile / 2 col `sm:` / 3 col `xl:`).
  History + readings section (`lg:grid-cols-3`, chart spans 2 cols). Loading
  skeletons, empty state ("No devices registered yet — start the ESP8266
  simulator"), error Alert with retry. Sticky footer (`mt-auto`) with
  "SmartFan IoT Platform • ESP8266 + Next.js" + year. Inline `<style>` block
  defines `.custom-scroll` for the readings/commands tables. Mounts the
  Sonner Toaster directly (so `command:ack` toasts work without depending on
  the layout's existing radix Toaster).

## Key implementation notes
- All WS event handlers type their payloads against the shared
  `IoTEvents` constant in `src/lib/iot-contracts.ts` (snapshot, telemetry,
  device:status, fan:state, command:ack) — no string literals duplicated.
- The store is the single source of truth: components subscribe via
  `useIotStore((s) => s.devices)` etc., so WS frames and 10s `/api/stats`
  polling both flow into the same state with no prop-drilling.
- The chart's selected device stays stable across telemetry updates: the
  page stores `chartDeviceId` (string) and passes it to `ReadingsTable`,
  while `HistoryChart` resolves its effective id via `useMemo` (locked →
  explicit → first-online → first device). No `setState` in effect bodies
  for the auto-pick path, satisfying `react-hooks/set-state-in-effect`.
- All fetch effects use `AbortController` + an async IIFE so `setState`
  calls live inside the promise callbacks (not the effect body) — also
  satisfies the same lint rule.
- Colors: no indigo/blue anywhere. Emerald (online/on), rose (offline /
  hot temp), amber (warning / fair signal), teal (humidity), chart palette
  `--chart-1` (temp area) / `--chart-3` (humidity line).
- Sticky footer pattern: root `min-h-screen flex flex-col`, `main` is
  `flex-1`, `footer` has `mt-auto` — verified via the agent-browser
  screenshots (footer pinned to viewport bottom on short pages, pushed
  down naturally when the grid grows).
- Touch targets ≥ 44px: fan buttons use `h-10`, sheet rows have generous
  padding, Select/ToggleGroup triggers are `h-9`.

## Verification
- `bun run lint` → clean (0 errors, 0 warnings) across the new files.
- `agent-browser open http://localhost:81/` (via gateway so WS works):
  - Header renders title, live clock, `LiveIndicator` (LIVE when hub up,
    RECONNECTING when hub down), Refresh button.
  - Stats strip renders all 6 KPI cards with correct numbers (4 devices,
    4 online, 1 fan on after a prior command, avg temp 22.8°C, avg
    humidity 56%, last activity 17s ago).
  - Device grid renders 4 cards (Fan-Bedroom-02, Fan-Garage-04,
    Fan-Kitchen-03, Fan-LivingRoom-01) with status badges, fan pill,
    temperature color hint, signal bars, uptime, last-seen, and ON/OFF +
    Details buttons (correct disabled states when fan already on/off).
  - Device detail Sheet opens with health banner, info grid, mini history
    chart (range toggles + temp/humidity tabs work), recent commands table.
  - Mobile viewport 390×844: all cards stack single-column, header wraps,
    footer stays sticky.
  - `command:ack` toast correctly resolved the device name from the store.
- Resilience: when the IoT hub (port 3003) was temporarily down, the
  dashboard correctly fell back to 10s `/api/stats` polling, the header
  showed RECONNECTING, and POST `/api/devices/[id]/fan` correctly showed
  an error toast (the API route returned 503 because the hub was
  unreachable — expected behavior).

## Status
Complete. No blockers. Frontend is decoupled from the API/mini-service
implementations and works against any backend that honors the contracts in
`src/lib/iot-contracts.ts`. Screenshots saved in
`/home/z/my-project/screenshots/` (desktop, mobile, LIVE state, detail
sheet, post-command state).
