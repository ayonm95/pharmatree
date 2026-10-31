import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { getUnitsPaginated } from "@/lib/db";
import { syncChainEvents } from "@/lib/indexer";
import { checkRateLimitAsync, getRateLimitHeaders } from "@/lib/rateLimit";
import { PHARMA_TREE_ABI, PHARMA_TREE_CONTRACT } from "@/lib/pharmaTree";
import { readonlyProvider } from "@/lib/rpc";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // Apply rate limiter (fail-open for read queries)
  const rateLimitResult = await checkRateLimitAsync(request, {
    limit: 60,
    windowMs: 60 * 1000,
    prefix: "units-get",
  });
  const headers = getRateLimitHeaders(rateLimitResult);

  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      { success: false, error: "Too many unit requests. Please slow down." },
      { status: 429, headers }
    );
  }

  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(Math.max(Number(searchParams.get("limit") || "25"), 1), 100);
    const cursor = Number(searchParams.get("cursor") || "0");
    const owner = searchParams.get("owner") || undefined;
    const statusParam = searchParams.get("status");
    const status = statusParam !== null && statusParam !== "" ? Number(statusParam) : undefined;
    const shouldRefresh = searchParams.get("refresh") === "true" || searchParams.get("refresh") === "1";

    const contract = new ethers.Contract(PHARMA_TREE_CONTRACT, PHARMA_TREE_ABI, readonlyProvider);
    let totalOnChain = 0;
    try {
      const counter = await contract.unitCounter();
      totalOnChain = Number(counter);
    } catch (countErr) {
      console.warn("[API Units] Failed to query on-chain unitCounter:", countErr);
    }

    if (shouldRefresh) {
      await syncChainEvents();
    }

    let result = await getUnitsPaginated({ limit, cursor, owner, status });

    // If database projection is cold/empty or missing on-chain units, trigger backfill sync
    const needsBackfill = !shouldRefresh && (
      result.total === 0 ||
      (!owner && status === undefined && totalOnChain > 0 && result.total < totalOnChain)
    );

    if (needsBackfill) {
      await syncChainEvents();
      result = await getUnitsPaginated({ limit, cursor, owner, status });
    }

    return NextResponse.json(
      {
        success: true,
        units: result.units,
        nextCursor: result.nextCursor,
        total: result.total,
      },
      { headers }
    );
  } catch (err: any) {
    console.error("[API Units] Error retrieving units:", err);
    return NextResponse.json(
      { success: false, error: "Failed to query units projection", details: err?.message },
      { status: 500, headers }
    );
  }
}
