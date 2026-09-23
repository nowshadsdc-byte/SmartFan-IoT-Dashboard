import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toSensorReadingDTO } from "@/lib/iot-hub-client";

// GET /api/devices/[id]/history?range=1h|6h|24h|7d — sensor history
const RANGE_MS: Record<string, number> = {
  "1h": 3_600_000,
  "6h": 21_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
};

const MAX_POINTS = 500;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const rangeParam = url.searchParams.get("range") ?? "1h";
    const rangeKey = RANGE_MS[rangeParam] ? rangeParam : "1h";
    const rangeMs = RANGE_MS[rangeKey];

    const device = await db.device.findUnique({ where: { id }, select: { id: true } });
    if (!device) {
      return NextResponse.json({ error: "device_not_found" }, { status: 404 });
    }

    const since = new Date(Date.now() - rangeMs);
    const readings = await db.sensorReading.findMany({
      where: { deviceId: id, createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
      take: 5000, // safety cap before downsample
    });

    let downsampled = readings;
    if (readings.length > MAX_POINTS) {
      const step = Math.ceil(readings.length / MAX_POINTS);
      downsampled = readings.filter((_, i) => i % step === 0);
    }

    return NextResponse.json({ readings: downsampled.map(toSensorReadingDTO) });
  } catch (err) {
    console.error("[GET /api/devices/[id]/history] error:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
