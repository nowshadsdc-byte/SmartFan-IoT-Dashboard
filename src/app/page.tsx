"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Toaster as SonnerToaster } from "sonner";
import {
  Fan,
  RefreshCw,
  Wind,
  AlertCircle,
  Cpu,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { LiveIndicator } from "@/components/iot/live-indicator";
import { StatsStrip } from "@/components/iot/stats-strip";
import { DeviceCard } from "@/components/iot/device-card";
import { DeviceDetailDialog } from "@/components/iot/device-detail-dialog";
import { HistoryChart } from "@/components/iot/history-chart";
import { ReadingsTable } from "@/components/iot/readings-table";
import { useIotSocket } from "@/hooks/use-iot-socket";
import { useIotStore } from "@/hooks/use-iot-store";
import type { DeviceDTO } from "@/lib/iot-contracts";

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export default function Home() {
  // Activate the WebSocket connection (the hook handles reconnection).
  useIotSocket();

  const devices = useIotStore((s) => s.devices);
  const connection = useIotStore((s) => s.connection);
  const loading = useIotStore((s) => s.loading);
  const error = useIotStore((s) => s.error);
  const setDevices = useIotStore((s) => s.setDevices);
  const setStats = useIotStore((s) => s.setStats);
  const setLoading = useIotStore((s) => s.setLoading);
  const setError = useIotStore((s) => s.setError);

  const [openDeviceId, setOpenDeviceId] = useState<string | null>(null);
  const [chartDeviceId, setChartDeviceId] = useState<string | undefined>();
  const [refreshing, setRefreshing] = useState(false);
  const now = useClock();
  const firstLoad = useRef(true);

  // Initial fetch + 10s stats polling fallback.
  async function fetchDevices() {
    try {
      const r = await fetch("/api/devices");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { devices: DeviceDTO[] };
      setDevices(data.devices ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load devices");
    }
  }

  async function fetchStats() {
    try {
      const r = await fetch("/api/stats");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setStats(data);
    } catch {
      // The store recomputes from device list as a fallback.
    }
  }

  // Bootstrap on first mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await Promise.all([fetchDevices(), fetchStats()]);
      if (!cancelled) setLoading(false);
      firstLoad.current = false;
    })();
    return () => {
      cancelled = true;
    };
    // Empty deps: only run on mount.
  }, []);

  // Poll stats every 10s as a WS fallback.
  useEffect(() => {
    const id = setInterval(() => {
      void fetchStats();
    }, 10_000);
    return () => clearInterval(id);
    // Empty deps: the interval is stable.
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    await Promise.all([fetchDevices(), fetchStats()]);
    setRefreshing(false);
  }

  const openDevice: DeviceDTO | null = openDeviceId
    ? devices.find((d) => d.id === openDeviceId) ?? null
    : null;

  const year = now.getFullYear();

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <style>{`
        .custom-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
        .custom-scroll::-webkit-scrollbar-track { background: transparent; }
        .custom-scroll::-webkit-scrollbar-thumb {
          background: color-mix(in oklab, var(--muted-foreground) 30%, transparent);
          border-radius: 9999px;
        }
        .custom-scroll::-webkit-scrollbar-thumb:hover {
          background: color-mix(in oklab, var(--muted-foreground) 50%, transparent);
        }
      `}</style>

      <SonnerToaster position="top-right" richColors closeButton />

      {/* Header */}
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
              <Fan className="size-5" />
            </span>
            <div className="leading-tight">
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold tracking-tight sm:text-lg">
                  SmartFan IoT
                </h1>
                <Badge variant="secondary" className="hidden text-[10px] sm:inline-flex">
                  Dashboard
                </Badge>
              </div>
              <p className="hidden text-[10px] text-muted-foreground sm:block">
                Real-time fleet monitoring & remote fan control
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <div className="hidden font-mono text-xs tabular-nums text-muted-foreground sm:block">
              {now.toLocaleTimeString()}
            </div>
            <LiveIndicator connected={connection === "connected"} />
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={refreshing}
              aria-label="Refresh dashboard"
              className="h-9"
            >
              <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 px-4 py-6 sm:px-6 sm:py-8">
        {/* Stats strip */}
        <StatsStrip />

        {/* Devices section */}
        <section aria-label="Devices" className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              <Cpu className="size-4" />
              Devices
              <span className="ml-1 text-xs font-medium text-muted-foreground/70">
                ({devices.length})
              </span>
            </h2>
          </div>

          {error ? (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>Couldn&apos;t load devices</AlertTitle>
              <AlertDescription>
                {error}
              </AlertDescription>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={handleRefresh}
              >
                <RefreshCw className="size-4" />
                Retry
              </Button>
            </Alert>
          ) : loading && devices.length === 0 ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Card key={i} className="gap-0 p-0">
                  <div className="border-b p-4">
                    <Skeleton className="h-5 w-32" />
                    <Skeleton className="mt-2 h-3 w-20" />
                  </div>
                  <div className="p-4">
                    <Skeleton className="h-12 w-12 rounded-full" />
                  </div>
                  <div className="grid grid-cols-3 gap-2 px-4 pb-3">
                    {Array.from({ length: 3 }).map((_, j) => (
                      <Skeleton key={j} className="h-14" />
                    ))}
                  </div>
                  <div className="border-t p-4">
                    <div className="grid grid-cols-2 gap-2">
                      <Skeleton className="h-10" />
                      <Skeleton className="h-10" />
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          ) : devices.length === 0 ? (
            <Card className="flex flex-col items-center justify-center gap-3 p-12 text-center">
              <span className="flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Wind className="size-7" />
              </span>
              <div>
                <p className="text-base font-medium">No devices registered yet</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Start the ESP8266 simulator to see devices appear here in real time.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={handleRefresh}>
                <RefreshCw className="size-4" />
                Refresh
              </Button>
            </Card>
          ) : (
            <motion.div
              layout
              className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
            >
              <AnimatePresence mode="popLayout">
                {devices.map((d) => (
                  <DeviceCard
                    key={d.id}
                    device={d}
                    onOpenDetails={(dev) => setOpenDeviceId(dev.id)}
                  />
                ))}
              </AnimatePresence>
            </motion.div>
          )}
        </section>

        {/* History + readings section */}
        {devices.length > 0 && (
          <section aria-label="History & readings" className="space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              <Wind className="size-4" />
              Telemetry History
            </h2>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <HistoryChart
                className="lg:col-span-2"
                onDeviceChange={(id) => setChartDeviceId(id)}
              />
              <ReadingsTable deviceId={chartDeviceId} className="lg:col-span-1" />
            </div>
          </section>
        )}
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t bg-background/95">
        <div className="mx-auto flex w-full max-w-7xl flex-col items-center justify-between gap-2 px-4 py-4 text-xs text-muted-foreground sm:flex-row sm:px-6">
          <div className="flex items-center gap-1.5">
            <Fan className="size-3.5" />
            <span>SmartFan IoT Platform • ESP8266 + Next.js</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline">© {year} SmartFan.</span>
            <LiveIndicator
              connected={connection === "connected"}
              compact
            />
          </div>
        </div>
      </footer>

      {/* Device detail sheet */}
      <DeviceDetailDialog
        deviceId={openDevice?.id ?? null}
        open={openDeviceId !== null}
        onOpenChange={(o) => !o && setOpenDeviceId(null)}
      />
    </div>
  );
}
