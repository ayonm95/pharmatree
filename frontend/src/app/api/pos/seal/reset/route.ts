import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import {
  PHARMA_TREE_ABI,
  PHARMA_TREE_CONTRACT,
} from "@/lib/pharmaTree";
import { readonlyProvider } from "@/lib/rpc";
import {
  checkRateLimit,
  getRateLimitHeaders,
  isValidEthAddress,
  parseSafePositiveInt,
} from "@/lib/rateLimit";
import { resetSealLock } from "@/lib/sealVerifier";
import { saveUnitEvent } from "@/lib/db";
import { consumeResetNonce } from "@/lib/tenantAuth";

export async function POST(req: NextRequest) {
  const rateLimit = checkRateLimit(req, {
    limit: 20,
    windowMs: 60 * 1000,
    prefix: "seal-reset",
  });
  const rateHeaders = getRateLimitHeaders(rateLimit);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { success: false, error: "RATE_LIMITED", message: "Rate limit exceeded. Please retry momentarily." },
      { status: 429, headers: rateHeaders }
    );
  }

  try {
    const body = await req.json();
    const unitId = parseSafePositiveInt(body.unitId);
    const callerAddress = typeof body.callerAddress === "string" ? body.callerAddress.trim() : "";
    const signature = typeof body.signature === "string" ? body.signature.trim() : "";
    const nonce = typeof body.nonce === "string" ? body.nonce.trim() : "";
    const timestamp = body.timestamp ? Number(body.timestamp) : Date.now();
    const clientIdentifier = typeof body.clientIdentifier === "string" ? body.clientIdentifier.trim() : undefined;

    if (!unitId || !isValidEthAddress(callerAddress) || !signature || !nonce) {
      return NextResponse.json(
        {
          success: false,
          error: "INVALID_PARAMETERS",
          message: "Unit ID, valid Ethereum caller address, cryptographic signature, and single-use nonce are required.",
        },
        { status: 400, headers: rateHeaders }
      );
    }

    // Check signature age (10 minutes validity window)
    const ageMs = Date.now() - timestamp;
    if (ageMs < -60000 || ageMs > 10 * 60 * 1000) {
      return NextResponse.json(
        {
          success: false,
          error: "EXPIRED_SIGNATURE",
          message: "Reset signature has expired. Please sign a fresh challenge.",
        },
        { status: 401, headers: rateHeaders }
      );
    }

    // Verify cryptographic signature binding unitId, explicit action, single-use nonce and timestamp
    const challengeMessage = `Reset Seal Lockout for Unit #${unitId} Action: RESET_SEAL Nonce: ${nonce} Timestamp: ${timestamp}`;
    let recovered = "";
    try {
      recovered = ethers.verifyMessage(challengeMessage, signature).toLowerCase();
    } catch {
      return NextResponse.json(
        { success: false, error: "INVALID_SIGNATURE", message: "Malformed signature format." },
        { status: 400, headers: rateHeaders }
      );
    }

    if (recovered !== callerAddress.toLowerCase()) {
      return NextResponse.json(
        {
          success: false,
          error: "SIGNER_MISMATCH",
          message: `Recovered signer (${recovered}) does not match declared caller address (${callerAddress}).`,
        },
        { status: 403, headers: rateHeaders }
      );
    }

    // Atomically consume single-use nonce to prevent replay attacks inside the 10-minute window
    const nonceResult = await consumeResetNonce(nonce, unitId);
    if (!nonceResult.success) {
      return NextResponse.json(
        {
          success: false,
          error: nonceResult.error || "REPLAYED_SIGNATURE",
          message: "This administrative reset signature or nonce has already been consumed. Please generate a fresh nonce.",
        },
        { status: 409, headers: rateHeaders }
      );
    }

    // Query on-chain manufacturer and admin
    const contract = new ethers.Contract(PHARMA_TREE_CONTRACT, PHARMA_TREE_ABI, readonlyProvider);
    const unitData = await contract.getUnitDetails(unitId);
    const manufacturer = unitData.manufacturer;
    const admin = await contract.admin();

    const resetResult = await resetSealLock(
      unitId,
      callerAddress,
      manufacturer,
      admin,
      clientIdentifier
    );

    if (!resetResult.success) {
      return NextResponse.json(
        { success: false, error: "UNAUTHORIZED", message: resetResult.message },
        { status: 403, headers: rateHeaders }
      );
    }

    // Record immutable regulatory audit trail for the administrative reset
    try {
      await saveUnitEvent({
        unitId: String(unitId),
        eventName: "SEAL_LOCKOUT_RESET",
        fromAddress: callerAddress,
        toAddress: manufacturer,
        blockNumber: 0,
        txHash: `auth-reset-${Date.now()}-${callerAddress.slice(0, 10)}`,
        timestamp: Math.floor(Date.now() / 1000),
      });
    } catch (auditErr) {
      console.warn("Non-fatal: could not write audit log for seal reset:", auditErr);
    }

    return NextResponse.json(
      {
        success: true,
        unitId,
        message: resetResult.message,
        resetBy: callerAddress,
        timestamp: Math.floor(Date.now() / 1000),
      },
      { headers: rateHeaders }
    );
  } catch (err: any) {
    console.error("Error in /api/pos/seal/reset:", err);
    return NextResponse.json(
      {
        success: false,
        error: "INTERNAL_ERROR",
        message: err.message || "Failed to reset seal lockout.",
      },
      { status: 500, headers: rateHeaders }
    );
  }
}
