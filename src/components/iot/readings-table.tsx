"use client";

import { useEffect, useState } from "react";
import { format } from "date-fns";
import { Loader2, History } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useIotStore } from "@/hooks/use-iot-store";
import type { SensorReadingDTO } from "@/lib/iot-contracts";
import { cn } from "@/lib/utils";

interface ReadingsTableProps {
  deviceId: string | undefined;
  /** How many rows to show. Defaults to 20. */
  limit?: number;
  className?: string;
}

export function ReadingsTable({
  deviceId,
  limit = 20,
  className,
}: ReadingsTableProps) {
  const devices = useIotStore((s) => s.devices);
  const [readings, setReadings] = useState<SensorReadingDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!deviceId) return;
    const controller = new AbortController();
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`/api/devices/${deviceId}/history?range=24h`, {
          signal: controller.signal,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as { readings: SensorReadingDTO[] };
        if (cancelled) return;
        // Most recent first, limited to `limit` rows.
        const sorted = (data.readings ?? [])
          .slice()
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
          .slice(0, limit);
        setReadings(sorted);
      } catch (e: unknown) {
        if (cancelled) return;
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed to load readings");
        setReadings([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [deviceId, limit]);

  const device = devices.find((d) => d.id === deviceId);

  return (
    <Card className={cn("h-full gap-0 py-0", className)}>
      <CardHeader className="border-b p-4">
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="size-4 text-muted-foreground" />
          Recent Readings
        </CardTitle>
        <CardDescription className="text-xs">
          {device
            ? `${device.name} • last ${limit} entries`
            : "Select a device"}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span className="ml-2">Loading readings…</span>
          </div>
        ) : error ? (
          <div className="flex h-40 items-center justify-center text-sm text-rose-600">
            {error}
          </div>
        ) : readings.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            No readings yet.
          </div>
        ) : (
          <div className="custom-scroll max-h-96 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead className="text-right">Temp</TableHead>
                  <TableHead className="text-right">Humidity</TableHead>
                  <TableHead className="text-center">Fan</TableHead>
                  <TableHead className="text-right">RSSI</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {readings.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs text-muted-foreground">
                      {format(new Date(r.createdAt), "MMM d, HH:mm:ss")}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {Number(r.temperature).toFixed(1)}°
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {Number(r.humidity).toFixed(0)}%
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge
                        variant="outline"
                        className={cn(
                          r.fanStatus === "on"
                            ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
                            : "text-muted-foreground",
                        )}
                      >
                        {r.fanStatus === "on" ? "ON" : "OFF"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-xs">
                      {r.rssi} dBm
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
