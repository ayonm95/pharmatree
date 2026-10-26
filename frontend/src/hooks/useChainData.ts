"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { ethers } from "ethers";
import {
  PHARMA_TREE_ABI,
  PHARMA_TREE_CHAIN_ID,
  PHARMA_TREE_CONTRACT,
} from "@/lib/pharmaTree";
import { readonlyProvider } from "@/lib/rpc";
import { withRpcRetry } from "./useRpcRetry";
import { UnitRecord, HistoryEntry, UnitActivity } from "@/types/pharmatree";

const WALLET_STORAGE_KEY = "pharmatree-wallet-address";
const DEFAULT_EVENT_LOOKBACK = 10_000;
const ACTIVITY_CACHE_TTL = 30_000;

type ActivityResult = {
  activity: Record<string, UnitActivity>;
  historyLogs: HistoryEntry[];
};

let activityCache: { expiresAt: number; value: ActivityResult } | null = null;
let activityRequest: Promise<ActivityResult> | null = null;

export function invalidateChainActivityCache() {
  activityCache = null;
  activityRequest = null;
}

export function useChainData() {
  const [account, setAccount] = useState("");
  const [contract, setContract] = useState<ethers.Contract | null>(null);
  const [connected, setConnected] = useState(false);
  const [role, setRole] = useState<{ manufacturer: boolean; handler: boolean }>({
    manufacturer: false,
    handler: false,
  });
  const [isAdmin, setIsAdmin] = useState(false);
  const [units, setUnits] = useState<UnitRecord[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [status, setStatus] = useState("Connect your wallet to review the chain");
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [isDataLoading, setIsDataLoading] = useState(true);
  const isConnectingRef = useRef(false);

  const readonlyContract = useMemo(
    () => new ethers.Contract(PHARMA_TREE_CONTRACT, PHARMA_TREE_ABI, readonlyProvider),
    []
  );

  const fetchUnitActivity = useCallback(async (contractInstance: ethers.Contract): Promise<ActivityResult> => {
    if (activityCache && activityCache.expiresAt > Date.now()) return activityCache.value;
    if (activityRequest) return activityRequest;

    activityRequest = (async (): Promise<ActivityResult> => {
      try {
        const activity: Record<string, UnitActivity> = {};
        const historyLogs: HistoryEntry[] = [];
        const latestBlock = await withRpcRetry(() => readonlyProvider.getBlockNumber());
        const configuredStart = Number(process.env.NEXT_PUBLIC_DEPLOYMENT_BLOCK || "11683269");
        const fromBlock = configuredStart > 0
          ? configuredStart
          : Math.max(0, latestBlock - DEFAULT_EVENT_LOOKBACK);

        const LOG_CHUNK_SIZE = 40_000;
        const ranges: { from: number; to: number }[] = [];
        for (let start = fromBlock; start <= latestBlock; start += LOG_CHUNK_SIZE) {
          ranges.push({ from: start, to: Math.min(start + LOG_CHUNK_SIZE - 1, latestBlock) });
        }

        const logResults = await Promise.all(
          ranges.map((r) =>
            withRpcRetry(() =>
              readonlyProvider.getLogs({
                address: PHARMA_TREE_CONTRACT,
                fromBlock: r.from,
                toBlock: r.to,
              })
            )
          )
        );
        const logs: ethers.Log[] = logResults.flat();

        const blockTimes = new Map<number, number>();
        const uniqueBlockNumbers = Array.from(new Set(logs.map((l) => l.blockNumber)));
        await Promise.all(
          uniqueBlockNumbers.slice(0, 30).map(async (bNum) => {
            try {
              const block = await withRpcRetry(() => readonlyProvider.getBlock(bNum));
              if (block) blockTimes.set(bNum, Number(block.timestamp));
            } catch {
              blockTimes.set(bNum, Math.floor(Date.now() / 1000));
            }
          })
        );

        for (const rawLog of logs) {
          try {
            const parsed = contractInstance.interface.parseLog(rawLog);
            if (!parsed || !parsed.args) continue;
            const log = { ...rawLog, args: parsed.args, fragment: parsed.fragment };
            const id = String(log.args[0]);
            const current = activity[id] ?? {};
            const timestamp = blockTimes.get(log.blockNumber) ?? Math.floor(Date.now() / 1000);
            const eventName = log.fragment?.name;

            let from = "";
            let to = "";
            let rejectedBy: string | undefined = undefined;

            if (eventName === "UnitCreated") {
              current.createdAt = timestamp;
              from = String(log.args.owner || log.args[3] || "");
              to = from;
            } else if (eventName === "TransferInitiated") {
              current.initiatedAt = timestamp;
              current.initiatedFrom = String(log.args.from || log.args[1] || "");
              current.initiatedTo = String(log.args.to || log.args[2] || "");
              from = current.initiatedFrom;
              to = current.initiatedTo;
            } else if (eventName === "TransferCompleted") {
              current.acceptedAt = timestamp;
              current.acceptedFrom = String(log.args.from || log.args[1] || "");
              current.acceptedTo = String(log.args.to || log.args[2] || "");
              from = current.acceptedFrom;
              to = current.acceptedTo;
            } else if (eventName === "TransferRejected") {
              current.rejectedAt = timestamp;
              current.rejectedFrom = String(log.args.from || log.args[1] || "");
              current.rejectedBy = String(log.args.rejectedBy || log.args[2] || "");
              from = current.rejectedFrom;
              rejectedBy = current.rejectedBy;
              to = current.rejectedBy;
            } else if (eventName === "UnitSold") {
              current.soldAt = timestamp;
              from = String(log.args.soldBy || log.args[1] || "");
            } else if (eventName === "TransferCancelled") {
              from = String(log.args.cancelledBy || log.args[1] || "");
            } else if (eventName === "UnitReclaimed") {
              from = String(log.args.reclaimedBy || log.args[1] || "");
            }

            activity[id] = current;

            if (eventName) {
              historyLogs.push({
                id,
                type: eventName,
                from,
                to,
                rejectedBy,
                txHash: rawLog.transactionHash,
                blockNumber: rawLog.blockNumber,
                timestamp,
              });
            }
          } catch {
            // Ignore unparseable log
          }
        }

        historyLogs.sort((a, b) => {
          if (b.blockNumber !== a.blockNumber) return b.blockNumber - a.blockNumber;
          return (b.timestamp ?? 0) - (a.timestamp ?? 0);
        });

        const result: ActivityResult = { activity, historyLogs };
        activityCache = { expiresAt: Date.now() + ACTIVITY_CACHE_TTL, value: result };
        return result;
      } catch (err) {
        console.warn("fetchUnitActivity failed:", err);
        return { activity: {}, historyLogs: [] };
      }
    })();

    try {
      return await activityRequest;
    } finally {
      activityRequest = null;
    }
  }, []);

  const fetchAllUnits = useCallback(async (contractInstance: ethers.Contract): Promise<UnitRecord[]> => {
    try {
      // Fast path: Query indexed database projection endpoint
      try {
        const res = await fetch("/api/units?limit=100");
        if (res.ok) {
          const data = await res.json();
          if (data.success && Array.isArray(data.units) && data.units.length > 0) {
            const unitsList: UnitRecord[] = data.units.map((u: any) => ({
              id: String(u.unitId),
              displayId: String(u.unitId),
              parentId: String(u.parentId),
              rootId: String(u.rootId),
              level: Number(u.level),
              manufacturer: u.manufacturer,
              currentOwner: u.currentOwner,
              pendingReceiver: u.pendingReceiver,
              status: Number(u.status),
              quantity: String(u.quantity),
              metadata: u.metadata,
              ownerLabel: u.currentOwner,
            }));

            const childrenSeen: Record<string, number> = {};
            const byId = new Map(unitsList.map((unit) => [unit.id, unit]));
            for (const unit of unitsList) {
              if (unit.parentId === "0") continue;
              childrenSeen[unit.rootId] = (childrenSeen[unit.rootId] ?? 0) + 1;
              const root = byId.get(unit.rootId);
              unit.displayId = `${root?.displayId ?? unit.rootId}.${childrenSeen[unit.rootId]}`;
            }

            void fetchUnitActivity(contractInstance)
              .then((res) => {
                if (!res) return;
                const { activity, historyLogs } = res;
                if (activity && Object.keys(activity).length > 0) {
                  setUnits((prev) =>
                    prev.map((unit) => (activity && activity[unit.id] ? { ...unit, ...activity[unit.id] } : unit))
                  );
                }
                if (historyLogs && historyLogs.length > 0) {
                  setHistory(historyLogs);
                }
              })
              .catch(() => {});

            return unitsList;
          }
        }
      } catch (apiErr) {
        console.warn("Fast indexer API fetch bypassed, using direct RPC:", apiErr);
      }

      // Fallback: Direct RPC loop if API is offline
      const count = await contractInstance.unitCounter();
      const countNum = Number(count);
      if (countNum <= 0) return [];

      const promises: Promise<UnitRecord | null>[] = [];
      for (let index = 1; index <= countNum; index++) {
        promises.push(
          contractInstance.getUnitDetails(BigInt(index))
            .then((detail: any) => ({
              id: String(index),
              displayId: String(index),
              parentId: String(detail[0]),
              rootId: String(detail[1]),
              level: Number(detail[2]),
              manufacturer: detail[3],
              currentOwner: detail[4],
              pendingReceiver: detail[5],
              status: Number(detail[6]),
              quantity: String(detail[7]),
              metadata: detail[8],
              ownerLabel: detail[4],
            } as UnitRecord))
            .catch((error: any) => {
              console.warn(`Unable to read unit ${index}`, error);
              return null;
            })
        );
      }

      const results = await Promise.all(promises);
      const unitsList: UnitRecord[] = results.filter((u): u is UnitRecord => u !== null);

      const childrenSeen: Record<string, number> = {};
      const byId = new Map(unitsList.map((unit) => [unit.id, unit]));
      for (const unit of unitsList) {
        if (unit.parentId === "0") continue;
        childrenSeen[unit.rootId] = (childrenSeen[unit.rootId] ?? 0) + 1;
        const root = byId.get(unit.rootId);
        unit.displayId = `${root?.displayId ?? unit.rootId}.${childrenSeen[unit.rootId]}`;
      }

      void fetchUnitActivity(contractInstance)
        .then((res) => {
          if (!res) return;
          const { activity, historyLogs } = res;
          if (activity && Object.keys(activity).length > 0) {
            setUnits((prev) =>
              prev.map((unit) => (activity && activity[unit.id] ? { ...unit, ...activity[unit.id] } : unit))
            );
          }
          if (historyLogs && historyLogs.length > 0) {
            setHistory(historyLogs);
          }
        })
        .catch(() => {});

      return unitsList;
    } catch (err) {
      console.warn("fetchAllUnits error:", err);
      return [];
    }
  }, [fetchUnitActivity]);

  const loadWalletData = useCallback(async (walletAddress: string, contractToUse: ethers.Contract = readonlyContract) => {
    setIsDataLoading(true);
    try {
      const [manufacturer, handler, adminAddress] = await Promise.all([
        contractToUse.isManufacturer(walletAddress),
        contractToUse.isHandler(walletAddress),
        contractToUse.admin(),
      ]);
      setRole({ manufacturer, handler });
      setIsAdmin(adminAddress.toLowerCase() === walletAddress.toLowerCase());

      const allUnits = await fetchAllUnits(contractToUse);
      // Immediately set units so inventory renders in < 1s without waiting for 25 getLogs calls
      setUnits(allUnits);

      const lowerWallet = walletAddress.toLowerCase();
      const pendingIncoming = allUnits.filter(
        (unit) => unit.pendingReceiver.toLowerCase() === lowerWallet && unit.status === 1
      );
      setPendingApprovalCount(pendingIncoming.length);

      // Hydrate historical logs asynchronously in the background without blocking active inventory
      void fetchUnitActivity(contractToUse)
        .then((res) => {
          if (!res) return;
          const { activity, historyLogs } = res;
          const enrichedUnits = allUnits.map((unit) =>
            activity && activity[unit.id] ? { ...unit, ...activity[unit.id] } : unit
          );
          setUnits(enrichedUnits);

          if (historyLogs && historyLogs.length > 0) {
            setHistory(historyLogs);
          } else {
            const syntheticHistory: HistoryEntry[] = enrichedUnits.flatMap((unit) => {
              const entries: HistoryEntry[] = [];
              if (unit.status === 3 || unit.rejectedAt) {
                entries.push({
                  id: unit.id,
                  type: "TransferRejected",
                  from: unit.rejectedFrom || unit.manufacturer,
                  to: unit.rejectedBy,
                  rejectedBy: unit.rejectedBy,
                  txHash: "rejected",
                  blockNumber: 0,
                  timestamp: unit.rejectedAt ?? unit.createdAt,
                  quantity: unit.quantity,
                });
              }
              if (unit.status === 1) {
                const toTarget =
                  unit.pendingReceiver !== "0x0000000000000000000000000000000000000000"
                    ? unit.pendingReceiver
                    : unit.initiatedTo;
                entries.push({
                  id: unit.id,
                  type: "TransferInitiated",
                  from: unit.initiatedFrom || unit.manufacturer,
                  to: toTarget,
                  txHash: "initiated",
                  blockNumber: 0,
                  timestamp: unit.initiatedAt ?? unit.createdAt,
                  quantity: unit.quantity,
                });
              }
              if (unit.acceptedAt || (unit.status === 0 && unit.parentId !== "0")) {
                entries.push({
                  id: unit.id,
                  type: "TransferCompleted",
                  from: unit.acceptedFrom || unit.manufacturer,
                  to: unit.acceptedTo || unit.currentOwner,
                  txHash: "completed",
                  blockNumber: 0,
                  timestamp: unit.acceptedAt ?? unit.createdAt,
                  quantity: unit.quantity,
                });
              }
              if (unit.status === 2 || unit.soldAt) {
                entries.push({
                  id: unit.id,
                  type: "UnitSold",
                  from: unit.currentOwner || unit.manufacturer,
                  txHash: "sold",
                  blockNumber: 0,
                  timestamp: unit.soldAt ?? unit.createdAt,
                  quantity: unit.quantity,
                });
              }
              return entries;
            });
            setHistory(syntheticHistory);
          }
        })
        .catch((activityErr) => {
          console.warn("Background activity fetch failed (non-critical):", activityErr);
        });
    } catch (err) {
      console.error("loadWalletData failed:", err);
    } finally {
      setIsDataLoading(false);
    }
  }, [fetchAllUnits, fetchUnitActivity, readonlyContract]);

  const refreshReadonlyState = useCallback(async () => {
    setIsDataLoading(true);
    try {
      const mapped = await fetchAllUnits(readonlyContract);
      setUnits(mapped);
    } catch (error) {
      console.error(error);
    } finally {
      setIsDataLoading(false);
    }
  }, [fetchAllUnits, readonlyContract]);

  const getEthereumProvider = () => {
    if (typeof window === "undefined") return null;
    const anyWin = window as any;
    if (!anyWin.ethereum) return null;

    if (Array.isArray(anyWin.ethereum.providers)) {
      // Find authentic MetaMask provider (not hijacked by Phantom, Coinbase, Brave, etc.)
      const metamask = anyWin.ethereum.providers.find(
        (p: any) => p.isMetaMask && !p.isPhantom && !p.isCoinbaseWallet && !p.isBraveWallet
      );
      if (metamask) return metamask;
      const fallbackMetaMask = anyWin.ethereum.providers.find((p: any) => p.isMetaMask);
      if (fallbackMetaMask) return fallbackMetaMask;
      return anyWin.ethereum.providers[0];
    }

    return anyWin.ethereum;
  };

  const connectWallet = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}): Promise<{
      success: boolean;
      account?: string;
      error?: string;
    }> => {
      if (isConnectingRef.current) {
        return { success: false, error: "Connection request already in progress." };
      }

      const provider = getEthereumProvider();
      if (!provider) {
        const errorMsg = "MetaMask is not detected. Please install the MetaMask browser extension and refresh.";
        if (!silent) setStatus(errorMsg);
        return { success: false, error: errorMsg };
      }

      try {
        isConnectingRef.current = true;
        setLoading(true);

        let walletAddress: string | null = null;

        if (silent) {
          const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
          if (accounts && accounts.length > 0) {
            walletAddress = accounts[0];
          }
        } else {
          try {
            const requested = (await provider.request({ method: "eth_requestAccounts" })) as string[];
            if (requested && requested.length > 0) {
              walletAddress = requested[0];
            }
          } catch (reqErr: any) {
            if (reqErr?.code === -32002) {
              const msg = "MetaMask connection request is already open. Please open your MetaMask extension popup.";
              setStatus(msg);
              return { success: false, error: msg };
            }
            if (reqErr?.code === 4001) {
              const msg = "Connection request was rejected in MetaMask.";
              setStatus(msg);
              return { success: false, error: msg };
            }
            throw reqErr;
          }
        }

        if (!walletAddress) {
          if (!silent) {
            const msg = "No account selected. Please unlock or select an account in MetaMask.";
            setStatus(msg);
            return { success: false, error: msg };
          }
          return { success: false };
        }

        // Verify and switch network via direct EIP-1193 calls (avoids ethers v6 cached NETWORK_ERROR)
        const targetChainHex = `0x${PHARMA_TREE_CHAIN_ID.toString(16)}`;
        let currentChainHex = (await provider.request({ method: "eth_chainId" })) as string;

        if (BigInt(currentChainHex) !== PHARMA_TREE_CHAIN_ID) {
          try {
            await provider.request({
              method: "wallet_switchEthereumChain",
              params: [{ chainId: targetChainHex }],
            });
          } catch (switchError: any) {
            const errorCode = switchError?.code || switchError?.data?.originalError?.code;
            if (
              errorCode === 4902 ||
              switchError?.message?.includes("4902") ||
              switchError?.message?.toLowerCase().includes("unrecognized chain")
            ) {
              try {
                await provider.request({
                  method: "wallet_addEthereumChain",
                  params: [
                    {
                      chainId: targetChainHex,
                      chainName: "Sepolia Test Network",
                      nativeCurrency: { name: "SepoliaETH", symbol: "ETH", decimals: 18 },
                      rpcUrls: [
                        process.env.NEXT_PUBLIC_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
                        "https://rpc.sepolia.org",
                      ],
                      blockExplorerUrls: ["https://sepolia.etherscan.io"],
                    },
                  ],
                });
              } catch (_addError: any) {
                console.warn("Failed to add Sepolia network to MetaMask", _addError);
                const msg = "Failed to add Sepolia network to MetaMask.";
                setStatus(msg);
                return { success: false, error: msg };
              }
            } else if (switchError?.code === 4001) {
              const msg = "Network switch to Sepolia was rejected in MetaMask.";
              setStatus(msg);
              return { success: false, error: msg };
            } else {
              const msg = `Please switch MetaMask to Sepolia network (Chain ID: ${PHARMA_TREE_CHAIN_ID.toString()}).`;
              setStatus(msg);
              return { success: false, error: msg };
            }
          }

          // Re-verify chain after switch attempt
          currentChainHex = (await provider.request({ method: "eth_chainId" })) as string;
          if (BigInt(currentChainHex) !== PHARMA_TREE_CHAIN_ID) {
            const msg = `MetaMask must be connected to Sepolia (Chain ${PHARMA_TREE_CHAIN_ID.toString()}).`;
            setStatus(msg);
            return { success: false, error: msg };
          }
        }

        // Initialize fresh BrowserProvider with confirmed chain
        const browserProvider = new ethers.BrowserProvider(provider, "any");
        const signer = await browserProvider.getSigner(walletAddress);
        const signerContract = new ethers.Contract(PHARMA_TREE_CONTRACT, PHARMA_TREE_ABI, signer);

        setContract(signerContract);
        setAccount(walletAddress);
        setConnected(true);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(WALLET_STORAGE_KEY, walletAddress);
        }
        setStatus(`Connected as ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}.`);

        void loadWalletData(walletAddress, readonlyContract);
        return { success: true, account: walletAddress };
      } catch (error: any) {
        console.error("Wallet connection error:", error);
        let message = "Wallet connection failed.";
        if (error?.code === 4001) message = "Connection request was rejected in MetaMask.";
        else if (error?.code === -32002) message = "MetaMask popup is already pending. Click the MetaMask extension icon.";
        else if (error?.message) message = error.message.slice(0, 100);

        if (!silent) setStatus(message);
        return { success: false, error: message };
      } finally {
        isConnectingRef.current = false;
        setLoading(false);
      }
    },
    [loadWalletData, readonlyContract]
  );

  useEffect(() => {
    void refreshReadonlyState();
  }, [refreshReadonlyState]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const setupListenersAndAutoConnect = async () => {
      const provider = getEthereumProvider();
      if (!provider) return;

      try {
        const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
        if (accounts && accounts.length > 0) {
          await connectWallet({ silent: true });
        }
      } catch (error) {
        console.warn("Auto-connect failed", error);
      }

      const handleAccountsChanged = (accounts: string[]) => {
        if (!accounts || accounts.length === 0) {
          setAccount("");
          setConnected(false);
          setRole({ manufacturer: false, handler: false });
          setIsAdmin(false);
          setPendingApprovalCount(0);
          setHistory([]);
          setUnits([]);
          window.localStorage.removeItem(WALLET_STORAGE_KEY);
          setStatus("Wallet disconnected");
          return;
        }
        window.localStorage.setItem(WALLET_STORAGE_KEY, accounts[0]);
        void connectWallet({ silent: true });
      };

      const handleChainChanged = () => {
        window.location.reload();
      };

      provider.on?.("accountsChanged", handleAccountsChanged);
      provider.on?.("chainChanged", handleChainChanged);

      return () => {
        provider.removeListener?.("accountsChanged", handleAccountsChanged);
        provider.removeListener?.("chainChanged", handleChainChanged);
      };
    };

    let cleanupListeners: (() => void) | undefined;
    void setupListenersAndAutoConnect().then((cleanup) => {
      cleanupListeners = cleanup;
    });

    const handleEthereumInitialized = () => {
      void setupListenersAndAutoConnect().then((cleanup) => {
        cleanupListeners = cleanup;
      });
    };
    window.addEventListener("ethereum#initialized", handleEthereumInitialized, { once: true });

    return () => {
      window.removeEventListener("ethereum#initialized", handleEthereumInitialized);
      cleanupListeners?.();
    };
  }, [connectWallet]);

  return {
    account,
    contract,
    connected,
    role,
    isAdmin,
    units,
    history,
    status,
    loading,
    isDataLoading,
    pendingApprovalCount,
    readonlyContract,
    connectWallet,
    refreshReadonlyState,
    loadWalletData,
  };
}
