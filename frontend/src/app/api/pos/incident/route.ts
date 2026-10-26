import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const INCIDENTS_FILE = path.join(DATA_DIR, "incidents.json");

export type IncidentReport = {
  incidentId: string;
  unitId: string;
  rawPayload: string;
  tierFailed: number;
  reason: string;
  message: string;
  vendorAddress?: string;
  terminalId?: string;
  coordinates?: { latitude: number; longitude: number };
  notes?: string;
  status: "QUARANTINED" | "RESOLVED" | "UNDER_REVIEW";
  timestamp: number;
  isoDate: string;
};

function loadIncidents(): IncidentReport[] {
  try {
    if (fs.existsSync(INCIDENTS_FILE)) {
      return JSON.parse(fs.readFileSync(INCIDENTS_FILE, "utf-8"));
    }
  } catch (err) {
    console.warn("Could not load incidents:", err);
  }
  return [];
}

function saveIncidents(list: IncidentReport[]) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(INCIDENTS_FILE, JSON.stringify(list, null, 2), "utf-8");
  } catch (err) {
    console.warn("Could not save incidents:", err);
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") || 50), 100);
  const incidents = loadIncidents();
  // Return most recent first
  incidents.sort((a, b) => b.timestamp - a.timestamp);
  return NextResponse.json({
    total: incidents.length,
    incidents: incidents.slice(0, limit),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const unitId = String(body.unitId || "").trim();
    const rawPayload = String(body.rawPayload || unitId).trim();
    const tierFailed = Number(body.tierFailed || 1);
    const reason = String(body.reason || "COUNTERFEIT_DETECTED").trim();
    const message = String(body.message || "Suspicious or counterfeit unit quarantined at POS").trim();
    const vendorAddress = body.vendorAddress?.trim();
    const terminalId = String(body.terminalId || "POS-TERM-01").trim();
    const coordinates = body.coordinates;
    const notes = body.notes?.trim();

    const now = Math.floor(Date.now() / 1000);
    const isoDate = new Date().toISOString();
    const hash = crypto
      .createHash("sha256")
      .update(`${unitId}-${now}-${reason}`)
      .digest("hex")
      .slice(0, 8)
      .toUpperCase();

    const incidentId = `INC-${now}-${hash}`;

    const report: IncidentReport = {
      incidentId,
      unitId,
      rawPayload,
      tierFailed,
      reason,
      message,
      vendorAddress,
      terminalId,
      coordinates,
      notes,
      status: "QUARANTINED",
      timestamp: now,
      isoDate,
    };

    const incidents = loadIncidents();
    incidents.push(report);
    saveIncidents(incidents);

    console.warn(`[POS ALERT] Counterfeit/Compromised unit quarantined: ${incidentId} (Unit #${unitId}, reason: ${reason})`);

    return NextResponse.json({
      success: true,
      incident: report,
      message: `Incident ${incidentId} logged successfully. Product flagged and placed in quarantine registry.`,
    });
  } catch (err: any) {
    console.error("Error logging incident:", err);
    return NextResponse.json(
      { success: false, error: "LOG_FAILED", message: err.message || "Failed to record incident." },
      { status: 500 }
    );
  }
}
