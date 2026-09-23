"use client";

import { cn } from "@/lib/utils";

interface LiveIndicatorProps {
  /** Whether the underlying WebSocket is currently connected. */
  connected: boolean;
  className?: string;
  /** Compact mode hides the text label and just shows the dot. */
  compact?: boolean;
}

/**
 * Small pulsing dot used in the header. Turns emerald ("LIVE") when the
 * socket is connected, amber ("RECONNECTING…") otherwise.
 */
export function LiveIndicator({
  connected,
  className,
  compact = false,
}: LiveIndicatorProps) {
  const color = connected ? "bg-emerald-500" : "bg-amber-500";
  const ring = connected ? "bg-emerald-500/40" : "bg-amber-500/40";
  const label = connected ? "LIVE" : "RECONNECTING…";
  const text = connected ? "text-emerald-600" : "text-amber-600";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2",
        !compact && "rounded-full border bg-card/60 px-2.5 py-1",
        className,
      )}
      role="status"
      aria-label={label}
    >
      <span className="relative inline-flex h-2.5 w-2.5">
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
            ring,
          )}
        />
        <span
          className={cn(
            "relative inline-flex h-2.5 w-2.5 rounded-full",
            color,
          )}
        />
      </span>
      {!compact && (
        <span className={cn("text-xs font-semibold tracking-wide", text)}>
          {label}
        </span>
      )}
    </span>
  );
}
