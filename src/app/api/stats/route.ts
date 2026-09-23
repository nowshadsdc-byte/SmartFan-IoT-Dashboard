import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// GET /api/stats — global dashboard stats
export async function GET() {
  try {
    const devices = await db.device.findMany();

    const totalDevices = devices.length;
    const onlineDevices = devices.filter((d) => d.status === "online").length;
    const offlineDevices = totalDevices - onlineDevices;
    const fansOn = devices.filter((d) => d.fanStatus === "on").length;
    const fansOff = totalDevices - fansOn;

    const online = devices.filter((d) => d.status === "online");
    const avgTemperature =
      online.length > 0
        ? online.reduce((s, d) => s + d.temperature, 0) / online.length
        : 0;
    const avgHumidity =
      online.length > 0
        ? online.reduce((s, d) => s + d.humidity, 0) / online.length
        : 0;

    const lastActivityAt =
      devices.length === 0
        ? null
        : devices
            .map((d) => d.lastSeenAt.getTime())
            .reduce((a, b) => (a > b ? a : b), 0);

    return NextResponse.json({
      totalDevices,
      onlineDevices,
      offlineDevices,
      fansOn,
      fansOff,
      avgTemperature: Math.round(avgTemperature * 100) / 100,
      avgHumidity: Math.round(avgHumidity * 100) / 100,
      lastActivityAt: lastActivityAt ? new Date(lastActivityAt).toISOString() : null,
    });
  } catch (err) {
    console.error("[GET /api/stats] error:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
