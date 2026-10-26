import { ethers } from "ethers";
import { PHARMA_TREE_ABI, PHARMA_TREE_CONTRACT } from "./pharmaTree";
import { readonlyProvider } from "./rpc";
import {
  upsertUnitRecord,
  saveUnitEvent,
  getLastIndexedBlock,
  setLastIndexedBlock,
  DbUnitRecord,
  DbUnitEvent,
} from "./db";

const DEFAULT_DEPLOYMENT_BLOCK = 11995000;
let isIndexing = false;

export interface IndexerSyncResult {
  success: boolean;
  running?: boolean;
  processedEvents: number;
  fromBlock: number;
  toBlock: number;
  unitCounter?: number;
  error?: string;
}

/**
 * Parses GTIN, Lot, and Serial from unit metadata if present
 */
function extractGs1Identifiers(metadata: string): { gtin?: string; lot?: string; serial?: string } {
  try {
    if (metadata.startsWith("{") && metadata.endsWith("}")) {
      const parsed = JSON.parse(metadata);
      return {
        gtin: parsed.gtin || parsed.GTIN,
        lot: parsed.lot || parsed.batch || parsed.LOT,
        serial: parsed.serial || parsed.serialNumber || parsed.SN,
      };
    }
  } catch {
    // Not JSON
  }

  // Regex extraction for GS1 patterns like "01/GTIN/10/LOT/21/SERIAL"
  const gs1Match = metadata.match(/\/01\/(\d{14})\/10\/([a-zA-Z0-9_-]+)\/21\/([a-zA-Z0-9_-]+)/);
  if (gs1Match) {
    return {
      gtin: gs1Match[1],
      lot: gs1Match[2],
      serial: gs1Match[3],
    };
  }

  return {};
}

/**
 * Hydrates an on-chain unit and saves to database projection
 */
async function hydrateUnit(
  contract: ethers.Contract,
  unitId: number
): Promise<DbUnitRecord | null> {
  try {
    const detail = await contract.getUnitDetails(BigInt(unitId));
    const metadata = String(detail[8] || "");
    const gs1 = extractGs1Identifiers(metadata);

    const record: DbUnitRecord = {
      unitId: String(unitId),
      parentId: String(detail[0]),
      rootId: String(detail[1]),
      level: Number(detail[2]),
      manufacturer: String(detail[3]),
      currentOwner: String(detail[4]),
      pendingReceiver: String(detail[5]),
      status: Number(detail[6]),
      quantity: String(detail[7]),
      metadata,
      gtin: gs1.gtin,
      lot: gs1.lot,
      serial: gs1.serial,
    };

    await upsertUnitRecord(record);
    return record;
  } catch (err) {
    console.warn(`[Indexer] Failed to hydrate Unit #${unitId}:`, err);
    return null;
  }
}

/**
 * Synchronizes chain events from Sepolia into the Postgres/disk projection
 */
export async function syncChainEvents(forceFromBlock?: number): Promise<IndexerSyncResult> {
  if (isIndexing) {
    return {
      success: true,
      running: true,
      processedEvents: 0,
      fromBlock: 0,
      toBlock: 0,
    };
  }

  isIndexing = true;
  try {
    const contract = new ethers.Contract(PHARMA_TREE_CONTRACT, PHARMA_TREE_ABI, readonlyProvider);
    const iface = new ethers.Interface(PHARMA_TREE_ABI);

    const configuredStart = Number(process.env.NEXT_PUBLIC_DEPLOYMENT_BLOCK || DEFAULT_DEPLOYMENT_BLOCK);
    const lastIndexed = await getLastIndexedBlock(configuredStart);
    const fromBlock = forceFromBlock ?? Math.max(lastIndexed, configuredStart);

    let latestBlock = fromBlock;
    try {
      latestBlock = await readonlyProvider.getBlockNumber();
    } catch (err) {
      console.warn("[Indexer] Failed to fetch latest block number, using fallback:", err);
      latestBlock = fromBlock;
    }

    if (latestBlock < fromBlock) {
      return {
        success: true,
        processedEvents: 0,
        fromBlock,
        toBlock: latestBlock,
      };
    }

    // Process logs in chunks of 20,000 blocks to prevent RPC timeouts
    const CHUNK_SIZE = 20_000;
    const touchedUnitIds = new Set<number>();
    let totalEvents = 0;

    for (let start = fromBlock; start <= latestBlock; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE - 1, latestBlock);
      try {
        const logs = await readonlyProvider.getLogs({
          address: PHARMA_TREE_CONTRACT,
          fromBlock: start,
          toBlock: end,
        });

        for (const log of logs) {
          try {
            const parsed = iface.parseLog(log);
            if (!parsed) continue;

            const unitId = Number(parsed.args.id || parsed.args[0] || 0);
            if (unitId > 0) {
              touchedUnitIds.add(unitId);
            }

            let fromAddress = "";
            let toAddress = "";

            if (parsed.name === "UnitCreated") {
              fromAddress = String(parsed.args.owner || parsed.args[3] || "");
            } else if (parsed.name === "TransferInitiated" || parsed.name === "TransferCompleted") {
              fromAddress = String(parsed.args.from || parsed.args[1] || "");
              toAddress = String(parsed.args.to || parsed.args[2] || "");
            } else if (parsed.name === "TransferRejected") {
              fromAddress = String(parsed.args.from || parsed.args[1] || "");
              toAddress = String(parsed.args.rejectedBy || parsed.args[2] || "");
            } else if (parsed.name === "TransferCancelled") {
              fromAddress = String(parsed.args.cancelledBy || parsed.args[1] || "");
            } else if (parsed.name === "UnitReclaimed") {
              fromAddress = String(parsed.args.reclaimedBy || parsed.args[1] || "");
            } else if (parsed.name === "UnitSold") {
              fromAddress = String(parsed.args.soldBy || parsed.args[1] || "");
            }

            const eventRecord: DbUnitEvent = {
              unitId: String(unitId),
              eventName: parsed.name,
              fromAddress: fromAddress || undefined,
              toAddress: toAddress || undefined,
              blockNumber: log.blockNumber,
              txHash: log.transactionHash,
              timestamp: Math.floor(Date.now() / 1000),
            };

            await saveUnitEvent(eventRecord);
            totalEvents++;
          } catch {
            // Ignore unparsed logs
          }
        }
      } catch (err) {
        console.warn(`[Indexer] Log retrieval chunk ${start}-${end} encountered error:`, err);
      }
    }

    // Hydrate total unit count from on-chain unitCounter
    let totalUnitsOnChain = 0;
    try {
      const counter = await contract.unitCounter();
      totalUnitsOnChain = Number(counter);
    } catch {
      totalUnitsOnChain = 0;
    }

    // If initial sync or touched units exist, hydrate state
    for (let i = 1; i <= totalUnitsOnChain; i++) {
      if (touchedUnitIds.has(i) || touchedUnitIds.size === 0) {
        await hydrateUnit(contract, i);
      }
    }

    await setLastIndexedBlock(latestBlock);

    return {
      success: true,
      processedEvents: totalEvents,
      fromBlock,
      toBlock: latestBlock,
      unitCounter: totalUnitsOnChain,
    };
  } catch (err: any) {
    console.error("[Indexer] Sync error:", err);
    return {
      success: false,
      processedEvents: 0,
      fromBlock: 0,
      toBlock: 0,
      error: err?.message || "Unknown indexer error",
    };
  } finally {
    isIndexing = false;
  }
}
