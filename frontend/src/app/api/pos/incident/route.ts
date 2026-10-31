import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { z } from "zod";
import {
  checkRateLimitAsync,
  getRateLimitHeaders,
} from "@/lib/rateLimit";
import {
  saveIncidentReport,
  getIncidentsList,
  findRecentIncident,
  DbIncidentReport,
} from "@/lib/db";
import { resolveTenantFromHeadersAsync } from "@/lib/tenantAuth";

const IncidentInputSchema = z.object({
  unitId: z.string().min(1).max(64),
  rawPayload: z.string().max(1024).optional(),
  tierFailed: z.number().int().min(1).max(5).default(1),
  reason: z.string().min(1).max(64).default("COUNTERFEIT_DETECTED"),
  message: z.string().max(512).default("Suspicious or counterfeit unit quarantined at POS"),
  vendorAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address format")
    .optional(),
  terminalId: z.string().max(64).default("POS-TERM-01"),
  notes: z.string().max(1024).optional(),
  coordinates: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    })
    .optional(),
});

export async function GET(req: NextRequest) {
  const rateLimit = await checkRateLimitAsync(req, {
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
  const incidents = await getIncidentsList(limit);

  return NextResponse.json(
    {
      total: incidents.length,
      incidents,
    },
    { headers: rateHeaders }
  );
}

export async function POST(req: NextRequest) {
  const rateLimit = await checkRateLimitAsync(req, {
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

  const allowDemo = process.env.STRICT_TENANT_AUTH !== "true";
  const tenantAuth = await resolveTenantFromHeadersAsync(req.headers, { allowDemoFallback: allowDemo });
  if (tenantAuth.authenticated && tenantAuth.tenant) {
    rateHeaders["X-Tenant-ID"] = tenantAuth.tenant.id;
    rateHeaders["X-Tenant-Tier"] = tenantAuth.tenant.tier;
  }

  if (!tenantAuth.authenticated) {
    return NextResponse.json(
      { success: false, error: "UNAUTHORIZED_TENANT", message: tenantAuth.error || "Valid X-Tenant-Key required" },
      { status: 401, headers: rateHeaders }
    );
  }

  try {
    const rawBody = await req.json();
    const parseResult = IncidentInputSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        {
          success: false,
          error: "INVALID_INCIDENT_PAYLOAD",
          message: parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
        { status: 400, headers: rateHeaders }
      );
    }

    const data = parseResult.data;
    const unitId = data.unitId.trim();
    const vendorAddress = data.vendorAddress ? data.vendorAddress.toLowerCase() : undefined;
    const tierFailed = data.tierFailed;

    // Deduplication check: (unit, vendor, tier, hour)
    const recent = await findRecentIncident(unitId, vendorAddress, tierFailed, 3600);
    if (recent) {
      return NextResponse.json(
        {
          success: true,
          deduped: true,
          incident: recent,
          message: `Incident for Unit #${unitId} under tier ${tierFailed} already recorded within the past hour. Deduplicated.`,
        },
        { headers: rateHeaders }
      );
    }

    // Coarse GPS rounding: Round coordinates to 2 decimal places (~1.1 km neighborhood resolution) to protect terminal location privacy without claiming formal statutory compliance
    let coordinates: { latitude: number; longitude: number } | undefined;
    if (data.coordinates) {
      coordinates = {
        latitude: Number(data.coordinates.latitude.toFixed(2)),
        longitude: Number(data.coordinates.longitude.toFixed(2)),
      };
    }

    const now = Math.floor(Date.now() / 1000);
    const isoDate = new Date().toISOString();
    const hash = crypto
      .createHash("sha256")
      .update(`${unitId}-${now}-${data.reason}`)
      .digest("hex")
      .slice(0, 8)
      .toUpperCase();

    const incidentId = `INC-${now}-${hash}`;

    const report: DbIncidentReport = {
      incidentId,
      unitId,
      rawPayload: data.rawPayload || unitId,
      tierFailed,
      reason: data.reason,
      message: data.message,
      vendorAddress,
      terminalId: data.terminalId,
      coordinates,
      notes: data.notes,
      status: "QUARANTINED",
      timestamp: now,
      isoDate,
    };

    await saveIncidentReport(report);

    console.warn(
      `[POS ALERT] Counterfeit/Compromised unit quarantined: ${incidentId} (Unit #${unitId}, reason: ${data.reason})`
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
