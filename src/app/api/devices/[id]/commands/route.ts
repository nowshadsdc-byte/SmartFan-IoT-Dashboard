import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toCommandLogDTO } from "@/lib/iot-hub-client";

// GET /api/devices/[id]/commands?limit=20 — recent command logs
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const limitParam = url.searchParams.get("limit");
    let limit = 20;
    if (limitParam) {
      const parsed = parseInt(limitParam, 10);
      if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 100) {
        limit = parsed;
      }
    }

    const device = await db.device.findUnique({ where: { id }, select: { id: true } });
    if (!device) {
      return NextResponse.json({ error: "device_not_found" }, { status: 404 });
    }

    const commands = await db.commandLog.findMany({
      where: { deviceId: id },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return NextResponse.json({ commands: commands.map(toCommandLogDTO) });
  } catch (err) {
    console.error("[GET /api/devices/[id]/commands] error:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
