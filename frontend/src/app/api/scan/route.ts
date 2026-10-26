import { NextRequest, NextResponse } from "next/server";
import {
  checkRateLimitAsync,
  getRateLimitHeaders,
  parseSafePositiveInt,
  getClientIp,
} from "@/lib/rateLimit";
import { recordScanAtomic, getScanRecord, getSealRecord } from "@/lib/db";

export async function GET(req: NextRequest) {
  const rateLimit = await checkRateLimitAsync(req, {
    limit: 120,
    windowMs: 60 * 1000,
    prefix: "scan-get",
  });
  const rateHeaders = getRateLimitHeaders(rateLimit);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "RATE_LIMITED", message: "Too many scan lookups." },
      { status: 429, headers: rateHeaders }
    );
  }

  const { searchParams } = new URL(req.url);
  const rawId = searchParams.get("unitId");
  const unitId = parseSafePositiveInt(rawId);

  if (!unitId) {
    return NextResponse.json(
      { error: "Missing or invalid unitId query parameter" },
      { status: 400, headers: rateHeaders }
    );
  }

  const record = await getScanRecord(String(unitId));
  const seal = await getSealRecord(String(unitId));

  return NextResponse.json(
    {
      unitId: String(unitId),
      scanCount: record.scanCount,
      firstScanTime: record.firstScanTime > 0 ? record.firstScanTime : null,
      lastScanTime: record.lastScanTime > 0 ? record.lastScanTime : null,
      isFirstScan: record.isFirstScan,
      seal: seal
        ? {
            state: seal.state,
            consumedAt: seal.consumedAt,
            scheme: seal.scheme,
          }
        : null,
    },
    { headers: rateHeaders }
  );
}

export async function POST(req: NextRequest) {
  const rateLimit = await checkRateLimitAsync(req, {
    limit: 60,
    windowMs: 60 * 1000,
    prefix: "scan-post",
  });
  const rateHeaders = getRateLimitHeaders(rateLimit);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "RATE_LIMITED", message: "Scan recording threshold reached." },
      { status: 429, headers: rateHeaders }
    );
  }

  try {
    const body = await req.json();
    const parsedId = parseSafePositiveInt(body.unitId);

    if (!parsedId) {
      return NextResponse.json(
        { error: "Missing or invalid unitId in body" },
        { status: 400, headers: rateHeaders }
      );
    }

    const unitId = String(parsedId);
    const ip = getClientIp(req);
    const source = typeof body.source === "string" ? body.source.slice(0, 32) : "web";

    const record = await recordScanAtomic(unitId, ip, source);

    return NextResponse.json(
      {
        unitId,
        scanCount: record.scanCount,
        firstScanTime: record.firstScanTime,
        lastScanTime: record.lastScanTime,
        isFirstScan: record.isFirstScan,
      },
      { headers: rateHeaders }
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to record scan" },
      { status: 500, headers: rateHeaders }
    );
  }
}
