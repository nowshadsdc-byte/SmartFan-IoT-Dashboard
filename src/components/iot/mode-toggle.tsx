"use client";

import { Bot, Hand, Loader2 } from "lucide-react";
import type { DeviceDTO } from "@/lib/iot-contracts";
import { cn } from "@/lib/utils";
import { useFanAction } from "@/components/iot/use-fan-action";

/** Auto / Manual segmented toggle. Auto → action "auto"; Manual → keep the fan as it is now, in manual mode. */
export function ModeToggle({ device, className }: { device: DeviceDTO; className?: string }) {
  const { pending, send } = useFanAction(device);
  const isAuto = device.mode === "auto";

  const seg = (active: boolean) =>
    cn(
      "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed",
      active
        ? "bg-emerald-600 text-white shadow-sm"
        : "text-muted-foreground hover:bg-background/60",
    );

  return (
    <div
      role="group"
      aria-label={`Control mode for ${device.name}`}
      className={cn("flex gap-1 rounded-lg bg-muted p-1", className)}
    >
      <button
        type="button"
        className={seg(isAuto)}
        aria-pressed={isAuto}
        disabled={isAuto || pending !== null}
        onClick={() => send("auto")}
      >
        {pending === "auto" ? <Loader2 className="size-3.5 animate-spin" /> : <Bot className="size-3.5" />}
        Auto
      </button>
      <button
        type="button"
        className={seg(!isAuto)}
        aria-pressed={!isAuto}
        disabled={!isAuto || pending !== null}
        onClick={() => send(device.fanStatus)}
      >
        {pending !== null && pending !== "auto" ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Hand className="size-3.5" />
        )}
        Manual
      </button>
    </div>
  );
}
