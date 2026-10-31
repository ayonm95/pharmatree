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
  getClientIp,
  getRateLimitHeaders,
  parseSafePositiveInt,
} from "@/lib/rateLimit";
import {
  withRelayerLock,
  getSaleByIdempotencyKey,
  recordSaleSubmitted,
  recordSaleCompleted,
  recordSaleFailed,
} from "@/lib/db";
import {
  resolveTenantFromHeadersAsync,
  isVendorAllowedForTenant,
  checkTenantDailyQuota,
  getQuotaForTier,
} from "@/lib/tenantAuth";

/**
 * Execute an on-chain transaction with dynamic pending nonce resolution and jittered retry backoff.
 */
async function executeWithNonceRetry<T>(
  wallet: ethers.Wallet,
  sendFn: (nonce: number) => Promise<T>,
  maxRetries = 3
): Promise<T> {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      const nonce = await wallet.getNonce("pending");
      return await sendFn(nonce);
    } catch (err: any) {
      attempt++;
      const msg = (err?.message || "").toLowerCase();
      const isNonceCollision =
        msg.includes("nonce") ||
        msg.includes("replacement transaction underpriced") ||
        msg.includes("already known");
      if (isNonceCollision && attempt < maxRetries) {
        const jitterMs = 300 + Math.floor(Math.random() * 500) * attempt;
        console.warn(
          `[Relayer] Nonce collision detected (attempt ${attempt}/${maxRetries}), retrying in ${jitterMs}ms:`,
          err.message
        );
        await new Promise((res) => setTimeout(res, jitterMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Relayer transaction failed after maximum retries");
}

function extractSoldUnitId(receipt: any, fallbackId: number): number {
  if (!receipt || !receipt.logs) return fallbackId;
  const iface = new ethers.Interface(PHARMA_TREE_ABI);
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "UnitSold") {
        return Number(parsed.args[0]);
      }
    } catch {}
  }
  return fallbackId;
}

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

  // 2. Multi-Tenant Authentication & Access Policy
  const allowDemoFallback = process.env.STRICT_TENANT_AUTH !== "true";
  const tenantResolution = await resolveTenantFromHeadersAsync(req.headers, { allowDemoFallback });

  if (!tenantResolution.authenticated || !tenantResolution.tenant) {
    return NextResponse.json(
      {
        success: false,
        error: tenantResolution.error || "UNAUTHORIZED",
        message:
          tenantResolution.message ||
          "Valid X-Tenant-Key or Authorization Bearer token required to access POS endpoints.",
      },
      {
        status: 401,
        headers: rateHeaders,
      }
    );
  }

  const tenant = tenantResolution.tenant;
  rateHeaders["X-Tenant-ID"] = tenant.id;
  rateHeaders["X-Tenant-Tier"] = tenant.tier;

  const rawIdempotencyKey =
    req.headers.get("idempotency-key") || req.headers.get("x-idempotency-key");
  const idempotencyKey = rawIdempotencyKey ? `${tenant.id}:${rawIdempotencyKey.trim()}` : null;

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

    // Idempotency check with tenant scoping, payload match verification, and status reconciliation
    if (idempotencyKey) {
      const existing = await getSaleByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (
          existing.unitId !== unitId ||
          (requestedQty !== null && existing.quantity !== requestedQty)
        ) {
          return NextResponse.json(
            {
              success: false,
              error: "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH",
              message:
                "Idempotency key was previously submitted with a different unitId or quantity payload.",
            },
            { status: 422, headers: rateHeaders }
          );
        }

        if (existing.status === "MINED" && existing.responsePayload) {
          return NextResponse.json(existing.responsePayload, {
            headers: {
              ...rateHeaders,
              "X-Idempotency-Replay": "true",
            },
          });
        }

        if (existing.status === "SUBMITTED") {
          if (existing.txHash) {
            try {
              const receipt = await provider.getTransactionReceipt(existing.txHash);
              if (receipt) {
                if (receipt.status === 1) {
                  const minedPayload = existing.responsePayload || {
                    success: true,
                    txHash: existing.txHash,
                    blockNumber: receipt.blockNumber,
                    unitId: existing.unitId,
                    soldUnitId: existing.unitId,
                    dispensedQuantity: existing.quantity,
                    tenant: { id: tenant.id, name: tenant.name, tier: tenant.tier },
                    timestamp: Math.floor(Date.now() / 1000),
                  };
                  await recordSaleCompleted(idempotencyKey, existing.txHash, minedPayload);
                  return NextResponse.json(minedPayload, {
                    headers: {
                      ...rateHeaders,
                      "X-Idempotency-Replay": "true",
                    },
                  });
                } else if (receipt.status === 0) {
                  await recordSaleFailed(idempotencyKey, "Transaction reverted on-chain");
                  return NextResponse.json(
                    {
                      success: false,
                      error: "TRANSACTION_REVERTED",
                      txHash: existing.txHash,
                      message: "The on-chain transaction for this idempotency key reverted.",
                    },
                    { status: 500, headers: rateHeaders }
                  );
                }
              }
            } catch (rErr) {
              console.warn("Could not query transaction receipt for idempotency key:", rErr);
            }
          }

          return NextResponse.json(
            {
              success: false,
              error: "TRANSACTION_IN_PROGRESS",
              txHash: existing.txHash,
              message:
                "A dispensing transaction with this Idempotency-Key has already been submitted and is pending confirmation.",
            },
            { status: 409, headers: rateHeaders }
          );
        }
      }
    }

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

    // 3. Multi-Tenant Vendor Whitelist & Tenant Gas Quota
    if (!isVendorAllowedForTenant(tenant, currentOwner)) {
      return NextResponse.json(
        {
          success: false,
          error: "UNAUTHORIZED_TENANT_VENDOR",
          message: `Unit owner (${currentOwner}) is not authorized under tenant '${tenant.name}'.`,
        },
        { status: 403, headers: rateHeaders }
      );
    }

    const effectiveTierLimit = getQuotaForTier(tenant.tier);
    if (effectiveTierLimit === null) {
      return NextResponse.json(
        {
          success: false,
          error: "UNKNOWN_TENANT_TIER",
          message: `Tenant '${tenant.name}' has unrecognized tier '${tenant.tier}'. Quota lookup failed closed.`,
        },
        { status: 403, headers: rateHeaders }
      );
    }
    const tenantDailyLimit =
      tenant.dailyQuota > 0 ? Math.min(tenant.dailyQuota, effectiveTierLimit) : effectiveTierLimit;
    const clientIp = getClientIp(req);
    const tenantQuota = await checkTenantDailyQuota(tenant.id, tenantDailyLimit, clientIp);
    rateHeaders["X-Tenant-Quota-Remaining"] = String(tenantQuota.remaining);

    if (!tenantQuota.allowed) {
      if (tenant.tier === "sandbox") {
        return NextResponse.json(
          {
            success: false,
            error: "DEMO_QUOTA_EXCEEDED",
            message: `Demo Dispensing Daily Allowance Reached for this device/IP (${tenantDailyLimit}/${tenantDailyLimit} demo transactions used today). This limit protects testnet relayer gas. Connect a dispensary wallet to sign directly, or try again tomorrow.`,
          },
          { status: 429, headers: rateHeaders }
        );
      }
      return NextResponse.json(
        {
          success: false,
          error: "TENANT_DAILY_QUOTA_EXCEEDED",
          message: `Daily transaction quota exceeded for tenant '${tenant.name}' (${tenantDailyLimit} tx/day limit). Contact sales to upgrade your tier.`,
        },
        { status: 429, headers: rateHeaders }
      );
    }

    // 4. Check Relayer Key Configuration
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

      // staticCall simulation pre-check before submitting on-chain transaction
      try {
        await forwarder.execute.staticCall(fwd);
      } catch (simErr: any) {
        const revertReason =
          simErr?.reason || simErr?.shortMessage || simErr?.message || "Execution simulation reverted";
        return NextResponse.json(
          {
            success: false,
            error: "SIMULATION_REVERTED",
            message: `Pre-execution staticCall reverted: ${revertReason}`,
          },
          { status: 400, headers: rateHeaders }
        );
      }

      if (idempotencyKey) {
        await recordSaleSubmitted(idempotencyKey, unitId, dispenseQty);
      }

      const tx = await withRelayerLock(() =>
        executeWithNonceRetry(relayerWallet, (nonce) => forwarder.execute(fwd, { nonce }))
      );
      const receipt = await tx.wait(1);

      const soldUnitId = extractSoldUnitId(receipt, unitId);
      const responsePayload = {
        success: true,
        relayed: true,
        txHash: tx.hash,
        blockNumber: receipt?.blockNumber,
        unitId,
        soldUnitId,
        dispensedQuantity: dispenseQty,
        remainingQuantity: unitQuantity - dispenseQty,
        isFractional: dispenseQty < unitQuantity,
        quotaRemaining: quota.remaining,
        tenant: {
          id: tenant.id,
          name: tenant.name,
          tier: tenant.tier,
          quotaRemaining: tenantQuota.remaining,
        },
        timestamp: Math.floor(Date.now() / 1000),
      };

      if (idempotencyKey) {
        await recordSaleCompleted(idempotencyKey, tx.hash, responsePayload);
      }

      return NextResponse.json(responsePayload, { headers: rateHeaders });
    }

    // 6. Direct Relayer Execution (Self-Owned Units Only)
    // Since the relayer holds zero roles, third-party sales MUST use EIP-712 forwardRequest
    if (currentOwner.toLowerCase() !== relayerWallet.address.toLowerCase()) {
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
          message: `Unit #${unitId} is owned by ${currentOwner}. Since the relayer holds zero contract roles, state-changing sales require a signed EIP-712 forward request through ${PHARMA_TREE_FORWARDER_CONTRACT || "forwarder"} or direct wallet transaction.`,
        },
        { headers: rateHeaders }
      );
    }

    // 7. Execute on-chain dispense via relayer wallet (only for self-owned units)
    const writeContract = new ethers.Contract(PHARMA_TREE_CONTRACT, PHARMA_TREE_ABI, relayerWallet);

    // staticCall simulation pre-check
    try {
      if (dispenseQty === unitQuantity) {
        await writeContract.markAsSold.staticCall(unitId);
      } else {
        await writeContract.sellQuantity.staticCall(unitId, dispenseQty);
      }
    } catch (simErr: any) {
      const revertReason =
        simErr?.reason || simErr?.shortMessage || simErr?.message || "Simulation reverted";
      return NextResponse.json(
        {
          success: false,
          error: "SIMULATION_REVERTED",
          message: `Pre-execution staticCall reverted: ${revertReason}`,
        },
        { status: 400, headers: rateHeaders }
      );
    }

    if (idempotencyKey) {
      await recordSaleSubmitted(idempotencyKey, unitId, dispenseQty);
    }

    const tx = await withRelayerLock(() =>
      executeWithNonceRetry(relayerWallet, (nonce) => {
        if (dispenseQty === unitQuantity) {
          return writeContract.markAsSold(unitId, { nonce });
        } else {
          return writeContract.sellQuantity(unitId, dispenseQty, { nonce });
        }
      })
    );

    const receipt = await tx.wait(1);

    const soldUnitId = extractSoldUnitId(receipt, unitId);
    const responsePayload = {
      success: true,
      txHash: tx.hash,
      blockNumber: receipt?.blockNumber,
      unitId,
      soldUnitId,
      dispensedQuantity: dispenseQty,
      remainingQuantity: unitQuantity - dispenseQty,
      isFractional: dispenseQty < unitQuantity,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        tier: tenant.tier,
        quotaRemaining: tenantQuota.remaining,
      },
      timestamp: Math.floor(Date.now() / 1000),
    };

    if (idempotencyKey) {
      await recordSaleCompleted(idempotencyKey, tx.hash, responsePayload);
    }

    return NextResponse.json(responsePayload, { headers: rateHeaders });
  } catch (err: any) {
    if (idempotencyKey) {
      await recordSaleFailed(idempotencyKey, err.message || "Dispense transaction failed");
    }
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
