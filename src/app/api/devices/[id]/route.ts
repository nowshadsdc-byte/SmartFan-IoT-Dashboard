import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toDeviceDTO, toSensorReadingDTO } from "@/lib/iot-hub-client";

// GET /api/devices/[id] — device detail + most recent reading
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

    const latestReading = await db.sensorReading.findFirst({
      where: { deviceId: id },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({
      device: toDeviceDTO(device),
      latestReading: latestReading ? toSensorReadingDTO(latestReading) : null,
    });
  } catch (err) {
    console.error("[GET /api/devices/[id]] error:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
