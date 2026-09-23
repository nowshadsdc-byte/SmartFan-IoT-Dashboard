"use client";

import { useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import { toast } from "sonner";
import { CheckCircle2, XCircle } from "lucide-react";
import { IoTEvents } from "@/lib/iot-contracts";
import { useIotStore } from "@/hooks/use-iot-store";

/**
 * Establishes a socket.io connection to the IoT hub (port 3003) and
 * wires every broadcast event into the shared Zustand store.
 *
 * Connection URL uses the gateway's XTransformPort query param so Caddy
 * can route to the correct backend port without us hard-coding a host.
 */
export function useIotSocket() {
  const socketRef = useRef<Socket | null>(null);
  const setConnection = useIotStore((s) => s.setConnection);

  useEffect(() => {
    setConnection("connecting");

    const socket = io("/?XTransformPort=3003", {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10_000,
    });
    socketRef.current = socket;

    const apply = useIotStore.getState();

    socket.on("connect", () => {
      setConnection("connected");
      // Ask the hub for the current device snapshot.
      socket.emit(IoTEvents.Subscribe);
    });

    socket.on("disconnect", () => {
      setConnection("disconnected");
    });

    socket.on("connect_error", () => {
      setConnection("reconnecting");
    });

    socket.on("reconnect_attempt", () => {
      setConnection("reconnecting");
    });

    socket.on("reconnect", () => {
      setConnection("connected");
      socket.emit(IoTEvents.Subscribe);
    });

    // ---- Hub → dashboard broadcasts ----
    socket.on(
      IoTEvents.InitialSnapshot,
      (payload: { devices: unknown[] }) => {
        if (payload && Array.isArray(payload.devices)) {
          useIotStore.getState().applySnapshot({
            devices: payload.devices as never,
          });
        }
      },
    );

    socket.on(IoTEvents.TelemetryBroadcast, (payload: unknown) => {
      if (payload && typeof payload === "object") {
        apply.applyTelemetry(payload as never);
      }
    });

    socket.on(IoTEvents.DeviceStatus, (payload: unknown) => {
      if (payload && typeof payload === "object") {
        useIotStore.getState().applyDeviceStatus(payload as never);
      }
    });

    socket.on(IoTEvents.FanState, (payload: unknown) => {
      if (payload && typeof payload === "object") {
        useIotStore.getState().applyFanState(payload as never);
      }
    });

    socket.on(IoTEvents.CommandAckBroadcast, (payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      const ack = payload as {
        commandId?: string;
        deviceId?: string;
        success?: boolean;
        fanStatus?: "on" | "off";
        timestamp?: string;
      };
      useIotStore.getState().applyCommandAck(ack as never);

      // Friendly toast — find the device name from the latest state.
      const device = useIotStore
        .getState()
        .devices.find((d) => d.id === ack.deviceId);
      const where = device?.name ?? ack.deviceId ?? "device";
      if (ack.success) {
        const verb =
          ack.fanStatus === "on" ? "turned ON" : "turned OFF";
        toast.success(`Fan ${verb} for ${where}`, {
          description: "Command acknowledged by the device.",
          icon: <CheckCircle2 className="size-4" />,
        });
      } else {
        toast.error(`Command failed for ${where}`, {
          description: "The device did not acknowledge the fan command.",
          icon: <XCircle className="size-4" />,
        });
      }
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [setConnection]);

  return socketRef;
}
