import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { notifyConfigUpdate } from "@/lib/iot-hub-client";
import { describeConfigErrors, validateConfig } from "@/lib/config-validation";

const configOf = (d: {
  id: string;
  mode: string;
  desiredFanStatus: string;
  tempOn: number;
  tempOff: number;
  heartbeatIntervalSec: number;
}) => ({
  deviceId: d.id,
  mode: d.mode === "manual" ? "manual" : "auto",
  desiredFanStatus: d.desiredFanStatus === "on" ? "on" : "off",
  tempOn: d.tempOn,
  tempOff: d.tempOff,
  heartbeatIntervalSec: d.heartbeatIntervalSec,
});

// GET /api/devices/[id]/config — current control config
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const device = await db.device.findUnique({ where: { id } });
    if (!device) {
      return NextResponse.json({ error: "device_not_found" }, { status: 404 });
    }
    return NextResponse.json({ config: configOf(device) });
  } catch (err) {
    console.error("[GET /api/devices/[id]/config] error:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

// PUT /api/devices/[id]/config — body: { tempOn?, tempOff?, heartbeatIntervalSec? }
// Validates, saves, then asks the hub to push a fresh device:config to the device.
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      body = null;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        { error: "invalid_config", message: "body must be a JSON object" },
        { status: 400 }
      );
    }
    const input = body as Record<string, unknown>;
    const keys = ["tempOn", "tempOff", "heartbeatIntervalSec"] as const;
    const patch: Partial<Record<(typeof keys)[number], number>> = {};
    for (const k of keys) {
      if (input[k] === undefined) continue;
      if (typeof input[k] !== "number" || !Number.isFinite(input[k] as number)) {
        return NextResponse.json(
          { error: "invalid_config", message: `${k} must be a finite number`, fields: { [k]: `${k} must be a finite number` } },
          { status: 400 }
        );
      }
      patch[k] = input[k] as number;
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { error: "invalid_config", message: "provide at least one of tempOn, tempOff, heartbeatIntervalSec" },
        { status: 400 }
      );
    }

    const device = await db.device.findUnique({ where: { id } });
    if (!device) {
      return NextResponse.json({ error: "device_not_found" }, { status: 404 });
    }

    const merged = {
      tempOn: patch.tempOn ?? device.tempOn,
      tempOff: patch.tempOff ?? device.tempOff,
      heartbeatIntervalSec: patch.heartbeatIntervalSec ?? device.heartbeatIntervalSec,
    };
    const errors = validateConfig(merged);
    if (Object.keys(errors).length > 0) {
      return NextResponse.json(
        { error: "invalid_config", message: describeConfigErrors(errors), fields: errors },
        { status: 400 }
      );
    }

    const updated = await db.device.update({ where: { id }, data: merged });

    // Best-effort push; the config is already persisted and is delivered on next register otherwise.
    const result = await notifyConfigUpdate({ deviceId: id, ...merged });

    return NextResponse.json({
      config: configOf(updated),
      deviceOnline: result.ok ? result.status === "sent" : false,
      ...(result.ok ? {} : { warning: result.error ?? "hub unreachable" }),
    });
  } catch (err) {
    console.error("[PUT /api/devices/[id]/config] error:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
