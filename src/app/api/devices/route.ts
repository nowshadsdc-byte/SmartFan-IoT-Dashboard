import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toDeviceDTO } from "@/lib/iot-hub-client";

// GET /api/devices — list all devices, ordered by name ASC
export async function GET() {
  try {
    const devices = await db.device.findMany({ orderBy: { name: "asc" } });
    return NextResponse.json({ devices: devices.map(toDeviceDTO) });
  } catch (err) {
    console.error("[GET /api/devices] error:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
