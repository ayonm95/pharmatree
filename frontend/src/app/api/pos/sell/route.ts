import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import {
  PHARMA_TREE_ABI,
  PHARMA_TREE_CONTRACT,
} from "@/lib/pharmaTree";
import { getReadonlyProvider } from "@/lib/rpc";
import {
  checkRateLimit,
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

    // 2. Verify on-chain state
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

    // 3. Check Relayer Key
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

    // 4. Check ownership permissions
    if (currentOwner.toLowerCase() !== relayerWallet.address.toLowerCase()) {
      return NextResponse.json(
        {
          success: false,
          requiresClientSigning: true,
          currentOwner,
          relayerAddress: relayerWallet.address,
          message: `Unit is registered to owner ${currentOwner}, but the gasless relayer operates as ${relayerWallet.address}. Please sign directly using your dispensary wallet.`,
        },
        { headers: rateHeaders }
      );
    }

    // 5. Execute transaction via relayer
    const writeContract = new ethers.Contract(PHARMA_TREE_CONTRACT, PHARMA_TREE_ABI, relayerWallet);
    let tx: ethers.ContractTransactionResponse;

    if (dispenseQty === unitQuantity) {
      // Full unit sale
      tx = await writeContract.markAsSold(unitId);
    } else {
      // Dynamic fractional sale
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
