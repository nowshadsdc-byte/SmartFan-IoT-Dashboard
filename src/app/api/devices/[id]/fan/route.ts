import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { forwardFanCommand } from "@/lib/iot-hub-client";

// POST /api/devices/[id]/fan — control the fan
// Body: { action: "on" | "off" | "auto" }
//  - on/off → mode = "manual", desiredFanStatus = action
//  - auto   → mode = "auto"
// The change is persisted FIRST, so it survives an offline device or hub.
// 200 = delivered to the online device, 202 = queued (device or hub offline).

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    let action: "on" | "off" | "auto" | null = null;
    try {
      const body = await req.json();
      if (body?.action === "on" || body?.action === "off" || body?.action === "auto") {
        action = body.action;
      }
    } catch {
      action = null;
    }
    if (!action) {
      return NextResponse.json(
        { error: "invalid_action", message: 'action must be "on", "off" or "auto"' },
        { status: 400 }
      );
    }

    const device = await db.device.findUnique({ where: { id }, select: { id: true } });
    if (!device) {
      return NextResponse.json({ error: "device_not_found" }, { status: 404 });
    }

    // Persist desired state + command log in one transaction (exactly one CommandLog row).
    const [updated, command] = await db.$transaction([
      db.device.update({
        where: { id },
        data:
          action === "auto"
            ? { mode: "auto" }
            : { mode: "manual", desiredFanStatus: action },
      }),
      db.commandLog.create({
        data: { deviceId: id, action, status: "queued", source: "dashboard" },
      }),
    ]);

    // The hub updates this same row (queued → sent → acknowledged|failed).
    const result = await forwardFanCommand({ deviceId: id, action, commandId: command.id });
    const status = result.ok ? (result.status ?? "queued") : "queued";

    return NextResponse.json(
      {
        commandId: command.id,
        deviceId: id,
        action,
        status,
        mode: updated.mode,
        desiredFanStatus: updated.desiredFanStatus,
        createdAt: command.createdAt.toISOString(),
        ...(result.ok ? {} : { warning: result.error ?? "hub unreachable" }),
      },
      { status: status === "sent" ? 200 : 202 }
    );
  } catch (err) {
    console.error("[POST /api/devices/[id]/fan] error:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
