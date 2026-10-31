import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import {
  PHARMA_TREE_ABI,
  PHARMA_TREE_CONTRACT,
  unitLevelToName,
  unitStatusToName,
} from "@/lib/pharmaTree";
import { readonlyProvider } from "@/lib/rpc";
import {
  checkRateLimitAsync,
  getRateLimitHeaders,
  isValidEthAddress,
  parseSafePositiveInt,
  sanitizeInputString,
  getClientIp,
} from "@/lib/rateLimit";
import { recordScanAtomic, getSealRecord } from "@/lib/db";
import { evaluateTiers } from "@/lib/tierEvaluator";
import { verifyUnitSeal } from "@/lib/sealVerifier";
import { resolveTenantFromHeaders } from "@/lib/tenantAuth";

export async function POST(req: NextRequest) {
  // Rate limiting: 120 verification queries/min per IP
  const rateLimit = await checkRateLimitAsync(req, {
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

  // Multi-Tenant Context Resolution
  const allowDemoFallback = process.env.STRICT_TENANT_AUTH !== "true";
  const tenantResolution = resolveTenantFromHeaders(req.headers, { allowDemoFallback });
  if (tenantResolution.authenticated && tenantResolution.tenant) {
    rateHeaders["X-Tenant-ID"] = tenantResolution.tenant.id;
    rateHeaders["X-Tenant-Tier"] = tenantResolution.tenant.tier;
  }

  try {
    const body = await req.json();
    const unitId = parseSafePositiveInt(body.unitId);
    const rawVendor = typeof body.vendorAddress === "string" ? body.vendorAddress.trim() : "";
    const vendorAddress = isValidEthAddress(rawVendor) ? rawVendor.toLowerCase() : undefined;
    const scratchSecret = sanitizeInputString(body.scratchSecret || "", 32);
    const rawSerial = typeof body.serial === "string" ? body.serial.trim() : undefined;

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

    const ip = getClientIp(req);
    const contract = new ethers.Contract(PHARMA_TREE_CONTRACT, PHARMA_TREE_ABI, readonlyProvider);

    // 1. Check unit counter on-chain
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

    // Check if ID is out of bounds (uniform 404 response)
    if (BigInt(unitId) > totalUnits) {
      let scanRec: any = null;
      try {
        scanRec = await recordScanAtomic(String(unitId), ip, "pos_terminal");
      } catch (scanErr) {
        console.warn("Scan telemetry error for unregistered unit:", scanErr);
      }

      return NextResponse.json(
        {
          authentic: false,
          tierFailed: 1,
          reason: "UNIT_NOT_FOUND",
          message: `Unit details could not be retrieved for Unit #${unitId}.`,
          scanRecord: scanRec,
        },
        { status: 404, headers: rateHeaders }
      );
    }

    // 2. Fetch on-chain unit details
    const unitData = await contract.getUnitDetails(unitId);
    let scanRec: any = null;
    try {
      scanRec = await recordScanAtomic(String(unitId), ip, "pos_terminal");
    } catch (scanErr) {
      console.warn("Scan telemetry recording non-fatal error:", scanErr);
    }

    const parentId = unitData.parentId.toString();
    const rootId = unitData.rootId.toString();
    const level = Number(unitData.level);
    const manufacturer = unitData.manufacturer;
    const currentOwner = unitData.currentOwner;
    const pendingReceiver = unitData.pendingReceiver;
    const status = Number(unitData.status);
    const quantity = unitData.quantity.toString();
    const metadata = unitData.metadata;
    const serialHash = unitData.serialHash ? String(unitData.serialHash) : undefined;
    const expiry = unitData.expiry !== undefined ? Number(unitData.expiry) : 0;

    let isRecalled = false;
    try {
      const rId = rootId === "0" ? unitId : Number(rootId);
      isRecalled = await contract.recalledRoots(rId);
    } catch {}

    const levelName = unitLevelToName(level);
    const statusName = unitStatusToName(status);

    const unitObj = {
      parentId,
      rootId,
      level,
      manufacturer,
      currentOwner,
      pendingReceiver,
      status,
      quantity,
      metadata,
      serialHash,
      expiry,
      isRecalled,
    };

    // 3. Scratch Seal Evaluation
    let sealRecord: any = null;
    let sealResult: any = null;

    try {
      sealRecord = await getSealRecord(String(unitId));

      if (scratchSecret) {
        sealResult = await verifyUnitSeal({
          unitId,
          secret: scratchSecret,
          manufacturerAddress: manufacturer,
          clientIdentifier: ip,
        });
        sealRecord = await getSealRecord(String(unitId));
      }
    } catch (sealErr) {
      console.warn("Seal retrieval non-fatal error:", sealErr);
    }

    // 4. Pure 5-Tier Evaluation
    const evalResult = evaluateTiers({
      unitId,
      totalUnitsOnChain: totalUnits,
      serial: rawSerial,
      unit: unitObj,
      vendorAddress,
      scratchSecret,
      sealRecord: sealRecord
        ? {
            state: sealRecord.state,
            consumedAt: sealRecord.consumedAt,
            failedAttempts: sealRecord.failedAttempts,
            lockedUntil: sealRecord.lockedUntil,
          }
        : null,
    });

    // Uniform 404 for missing unit or wrong/missing serial on serialized units
    if (evalResult.reason === "UNIT_NOT_FOUND") {
      return NextResponse.json(
        {
          authentic: false,
          tierFailed: 1,
          reason: "UNIT_NOT_FOUND",
          message: `Unit details could not be retrieved for Unit #${unitId}.`,
          scanRecord: scanRec,
        },
        { status: 404, headers: rateHeaders }
      );
    }

    if (!evalResult.authentic) {
      return NextResponse.json(
        {
          authentic: false,
          tierFailed: evalResult.tierFailed,
          reason: evalResult.reason,
          message: evalResult.message,
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
          sealResult: sealResult || undefined,
        },
        { headers: rateHeaders }
      );
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
        tiers: evalResult.tiers,
        diversionDetected: evalResult.diversionDetected,
        tamperSealStatus: evalResult.tamperSealStatus,
        tamperSealMessage: sealResult?.message || (sealRecord?.consumedAt ? `Seal authenticated on ${sealRecord.consumedAt}` : undefined),
        consumedAt: sealRecord?.consumedAt || null,
        scanRecord: scanRec,
        sealResult: sealResult || undefined,
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
