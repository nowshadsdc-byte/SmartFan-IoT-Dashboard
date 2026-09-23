import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toCommandLogDTO, forwardFanCommand } from "@/lib/iot-hub-client";

// POST /api/devices/[id]/fan — turn fan ON or OFF
// Body: { action: "on" | "off" }

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Parse body
    let action: "on" | "off" | null = null;
    try {
      const body = await req.json();
      if (body?.action === "on" || body?.action === "off") {
        action = body.action;
      }
    } catch {
      action = null;
    }
    if (!action) {
      return NextResponse.json(
        { error: "invalid_action", message: 'action must be "on" or "off"' },
        { status: 400 }
      );
    }

    // Validate device exists
    const device = await db.device.findUnique({ where: { id } });
    if (!device) {
      return NextResponse.json({ error: "device_not_found" }, { status: 404 });
    }

    const commandId = crypto.randomUUID();
    const now = new Date();

    // Create pending command log
    const command = await db.commandLog.create({
      data: {
        deviceId: id,
        action,
        status: "pending",
        source: "dashboard",
      },
    });

    // Forward to hub (fire-and-forget with timeout)
    const result = await forwardFanCommand({ deviceId: id, action, commandId });

    if (!result.ok) {
      // Mark failed
      const updated = await db.commandLog.update({
        where: { id: command.id },
        data: { status: "failed", error: result.error ?? "hub unreachable" },
      });
      return NextResponse.json(
        {
          commandId,
          deviceId: id,
          action,
          status: "failed",
          error: result.error ?? "hub unreachable",
          createdAt: updated.createdAt.toISOString(),
        },
        { status: 503 }
      );
    }

    // Mark sent
    const updated = await db.commandLog.update({
      where: { id: command.id },
      data: { status: "sent", sentAt: now },
    });

    return NextResponse.json({
      commandId,
      deviceId: id,
      action,
      status: "sent",
      createdAt: updated.createdAt.toISOString(),
    });
  } catch (err) {
    console.error("[POST /api/devices/[id]/fan] error:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
