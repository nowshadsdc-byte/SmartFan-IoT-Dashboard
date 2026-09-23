"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
  Area,
  AreaChart,
} from "recharts";
import { format, isToday, isThisYear } from "date-fns";
import { Thermometer, Droplets, Loader2, Activity } from "lucide-react";
import { motion } from "framer-motion";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { useIotStore } from "@/hooks/use-iot-store";
import type { SensorReadingDTO } from "@/lib/iot-contracts";
import { cn } from "@/lib/utils";

type Range = "1h" | "6h" | "24h" | "7d";
type Metric = "temperature" | "humidity";

const RANGE_OPTIONS: { value: Range; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
];

const METRIC_TABS: { value: Metric; label: string; icon: typeof Thermometer }[] = [
  { value: "temperature", label: "Temperature", icon: Thermometer },
  { value: "humidity", label: "Humidity", icon: Droplets },
];

const chartConfig = {
  temperature: {
    label: "Temperature (°C)",
    color: "var(--chart-1)",
  },
  humidity: {
    label: "Humidity (%)",
    color: "var(--chart-3)",
  },
} satisfies ChartConfig;

function formatTick(iso: string, range: Range): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (range === "7d") return format(d, "EEE HH:mm");
  if (range === "24h") return format(d, "HH:mm");
  return format(d, "HH:mm:ss");
}

function formatTooltipLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (isToday(d)) return format(d, "HH:mm:ss");
  if (isThisYear(d)) return format(d, "MMM d, HH:mm");
  return format(d, "MMM d yyyy, HH:mm");
}

interface HistoryChartProps {
  /** Optional pre-selected device id (e.g. when opened from device detail). */
  initialDeviceId?: string;
  /** Compact mode renders without the device selector (used inside dialogs). */
  hideDeviceSelector?: boolean;
  /** Locked device id — when provided, no dropdown is shown. */
  deviceId?: string;
  /** Allow parent to observe the active device id. */
  onDeviceChange?: (id: string) => void;
  className?: string;
  defaultRange?: Range;
}

export function HistoryChart({
  initialDeviceId,
  hideDeviceSelector,
  deviceId: lockedDeviceId,
  onDeviceChange,
  className,
  defaultRange = "1h",
}: HistoryChartProps) {
  const devices = useIotStore((s) => s.devices);

  const [explicitId, setExplicitId] = useState<string | undefined>(
    lockedDeviceId ?? initialDeviceId,
  );
  const [range, setRange] = useState<Range>(defaultRange);
  const [metric, setMetric] = useState<Metric>("temperature");
  const [readings, setReadings] = useState<SensorReadingDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pick a sensible default device when none is locked yet. Using derived
  // state avoids setState-in-effect cascades for the auto-pick path.
  const fallbackId = useMemo(() => {
    const firstOnline = devices.find((d) => d.status === "online");
    return (firstOnline ?? devices[0])?.id;
  }, [devices]);

  const effectiveId = lockedDeviceId ?? explicitId ?? fallbackId;

  // Notify the parent of the resolved device id (no local setState here).
  useEffect(() => {
    if (effectiveId) onDeviceChange?.(effectiveId);
  }, [effectiveId, onDeviceChange]);

  // Fetch history whenever device or range changes. All setState calls live
  // inside the async IIFE so the linter doesn't flag cascading renders.
  useEffect(() => {
    if (!effectiveId) return;
    const controller = new AbortController();
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(
          `/api/devices/${effectiveId}/history?range=${range}`,
          { signal: controller.signal },
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as { readings: SensorReadingDTO[] };
        if (!cancelled) {
          setReadings(data.readings ?? []);
        }
      } catch (e: unknown) {
        if (cancelled) return;
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed to load history");
        setReadings([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [effectiveId, range]);

  const chartData = useMemo(
    () =>
      readings
        .slice()
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
        .map((r) => ({
          time: r.createdAt,
          temperature: Number(r.temperature?.toFixed(2)),
          humidity: Number(r.humidity?.toFixed(1)),
        })),
    [readings],
  );

  const selectedDevice = devices.find((d) => d.id === effectiveId);

  return (
    <Card className={cn("h-full gap-0 py-0", className)}>
      <CardHeader className="gap-3 border-b p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="size-4 text-emerald-600" />
              Sensor History
            </CardTitle>
            <CardDescription className="text-xs">
              {selectedDevice
                ? `${selectedDevice.name} • ${selectedDevice.location}`
                : "Select a device"}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!hideDeviceSelector && !lockedDeviceId && (
              <Select
                value={effectiveId}
                onValueChange={(v) => {
                  setExplicitId(v);
                  onDeviceChange?.(v);
                }}
              >
                <SelectTrigger className="h-9 min-w-[180px]" aria-label="Select device">
                  <SelectValue placeholder="Select device" />
                </SelectTrigger>
                <SelectContent>
                  {devices.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      <span className="flex items-center gap-2">
                        <span
                          className={cn(
                            "size-1.5 rounded-full",
                            d.status === "online" ? "bg-emerald-500" : "bg-rose-500",
                          )}
                        />
                        {d.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <ToggleGroup
              type="single"
              value={range}
              onValueChange={(v: string) => {
                if (v) setRange(v as Range);
              }}
              variant="outline"
              size="sm"
              aria-label="History range"
            >
              {RANGE_OPTIONS.map((opt) => (
                <ToggleGroupItem key={opt.value} value={opt.value} className="px-3">
                  {opt.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {METRIC_TABS.map((tab) => {
            const Icon = tab.icon;
            const active = metric === tab.value;
            return (
              <button
                key={tab.value}
                type="button"
                onClick={() => setMetric(tab.value)}
                aria-pressed={active}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-accent",
                )}
              >
                <Icon className="size-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </CardHeader>

      <CardContent className="p-2 sm:p-4">
        {loading ? (
          <div className="flex h-[280px] items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            <span className="ml-2 text-sm">Loading history…</span>
          </div>
        ) : error ? (
          <div className="flex h-[280px] items-center justify-center text-sm text-rose-600">
            {error}
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
            No readings in this range yet.
          </div>
        ) : (
          <motion.div
            key={`${effectiveId}-${range}-${metric}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.25 }}
          >
            <ChartContainer
              config={chartConfig}
              className="h-[280px] w-full aspect-auto"
            >
              {metric === "temperature" ? (
                <AreaChart data={chartData} margin={{ top: 10, right: 12, bottom: 0, left: -8 }}>
                  <defs>
                    <linearGradient id="fillTemp" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="time"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    minTickGap={24}
                    tickFormatter={(v: string) => formatTick(v, range)}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={40}
                    tickMargin={4}
                    unit="°"
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        labelFormatter={(_, payload) =>
                          payload?.[0]?.payload?.time
                            ? formatTooltipLabel(payload[0].payload.time)
                            : ""
                        }
                      />
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="temperature"
                    stroke="var(--chart-1)"
                    strokeWidth={2}
                    fill="url(#fillTemp)"
                    dot={false}
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                </AreaChart>
              ) : (
                <LineChart data={chartData} margin={{ top: 10, right: 12, bottom: 0, left: -8 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="time"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    minTickGap={24}
                    tickFormatter={(v: string) => formatTick(v, range)}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={40}
                    tickMargin={4}
                    unit="%"
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        labelFormatter={(_, payload) =>
                          payload?.[0]?.payload?.time
                            ? formatTooltipLabel(payload[0].payload.time)
                            : ""
                        }
                      />
                    }
                  />
                  <Line
                    type="monotone"
                    dataKey="humidity"
                    stroke="var(--chart-3)"
                    strokeWidth={2}
                    dot={false}
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                </LineChart>
              )}
            </ChartContainer>
          </motion.div>
        )}
      </CardContent>
    </Card>
  );
}
