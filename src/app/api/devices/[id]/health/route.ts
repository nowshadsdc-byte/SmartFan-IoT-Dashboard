import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toDeviceDTO } from "@/lib/iot-hub-client";

// GET /api/devices/[id]/health — device health metrics
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

    const now = Date.now();
    const lastSeenMs = device.lastSeenAt.getTime();
    const lastSeenAgoSeconds = Math.max(0, Math.floor((now - lastSeenMs) / 1000));

    // signal quality from current rssi
    const rssi = device.rssi;
    let signalQuality: "excellent" | "good" | "fair" | "poor";
    if (rssi >= -50) signalQuality = "excellent";
    else if (rssi >= -60) signalQuality = "good";
    else if (rssi >= -70) signalQuality = "fair";
    else signalQuality = "poor";

    // Recent readings in the last 1h
    const since = new Date(now - 3_600_000);
    const recentReadings = await db.sensorReading.findMany({
      where: { deviceId: id, createdAt: { gte: since } },
      select: { rssi: true },
    });
    const recentReadingsCount = recentReadings.length;
    const avgRssi =
      recentReadingsCount > 0
        ? Math.round(
            recentReadings.reduce((s, r) => s + r.rssi, 0) / recentReadingsCount
          )
        : 0;

    // Status + message
    const isOnline = device.status === "online";
    let status: "online" | "offline" | "stale";
    let message: string;
    if (isOnline && lastSeenAgoSeconds <= 60) {
      status = "online";
      message = "Device is online and reporting normally";
    } else if (isOnline && lastSeenAgoSeconds <= 300) {
      status = "stale";
      message = `Device is online but has not reported in ${lastSeenAgoSeconds}s`;
    } else {
      status = "offline";
      message = `Device has not reported in ${lastSeenAgoSeconds}s — possibly disconnected`;
    }

    return NextResponse.json({
      device: toDeviceDTO(device),
      health: {
        status,
        lastSeenAgoSeconds,
        signalQuality,
        uptimeSeconds: device.uptimeSeconds,
        firmwareVersion: device.firmwareVersion,
        ipAddress: device.ipAddress,
        recentReadingsCount,
        avgRssi,
        message,
      },
    });
  } catch (err) {
    console.error("[GET /api/devices/[id]/health] error:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
