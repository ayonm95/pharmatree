import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  checkRateLimit,
  getRateLimitHeaders,
  isValidEthAddress,
  sanitizeInputString,
} from "@/lib/rateLimit";

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
  const rateLimit = checkRateLimit(req, {
    limit: 60,
    windowMs: 60 * 1000,
    prefix: "incident-get",
  });
  const rateHeaders = getRateLimitHeaders(rateLimit);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "RATE_LIMITED", message: "Too many requests" },
      { status: 429, headers: rateHeaders }
    );
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Math.max(1, Number(searchParams.get("limit") || 50)), 100);
  const incidents = loadIncidents();
  incidents.sort((a, b) => b.timestamp - a.timestamp);
  return NextResponse.json(
    {
      total: incidents.length,
      incidents: incidents.slice(0, limit),
    },
    { headers: rateHeaders }
  );
}

export async function POST(req: NextRequest) {
  const rateLimit = checkRateLimit(req, {
    limit: 60,
    windowMs: 60 * 1000,
    prefix: "incident-post",
  });
  const rateHeaders = getRateLimitHeaders(rateLimit);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { success: false, error: "RATE_LIMITED", message: "Incident reporting threshold reached." },
      { status: 429, headers: rateHeaders }
    );
  }

  try {
    const body = await req.json();
    const unitId = sanitizeInputString(String(body.unitId || ""), 64);
    const rawPayload = sanitizeInputString(String(body.rawPayload || unitId), 512);
    const tierRaw = Number(body.tierFailed || 1);
    const tierFailed = Number.isInteger(tierRaw) && tierRaw >= 1 && tierRaw <= 5 ? tierRaw : 1;
    const reason = sanitizeInputString(String(body.reason || "COUNTERFEIT_DETECTED"), 64);
    const message = sanitizeInputString(
      String(body.message || "Suspicious or counterfeit unit quarantined at POS"),
      256
    );

    const rawVendor = typeof body.vendorAddress === "string" ? body.vendorAddress.trim() : "";
    const vendorAddress = isValidEthAddress(rawVendor) ? rawVendor.toLowerCase() : undefined;
    const terminalId = sanitizeInputString(String(body.terminalId || "POS-TERM-01"), 32);
    const notes = sanitizeInputString(String(body.notes || ""), 512);

    let coordinates: { latitude: number; longitude: number } | undefined;
    if (
      body.coordinates &&
      typeof body.coordinates.latitude === "number" &&
      typeof body.coordinates.longitude === "number" &&
      body.coordinates.latitude >= -90 &&
      body.coordinates.latitude <= 90 &&
      body.coordinates.longitude >= -180 &&
      body.coordinates.longitude <= 180
    ) {
      coordinates = {
        latitude: Number(body.coordinates.latitude.toFixed(6)),
        longitude: Number(body.coordinates.longitude.toFixed(6)),
      };
    }

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

    console.warn(
      `[POS ALERT] Counterfeit/Compromised unit quarantined: ${incidentId} (Unit #${unitId}, reason: ${reason})`
    );

    return NextResponse.json(
      {
        success: true,
        incident: report,
        message: `Incident ${incidentId} logged successfully. Product flagged and placed in quarantine registry.`,
      },
      { headers: rateHeaders }
    );
  } catch (err: any) {
    console.error("Error logging incident:", err);
    return NextResponse.json(
      { success: false, error: "LOG_FAILED", message: err.message || "Failed to record incident." },
      { status: 500, headers: rateHeaders }
    );
  }
}
