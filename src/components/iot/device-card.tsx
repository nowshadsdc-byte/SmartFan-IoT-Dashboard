"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  MapPin,
  Thermometer,
  Droplets,
  Signal,
  Clock,
  ChevronRight,
  Loader2,
  Power,
  Wifi,
  WifiOff,
} from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { FanIcon } from "@/components/iot/fan-icon";
import type { DeviceDTO } from "@/lib/iot-contracts";
import { cn } from "@/lib/utils";

interface DeviceCardProps {
  device: DeviceDTO;
  onOpenDetails: (device: DeviceDTO) => void;
}

/** Format seconds as "Xh Ym" or "Ym Zs" for short uptimes. */
function formatUptime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "—";
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Map RSSI (dBm) to 0–4 bars. */
function rssiBars(rssi: number): number {
  if (rssi >= -55) return 4;
  if (rssi >= -65) return 3;
  if (rssi >= -72) return 2;
  if (rssi >= -80) return 1;
  return 0;
}

function SignalBars({ rssi }: { rssi: number }) {
  const bars = rssiBars(rssi);
  const tone =
    bars >= 3
      ? "bg-emerald-500"
      : bars === 2
        ? "bg-amber-500"
        : "bg-rose-500";
  return (
    <div className="flex items-end gap-0.5" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className={cn(
            "w-1 rounded-sm",
            i === 0 && "h-1.5",
            i === 1 && "h-2.5",
            i === 2 && "h-3.5",
            i === 3 && "h-4",
            i >= bars ? "bg-muted-foreground/30" : tone,
          )}
        />
      ))}
    </div>
  );
}

function tempTone(t: number) {
  if (t >= 30) return "text-rose-600";
  if (t >= 25) return "text-amber-600";
  return "text-foreground";
}

export function DeviceCard({ device, onOpenDetails }: DeviceCardProps) {
  const [pending, setPending] = useState<"on" | "off" | null>(null);
  const isOnline = device.status === "online";
  const fanOn = device.fanStatus === "on";

  async function handleFan(action: "on" | "off") {
    setPending(action);
    try {
      const res = await fetch(`/api/devices/${device.id}/fan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      toast.success(
        action === "on"
          ? `Fan ON command sent for ${device.name}`
          : `Fan OFF command sent for ${device.name}`,
        {
          description:
            "Waiting for the device to acknowledge (watch the live feed).",
        },
      );
      // Optimistically reflect the pending state until the WS ack lands.
      if (data?.status && data.status !== "acknowledged") {
        // The hub will broadcast a fan:state / command:ack soon.
      }
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Unknown error";
      toast.error(`Failed to ${action === "on" ? "turn on" : "turn off"} fan`, {
        description: message,
      });
    } finally {
      setPending(null);
    }
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.25 }}
      className="h-full"
    >
      <Card className="h-full gap-0 p-0">
        {/* Header row */}
        <div className="flex items-start justify-between gap-2 border-b p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-base font-semibold">
                {device.name}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
              <MapPin className="size-3" />
              <span className="truncate">{device.location || "Unknown"}</span>
            </div>
          </div>
          {isOnline ? (
            <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
              <span className="relative mr-1 inline-flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
              Online
            </Badge>
          ) : (
            <Badge
              variant="destructive"
              className="border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300"
            >
              <WifiOff className="size-3" />
              Offline
            </Badge>
          )}
        </div>

        {/* Fan status pill + temperature row */}
        <div className="flex items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3">
            <FanIcon
              spinning={fanOn && isOnline}
              className="size-10 rounded-lg bg-muted p-2"
              colorClassName={fanOn ? "text-emerald-600" : "text-muted-foreground"}
            />
            <div>
              <div className="text-xs text-muted-foreground">Fan</div>
              <div
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-semibold",
                  fanOn
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {fanOn ? "ON" : "OFF"}
              </div>
            </div>
          </div>

          <div className="text-right">
            <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
              <Thermometer className="size-3" /> Temperature
            </div>
            <div
              className={cn(
                "text-3xl font-bold tabular-nums",
                tempTone(device.temperature ?? 0),
              )}
            >
              {Number.isFinite(device.temperature)
                ? device.temperature.toFixed(1)
                : "—"}
              <span className="ml-0.5 text-base font-medium text-muted-foreground">
                °C
              </span>
            </div>
          </div>
        </div>

        {/* Telemetry mini-grid */}
        <div className="grid grid-cols-3 gap-2 px-4 pb-3">
          <Telemetry
            icon={<Droplets className="size-3.5 text-teal-600" />}
            label="Humidity"
            value={
              Number.isFinite(device.humidity)
                ? `${device.humidity.toFixed(0)}%`
                : "—"
            }
          />
          <Telemetry
            icon={<Signal className="size-3.5 text-muted-foreground" />}
            label="Signal"
            value={
              Number.isFinite(device.rssi) ? `${device.rssi} dBm` : "—"
            }
            extra={<SignalBars rssi={device.rssi ?? -100} />}
          />
          <Telemetry
            icon={<Clock className="size-3.5 text-muted-foreground" />}
            label="Uptime"
            value={formatUptime(device.uptimeSeconds ?? 0)}
          />
        </div>

        {/* Last seen + command footer */}
        <div className="mt-auto border-t p-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              {isOnline ? (
                <Wifi className="size-3 text-emerald-600" />
              ) : (
                <WifiOff className="size-3 text-rose-500" />
              )}
              Last seen{" "}
              {device.lastSeenAt
                ? `${formatDistanceToNowStrict(new Date(device.lastSeenAt))} ago`
                : "—"}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="font-mono text-[10px]">
                  {device.ipAddress || "—"}
                </span>
              </TooltipTrigger>
              <TooltipContent>IP address</TooltipContent>
            </Tooltip>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              className={cn(
                "h-10 bg-emerald-600 text-white shadow-sm hover:bg-emerald-700",
                (fanOn || !isOnline || pending === "on") &&
                  "opacity-100 disabled:cursor-not-allowed disabled:opacity-50",
              )}
              disabled={fanOn || !isOnline || pending !== null}
              onClick={() => handleFan("on")}
              aria-label={`Turn fan on for ${device.name}`}
            >
              {pending === "on" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Power className="size-4" />
              )}
              Turn ON
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-10"
              disabled={!fanOn || !isOnline || pending !== null}
              onClick={() => handleFan("off")}
              aria-label={`Turn fan off for ${device.name}`}
            >
              {pending === "off" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Power className="size-4" />
              )}
              Turn OFF
            </Button>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-2 h-9 w-full justify-between text-xs"
            onClick={() => onOpenDetails(device)}
            aria-label={`Open details for ${device.name}`}
          >
            View device details, health & history
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </Card>
    </motion.div>
  );
}

function Telemetry({
  icon,
  label,
  value,
  extra,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border bg-muted/40 px-2.5 py-2">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 flex items-end gap-1.5">
        <span className="text-sm font-semibold tabular-nums">{value}</span>
        {extra}
      </div>
    </div>
  );
}
