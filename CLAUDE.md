# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SmartFan IoT — a monitoring & remote-control dashboard for ESP8266-attached fans. A Next.js 16 app (single dashboard page) backed by Prisma/SQLite, plus two standalone Bun mini-services that simulate the IoT side (a WebSocket hub and a fleet of simulated ESP8266 devices). The package name (`nextjs_tailwind_shadcn_ts`) and `.zscripts/`/`tests/` build tooling are leftovers from the original scaffold template this project was generated from — the actual application is the IoT platform described below.

## Device control model

`Device` carries server-owned config (`mode` auto|manual, `desiredFanStatus`, `tempOn`/`tempOff`, `heartbeatIntervalSec`) that telemetry never overwrites; `fanStatus` is the device's actual state. The hub pushes it to devices as `device:config` (and to dashboards). Commands go `queued → sent → acknowledged|failed` (30s no-ack timeout); the API creates the `CommandLog` row and the hub updates that same row. Config validation lives in `src/lib/config-validation.ts` (mirrored in the hub). `scripts/fake-device.ts` emulates the real ESP8266 firmware.

## Commands

Run from the repo root with `bun`:

- `bun install` — install deps
- `bun run dev` — Next.js dev server on port 3000 (tees to `dev.log`)
- `bun run build` — production build (`next build`, standalone output), then copies `.next/static` and `public/` into `.next/standalone/`
- `bun run start` — run the built standalone server (`NODE_ENV=production bun .next/standalone/server.js`, tees to `server.log`)
- `bun run lint` — ESLint over the whole repo
- `bun run db:push` — `prisma db push --accept-data-loss` (sync schema to SQLite without a migration)
- `bun run db:generate` — regenerate the Prisma client
- `bun run db:migrate` / `bun run db:reset` — Prisma migrate dev / reset

There is no application test suite. `tests/*.sh` only test the `.zscripts/` bash build tooling (fake out `bun`/`caddy` and assert on invocation), not app behavior.

### Mini-services (must be started separately for live telemetry/fan control)

Each lives under `mini-services/<name>/` with its own `package.json` (dev script `bun --hot index.ts`):

```bash
# hub needs DEVICE_TOKEN + HUB_INTERNAL_SECRET (>=16 chars) and DATABASE_URL; simulator needs DEVICE_TOKEN
cd mini-services/iot-hub && bun install && bun run dev        # WebSocket hub, port 3003
cd mini-services/esp-simulator && bun install && bun run dev  # simulated devices, port 3004
```

Without the hub running, the Next.js app still serves the dashboard and REST API against whatever is already in the DB, but degrades gracefully (WS shows "RECONNECTING", fan commands are persisted and return 202 `queued`). Without the simulator, no new telemetry/devices are produced — the hub just has nothing registering.

`.zscripts/dev.sh` / `.zscripts/start.sh` / `.zscripts/mini-services-*.sh` automate installing + starting Next.js and every `mini-services/*` subfolder together, but assume a Linux sandbox layout (hardcoded `/home/z/my-project`, `/app/...` paths, Chinese-language logging) from the original deployment scaffold — treat them as reference/CI tooling, not the normal local dev path on this machine.

## Architecture

**Single-page dashboard.** The entire user-facing UI is `src/app/page.tsx` — there are no other routes. It composes a sticky header (live clock, WS status pill), a 6-card KPI strip, a responsive device grid, a sensor-history chart with device/range/metric pickers, a recent-readings table, and a device-detail Sheet.

**Three runtime processes, one DB:**

```
ESP8266 simulator (mini-services/esp-simulator, :3004)
        │  socket.io client → device:register, telemetry, command:ack
        ▼
IoT hub (mini-services/iot-hub, :3003)  ── Prisma ──▶  SQLite (db/custom.db)
        │  socket.io broadcast → snapshot, telemetry, device:status, fan:state, command:ack
        ▼
Next.js dashboard (src/app/page.tsx, :3000)
        │  REST: GET /api/devices, /api/devices/[id], /api/devices/[id]/history,
        │        /api/devices/[id]/health, /api/devices/[id]/commands, /api/stats
        │  POST /api/devices/[id]/fan, PUT /api/devices/[id]/config → persist to DB first,
        │        then forwardFanCommand()/notifyConfigUpdate() socket.io calls into the hub
        │        (800ms hard timeout; hub unreachable ⇒ still persisted, HTTP 202 "queued")
        ▼
Caddy (Docker, :80/:443, Caddyfile) — basic_auth for all web routes; `/socket.io/*` → iot-hub:3003
        (adds the `x-hub-secret` header), everything else → frontend:3000. The ESP8266 bypasses
        Caddy and connects to the hub directly on :3003 with `?token=<DEVICE_TOKEN>`.
```

Hub sockets are authenticated in `io.use` (device token or `x-hub-secret`) and role-gated per event. Production runs via `docker-compose.yml` (migrate → frontend + iot-hub + caddy; simulator only under `--profile dev`); see README.md and `.env.example`. Socket.IO path is the default `/socket.io/`.

The mini-services mirror the shared contract types locally (they're self-contained Bun projects, not part of the Next.js TS project) — keep `src/lib/iot-contracts.ts` and each `mini-services/*/index.ts`'s inline types in sync by hand when changing the wire format.

**Key files:**
- `src/lib/iot-contracts.ts` — the single source of truth for DTO shapes (`DeviceDTO`, `SensorReadingDTO`, `CommandLogDTO`), payload shapes, and the `IoTEvents` socket.io event-name constants. Read this first before touching any API route, the hub, or the simulator.
- `src/lib/iot-hub-client.ts` — Prisma-row → DTO mappers (`toDeviceDTO`, `toSensorReadingDTO`, `toCommandLogDTO`) and `forwardFanCommand()`, the only bridge from a Next.js API route to the hub.
- `src/lib/db.ts` — Prisma client singleton (`globalForPrisma` pattern for dev hot-reload).
- `prisma/schema.prisma` — SQLite via `DATABASE_URL`. Models: `Device`, `SensorReading`, `CommandLog` (plus unused scaffold leftovers `User`/`Post`). `Device` caches the latest telemetry directly on the row for fast dashboard loads; `SensorReading` is the time series; `CommandLog` tracks fan-command lifecycle (`pending → sent → acknowledged|failed`).
- `src/hooks/use-iot-store.ts` — Zustand store; single source of truth for devices/stats/connection state on the client. WS frames are merged in by device id; `recomputeStats()` re-derives KPIs from the live device list between `/api/stats` polls.
- `src/hooks/use-iot-socket.tsx` — the dashboard's socket.io-client connection and WS→store wiring.
- `src/components/iot/*` — dashboard building blocks (device cards, history chart, readings table, detail sheet, status indicators). `src/components/ui/*` is shadcn/ui — treat as generated/vendor, prefer composing over editing.

**Conventions to preserve:**
- Route handlers use the Next 16 async params signature: `{ params }: { params: Promise<{ id: string }> }`, then `await params`.
- API routes return `NextResponse.json`, convert all `Date` fields to ISO strings via the DTO mappers, wrap DB calls in try/catch → 500 `{ error: "internal_error" }`, and use `{ error: "device_not_found" }` for 404s.
- `forwardFanCommand` (hub calls from API routes) must never block the response for more than ~800ms — hub-unreachable is a normal, handled case (503), not an exception path to avoid.
- Client components rely on the WS broadcast (`fan:state`/`command:ack`) for final state after a `POST /fan`, not an optimistic local update.
- Color semantics: emerald = online/on, rose = offline/hot, amber = warning, teal = humidity, `--chart-1`/`--chart-3` for temp/humidity series. No indigo/blue.
- ESLint (`eslint.config.mjs`) deliberately disables most strictness (`no-explicit-any`, `no-unused-vars`, `exhaustive-deps`, etc.) on top of `eslint-config-next` — don't assume a lint pass implies type or dependency correctness.
- `next.config.ts` sets `typescript.ignoreBuildErrors: true` and `reactStrictMode: false` — `bun run build` will succeed even with type errors; don't rely on the build to catch them.

**Local DB note:** `.env` is git-ignored — copy `.env.example`. An older local `.env` may hold a leftover absolute `DATABASE_URL`; check it before relying on `bun run db:push` or the mini-services connecting to the right SQLite file locally.

**Deployment:** `docker-compose.yml` runs `migrate` (one-shot `prisma db push`), `frontend` (internal :3000), `iot-hub` (public :3003, own `mini-services/iot-hub/Dockerfile`, built from the repo root so it can generate Prisma from the root schema) and `caddy` (:80/:443), all sharing the `iot-data` volume (`file:/app/data/dev.db`, WAL). `esp-simulator` is under `profiles: ["dev"]`.
