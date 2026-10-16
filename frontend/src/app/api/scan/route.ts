import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

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
  const { searchParams } = new URL(req.url);
  const unitId = searchParams.get("unitId");

  if (!unitId) {
    return NextResponse.json({ error: "Missing unitId query parameter" }, { status: 400 });
  }

  const existing = memoryCache[unitId];
  if (existing) {
    return NextResponse.json({
      unitId,
      scanCount: existing.scanCount,
      firstScanTime: existing.firstScanTime,
      lastScanTime: existing.lastScanTime,
      isFirstScan: false,
    });
  }

  return NextResponse.json({
    unitId,
    scanCount: 0,
    firstScanTime: null,
    lastScanTime: null,
    isFirstScan: true,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const unitId = String(body.unitId || "").trim();

    if (!unitId) {
      return NextResponse.json({ error: "Missing unitId in body" }, { status: 400 });
    }

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

    return NextResponse.json({
      unitId,
      scanCount: record.scanCount,
      firstScanTime: record.firstScanTime,
      lastScanTime: record.lastScanTime,
      isFirstScan: record.scanCount === 1,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to record scan" }, { status: 500 });
  }
}
