import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import {
  PHARMA_TREE_ABI,
  PHARMA_TREE_CONTRACT,
} from "@/lib/pharmaTree";
import { getReadonlyProvider } from "@/lib/rpc";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const rawId = body.unitId;
    const requestedQty = body.quantity ? Number(body.quantity) : null;

    if (!rawId || isNaN(Number(rawId)) || Number(rawId) <= 0) {
      return NextResponse.json(
        { success: false, error: "INVALID_UNIT_ID", message: "A valid numerical unitId is required." },
        { status: 400 }
      );
    }

    const unitId = Number(rawId);
    const provider = getReadonlyProvider();
    const readContract = new ethers.Contract(PHARMA_TREE_CONTRACT, PHARMA_TREE_ABI, provider);

    // 1. Verify on-chain state
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
        { status: 400 }
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
        { status: 400 }
      );
    }

    // 2. Check Relayer Key
    const relayerKey = process.env.RELAYER_PRIVATE_KEY?.trim();
    if (!relayerKey) {
      return NextResponse.json({
        success: false,
        requiresClientSigning: true,
        currentOwner,
        message: "No server relayer key configured. Please confirm sale via connected vendor wallet.",
      });
    }

    // Connect wallet signer to Sepolia
    const cleanKey = relayerKey.startsWith("0x") ? relayerKey : `0x${relayerKey}`;
    const relayerWallet = new ethers.Wallet(cleanKey, provider);

    // 3. Check ownership permissions
    if (currentOwner.toLowerCase() !== relayerWallet.address.toLowerCase()) {
      return NextResponse.json({
        success: false,
        requiresClientSigning: true,
        currentOwner,
        relayerAddress: relayerWallet.address,
        message: `Unit is registered to owner ${currentOwner}, but the gasless relayer operates as ${relayerWallet.address}. Please sign directly using your dispensary wallet.`,
      });
    }

    // 4. Execute transaction via relayer
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

    return NextResponse.json({
      success: true,
      txHash: tx.hash,
      blockNumber: receipt?.blockNumber,
      unitId,
      dispensedQuantity: dispenseQty,
      remainingQuantity: unitQuantity - dispenseQty,
      isFractional: dispenseQty < unitQuantity,
      timestamp: Math.floor(Date.now() / 1000),
    });
  } catch (err: any) {
    console.error("Error in /api/pos/sell:", err);
    return NextResponse.json(
      {
        success: false,
        error: "TRANSACTION_FAILED",
        message: err.reason || err.message || "Failed to broadcast dispensing transaction to Sepolia.",
      },
      { status: 500 }
    );
  }
}
