"use client";

import {
  Cpu,
  Wifi,
  Fan,
  Thermometer,
  Droplets,
  Clock,
  type LucideIcon,
} from "lucide-react";
import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useIotStore, type DashboardStats } from "@/hooks/use-iot-store";
import { formatDistanceToNowStrict } from "date-fns";
import { cn } from "@/lib/utils";

interface StatCardDef {
  key: string;
  label: string;
  icon: LucideIcon;
  accent: string; // tailwind text color class for the icon
  value: (s: DashboardStats) => string;
  hint?: (s: DashboardStats) => string;
}

const CARDS: StatCardDef[] = [
  {
    key: "total",
    label: "Total Devices",
    icon: Cpu,
    accent: "text-foreground",
    value: (s) => String(s.totalDevices),
    hint: (s) =>
      `${s.onlineDevices} online · ${s.offlineDevices} offline`,
  },
  {
    key: "online",
    label: "Online",
    icon: Wifi,
    accent: "text-emerald-600",
    value: (s) => String(s.onlineDevices),
    hint: (s) =>
      s.totalDevices === 0
        ? "—"
        : `${Math.round((s.onlineDevices / s.totalDevices) * 100)}% of fleet`,
  },
  {
    key: "fans",
    label: "Fans Running",
    icon: Fan,
    accent: "text-emerald-600",
    value: (s) => String(s.fansOn),
    hint: (s) => `${s.fansOff} idle`,
  },
  {
    key: "temp",
    label: "Avg Temperature",
    icon: Thermometer,
    accent: "text-rose-600",
    value: (s) =>
      s.totalDevices === 0 ? "—" : `${s.avgTemperature.toFixed(1)}°C`,
  },
  {
    key: "humidity",
    label: "Avg Humidity",
    icon: Droplets,
    accent: "text-teal-600",
    value: (s) =>
      s.totalDevices === 0 ? "—" : `${s.avgHumidity.toFixed(1)}%`,
  },
  {
    key: "last",
    label: "Last Activity",
    icon: Clock,
    accent: "text-muted-foreground",
    value: (s) =>
      s.lastActivityAt ? formatDistanceToNowStrict(new Date(s.lastActivityAt)) : "—",
    hint: (s) => (s.lastActivityAt ? "ago" : "no readings yet"),
  },
];

export function StatsStrip() {
  const stats = useIotStore((s) => s.stats);
  const loading = useIotStore((s) => s.loading);

  return (
    <section
      aria-label="Fleet KPIs"
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
    >
      {CARDS.map((card, idx) => {
        const Icon = card.icon;
        return (
          <motion.div
            key={card.key}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: idx * 0.04 }}
          >
            <Card className="gap-0 px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {card.label}
                </span>
                <span
                  className={cn(
                    "flex size-7 items-center justify-center rounded-md bg-muted",
                    card.accent,
                  )}
                >
                  <Icon className="size-3.5" />
                </span>
              </div>
              {loading || !stats ? (
                <div className="mt-2 space-y-1.5">
                  <Skeleton className="h-7 w-16" />
                  <Skeleton className="h-3 w-20" />
                </div>
              ) : (
                <div className="mt-1.5">
                  <div
                    className={cn(
                      "text-2xl font-semibold tracking-tight tabular-nums",
                      card.accent,
                    )}
                  >
                    {card.value(stats)}
                  </div>
                  {card.hint && (
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {card.hint(stats)}
                    </div>
                  )}
                </div>
              )}
            </Card>
          </motion.div>
        );
      })}
    </section>
  );
}
