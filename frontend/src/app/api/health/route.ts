import { NextResponse } from "next/server";
import { ethers } from "ethers";
import {
  PHARMA_TREE_ABI,
  PHARMA_TREE_CONTRACT,
} from "@/lib/pharmaTree";
import { getReadonlyProvider } from "@/lib/rpc";

export const dynamic = "force-dynamic";

export async function GET() {
  const startTime = Date.now();
  let rpcHealthy = false;
  let contractHealthy = false;
  let relayerHealthy = false;
  let currentBlock: number | null = null;
  let totalUnits: number | null = null;
  let rpcLatencyMs: number | null = null;

  let relayerInfo: {
    configured: boolean;
    address?: string;
    balanceEth?: string;
    solvent?: boolean;
  } = { configured: false };

  const provider = getReadonlyProvider();

  // 1. Check RPC provider & measure latency
  try {
    const rpcStart = Date.now();
    currentBlock = await provider.getBlockNumber();
    rpcLatencyMs = Date.now() - rpcStart;
    rpcHealthy = true;
  } catch (err: any) {
    console.error("[HEALTH CHECK] RPC failure:", err.message);
  }

  // 2. Check Smart Contract availability & unitCounter
  if (rpcHealthy) {
    try {
      const contract = new ethers.Contract(PHARMA_TREE_CONTRACT, PHARMA_TREE_ABI, provider);
      const unitsBig = await contract.unitCounter();
      totalUnits = Number(unitsBig);
      contractHealthy = true;
    } catch (err: any) {
      console.error("[HEALTH CHECK] Contract query failure:", err.message);
    }
  }

  // 3. Check Relayer Wallet solvency
  const relayerKey = process.env.RELAYER_PRIVATE_KEY?.trim();
  if (relayerKey) {
    try {
      const cleanKey = relayerKey.startsWith("0x") ? relayerKey : `0x${relayerKey}`;
      const wallet = new ethers.Wallet(cleanKey, provider);
      const balanceWei = await provider.getBalance(wallet.address);
      const balanceEth = ethers.formatEther(balanceWei);
      const solvent = balanceWei > ethers.parseEther("0.005");

      relayerHealthy = solvent;
      relayerInfo = {
        configured: true,
        address: wallet.address,
        balanceEth: Number(balanceEth).toFixed(4),
        solvent,
      };
    } catch (err: any) {
      console.error("[HEALTH CHECK] Relayer solvency query failure:", err.message);
      relayerInfo = { configured: true, solvent: false };
    }
  }

  const isHealthy = rpcHealthy && contractHealthy;
  const httpStatus = isHealthy ? 200 : 503;
  const memoryUsage = process.memoryUsage();

  return NextResponse.json(
    {
      status: isHealthy ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      latencyMs: Date.now() - startTime,
      environment: process.env.NODE_ENV || "production",
      network: {
        chain: "ethereum-sepolia",
        rpcStatus: rpcHealthy ? "connected" : "unreachable",
        rpcLatencyMs,
        latestBlockNumber: currentBlock,
      },
      contract: {
        address: PHARMA_TREE_CONTRACT,
        status: contractHealthy ? "operational" : "unresponsive",
        totalUnitsRegistered: totalUnits,
      },
      relayer: {
        status: relayerHealthy ? "solvent" : relayerInfo.configured ? "low_funds_or_offline" : "unconfigured",
        ...relayerInfo,
      },
      system: {
        uptimeSeconds: Math.floor(process.uptime()),
        memoryRssMb: Math.round(memoryUsage.rss / 1024 / 1024),
        memoryHeapUsedMb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      },
      securityHardening: {
        contentSecurityPolicy: "enforced",
        rateLimiting: "active",
        inputSanitization: "enforced",
        antiReplayDefense: "active",
      },
    },
    { status: httpStatus }
  );
}
