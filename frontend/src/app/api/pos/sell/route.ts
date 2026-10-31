import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import {
  PHARMA_TREE_ABI,
  PHARMA_TREE_CONTRACT,
  PHARMA_TREE_FORWARDER_ABI,
  PHARMA_TREE_FORWARDER_CONTRACT,
} from "@/lib/pharmaTree";
import { getReadonlyProvider } from "@/lib/rpc";
import {
  checkRateLimit,
  checkVendorDailyQuota,
  getRateLimitHeaders,
  parseSafePositiveInt,
} from "@/lib/rateLimit";

export async function POST(req: NextRequest) {
  // 1. Rate Limiting Protection (Max 30 state-changing dispense calls/minute per IP)
  const rateLimit = checkRateLimit(req, {
    limit: 30,
    windowMs: 60 * 1000,
    prefix: "pos-sell",
  });

  const rateHeaders = getRateLimitHeaders(rateLimit);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        success: false,
        error: "RATE_LIMITED",
        message: "Dispense request threshold exceeded. Please pause briefly before scanning again.",
      },
      {
        status: 429,
        headers: rateHeaders,
      }
    );
  }

  try {
    const body = await req.json();
    const unitId = parseSafePositiveInt(body.unitId);
    const requestedQty = body.quantity !== undefined && body.quantity !== null
      ? parseSafePositiveInt(body.quantity)
      : null;

    if (!unitId) {
      return NextResponse.json(
        {
          success: false,
          error: "INVALID_UNIT_ID",
          message: "A valid positive numerical unit identifier is required.",
        },
        { status: 400, headers: rateHeaders }
      );
    }

    if (body.quantity !== undefined && body.quantity !== null && !requestedQty) {
      return NextResponse.json(
        {
          success: false,
          error: "INVALID_QUANTITY",
          message: "Dispense quantity must be a positive integer greater than zero.",
        },
        { status: 400, headers: rateHeaders }
      );
    }

    const provider = getReadonlyProvider();
    const readContract = new ethers.Contract(PHARMA_TREE_CONTRACT, PHARMA_TREE_ABI, provider);

    // 2. Verify on-chain state atomically before attempting any sale
    const unit = await readContract.getUnitDetails(unitId);
    const currentStatus = Number(unit.status);
    const unitQuantity = Number(unit.quantity);
    const currentOwner = unit.currentOwner;

    if (currentStatus !== 0) {
      const statusNames = ["Active", "PendingTransfer", "Sold", "Rejected"];
      return NextResponse.json(
        {
          success: false,
          error: "NOT_ACTIVE",
          message: `Cannot dispense unit #${unitId}: current status is '${statusNames[currentStatus] || currentStatus}'. Only Active items can be sold.`,
        },
        { status: 400, headers: rateHeaders }
      );
    }

    const dispenseQty = requestedQty && requestedQty > 0 ? requestedQty : unitQuantity;
    if (dispenseQty > unitQuantity) {
      return NextResponse.json(
        {
          success: false,
          error: "EXCEEDS_QUANTITY",
          message: `Requested quantity (${dispenseQty}) exceeds available unit stock (${unitQuantity}).`,
        },
        { status: 400, headers: rateHeaders }
      );
    }

    // 3. Check Relayer Key Configuration
    const relayerKey = process.env.RELAYER_PRIVATE_KEY?.trim();
    if (!relayerKey) {
      return NextResponse.json(
        {
          success: false,
          requiresClientSigning: true,
          currentOwner,
          message: "No server relayer key configured. Please confirm sale via connected vendor wallet.",
        },
        { headers: rateHeaders }
      );
    }

    // Connect wallet signer to Sepolia
    const cleanKey = relayerKey.startsWith("0x") ? relayerKey : `0x${relayerKey}`;
    const relayerWallet = new ethers.Wallet(cleanKey, provider);

    // 4. Relayer Balance Circuit Breaker
    // Prevents relayer starvation and gas exhaustion attacks
    let relayerBalance: bigint = BigInt(0);
    try {
      relayerBalance = await provider.getBalance(relayerWallet.address);
    } catch (balErr) {
      console.warn("Failed to query relayer balance:", balErr);
    }

    // Hard cutoff: < 0.001 ETH
    if (relayerBalance > BigInt(0) && relayerBalance < ethers.parseEther("0.001")) {
      return NextResponse.json(
        {
          success: false,
          error: "RELAYER_INSUFFICIENT_GAS",
          message: "Gasless relayer pool depleted below safety threshold (< 0.001 ETH). Please sign directly with your dispensary wallet.",
        },
        { status: 503, headers: rateHeaders }
      );
    }

    // Warning threshold: < 0.005 ETH
    if (relayerBalance > BigInt(0) && relayerBalance < ethers.parseEther("0.005")) {
      rateHeaders["X-Relayer-Gas-Low"] = "true";
    }

    const targetVendor = currentOwner.toLowerCase();

    // 5. Authenticated Forwarding: EIP-712 Forward Request Execution
    if (body.forwardRequest && PHARMA_TREE_FORWARDER_CONTRACT) {
      const fwd = body.forwardRequest;
      if (fwd.from?.toLowerCase() !== targetVendor) {
        return NextResponse.json(
          {
            success: false,
            error: "UNAUTHORIZED_FORWARD_SIGNER",
            message: `Forward request signer (${fwd.from}) does not match current unit owner (${currentOwner}).`,
          },
          { status: 403, headers: rateHeaders }
        );
      }

      // Check daily quota per vendor
      const quota = await checkVendorDailyQuota(targetVendor, 50);
      if (!quota.allowed) {
        return NextResponse.json(
          {
            success: false,
            error: "VENDOR_DAILY_QUOTA_EXCEEDED",
            message: `Daily gasless transaction quota exceeded for ${currentOwner} (50 tx/day). Please retry tomorrow or self-fund transaction.`,
          },
          { status: 429, headers: rateHeaders }
        );
      }

      const forwarder = new ethers.Contract(
        PHARMA_TREE_FORWARDER_CONTRACT,
        PHARMA_TREE_FORWARDER_ABI,
        relayerWallet
      );

      const isValid = await forwarder.verify(fwd);
      if (!isValid) {
        return NextResponse.json(
          {
            success: false,
            error: "INVALID_FORWARD_SIGNATURE",
            message: "The forward request signature or deadline failed verification.",
          },
          { status: 400, headers: rateHeaders }
        );
      }

      const tx = await forwarder.execute(fwd);
      const receipt = await tx.wait(1);

      return NextResponse.json(
        {
          success: true,
          relayed: true,
          txHash: tx.hash,
          blockNumber: receipt?.blockNumber,
          unitId,
          dispensedQuantity: dispenseQty,
          remainingQuantity: unitQuantity - dispenseQty,
          isFractional: dispenseQty < unitQuantity,
          quotaRemaining: quota.remaining,
          timestamp: Math.floor(Date.now() / 1000),
        },
        { headers: rateHeaders }
      );
    }

    // 6. Cryptographic Personal Sign Authentication (EIP-191 Auth)
    if (body.authSignature && body.authTimestamp) {
      const authAgeMs = Date.now() - Number(body.authTimestamp);
      if (authAgeMs < -60000 || authAgeMs > 10 * 60 * 1000) {
        return NextResponse.json(
          {
            success: false,
            error: "EXPIRED_AUTH_SIGNATURE",
            message: "Authorization signature has expired (validity window: 10 minutes).",
          },
          { status: 401, headers: rateHeaders }
        );
      }

      const expectedMsg = `Authorize PharmaTree Dispense: Unit #${unitId} Qty: ${dispenseQty} Nonce: ${body.authTimestamp}`;
      let recovered = "";
      try {
        recovered = ethers.verifyMessage(expectedMsg, body.authSignature).toLowerCase();
      } catch {
        return NextResponse.json(
          {
            success: false,
            error: "MALFORMED_SIGNATURE",
            message: "Failed to decode cryptographic authorization signature.",
          },
          { status: 400, headers: rateHeaders }
        );
      }

      if (recovered !== targetVendor) {
        return NextResponse.json(
          {
            success: false,
            error: "FORBIDDEN_SIGNER",
            message: `Signer ${recovered} does not match current registered owner ${currentOwner}.`,
          },
          { status: 403, headers: rateHeaders }
        );
      }

      // Check daily quota
      const quota = await checkVendorDailyQuota(targetVendor, 50);
      if (!quota.allowed) {
        return NextResponse.json(
          {
            success: false,
            error: "VENDOR_DAILY_QUOTA_EXCEEDED",
            message: `Daily gasless transaction quota exceeded for ${currentOwner} (50 tx/day).`,
          },
          { status: 429, headers: rateHeaders }
        );
      }
    }

    // 7. Check if Relayer is directly authorized
    if (currentOwner.toLowerCase() !== relayerWallet.address.toLowerCase() && !body.forwardRequest && !body.authSignature) {
      return NextResponse.json(
        {
          success: false,
          requiresClientSigning: true,
          currentOwner,
          relayerAddress: relayerWallet.address,
          trustedForwarder: PHARMA_TREE_FORWARDER_CONTRACT || undefined,
          challenge: {
            unitId,
            quantity: dispenseQty,
            nonce: Date.now(),
          },
          message: `Unit is registered to owner ${currentOwner}, but the gasless relayer operates as ${relayerWallet.address}. Please confirm transaction with your dispensary wallet signature.`,
        },
        { headers: rateHeaders }
      );
    }

    // 8. Execute on-chain dispense via relayer wallet
    const writeContract = new ethers.Contract(PHARMA_TREE_CONTRACT, PHARMA_TREE_ABI, relayerWallet);
    let tx: ethers.ContractTransactionResponse;

    if (dispenseQty === unitQuantity) {
      tx = await writeContract.markAsSold(unitId);
    } else {
      tx = await writeContract.sellQuantity(unitId, dispenseQty);
    }

    const receipt = await tx.wait(1);

    return NextResponse.json(
      {
        success: true,
        txHash: tx.hash,
        blockNumber: receipt?.blockNumber,
        unitId,
        dispensedQuantity: dispenseQty,
        remainingQuantity: unitQuantity - dispenseQty,
        isFractional: dispenseQty < unitQuantity,
        timestamp: Math.floor(Date.now() / 1000),
      },
      { headers: rateHeaders }
    );
  } catch (err: any) {
    console.error("Error in /api/pos/sell:", err);
    return NextResponse.json(
      {
        success: false,
        error: "TRANSACTION_FAILED",
        message: err.reason || err.message || "Failed to broadcast dispensing transaction to Sepolia.",
      },
      { status: 500, headers: rateHeaders }
    );
  }
}
