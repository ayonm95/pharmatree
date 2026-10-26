import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import {
  checkRateLimit,
  getRateLimitHeaders,
  parseSafePositiveInt,
} from "@/lib/rateLimit";

type ScanRecord = {
  scanCount: number;
  firstScanTime: number;
  lastScanTime: number;
};

// In-memory cache for fast access
const memoryCache: Record<string, ScanRecord> = {};

// Local fallback file path
const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "scans.json");

function loadFromDisk(): Record<string, ScanRecord> {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf-8");
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn("Could not load scans from disk:", err);
  }
  return {};
}

function saveToDisk(data: Record<string, ScanRecord>) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.warn("Could not write scans to disk:", err);
  }
}

// Initialise memory cache from disk once on module load
try {
  const diskData = loadFromDisk();
  Object.assign(memoryCache, diskData);
} catch {
  // Ignore
}

export async function GET(req: NextRequest) {
  const rateLimit = checkRateLimit(req, {
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

  const key = String(unitId);
  const existing = memoryCache[key];
  if (existing) {
    return NextResponse.json(
      {
        unitId: key,
        scanCount: existing.scanCount,
        firstScanTime: existing.firstScanTime,
        lastScanTime: existing.lastScanTime,
        isFirstScan: false,
      },
      { headers: rateHeaders }
    );
  }

  return NextResponse.json(
    {
      unitId: key,
      scanCount: 0,
      firstScanTime: null,
      lastScanTime: null,
      isFirstScan: true,
    },
    { headers: rateHeaders }
  );
}

export async function POST(req: NextRequest) {
  const rateLimit = checkRateLimit(req, {
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
    const now = Math.floor(Date.now() / 1000);
    const existing = memoryCache[unitId];

    let record: ScanRecord;
    if (existing) {
      record = {
        scanCount: existing.scanCount + 1,
        firstScanTime: existing.firstScanTime,
        lastScanTime: now,
      };
    } else {
      record = {
        scanCount: 1,
        firstScanTime: now,
        lastScanTime: now,
      };
    }

    memoryCache[unitId] = record;
    saveToDisk(memoryCache);

    return NextResponse.json(
      {
        unitId,
        scanCount: record.scanCount,
        firstScanTime: record.firstScanTime,
        lastScanTime: record.lastScanTime,
        isFirstScan: record.scanCount === 1,
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
