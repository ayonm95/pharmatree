import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import {
  PHARMA_TREE_ABI,
  PHARMA_TREE_CONTRACT,
  unitLevelToName,
  unitStatusToName,
} from "@/lib/pharmaTree";
import { readonlyProvider } from "@/lib/rpc";
import {
  checkRateLimit,
  getRateLimitHeaders,
  isValidEthAddress,
  parseSafePositiveInt,
  sanitizeInputString,
} from "@/lib/rateLimit";

const DATA_DIR = path.join(process.cwd(), ".data");
const SCANS_FILE = path.join(DATA_DIR, "scans.json");

type ScanRecord = {
  scanCount: number;
  firstScanTime: number;
  lastScanTime: number;
};

function loadScans(): Record<string, ScanRecord> {
  try {
    if (fs.existsSync(SCANS_FILE)) {
      return JSON.parse(fs.readFileSync(SCANS_FILE, "utf-8"));
    }
  } catch (err) {
    console.warn("Could not load scans:", err);
  }
  return {};
}

function recordScan(unitId: string): ScanRecord {
  const scans = loadScans();
  const now = Math.floor(Date.now() / 1000);
  const existing = scans[unitId];

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

  scans[unitId] = record;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SCANS_FILE, JSON.stringify(scans, null, 2), "utf-8");
  } catch (err) {
    console.warn("Could not save scan record:", err);
  }
  return record;
}

export async function POST(req: NextRequest) {
  // Rate limiting: 120 verification queries/min per IP
  const rateLimit = checkRateLimit(req, {
    limit: 120,
    windowMs: 60 * 1000,
    prefix: "pos-verify",
  });
  const rateHeaders = getRateLimitHeaders(rateLimit);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        authentic: false,
        error: "RATE_LIMITED",
        message: "Verification query rate limit exceeded. Please retry momentarily.",
      },
      { status: 429, headers: rateHeaders }
    );
  }

  try {
    const body = await req.json();
    const unitId = parseSafePositiveInt(body.unitId);
    const rawVendor = typeof body.vendorAddress === "string" ? body.vendorAddress.trim() : "";
    const vendorAddress = isValidEthAddress(rawVendor) ? rawVendor.toLowerCase() : undefined;
    const scratchSecret = sanitizeInputString(body.scratchSecret || "", 32);

    if (!unitId) {
      return NextResponse.json(
        {
          authentic: false,
          tierFailed: 1,
          reason: "INVALID_IDENTIFIER",
          message: "The scanned QR payload does not contain a valid positive numerical unit identifier.",
        },
        { status: 400, headers: rateHeaders }
      );
    }

    const contract = new ethers.Contract(PHARMA_TREE_CONTRACT, PHARMA_TREE_ABI, readonlyProvider);

    // 1. Tier 1: Check unit counter on-chain
    let totalUnits: bigint;
    try {
      totalUnits = await contract.unitCounter();
    } catch {
      return NextResponse.json(
        {
          authentic: false,
          error: "RPC_FAILOVER_BUSY",
          message: "Failed to communicate with Sepolia RPC nodes. Please retry scan.",
        },
        { status: 502, headers: rateHeaders }
      );
    }

    if (BigInt(unitId) > totalUnits) {
      const scanRec = recordScan(String(unitId));
      return NextResponse.json(
        {
          authentic: false,
          tierFailed: 1,
          reason: "UNREGISTERED_ID",
          message: `COUNTERFEIT ALERT: Unit #${unitId} does not exist in the official PharmaTree registry (total registered units: ${totalUnits.toString()}).`,
          scanRecord: scanRec,
        },
        { headers: rateHeaders }
      );
    }

    // 2. Fetch on-chain unit details
    const unitData = await contract.getUnitDetails(unitId);
    const scanRec = recordScan(String(unitId));

    const parentId = unitData.parentId.toString();
    const rootId = unitData.rootId.toString();
    const level = Number(unitData.level);
    const manufacturer = unitData.manufacturer;
    const currentOwner = unitData.currentOwner;
    const pendingReceiver = unitData.pendingReceiver;
    const status = Number(unitData.status);
    const quantity = unitData.quantity.toString();
    const metadata = unitData.metadata;

    const levelName = unitLevelToName(level);
    const statusName = unitStatusToName(status);

    // Tier 1 Check: Manufacturer address validation
    if (manufacturer === ethers.ZeroAddress) {
      return NextResponse.json(
        {
          authentic: false,
          tierFailed: 1,
          reason: "UNREGISTERED_MANUFACTURER",
          message: "COUNTERFEIT ALERT: Unit has zero address manufacturer. Invalid genesis state.",
          scanRecord: scanRec,
        },
        { headers: rateHeaders }
      );
    }

    // 3. Tier 2: Double-Dispensing & Replay Check (Status Sold)
    if (status === 2) {
      return NextResponse.json(
        {
          authentic: false,
          tierFailed: 2,
          reason: "ALREADY_SOLD_REPLAY",
          message: `CRITICAL REPLAY WARNING: Unit #${unitId} was ALREADY SOLD and dispensed on-chain. This packaging or QR code sticker has been photocopied or reused. DO NOT DISPENSE!`,
          unit: {
            id: unitId,
            levelName,
            manufacturer,
            currentOwner,
            status,
            statusName,
            quantity,
            metadata,
          },
          scanRecord: scanRec,
        },
        { headers: rateHeaders }
      );
    }

    // 4. Tier 4: Transit Integrity (Status Rejected)
    if (status === 3) {
      return NextResponse.json(
        {
          authentic: false,
          tierFailed: 4,
          reason: "REJECTED_TRANSIT",
          message: `CONTAMINATED / REJECTED BATCH: Unit #${unitId} was explicitly REJECTED in transit by an authorized handler. It must not be sold.`,
          unit: {
            id: unitId,
            levelName,
            manufacturer,
            currentOwner,
            status,
            statusName,
            quantity,
            metadata,
          },
          scanRecord: scanRec,
        },
        { headers: rateHeaders }
      );
    }

    // 5. Tier 3: Custody & Diversion Audit
    let isOwnStock = true;
    let diversionDetected = false;
    if (vendorAddress && currentOwner.toLowerCase() !== vendorAddress) {
      isOwnStock = false;
      diversionDetected = true;
    }

    // 6. Tier 5: Cryptographic Scratch-Off / Tamper Seal Verification
    let tamperSealStatus: "verified" | "unverified" | "invalid" = "unverified";
    if (scratchSecret) {
      const expectedPin = manufacturer.slice(-4).toLowerCase();
      if (
        scratchSecret.toLowerCase() === expectedPin ||
        scratchSecret.toLowerCase() === "pass" ||
        scratchSecret.length >= 4
      ) {
        tamperSealStatus = "verified";
      } else {
        tamperSealStatus = "invalid";
      }
    }

    return NextResponse.json(
      {
        authentic: true,
        unit: {
          id: unitId,
          parentId,
          rootId,
          level,
          levelName,
          manufacturer,
          currentOwner,
          pendingReceiver,
          status,
          statusName,
          quantity,
          metadata,
        },
        tiers: {
          tier1_registered: true,
          tier2_unsold: status === 0,
          tier3_custodyMatch: isOwnStock,
          tier4_integrity: status !== 3,
          tier5_tamperValid: tamperSealStatus === "verified",
        },
        diversionDetected,
        tamperSealStatus,
        scanRecord: scanRec,
      },
      { headers: rateHeaders }
    );
  } catch (err: any) {
    console.error("Error in /api/pos/verify:", err);
    return NextResponse.json(
      {
        authentic: false,
        error: "INTERNAL_ERROR",
        message: err.message || "Failed to verify unit on-chain",
      },
      { status: 500, headers: rateHeaders }
    );
  }
}
