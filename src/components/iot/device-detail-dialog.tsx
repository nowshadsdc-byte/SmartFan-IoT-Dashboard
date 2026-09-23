"use client";

import { useEffect, useState } from "react";
import { format, formatDistanceToNowStrict } from "date-fns";
import {
  Activity,
  Cpu,
  Globe,
  HardDrive,
  Loader2,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Wrench,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { HistoryChart } from "@/components/iot/history-chart";
import { FanIcon } from "@/components/iot/fan-icon";
import { useIotStore } from "@/hooks/use-iot-store";
import type {
  CommandLogDTO,
  DeviceDTO,
} from "@/lib/iot-contracts";
import { cn } from "@/lib/utils";

interface DeviceHealth {
  status: string;
  lastSeenAgoSeconds: number;
  signalQuality: "excellent" | "good" | "fair" | "poor" | "unknown";
  uptimeSeconds: number;
  firmwareVersion: string;
  ipAddress: string;
  recentReadingsCount: number;
  avgRssi: number;
  message: string;
}

interface DeviceDetailDialogProps {
  deviceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatUptime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "—";
  const s = Math.floor(totalSeconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const signalMeta: Record<
  DeviceHealth["signalQuality"],
  { label: string; tone: string; icon: typeof ShieldCheck }
> = {
  excellent: {
    label: "Excellent",
    tone: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
    icon: ShieldCheck,
  },
  good: {
    label: "Good",
    tone: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
    icon: ShieldCheck,
  },
  fair: {
    label: "Fair",
    tone: "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
    icon: ShieldAlert,
  },
  poor: {
    label: "Poor",
    tone: "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300",
    icon: ShieldAlert,
  },
  unknown: {
    label: "Unknown",
    tone: "text-muted-foreground",
    icon: ShieldX,
  },
};

function InfoRow({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Cpu;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

function commandStatusTone(status: string): string {
  switch (status) {
    case "acknowledged":
      return "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300";
    case "pending":
      return "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300";
    case "failed":
      return "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300";
    case "sent":
      return "border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300";
    default:
      return "text-muted-foreground";
  }
}

export function DeviceDetailDialog({
  deviceId,
  open,
  onOpenChange,
}: DeviceDetailDialogProps) {
  // Live device state from the store so the sheet reflects WS updates.
  const device = useIotStore((s) =>
    deviceId ? s.devices.find((d) => d.id === deviceId) ?? null : null,
  ) as DeviceDTO | null;

  const [health, setHealth] = useState<DeviceHealth | null>(null);
  const [commands, setCommands] = useState<CommandLogDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !deviceId) return;
    const controller = new AbortController();
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [h, c] = await Promise.all([
          fetch(`/api/devices/${deviceId}/health`, { signal: controller.signal }).then((r) => r.json()),
          fetch(`/api/devices/${deviceId}/commands?limit=20`, { signal: controller.signal }).then((r) => r.json()),
        ]);
        if (cancelled) return;
        setHealth(h?.health ?? null);
        setCommands(c?.commands ?? []);
      } catch (e: unknown) {
        if (cancelled) return;
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed to load details");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, deviceId]);

  const signal = health ? signalMeta[health.signalQuality] : signalMeta.unknown;
  const SignalIcon = signal.icon;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto p-0 sm:max-w-lg lg:max-w-2xl"
      >
        <SheetHeader className="border-b p-5 pb-4 pr-12">
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "flex size-10 items-center justify-center rounded-lg",
                device?.fanStatus === "on"
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                  : "bg-muted text-muted-foreground",
              )}
            >
              <FanIcon
                spinning={device?.fanStatus === "on"}
                className="size-6"
              />
            </span>
            <div>
              <SheetTitle className="text-base">
                {device?.name ?? "Device details"}
              </SheetTitle>
              <SheetDescription className="text-xs">
                {device?.location} •{" "}
                <span className="font-mono">{device?.macAddress}</span>
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="space-y-5 p-5 pt-4">
          {!device ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              No device selected.
            </div>
          ) : loading && !health ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span className="ml-2">Loading health & commands…</span>
            </div>
          ) : error ? (
            <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300">
              {error}
            </div>
          ) : (
            <>
              {/* Health summary banner */}
              <div
                className={cn(
                  "flex items-start gap-3 rounded-lg border p-3",
                  signal.tone,
                )}
              >
                <SignalIcon className="mt-0.5 size-5 shrink-0" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">
                      {health ? signal.label : "—"} signal
                    </span>
                    {health && (
                      <span className="text-xs opacity-80">
                        avg {health.avgRssi ?? device.rssi} dBm
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs opacity-90">
                    {health?.message ?? "No health message available."}
                  </p>
                </div>
              </div>

              {/* Info grid */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-2">
                <InfoRow
                  icon={Cpu}
                  label="Firmware"
                  value={device.firmwareVersion || "—"}
                />
                <InfoRow
                  icon={Globe}
                  label="IP Address"
                  value={device.ipAddress || "—"}
                />
                <InfoRow
                  icon={HardDrive}
                  label="MAC Address"
                  value={
                    <span className="font-mono text-xs">
                      {device.macAddress || "—"}
                    </span>
                  }
                />
                <InfoRow
                  icon={Wrench}
                  label="Registered"
                  value={
                    device.registeredAt
                      ? format(new Date(device.registeredAt), "MMM d, yyyy")
                      : "—"
                  }
                />
                <InfoRow
                  icon={Activity}
                  label="Last seen"
                  value={
                    device.lastSeenAt
                      ? `${formatDistanceToNowStrict(new Date(device.lastSeenAt))} ago`
                      : "—"
                  }
                />
                <InfoRow
                  icon={Cpu}
                  label="Uptime"
                  value={formatUptime(
                    health?.uptimeSeconds ?? device.uptimeSeconds ?? 0,
                  )}
                />
                <InfoRow
                  icon={Activity}
                  label="Readings (1h)"
                  value={health?.recentReadingsCount ?? 0}
                />
                <InfoRow
                  icon={Activity}
                  label="Status"
                  value={
                    <Badge
                      variant="outline"
                      className={cn(
                        "ml-auto",
                        device.status === "online"
                          ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
                          : "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300",
                      )}
                    >
                      {device.status}
                    </Badge>
                  }
                />
              </div>

              <Separator />

              {/* Mini history chart */}
              <div>
                <h3 className="mb-2 text-sm font-semibold">
                  Sensor history
                </h3>
                <HistoryChart
                  deviceId={device.id}
                  hideDeviceSelector
                  defaultRange="6h"
                />
              </div>

              <Separator />

              {/* Recent commands */}
              <div>
                <h3 className="mb-2 text-sm font-semibold">
                  Recent commands
                </h3>
                {commands.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No commands sent to this device yet.
                  </p>
                ) : (
                  <div className="custom-scroll max-h-72 overflow-y-auto rounded-md border">
                    <Table>
                      <TableHeader className="sticky top-0 z-10 bg-card">
                        <TableRow>
                          <TableHead>Action</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Source</TableHead>
                          <TableHead className="text-right">When</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {commands.map((cmd) => (
                          <TableRow key={cmd.id}>
                            <TableCell className="font-mono uppercase">
                              {cmd.action}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={commandStatusTone(cmd.status)}
                              >
                                {cmd.status}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {cmd.source || "—"}
                            </TableCell>
                            <TableCell className="text-right text-xs text-muted-foreground">
                              {cmd.ackedAt
                                ? format(new Date(cmd.ackedAt), "HH:mm:ss")
                                : cmd.sentAt
                                  ? format(new Date(cmd.sentAt), "HH:mm:ss")
                                  : format(new Date(cmd.createdAt), "HH:mm:ss")}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
