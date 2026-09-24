"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { CommandAction, DeviceDTO } from "@/lib/iot-contracts";

const LABEL: Record<CommandAction, string> = {
  on: "Fan ON",
  off: "Fan OFF",
  auto: "Auto mode",
};

/**
 * POST /api/devices/[id]/fan. The dashboard never updates optimistically:
 * final state arrives via the WS broadcasts (device:config / fan:state / command:ack).
 * on/off switch the device to manual mode; auto switches back.
 */
export function useFanAction(device: DeviceDTO) {
  const [pending, setPending] = useState<CommandAction | null>(null);

  async function send(action: CommandAction) {
    setPending(action);
    try {
      const res = await fetch(`/api/devices/${device.id}/fan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      if (res.status === 202) {
        toast.info(`${LABEL[action]} queued for ${device.name}`, {
          description: "The device is offline — it will be applied when it reconnects.",
        });
      } else {
        toast.success(`${LABEL[action]} command sent for ${device.name}`, {
          description: "Waiting for the device to acknowledge.",
        });
      }
    } catch (e) {
      toast.error(`Failed to send ${LABEL[action]}`, {
        description: e instanceof Error ? e.message : "Unknown error",
      });
    } finally {
      setPending(null);
    }
  }

  return { pending, send };
}
