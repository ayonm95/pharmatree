"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ethers } from "ethers";
import QRCode from "qrcode";
import styles from "@/app/page.module.css";
import { PHARMA_TREE_ABI, PHARMA_TREE_CHAIN_ID, PHARMA_TREE_CONTRACT, unitLevelToName } from "@/lib/pharmaTree";
import { readonlyProvider } from "@/lib/rpc";

type ViewMode = "overview" | "transfers" | "inventory" | "create" | "admin";

type UnitRecord = {
  id: string;
  displayId: string;
  parentId: string;
  rootId: string;
  level: number;
  status: number;
  manufacturer: string;
  currentOwner: string;
  pendingReceiver: string;
  metadata: string;
  quantity: string;
  ownerLabel: string;
  createdAt?: number;
  initiatedAt?: number;
  acceptedAt?: number;
  rejectedAt?: number;
  soldAt?: number;
  rejectedBy?: string;
  rejectedFrom?: string;
  initiatedTo?: string;
  initiatedFrom?: string;
  acceptedTo?: string;
  acceptedFrom?: string;
};
const formatDate = (timestamp?: number) =>
  timestamp ? new Date(timestamp * 1000).toLocaleString() : "Not recorded";
const formatDateOnly = (timestamp?: number) =>
  timestamp ? new Date(timestamp * 1000).toLocaleDateString() : "Not recorded";

type HistoryEntry = {
  id: string;
  type: string;
  from?: string;
  to?: string;
  rejectedBy?: string;
  txHash: string;
  blockNumber: number;
  timestamp?: number;
  quantity?: string;
};

type UnitActivity = {
  createdAt?: number;
  initiatedAt?: number;
  acceptedAt?: number;
  rejectedAt?: number;
  soldAt?: number;
  rejectedBy?: string;
  rejectedFrom?: string;
  initiatedTo?: string;
  initiatedFrom?: string;
  acceptedTo?: string;
  acceptedFrom?: string;
};

type ActionPopup = {
  message: string;
  tone: "success" | "error";
};

const WALLET_STORAGE_KEY = "pharmatree-wallet-address";
const EVENT_QUERY_WINDOW = 9_000;
const DEFAULT_EVENT_LOOKBACK = 10_000;
const ACTIVITY_CACHE_TTL = 30_000;
const RPC_RETRY_DELAYS = [250, 750, 1500];
let activityCache: { expiresAt: number; value: Record<string, UnitActivity> } | null = null;
let activityRequest: Promise<Record<string, UnitActivity>> | null = null;

async function withRpcRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let errDetails = "";
      try {
        errDetails = JSON.stringify(error);
      } catch {
        // ignore cyclic
      }
      const rateLimited =
        message.includes("Too Many Requests") ||
        message.includes("-32005") ||
        message.includes("429") ||
        message.includes("rate limit") ||
        message.includes("missing response for request") ||
        errDetails.includes("-32005") ||
        errDetails.includes("Too Many Requests");
      if (!rateLimited || attempt >= RPC_RETRY_DELAYS.length) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, RPC_RETRY_DELAYS[attempt]));
    }
  }
}

export function PharmaWalletView({ mode }: { mode: ViewMode }) {
  const [account, setAccount] = useState("");
  const [contract, setContract] = useState<ethers.Contract | null>(null);
  const [connected, setConnected] = useState(false);
  const [role, setRole] = useState<{ manufacturer: boolean; handler: boolean }>({ manufacturer: false, handler: false });
  const [units, setUnits] = useState<UnitRecord[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [status, setStatus] = useState("Connect your wallet to review the chain");
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [actionUnitId, setActionUnitId] = useState("1");
  const [actionQuantity, setActionQuantity] = useState("1");
  const [actionReceiver, setActionReceiver] = useState("");
  const [medicineName, setMedicineName] = useState("Paracetamol");
  const [medicineQuantity, setMedicineQuantity] = useState("100");
  const [roleTarget, setRoleTarget] = useState("");
  const [roleType, setRoleType] = useState<"manufacturer" | "handler">("manufacturer");
  const [selectedStockUnitId, setSelectedStockUnitId] = useState("1");
  const [isAdmin, setIsAdmin] = useState(false);
  const [expandedUnits, setExpandedUnits] = useState<Record<string, boolean>>({});
  const [modalUnit, setModalUnit] = useState<UnitRecord | null>(null);
  const [qrModalUnit, setQrModalUnit] = useState<UnitRecord | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [copiedLink, setCopiedLink] = useState(false);
  const [actionPopup, setActionPopup] = useState<ActionPopup | null>(null);
  const actionInFlight = useRef(false);
  const router = useRouter();

  const notifyAction = (message: string, tone: ActionPopup["tone"] = "success") => {
    setActionPopup({ message, tone });
  };

  useEffect(() => {
    if (!actionPopup) return;
    const timeout = window.setTimeout(() => setActionPopup(null), 4500);
    return () => window.clearTimeout(timeout);
  }, [actionPopup]);

  const readonlyContract = useMemo(
    () =>
      new ethers.Contract(
        PHARMA_TREE_CONTRACT,
        PHARMA_TREE_ABI,
        readonlyProvider
      ),
    []
  );

  useEffect(() => {
    void refreshReadonlyState();
  }, [readonlyContract]);

  async function fetchUnitActivity(contract: ethers.Contract): Promise<Record<string, UnitActivity>> {
    if (activityCache && activityCache.expiresAt > Date.now()) return activityCache.value;
    if (activityRequest) return activityRequest;

    activityRequest = (async () => {
      try {
        const activity: Record<string, UnitActivity> = {};
        const latestBlock = await withRpcRetry(() => readonlyProvider.getBlockNumber());
        const configuredStart = Number(process.env.NEXT_PUBLIC_DEPLOYMENT_BLOCK || "11683269");
        const fromBlock = configuredStart > 0
          ? configuredStart
          : Math.max(0, latestBlock - DEFAULT_EVENT_LOOKBACK);
        const logs: ethers.Log[] = [];
        for (let start = fromBlock; start <= latestBlock; start += EVENT_QUERY_WINDOW) {
          const end = Math.min(start + EVENT_QUERY_WINDOW - 1, latestBlock);
          logs.push(...await withRpcRetry(() => readonlyProvider.getLogs({
            address: PHARMA_TREE_CONTRACT,
            fromBlock: start,
            toBlock: end,
          })));
        }
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
            const parsed = contract.interface.parseLog(rawLog);
            if (!parsed || !parsed.args) continue;
            const log = { ...rawLog, args: parsed.args, fragment: parsed.fragment };
            const id = String(log.args[0]);
            const current = activity[id] ?? {};
            const timestamp = blockTimes.get(log.blockNumber) ?? Math.floor(Date.now() / 1000);
            if (log.fragment?.name === "UnitCreated") current.createdAt = timestamp;
            if (log.fragment?.name === "TransferInitiated") {
              current.initiatedAt = timestamp;
              current.initiatedFrom = String(log.args.from || log.args[1] || "");
              current.initiatedTo = String(log.args.to || log.args[2] || "");
            }
            if (log.fragment?.name === "TransferCompleted") {
              current.acceptedAt = timestamp;
              current.acceptedFrom = String(log.args.from || log.args[1] || "");
              current.acceptedTo = String(log.args.to || log.args[2] || "");
            }
            if (log.fragment?.name === "TransferRejected") {
              current.rejectedAt = timestamp;
              current.rejectedFrom = String(log.args.from || log.args[1] || "");
              current.rejectedBy = String(log.args.rejectedBy || log.args[2] || "");
            }
            if (log.fragment?.name === "UnitSold") current.soldAt = timestamp;
            activity[id] = current;
          } catch {
            // Skip unparseable log entry
          }
        }
        activityCache = { expiresAt: Date.now() + ACTIVITY_CACHE_TTL, value: activity };
        return activity;
      } catch (err) {
        console.warn("fetchUnitActivity failed:", err);
        return {};
      }
    })();

    try {
      return await activityRequest;
    } finally {
      activityRequest = null;
    }
  }

  async function fetchAllUnits(contract: ethers.Contract): Promise<UnitRecord[]> {
    try {
      const count = await contract.unitCounter();
      const countNum = Number(count);
      if (countNum <= 0) return [];

      const promises: Promise<UnitRecord | null>[] = [];
      for (let index = 1; index <= countNum; index++) {
        promises.push(
          contract.getUnitDetails(BigInt(index))
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

      // Asynchronously enrich activity timestamps in background without blocking immediate render
      void fetchUnitActivity(contract)
        .then((activity) => {
          if (!activity || Object.keys(activity).length === 0) return;
          setUnits((prev) =>
            prev.map((unit) => (activity && activity[unit.id] ? { ...unit, ...activity[unit.id] } : unit))
          );
        })
        .catch(() => {});

      return unitsList;
    } catch (err) {
      console.warn("fetchAllUnits error:", err);
      return [];
    }
  }

  async function refreshReadonlyState() {
    try {
      const mapped = await fetchAllUnits(readonlyContract);
      setUnits(mapped);
    } catch (error) {
      console.error(error);
    }
  }

  const getEthereumProvider = () => {
    if (typeof window === "undefined") return null;
    const anyWin = window as any;
    if (!anyWin.ethereum) return null;
    if (Array.isArray(anyWin.ethereum.providers)) {
      const mm = anyWin.ethereum.providers.find((p: any) => p.isMetaMask);
      if (mm) return mm;
    }
    return anyWin.ethereum;
  };

  async function connectWallet({ silent = false }: { silent?: boolean } = {}) {
    const provider = getEthereumProvider();
    if (!provider) {
      if (!silent) {
        const msg = "MetaMask is not detected. Please install or enable MetaMask.";
        setStatus(msg);
        notifyAction(msg, "error");
      }
      return;
    }

    try {
      setLoading(true);

      let walletAddress: string | null = null;
      const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
      if (accounts && accounts.length > 0) {
        walletAddress = accounts[0];
      } else if (!silent) {
        const requested = (await provider.request({ method: "eth_requestAccounts" })) as string[];
        if (requested && requested.length > 0) {
          walletAddress = requested[0];
        }
      }

      if (!walletAddress) {
        if (!silent) {
          const msg = "No wallet account selected in MetaMask. Please unlock MetaMask.";
          setStatus(msg);
          notifyAction(msg, "error");
        }
        return;
      }

      const browserProvider = new ethers.BrowserProvider(provider);
      let network = await browserProvider.getNetwork();

      if (network.chainId !== PHARMA_TREE_CHAIN_ID) {
        try {
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: `0x${PHARMA_TREE_CHAIN_ID.toString(16)}` }],
          });
          network = await browserProvider.getNetwork();
        } catch (switchError: any) {
          console.warn("Chain switch request failed", switchError);
          const msg = `Please switch MetaMask to Sepolia (Chain ${PHARMA_TREE_CHAIN_ID.toString()}).`;
          setStatus(msg);
          if (!silent) notifyAction(msg, "error");
          return;
        }
      }

      if (network.chainId !== PHARMA_TREE_CHAIN_ID) {
        const msg = `Switch MetaMask to chain ${PHARMA_TREE_CHAIN_ID.toString()} before using PharmaTree.`;
        setStatus(msg);
        if (!silent) notifyAction(msg, "error");
        return;
      }

      const signer = await browserProvider.getSigner(walletAddress);
      const signerContract = new ethers.Contract(PHARMA_TREE_CONTRACT, PHARMA_TREE_ABI, signer);

      setContract(signerContract);
      setAccount(walletAddress);
      setConnected(true);
      setLoading(false);
      localStorage.setItem(WALLET_STORAGE_KEY, walletAddress);

      const message = `Connected as ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}.`;
      setStatus(message);
      if (!silent) notifyAction(message);

      void loadWalletData(walletAddress, readonlyContract);
    } catch (error: any) {
      console.error("Wallet connection error:", error);
      if (!silent) {
        let message = "Wallet connection failed.";
        if (error?.code === 4001) {
          message = "Connection rejected in MetaMask.";
        } else if (error?.code === -32002) {
          message = "Connection request already open in MetaMask. Please open your extension popup.";
        } else if (error?.message) {
          message = error.message.slice(0, 100);
        }
        setStatus(message);
        notifyAction(message, "error");
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (typeof window === "undefined") return;

    const provider = getEthereumProvider();
    if (!provider) return;

    const autoConnect = async () => {
      try {
        const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
        if (accounts && accounts.length > 0) {
          await connectWallet({ silent: true });
        }
      } catch (error) {
        console.warn("Auto-connect failed", error);
      }
    };

    void autoConnect();

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

    provider.on("accountsChanged", handleAccountsChanged);
    provider.on("chainChanged", handleChainChanged);
    return () => {
      provider.removeListener?.("accountsChanged", handleAccountsChanged);
      provider.removeListener?.("chainChanged", handleChainChanged);
    };
  }, []);

  useEffect(() => {
    if (!isAdmin && role.manufacturer && roleType !== "handler") {
      setRoleType("handler");
    }
  }, [isAdmin, role.manufacturer, roleType]);

  function StockDonutChart({ activeCount, pendingCount, soldCount }: { activeCount: number; pendingCount: number; soldCount: number }) {
    const total = activeCount + pendingCount + soldCount;
    const activePct = total > 0 ? (activeCount / total) * 100 : 0;
    const pendingPct = total > 0 ? (pendingCount / total) * 100 : 0;

    // Calculate SVG stroke offset for the pending slice
    const pendingOffset = 100 - activePct;

    return (
      <div style={{ position: 'relative', width: 68, height: 68, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg viewBox="0 0 36 36" style={{ width: '100%', height: '100%', transform: 'rotate(-90deg)' }}>
          {/* Base Layer: Sold Units (Light Slate) */}
          <path
            d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
            fill="none"
            stroke="#e2e8f0"
            strokeWidth="4"
          />
          {/* Layer 2: Pending Transfers (Amber / Yellow) */}
          {pendingPct > 0 && (
            <path
              d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
              fill="none"
              stroke="#f59e0b"
              strokeWidth="4"
              strokeDasharray={`${pendingPct + activePct}, 100`}
              strokeDashoffset={-activePct}
            />
          )}
          {/* Layer 1: Active Units (Teal / Emerald) */}
          {activePct > 0 && (
            <path
              d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
              fill="none"
              stroke="#0d9488"
              strokeWidth="4"
              strokeDasharray={`${activePct}, 100`}
            />
          )}
        </svg>
        {/* Center Percentage Display */}
        <span style={{ position: 'absolute', fontSize: '10px', fontWeight: 700, color: '#0f172a' }}>
          {total > 0 ? `${Math.round(activePct)}%` : '0%'}
        </span>
      </div>
    );
  }

  async function loadWalletData(walletAddress: string, contractToUse: ethers.Contract = readonlyContract) {
    try {
      const [manufacturer, handler, adminAddress] = await Promise.all([
        contractToUse.isManufacturer(walletAddress),
        contractToUse.isHandler(walletAddress),
        contractToUse.admin(),
      ]);
      setRole({ manufacturer, handler });
      setIsAdmin(adminAddress.toLowerCase() === walletAddress.toLowerCase());

      const allUnits = await fetchAllUnits(contractToUse);
      const activity = await fetchUnitActivity(contractToUse);
      const enrichedUnits = allUnits.map((unit) =>
        activity && activity[unit.id] ? { ...unit, ...activity[unit.id] } : unit
      );

      const unitDetails = enrichedUnits.filter((unit) => {
        const lowerWallet = walletAddress.toLowerCase();
        return (
          unit.manufacturer.toLowerCase() === lowerWallet ||
          unit.currentOwner.toLowerCase() === lowerWallet ||
          unit.pendingReceiver.toLowerCase() === lowerWallet ||
          unit.rejectedBy?.toLowerCase() === lowerWallet ||
          unit.initiatedTo?.toLowerCase() === lowerWallet
        );
      });

      const createdByUser = unitDetails.filter((unit) => unit.manufacturer.toLowerCase() === walletAddress.toLowerCase());
      const ownedUnits = unitDetails.filter((unit) => unit.currentOwner.toLowerCase() === walletAddress.toLowerCase());
      const pendingIncoming = unitDetails.filter(
        (unit) => unit.pendingReceiver.toLowerCase() === walletAddress.toLowerCase() && unit.status === 1
      );
      const pendingTransfers = enrichedUnits.filter(
        (unit) => unit.status === 1 && (
          unit.currentOwner.toLowerCase() === walletAddress.toLowerCase() ||
          unit.pendingReceiver.toLowerCase() === walletAddress.toLowerCase()
        )
      );

      const syntheticHistory: HistoryEntry[] = enrichedUnits.flatMap((unit) => {
        const entries: HistoryEntry[] = [];

        // 1. Transfer Rejected
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

        // 2. Transfer Initiated (pending or historical)
        if (unit.status === 1 || unit.initiatedAt) {
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

        // 3. Transfer Completed
        if (unit.acceptedAt) {
          entries.push({
            id: unit.id,
            type: "TransferCompleted",
            from: unit.acceptedFrom || unit.manufacturer,
            to: unit.acceptedTo || unit.currentOwner,
            txHash: "completed",
            blockNumber: 0,
            timestamp: unit.acceptedAt,
            quantity: unit.quantity,
          });
        }

        // 4. Unit Sold
        if (unit.status === 2 || unit.soldAt) {
          entries.push({
            id: unit.id,
            type: "UnitSold",
            from: unit.currentOwner,
            to: undefined,
            txHash: "sold",
            blockNumber: 0,
            timestamp: unit.soldAt ?? unit.createdAt,
            quantity: unit.quantity,
          });
        }

        // 5. Initial Created state (fallback if no events)
        if (entries.length === 0) {
          entries.push({
            id: unit.id,
            type: "CurrentState",
            from: unit.manufacturer,
            to: unit.currentOwner,
            txHash: "state-read",
            blockNumber: 0,
            timestamp: unit.createdAt,
            quantity: unit.quantity,
          });
        }

        return entries;
      });

      const userHistory = syntheticHistory.filter((entry) => {
        const lowerWallet = walletAddress.toLowerCase();
        const fromIsUser = entry.from?.toLowerCase() === lowerWallet;
        const toIsUser = entry.to?.toLowerCase() === lowerWallet;
        const rejectedByUser = entry.rejectedBy?.toLowerCase() === lowerWallet;
        return fromIsUser || toIsUser || rejectedByUser;
      }).sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));

      setUnits(enrichedUnits);
      setHistory(userHistory);
      setPendingApprovalCount(pendingTransfers.length);

      if (createdByUser.length === 0 && ownedUnits.length === 0 && pendingIncoming.length === 0) {
        setStatus(`Connected. No medicines or transfers found for ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`);
      }
    } catch (error) {
      console.error(error);
      setStatus("Unable to fetch chain data");
    }
  }

  async function handleCreateMedicine() {
    if (!contract || !account) {
      setStatus("Connect a wallet before creating a medicine.");
      return;
    }

    if (!role.manufacturer && !isAdmin) {
      setStatus("Only the manufacturer/admin role can create medicine units.");
      return;
    }

    const name = medicineName.trim();
    const quantity = medicineQuantity.trim();
    if (!name || !quantity) {
      setStatus("Add a medicine name and tablet count before creating a unit.");
      return;
    }
    const quantityValue = Number(quantity);
    if (!Number.isInteger(quantityValue) || quantityValue <= 0) {
      setStatus("Quantity must be a positive whole number.");
      return;
    }

    try {
      setLoading(true);
      const metadata = `${name}, ${quantity} tablets`;
      const tx = await contract.createRootUnit(0, metadata, quantityValue);
      await tx.wait();
      const message = `Medicine created: ${name} (${quantity} tablets).`;
      setStatus(message);
      notifyAction(message);
      setMedicineName("Paracetamol");
      setMedicineQuantity("100");
      await loadWalletData(account, contract);
    } catch (error) {
      console.error(error);
      const message = "Medicine creation failed. Check the connected wallet role and contract address.";
      setStatus(message);
      notifyAction(message, "error");
    } finally {
      setLoading(false);
    }
  }

  async function handleRoleAssignment() {
    if (!contract || !account) {
      setStatus("Connect a wallet before assigning roles.");
      return;
    }

    if (!isAdmin && !role.manufacturer) {
      setStatus("Only the admin wallet or manufacturer can assign roles.");
      return;
    }

    if (roleType === "manufacturer" && !isAdmin) {
      setStatus("Only the admin wallet may assign manufacturer roles.");
      return;
    }

    if (!ethers.isAddress(roleTarget)) {
      setStatus("Enter a valid target wallet address.");
      return;
    }

    try {
      setLoading(true);
      const tx = roleType === "manufacturer"
        ? await contract.addManufacturer(roleTarget)
        : await contract.addHandler(roleTarget);
      await tx.wait();
      const roleName = roleType === "manufacturer" ? "Manufacturer" : "Handler";
      const message = `${roleName} role granted to ${roleTarget}.`;
      setStatus(message);
      notifyAction(message);
      setRoleTarget("");
      await loadWalletData(account, contract);
    } catch (error) {
      console.error(error);
      const message = `Could not grant the ${roleType} role.`;
      setStatus(message);
      notifyAction(message, "error");
    } finally {
      setLoading(false);
    }
  }

  async function handleTransferAction(action: "initiate" | "accept" | "reject" | "sell", requestedUnitId = actionUnitId) {
    if (loading || actionInFlight.current) return;
    const failAction = (message: string) => {
      setStatus(message);
      notifyAction(message, "error");
    };
    if (!contract || !account) {
      failAction("Connect a wallet before attempting a transfer action.");
      return;
    }
    

    const unitId = Number(requestedUnitId);
    if (!Number.isInteger(unitId) || unitId <= 0) {
      failAction("Select a valid medicine unit.");
      return;
    }

    try {
      actionInFlight.current = true;
      setLoading(true);
      let tx;

      if (action === "initiate") {
        if (!actionReceiver.trim()) {
          failAction("Enter a receiver wallet before initiating a transfer.");
          return;
        }
        if (!ethers.isAddress(actionReceiver.trim())) {
          failAction("Enter a valid receiver wallet address.");
          return;
        }
        if (!role.manufacturer && !role.handler) {
          failAction("Only a manufacturer or handler can initiate transfers.");
          return;
        }
        const quantity = Number(actionQuantity);
        if (!Number.isInteger(quantity) || quantity <= 0) {
          failAction("Enter a whole-number quantity to transfer.");
          return;
        }
        const selectedUnit = availableStockUnits.find((unit) => unit.id === requestedUnitId);
        if (!selectedUnit) {
          failAction("Select an active medicine unit from your inventory.");
          return;
        }
        const availableQuantity = Number(selectedUnit.quantity);
        if (!Number.isSafeInteger(availableQuantity) || quantity > availableQuantity) {
          failAction(`Transfer quantity cannot exceed the ${availableQuantity}-unit stock available.`);
          return;
        }
        let receiverIsManufacturer = false;
        let receiverIsHandler = false;
        try {
          [receiverIsManufacturer, receiverIsHandler] = await Promise.all([
            readonlyContract.isManufacturer(actionReceiver.trim()),
            readonlyContract.isHandler(actionReceiver.trim()),
          ]);
        } catch (error) {
          console.error("Unable to verify receiver authorization", error);
          failAction("Could not verify the receiver wallet. Check the network connection and try again.");
          return;
        }
        if (!receiverIsManufacturer && !receiverIsHandler) {
          failAction("Transfer blocked: this wallet is not an authorized manufacturer or handler.");
          return;
        }
        tx = await contract.initiatePartialTransfer(unitId, actionReceiver.trim(), quantity);
      } else if (action === "accept") {
        if (!role.manufacturer && !role.handler) {
          failAction("Only a manufacturer or handler can accept transfers.");
          return;
        }
        tx = await contract.acceptTransfer(unitId);
      } else if (action === "reject") {
        if (!role.manufacturer && !role.handler) {
          failAction("Only a manufacturer or handler can reject transfers.");
          return;
        }
        tx = await contract.rejectTransfer(unitId);
      } else {
        if (!role.manufacturer && !role.handler) {
          failAction("Only a manufacturer or handler can mark medicine as sold.");
          return;
        }
        const selectedUnit = availableStockUnits.find((unit) => unit.id === requestedUnitId);
        if (!selectedUnit) {
          failAction("Sale blocked: select an active medicine unit currently in your inventory.");
          return;
        }
        const availableQuantity = Number(selectedUnit.quantity);
        if (!Number.isSafeInteger(availableQuantity) || availableQuantity <= 0) {
          failAction("Sale blocked: this unit has no quantity currently in stock.");
          return;
        }
        const saleQuantity = Number(actionQuantity);
        if (!Number.isInteger(saleQuantity) || saleQuantity <= 0) {
          failAction("Enter a whole-number quantity to sell.");
          return;
        }
        if (saleQuantity > availableQuantity) {
          failAction(`Sale quantity cannot exceed the ${availableQuantity}-unit stock available.`);
          return;
        }
        try {
          if (typeof contract.sellQuantity === "function") {
            tx = await contract.sellQuantity(unitId, saleQuantity);
          } else {
            tx = await contract.markAsSold(unitId);
          }
        } catch (sellErr: any) {
          console.warn("sellQuantity call failed, falling back to markAsSold:", sellErr);
          try {
            tx = await contract.markAsSold(unitId);
          } catch {
            throw sellErr;
          }
        }
      }

      await tx.wait();
      const actionMessage = {
        initiate: "Transfer initiated and is waiting for acceptance.",
        accept: "Transfer accepted. The medicine is now in your inventory.",
        reject: "Transfer rejected.",
        sell: "Medicine marked as sold.",
      }[action];
      setStatus(`${actionMessage} Reloading data...`);
      notifyAction(actionMessage);
      setActionReceiver("");
      await loadWalletData(account, contract);
    } catch (error) {
      console.error(error);
      const errorText = error instanceof Error ? error.message : String(error);
      const reason = errorText.match(/reverted with reason string '([^']+)'/)?.[1] ?? errorText;
      const message = `Could not ${action === "initiate" ? "initiate the transfer" : `${action} the medicine`}: ${reason.slice(0, 140)}`;
      setStatus(message);
      notifyAction(message, "error");
    } finally {
      actionInFlight.current = false;
      setLoading(false);
    }
  }
  const formatAddress = (addr?: string) => {
    if (!addr || addr === "0x0000000000000000000000000000000000000000") return "-";
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  const createdByUser = useMemo(
    () => units.filter((unit) => unit.manufacturer.toLowerCase() === account.toLowerCase()),
    [account, units]
  );

  const openQrModal = async (unit: UnitRecord) => {
    setQrModalUnit(unit);
    setCopiedLink(false);
    setQrDataUrl("");
    try {
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const verifyUrl = `${origin}/verify?unitId=${unit.id}`;
      const dataUrl = await QRCode.toDataURL(verifyUrl, {
        width: 280,
        margin: 2,
        color: {
          dark: "#0f172a",
          light: "#ffffff",
        },
      });
      setQrDataUrl(dataUrl);
    } catch (err) {
      console.error("Failed to generate QR code:", err);
    }
  };

  const getMedicineName = (metadata?: string) => {
    if (!metadata) return "Medicine";
    return metadata.split(",")[0].trim() || metadata;
  };

  // Helper to calculate status & statistics for a partition branch
  const getPartitionBranchStats = (partitionUnit: UnitRecord, allUnits: UnitRecord[]) => {
    const branchUnits = [partitionUnit];
    const queue = [partitionUnit.id];
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const kids = allUnits.filter((u) => u.parentId === currentId && u.id !== currentId);
      for (const kid of kids) {
        branchUnits.push(kid);
        queue.push(kid.id);
      }
    }

    const isDirectlyRejected = partitionUnit.status === 3;
    const isDirectlyPending = partitionUnit.status === 1;
    const isDirectlySold = partitionUnit.status === 2;
    const soldUnits = branchUnits.filter((u) => u.status === 2);
    const soldQty = soldUnits.reduce((sum, u) => sum + Number(u.quantity || 0), 0);
    const activeUnits = branchUnits.filter((u) => u.status === 0);
    const activeQty = activeUnits.reduce((sum, u) => sum + Number(u.quantity || 0), 0);
    const pendingUnits = branchUnits.filter((u) => u.status === 1);
    const pendingQty = pendingUnits.reduce((sum, u) => sum + Number(u.quantity || 0), 0);
    const rejectedUnits = branchUnits.filter((u) => u.status === 3);
    const rejectedQty = rejectedUnits.reduce((sum, u) => sum + Number(u.quantity || 0), 0);
    const totalBranchQty = branchUnits.reduce((sum, u) => sum + Number(u.quantity || 0), 0);
    const partitionQty = Number(partitionUnit.quantity || 0);

    let statusText = "Transferred";
    let statusBadgeClass = styles.statusTransferred;
    let displayQty = partitionQty;

    if (isDirectlyRejected || (rejectedQty === totalBranchQty && totalBranchQty > 0)) {
      statusText = "Rejected";
      statusBadgeClass = styles.statusRejected;
      displayQty = partitionQty;
    } else if (isDirectlyPending || (pendingQty === totalBranchQty && totalBranchQty > 0)) {
      statusText = "Pending transfer";
      statusBadgeClass = styles.statusPending;
      displayQty = partitionQty;
    } else if (isDirectlySold || (soldQty === totalBranchQty && totalBranchQty > 0)) {
      statusText = "Sold";
      statusBadgeClass = styles.statusSold;
      displayQty = totalBranchQty;
    } else if (soldQty > 0) {
      statusText = "Partially sold";
      statusBadgeClass = styles.statusPartialTransfer;
      displayQty = activeQty;
    } else if (partitionUnit.currentOwner.toLowerCase() === account.toLowerCase() && partitionUnit.status === 0) {
      statusText = "In stock";
      statusBadgeClass = styles.statusInStock;
      displayQty = partitionQty;
    } else {
      statusText = "Transferred";
      statusBadgeClass = styles.statusTransferred;
      displayQty = activeQty > 0 ? activeQty : partitionQty;
    }

    return {
      soldQty,
      activeQty,
      pendingQty,
      rejectedQty,
      totalBranchQty,
      displayQty,
      statusText,
      statusBadgeClass,
    };
  };

  const createdRootSummaries = useMemo(() => {
    const wallet = account.toLowerCase();
    return units
      .filter((unit) => unit.manufacturer.toLowerCase() === wallet && unit.parentId === "0")
      .map((root) => {
        const descendants = units.filter((unit) => unit.rootId === root.id && unit.id !== root.id);
        const lineage = [root, ...descendants];
        const totalQuantity = lineage.reduce((sum, unit) => sum + Number(unit.quantity), 0);
        const manufacturerQuantity = lineage
          .filter((unit) => unit.currentOwner.toLowerCase() === wallet && (unit.status === 0 || unit.status === 3))
          .reduce((sum, unit) => sum + Number(unit.quantity), 0);
        const directDescendants = descendants.filter((unit) => unit.parentId === root.id);
        const partitions = directDescendants.length > 0 ? directDescendants : descendants.filter((unit) =>
          unit.manufacturer.toLowerCase() === wallet ||
          unit.currentOwner.toLowerCase() === wallet ||
          unit.pendingReceiver.toLowerCase() === wallet
        );
        return { root, partitions, totalQuantity, manufacturerQuantity };
      })
      .filter((summary) => summary.totalQuantity > 0);
  }, [account, units]);

  const ownedUnits = useMemo(
    () => units.filter((unit) => unit.currentOwner.toLowerCase() === account.toLowerCase()),
    [account, units]
  );

  const inventoryGroups = useMemo(() => {
    const wallet = account.toLowerCase();
    const relevant = units.filter((unit) =>
      unit.manufacturer.toLowerCase() === wallet ||
      unit.currentOwner.toLowerCase() === wallet ||
      (unit.status === 1 && unit.pendingReceiver.toLowerCase() === wallet)
    );
    const manufacturerTree = relevant.some((unit) => unit.manufacturer.toLowerCase() === wallet);
    if (!manufacturerTree) {
      return relevant
        .filter((unit) =>
          unit.currentOwner.toLowerCase() === wallet ||
          (unit.status === 1 && unit.pendingReceiver.toLowerCase() === wallet)
        )
        .sort((left, right) => Number(left.id) - Number(right.id))
        .map((unit) => ({ root: unit, partitions: [] }));
    }
    const rootIds = [...new Set(relevant.map((unit) => unit.rootId === "0" ? unit.id : unit.rootId))];

    return rootIds.map((rootId) => {
      const root = units.find((unit) => unit.id === rootId);
      const manufacturerTree = root?.manufacturer.toLowerCase() === wallet;
      const visibleUnits = manufacturerTree
        ? units.filter((unit) => unit.id === rootId || unit.rootId === rootId)
        : relevant.filter((unit) => unit.rootId === rootId);
      const representative = root && (manufacturerTree || relevant.some((unit) => unit.id === root.id))
        ? root
        : visibleUnits[0];

      return {
        root: representative,
        partitions: visibleUnits.filter((unit) => unit.id !== representative?.id),
      };
    }).filter((group): group is { root: UnitRecord; partitions: UnitRecord[] } => Boolean(group.root));
  }, [account, units]);

  const pendingIncoming = useMemo(
    () => units.filter((unit) => unit.pendingReceiver.toLowerCase() === account.toLowerCase() && unit.status === 1),
    [account, units]
  );

  const pendingTransferUnits = useMemo(
    () =>
      units.filter(
        (unit) =>
          unit.status === 1 &&
          (unit.currentOwner.toLowerCase() === account.toLowerCase() || unit.pendingReceiver.toLowerCase() === account.toLowerCase())
      ),
    [account, units]
  );

  const availableStockUnits = useMemo(
    () => units.filter((unit) => unit.status === 0 && unit.currentOwner.toLowerCase() === account.toLowerCase()),
    [account, units]
  );

  const walletLocalIds = useMemo(() => {
    const relevant = units
      .filter((unit) =>
        unit.currentOwner.toLowerCase() === account.toLowerCase() ||
        (unit.status === 1 && unit.pendingReceiver.toLowerCase() === account.toLowerCase())
      )
      .sort((left, right) => Number(left.id) - Number(right.id));
    return new Map(relevant.map((unit, index) => [unit.id, String(index + 1)]));
  }, [account, units]);

  const localUnitId = (unit: UnitRecord) => walletLocalIds.get(unit.id) ?? unit.displayId;
  const hasSoldChildren = (unit: UnitRecord) =>
    units.some((k) => k.parentId === unit.id && k.status === 2);

  const displayStatus = (unit: UnitRecord) =>
    unit.status === 2
      ? "Sold"
      : unit.status === 1
        ? "Pending transfer"
        : unit.status === 3
          ? "Rejected"
          : unit.currentOwner.toLowerCase() === account.toLowerCase()
            ? (hasSoldChildren(unit) ? "Partially sold" : "In stock")
            : "Transferred";
  const statusClass = (unit: UnitRecord) =>
    unit.status === 2
      ? styles.statusSold
      : unit.status === 1
        ? styles.statusPending
        : unit.status === 3
          ? styles.statusRejected
          : unit.currentOwner.toLowerCase() === account.toLowerCase()
            ? (hasSoldChildren(unit) ? styles.statusPartialTransfer : styles.statusInStock)
            : styles.statusTransferred;

  useEffect(() => {
    if (availableStockUnits.length > 0 && !availableStockUnits.some((unit) => unit.id === actionUnitId)) {
      setActionUnitId(availableStockUnits[0].id);
      setActionQuantity(availableStockUnits[0].quantity);
    }
  }, [actionUnitId, availableStockUnits]);

  const userUnits = useMemo(
    () =>
      units.filter(
        (unit) =>
          unit.manufacturer.toLowerCase() === account.toLowerCase() ||
          unit.currentOwner.toLowerCase() === account.toLowerCase() ||
          unit.pendingReceiver.toLowerCase() === account.toLowerCase() ||
          unit.rejectedBy?.toLowerCase() === account.toLowerCase() ||
          unit.initiatedTo?.toLowerCase() === account.toLowerCase()
      ),
    [account, units]
  );

  const visibleHistory = useMemo(
    () => history.filter((entry) => entry.txHash && entry.type !== "CurrentState"),
    [history]
  );

  const canCreateMedicine = Boolean(account) && (role.manufacturer || isAdmin);

  return (
    <div className={styles.appShell}>
      <header className={styles.topbar}>
        <div className={styles.brandWrap}>
          <div className={styles.brandMark}>✚</div>
          <div className={styles.brandName}>PHARMATREE</div>
        </div>

        <div className={styles.headerCenter}>
          <div className={styles.pageHeading}>Supply-chain Control Centre</div>
        </div>

        <div className={styles.headerActions}>
          <button className={styles.primaryButton} onClick={() => void connectWallet()} disabled={loading}>
            {loading ? "Connecting..." : connected ? (account ? `${account.slice(0, 6)}...${account.slice(-4)}` : "Connected") : "Connect wallet"}
          </button>
          <button type="button" className={styles.notifyButton} aria-label="Pending transfers" onClick={() => router.push('/transfers')}>
            <span>🔔</span>
            {pendingApprovalCount > 0 && <strong>{pendingApprovalCount}</strong>}
          </button>
          <div className={styles.avatar}>A</div>
        </div>
      </header>

      <div className={styles.workspace}>
        <aside className={styles.sidebar}>
          <nav className={styles.sideNav}>
            <Link className={`${styles.sideItem} ${mode === "overview" ? styles.sideItemActive : ""}`} href="/">
              <span className={styles.icon}>🏠</span>
              <span>Overview</span>
            </Link>
            {(role.manufacturer || isAdmin) && (
              <Link
                className={`${styles.sideItem} ${mode === "create" ? styles.sideItemActive : ""}`}
                href="/create"
              >
                <span className={styles.icon}>🧴</span>
                <span>Create Unit</span>
              </Link>
            )}
            <Link className={`${styles.sideItem} ${mode === "admin" ? styles.sideItemActive : ""}`} href="/admin">
              <span className={styles.icon}>🛡️</span>
              <span>Admin</span>
            </Link>
            <Link className={`${styles.sideItem} ${mode === "transfers" ? styles.sideItemActive : ""}`} href="/transfers">
              <span className={styles.icon}>🔁</span>
              <span>Transfers</span>
            </Link>
            <Link className={`${styles.sideItem} ${mode === "inventory" ? styles.sideItemActive : ""}`} href="/inventory">
              <span className={styles.icon}>📦</span>
              <span>Inventory</span>
            </Link>
          </nav>
        </aside>

        <main className={styles.mainPanel}>
          <section className={styles.summaryRow}>
            <article className={styles.summaryCard}> 
              <span>Wallet</span>
              <strong>{account ? `${account.slice(0, 6)}...${account.slice(-4)}` : "Not connected"}</strong>
            </article>
            <article className={styles.summaryCard}>
              <span>Role</span>
              <strong>
                {role.manufacturer && role.handler
                  ? "Manufacturer + Handler"
                  : role.manufacturer
                    ? "Manufacturer"
                    : role.handler
                      ? "Handler"
                      : "Unassigned"}
              </strong>
            </article>
            <article className={styles.summaryCard} onClick={() => router.push('/transfers')} style={{cursor:'pointer'}}>
              <span>Pending Transfers</span>
              <strong className={styles.healthOk}>{pendingApprovalCount}</strong>
            </article>
          </section>

          {pendingIncoming.length > 0 && (
            <div className={styles.alertBox}>
              <strong>Action required:</strong> {pendingIncoming.length} transfer(s) are awaiting your acceptance.
            </div>
          )}

          {mode === "overview" && (
            <div className={styles.cardGrid}>
              {/* SHOW ONLY IF MANUFACTURER OR ADMIN */}
              {(role.manufacturer || isAdmin) && (
                <section className={`${styles.featurePanel} ${styles.featurePanelAccent}`}>
                  <div className={styles.panelHeader}>
                    <div className={styles.panelIcon}>💊</div>
                    <div>
                      <h2>My Created Medicines</h2>
                      <p>Active production, batch history &amp; quality compliance.</p>
                    </div>
                  </div>

                  {createdRootSummaries.length === 0 ? (
                    <p className={styles.empty}>No medicines created by this wallet yet.</p>
                  ) : (
                    <div className={styles.dataTable}>
                      <div className={styles.tableHead} style={{ color: '#334155' }}>
                        <span>ID</span>
                        <span>Medicine</span>
                        <span>Qty in stock</span>
                        <span>Status</span>
                        <span aria-hidden="true" />
                      </div>
                      {createdRootSummaries.map(({ root, partitions, totalQuantity, manufacturerQuantity }) => {
                        const medName = (root.metadata || "").split(",")[0] || root.metadata;
                        const hasTransferredPortion = [root, ...partitions].some((unit) =>
                          unit.currentOwner.toLowerCase() !== account.toLowerCase() ||
                          unit.pendingReceiver !== "0x0000000000000000000000000000000000000000"
                        );
                        const hasSoldPortion = [root, ...partitions].some((unit) => unit.status === 2);
                        const rootStatus = manufacturerQuantity === totalQuantity
                          ? "In stock"
                          : manufacturerQuantity > 0
                            ? "Partially transferred"
                            : hasTransferredPortion
                              ? "Transferred"
                              : hasSoldPortion
                                ? "Sold"
                                : "Partially transferred";
                        const rootStatusClass = rootStatus === "In stock"
                          ? styles.statusInStock
                          : rootStatus === "Sold"
                            ? styles.statusSold
                            : rootStatus === "Transferred"
                              ? styles.statusTransferred
                              : styles.statusPartialTransfer;
                        const rootExpanded = !!expandedUnits[`overview-${root.id}`];
                        return (
                          <div className={styles.createdMedicineGroup} key={root.id}>
                            <button
                              type="button"
                              className={styles.tableRow}
                              aria-expanded={partitions.length > 0 ? rootExpanded : undefined}
                              onClick={() => partitions.length > 0 && setExpandedUnits((previous) => ({
                                ...previous,
                                [`overview-${root.id}`]: !rootExpanded,
                              }))}
                            >
                              <span>#{root.displayId}</span>
                              <span>{medName}</span>
                              <span>{manufacturerQuantity}/{totalQuantity}</span>
                              <span className={`${styles.statusBadge} ${rootStatusClass}`}>
                                {rootStatus}
                              </span>
                              {partitions.length > 0 && <span className={styles.partitionChevron}>{rootExpanded ? "−" : "+"}</span>}
                            </button>
                            {partitions.length > 0 && rootExpanded && (
                              <div className={styles.partitionList}>
                                {partitions.map((partition) => {
                                  const stats = getPartitionBranchStats(partition, units);
                                  return (
                                    <div className={styles.partitionTile} key={partition.id}>
                                      <div className={styles.partitionRow}>
                                        <span><strong>#{partition.displayId}</strong></span>
                                        <span>
                                          Qty {stats.displayQty}
                                          {stats.soldQty > 0 && stats.statusText === "Partially sold" ? ` (${stats.soldQty}/${stats.totalBranchQty} Sold)` : ""}
                                        </span>
                                        <span className={`${styles.statusBadge} ${stats.statusBadgeClass}`}>
                                          {partition.status === 3 && partition.rejectedBy
                                            ? `Rejected by ${formatAddress(partition.rejectedBy)}`
                                            : stats.statusText}
                                        </span>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div className={styles.footerRow}>
                    <div>
                      <span>Units Created This Quarter:</span>
                      <strong>{createdRootSummaries.length}</strong>
                    </div>
                    <button
                      className={`${styles.primaryButton} ${!canCreateMedicine ? styles.primaryButtonDisabled : ""}`}
                      onClick={() => window.location.assign("/create")}
                      disabled={!canCreateMedicine}
                    >
                      Create New Unit
                    </button>
                  </div>
                </section>
              )}

              {/* MY OWNED INVENTORY (ALWAYS VISIBLE) */}
              <section className={`${styles.featurePanel} ${styles.inventoryOverviewPanel}`}>
                <div className={styles.panelHeader}>
                  <div className={styles.panelIcon}>📦</div>
                  <div>
                    <h2>My Owned Inventory</h2>
                    <p>On-hand stock, storage locations &amp; asset details.</p>
                  </div>
                </div>

                {ownedUnits.length === 0 ? (
                  <p className={styles.empty}>No active ownership records.</p>
                ) : (
                  <div className={styles.dataTable}>
                    <div className={styles.tableHead} style={{ color: '#334155' }}>
                      <span>ID</span>
                      <span>Medicine</span>
                      <span>Qty</span>
                      <span>Location</span>
                      <span>{role.manufacturer || isAdmin ? "Created" : "Status"}</span>
                    </div>
                    {ownedUnits.map((unit) => {
                      const medName = (unit.metadata || "").split(",")[0] || unit.metadata;
                      return (
                        <div className={styles.tableRow} key={unit.id}>
                          <span>#{role.manufacturer || isAdmin ? unit.displayId : localUnitId(unit)}</span>
                          <span>{medName}</span>
                          <span>{unit.quantity}</span>
                          <span>WARE-H</span>
                          <span>{role.manufacturer || isAdmin ? (
                            formatDateOnly(unit.createdAt)
                          ) : (
                            <span className={`${styles.statusBadge} ${statusClass(unit)}`}>
                              {displayStatus(unit)}
                            </span>
                          )}</span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {(() => {
                  const lowerWallet = account.toLowerCase();

                  // Active units in inventory (Status 0)
                  const activeCount = userUnits.filter((u) => u.status === 0 && u.currentOwner.toLowerCase() === lowerWallet).length;

                  // Pending transfers waiting acceptance/rejection (Status 1)
                  const pendingCount = userUnits.filter((u) => u.status === 1 && (u.currentOwner.toLowerCase() === lowerWallet || u.pendingReceiver.toLowerCase() === lowerWallet)).length;

                  // Sold units (Status 2)
                  const soldCount = userUnits.filter((u) => u.status === 2 && u.currentOwner.toLowerCase() === lowerWallet).length;

                  // Rejected units returned to custody (Status 3)
                  const rejectedCount = userUnits.filter((u) => u.status === 3 && u.currentOwner.toLowerCase() === lowerWallet).length;

                  return (
                    <div className={styles.footerRow} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <span>Total Stock Volume:</span>
                        <strong style={{ display: 'block' }}>
                          {ownedUnits.reduce((sum, unit) => sum + Number(unit.quantity || 0), 0)} Units
                        </strong>
                        <div style={{ fontSize: '11px', color: '#64748b', marginTop: '6px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                          <span style={{ color: '#0d9488', fontWeight: 600 }}>● {activeCount} Active</span>
                          <span style={{ color: '#f59e0b', fontWeight: 600 }}>● {pendingCount} Pending</span>
                          {rejectedCount > 0 && <span style={{ color: '#ef4444', fontWeight: 600 }}>● {rejectedCount} Rejected</span>}
                          <span style={{ color: '#64748b', fontWeight: 600 }}>● {soldCount} Sold</span>
                        </div>
                      </div>
                      <StockDonutChart activeCount={activeCount} pendingCount={pendingCount} soldCount={soldCount} />
                    </div>
                  );
                })()}
              </section>
            </div>
          )}

          {mode === "create" && (
            <section className={styles.panel}>
              <h2>Create medicine unit</h2>
              {!account ? (
                <p className={styles.empty}>Connect a wallet to create a medicine.</p>
              ) : !role.manufacturer && !isAdmin ? (
                <div className={styles.empty} style={{ textAlign: "center", padding: "32px 16px" }}>
                  <h3>Access Denied</h3>
                  <p style={{ marginTop: "8px", color: "#64748b" }}>
                    Only registered Manufacturers or System Admins can create new medicine units.
                  </p>
                </div>
              ) : (
                <>
                  <div className={styles.formGrid}>
                    <div className={styles.fieldGroup}>
                      <label>Product name</label>
                      <input
                        value={medicineName}
                        onChange={(event) => setMedicineName(event.target.value)}
                        placeholder="Paracetamol"
                      />
                    </div>
                    <div className={styles.fieldGroup}>
                      <label>Quantity</label>
                      <input
                        value={medicineQuantity}
                        onChange={(event) => setMedicineQuantity(event.target.value)}
                        placeholder="100"
                      />
                    </div>
                  </div>

                  <div className={styles.sampleList}>
                    {[
                      { name: "Paracetamol", quantity: "100" },
                      { name: "Amoxicillin", quantity: "50" },
                      { name: "Ibuprofen", quantity: "75" },
                      { name: "Vitamin D", quantity: "120" },
                    ].map((item) => (
                      <button
                        key={item.name}
                        className={styles.secondaryButton}
                        type="button"
                        onClick={() => {
                          setMedicineName(item.name);
                          setMedicineQuantity(item.quantity);
                        }}
                      >
                        {item.name} · {item.quantity} tablets
                      </button>
                    ))}
                  </div>

                  <div className={styles.buttonRow}>
                    <button
                      className={`${styles.primaryButton} ${loading || !canCreateMedicine ? styles.primaryButtonDisabled : ""}`}
                      onClick={() => void handleCreateMedicine()}
                      disabled={loading || !canCreateMedicine}
                    >
                      {loading ? "Creating..." : "Create medicine unit"}
                    </button>
                  </div>
                </>
              )}
            </section>
          )}

          {mode === "admin" && (
            <section className={styles.panel}>
              <h2>{(role.handler && !isAdmin && !role.manufacturer) ? 'Add Handler' : 'Role management'}</h2>
              {!account ? (
                <p className={styles.empty}>Connect a wallet to manage roles.</p>
              ) : !isAdmin && !role.manufacturer ? (
                <p className={styles.empty}>Only the admin wallet or manufacturer role can grant access.</p>
              ) : (
                <>
                  <div className={styles.formGrid}>
                    <div className={styles.fieldGroup}>
                      <label>Target wallet</label>
                      <input value={roleTarget} onChange={(event) => setRoleTarget(event.target.value)} placeholder="0x..." />
                    </div>
                    <div className={styles.fieldGroup}>
                      <label>{(role.handler && !isAdmin && !role.manufacturer) ? "Add Handler" : "Assign role"}</label>
                      { (role.handler && !isAdmin && !role.manufacturer) ? (
                        <div style={{paddingTop:6}}>Handler (you can add another handler)</div>
                      ) : (
                        <select value={roleType} onChange={(event) => setRoleType(event.target.value as "manufacturer" | "handler")}>
                          <option value="manufacturer" disabled={!isAdmin}>Manufacturer</option>
                          <option value="handler">Handler</option>
                        </select>
                      )}
                    </div>
                  </div>
                  <div className={styles.buttonRow}>
                    <button
                      className={`${styles.primaryButton} ${loading ? styles.primaryButtonDisabled : ""}`}
                      onClick={() => void handleRoleAssignment()}
                      disabled={loading}
                    >
                      {(role.handler && !isAdmin && !role.manufacturer) ? "Add handler" : "Grant role"}
                    </button>
                  </div>
                </>
              )}
            </section>
          )}

          {mode === "transfers" && (
            <div className={styles.transferGrid}>
              {pendingTransferUnits.length > 0 && (
                <section className={styles.panel}>
                  <h2>Pending transfer actions</h2>
                  <div className={styles.inventoryGrid}>
                    {pendingTransferUnits.map((unit) => {
                      const medName = (unit.metadata || "").split(",")[0] || unit.metadata;
                      return (
                        <article key={unit.id} className={styles.transferTile} onClick={() => setModalUnit(unit)}>
                          <div className={styles.tileHeader}>
                            <div className={styles.tileTitle}>{medName}</div>
                            <div className={styles.tileMeta}>Unit #{localUnitId(unit)}</div>
                          </div>
                          <div className={styles.tileBody}>
                            <div><strong>From:</strong> {unit.currentOwner}</div>
                            <div><strong>To:</strong> {unit.pendingReceiver || "-"}</div>
                            <div><strong>Quantity:</strong> {unit.quantity}</div>
                            <div><strong>Initiated:</strong> {formatDate(unit.initiatedAt)}</div>
                            <div><strong>Status:</strong> {displayStatus(unit)}</div>
                          </div>
                          <div style={{marginTop:10}}>
                            <button className={styles.secondaryButton} onClick={(e) => { e.stopPropagation(); setModalUnit(unit); }}>View details</button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              )}

              <section className={styles.panel}>
                <h2>Transfer and sale actions</h2>
                {pendingTransferUnits.length === 0 && (
                  <p className={styles.compactEmpty}>No pending transfers.</p>
                )}
                <div className={styles.formGrid}>
                  <div className={styles.fieldGroup}>
                    <label>Medicine in your inventory</label>
                    <select
                      value={actionUnitId}
                      onChange={(event) => setActionUnitId(event.target.value)}
                      disabled={availableStockUnits.length === 0}
                    >
                      {availableStockUnits.length === 0 ? (
                        <option value="">No available units</option>
                      ) : (
                        availableStockUnits.map((unit) => (
                          <option key={unit.id} value={unit.id}>
                            Unit {localUnitId(unit)} · {(unit.metadata || "").split(",")[0] || "Medicine"} · {unit.quantity} available
                          </option>
                        ))
                      )}
                    </select>
                  </div>
                  <div className={styles.fieldGroup}>
                    <label>Receiver wallet</label>
                    <input value={actionReceiver} onChange={(event) => setActionReceiver(event.target.value)} placeholder="0x..." />
                  </div>
                  <div className={styles.fieldGroup}>
                    <label>Quantity to transfer</label>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={actionQuantity}
                      onChange={(event) => setActionQuantity(event.target.value)}
                      placeholder="1"
                    />
                  </div>
                </div>

                <div className={styles.buttonRow}>
                  <button className={styles.transferActionButton} onClick={() => void handleTransferAction("initiate")} disabled={!account || (!role.manufacturer && !role.handler)}>
                    Initiate transfer
                  </button>
                  <button className={`${styles.transferActionButton} ${styles.sellActionButton}`} onClick={() => void handleTransferAction("sell")} disabled={!account || (!role.manufacturer && !role.handler)}>
                    Mark as sold
                  </button>
                </div>

                <h3 className={styles.subHeading}>Medicine in stock</h3>
                {availableStockUnits.length === 0 ? (
                  <p className={styles.empty}>No active stock for this wallet yet.</p>
                ) : (
                  <div className={styles.inventoryGrid}>
                    {availableStockUnits.map((unit) => {
                      const medName = (unit.metadata || "").split(",")[0] || unit.metadata;
                      return (
                        <button key={unit.id} type="button" className={styles.stockButton} onClick={() => {
                          setActionUnitId(unit.id);
                          setActionReceiver("");
                          setActionQuantity(String(unit.quantity));
                        }}>
                          <div>{medName}</div>
                          <div>Unit #{localUnitId(unit)}</div>
                          <div>Qty {unit.quantity}</div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* History tiles */}
              <section className={`${styles.panel} ${styles.historyPanel}`}>
                <h2>Recent activity</h2>
                {visibleHistory.length === 0 ? (
                  <p className={styles.empty}>No recent activity for this wallet.</p>
                ) : (
                  <div className={styles.inventoryGrid}>
                      {visibleHistory.map((entry) => {
                        const unit = units.find((u) => u.id === entry.id);
                        const medName = unit ? (unit.metadata || "").split(",")[0] : `Unit ${entry.id}`;
                        const isRejection = entry.type === "TransferRejected";
                        const rejecterAddr = entry.rejectedBy || entry.to;
                        const isRejecter = Boolean(rejecterAddr && rejecterAddr.toLowerCase() === account.toLowerCase());
                        const isInitiator = Boolean(entry.from && entry.from.toLowerCase() === account.toLowerCase());

                        let typeBadgeText = entry.type;
                        let typeBadgeClass = styles.statusTransferred;

                        if (isRejection) {
                          typeBadgeClass = styles.statusRejected;
                          typeBadgeText = isRejecter ? "Rejected by You" : "Transfer Rejected";
                        } else if (entry.type === "TransferInitiated") {
                          typeBadgeClass = styles.statusPending;
                          typeBadgeText = isInitiator ? "Transfer Sent" : "Transfer Received";
                        } else if (entry.type === "TransferCompleted") {
                          typeBadgeClass = styles.statusAvailable;
                          typeBadgeText = "Transfer Accepted";
                        } else if (entry.type === "UnitSold") {
                          typeBadgeClass = styles.statusSold;
                          typeBadgeText = "Dispensed / Sold";
                        }

                        return (
                          <article key={`${entry.id}-${entry.txHash}`} className={styles.transferTile} onClick={() => setModalUnit(unit || null)}>
                            <div className={styles.tileHeader}>
                              <div className={styles.tileTitle}>{medName}</div>
                              <span className={`${styles.statusBadge} ${typeBadgeClass}`}>{typeBadgeText}</span>
                            </div>
                            <div className={styles.tileBody}>
                              <div>
                                <strong>Unit:</strong> #{unit
                                  ? (role.manufacturer || isAdmin ? unit.displayId : localUnitId(unit))
                                  : entry.id}
                              </div>
                              {(entry.quantity || unit?.quantity) && (
                                <div><strong>Quantity:</strong> {entry.quantity || unit?.quantity} tablets</div>
                              )}
                              <div><strong>When:</strong> {formatDate(entry.timestamp)}</div>
                              <div>
                                <strong>From:</strong>{" "}
                                <span style={{ fontFamily: 'monospace' }}>
                                  {isInitiator ? `You (${formatAddress(entry.from)})` : formatAddress(entry.from)}
                                </span>
                              </div>
                              {isRejection ? (
                                <div>
                                  <strong>Rejected by:</strong>{" "}
                                  <span style={{ fontFamily: 'monospace', color: '#b91c1c', fontWeight: 600 }}>
                                    {isRejecter ? `You (${formatAddress(rejecterAddr)})` : formatAddress(rejecterAddr)}
                                  </span>
                                </div>
                              ) : (
                                <div>
                                  <strong>To:</strong>{" "}
                                  <span style={{ fontFamily: 'monospace' }}>
                                    {entry.to && entry.to.toLowerCase() === account.toLowerCase()
                                      ? `You (${formatAddress(entry.to)})`
                                      : formatAddress(entry.to)}
                                  </span>
                                </div>
                              )}
                            </div>
                          </article>
                        );
                      })}
                  </div>
                )}
              </section>

            </div>
          )}

          {mode === "inventory" && (
            <section className={styles.panel}>
              <h2>Medicine inventory</h2>
              {inventoryGroups.length === 0 ? (
                <p className={styles.empty}>No medicine records for this account.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '16px' }}>
                  {inventoryGroups.map(({ root: unit, partitions }) => {
                    const isExpanded = !!expandedUnits[`inventory-${unit.id}`];
                    const medName = (unit.metadata || "").split(",")[0] || unit.metadata;
                    const manufacturerTree = unit.manufacturer.toLowerCase() === account.toLowerCase();
                    const lineage = [unit, ...partitions];
                    const totalQuantity = lineage.reduce((sum, candidate) => sum + Number(candidate.quantity), 0);
                    const currentQuantity = lineage
                      .filter((candidate) => (candidate.status === 0 || candidate.status === 3) && candidate.currentOwner.toLowerCase() === account.toLowerCase())
                      .reduce((sum, candidate) => sum + Number(candidate.quantity), 0);
                    const activeStockQuantity = lineage
                      .filter((candidate) => candidate.status === 0 && candidate.currentOwner.toLowerCase() === account.toLowerCase())
                      .reduce((sum, candidate) => sum + Number(candidate.quantity), 0);
                    const rejectedStockQuantity = lineage
                      .filter((candidate) => candidate.status === 3 && candidate.currentOwner.toLowerCase() === account.toLowerCase())
                      .reduce((sum, candidate) => sum + Number(candidate.quantity), 0);
                    const isPartial = manufacturerTree && currentQuantity < totalQuantity;
                    const rootStatus = isPartial ? "Partially transferred" : displayStatus(unit);
                    const unitHistoryLogs = history.filter((h) => h.id === unit.id);
                    const truncate = (addr: string) =>
                      addr && addr !== "0x0000000000000000000000000000000000000000"
                        ? `${addr.slice(0, 6)}...${addr.slice(-4)}`
                        : "None";

                    return (
                      <article
                        key={unit.id}
                        style={{
                          border: '1px solid #e2e8f0',
                          borderRadius: '12px',
                          padding: '0',
                          backgroundColor: '#ffffff',
                          boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
                        }}
                      >
                        <button
                          type="button"
                          className={styles.inventoryTileHeader}
                          aria-expanded={isExpanded}
                          onClick={() => setExpandedUnits((prev) => ({
                             ...prev,
                             [`inventory-${unit.id}`]: !isExpanded,
                          }))}
                        >
                          <span className={styles.inventoryTileIdentity}>
                             <strong>UNIT #{localUnitId(unit)}</strong>
                             <span>{medName}</span>
                          </span>
                          <span className={styles.inventoryTileSummary}>
                             <strong>{manufacturerTree ? `${currentQuantity}/${totalQuantity}` : `Qty ${unit.quantity}`}</strong>
                             <span className={`${styles.statusBadge} ${isPartial ? styles.statusTransferred : statusClass(unit)}`}>
                               {rootStatus}
                             </span>
                             <span className={styles.inventoryTileChevron}>{isExpanded ? '−' : '+'}</span>
                          </span>
                        </button>

                        {isExpanded && (
                          <div className={styles.inventoryTileContent}>
                            <p style={{ margin: 0, color: '#334155' }}>
                              <strong>Manufacturer:</strong> <span style={{ fontFamily: 'monospace' }}>{truncate(unit.manufacturer)}</span>
                            </p>
                            <p style={{ margin: 0, color: '#334155' }}>
                              <strong>Current Owner:</strong> <span style={{ fontFamily: 'monospace' }}>{truncate(unit.currentOwner)}</span>
                            </p>
                            {unit.status === 3 && unit.rejectedBy ? (
                              <p style={{ margin: 0, color: '#b91c1c' }}>
                                <strong>Rejected by:</strong> <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{truncate(unit.rejectedBy)}</span>
                              </p>
                            ) : (
                              <p style={{ margin: 0, color: '#334155' }}>
                                <strong>Pending Receiver:</strong> <span style={{ fontFamily: 'monospace' }}>{truncate(unit.pendingReceiver)}</span>
                              </p>
                            )}
                            <p style={{ margin: 0, color: '#334155' }}>
                              <strong>Quantity:</strong>{" "}
                              {manufacturerTree ? (
                                <>
                                  {currentQuantity} in stock / {totalQuantity} total
                                  {rejectedStockQuantity > 0 && (
                                    <span style={{ color: '#64748b', fontSize: '13px', marginLeft: '6px' }}>
                                      ({activeStockQuantity} active, {rejectedStockQuantity} rejected returned)
                                    </span>
                                  )}
                                </>
                              ) : (
                                unit.quantity
                              )}
                            </p>
                            <p style={{ margin: 0, color: '#334155' }}><strong>Parent / root:</strong> {unit.parentId === "0" ? "Root" : `${unit.parentId} / ${unit.rootId}`}</p>
                            <p style={{ margin: 0, color: '#334155' }}><strong>Created:</strong> {formatDate(unit.createdAt)}</p>
                            <p style={{ margin: 0, color: '#334155' }}><strong>Accepted:</strong> {formatDate(unit.acceptedAt)}</p>
                            <p style={{ margin: 0, color: '#334155' }}><strong>Container Level:</strong> {unitLevelToName(unit.level)}</p>
                            <p style={{ margin: 0, color: '#334155' }}><strong>Medicine:</strong> {getMedicineName(unit.metadata)} ({unit.quantity} tablets)</p>
                            <div style={{ marginTop: '10px', marginBottom: '6px' }}>
                              <button
                                type="button"
                                className={styles.secondaryButton}
                                style={{ padding: '6px 14px', fontSize: '13px', display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}
                                onClick={() => void openQrModal(unit)}
                              >
                                📱 View Public QR Code
                              </button>
                            </div>

                            {/* Unit History */}
                            <div style={{ marginTop: '12px', backgroundColor: '#f8fafc', padding: '12px', borderRadius: '8px' }}>
                              <h4 style={{ margin: '0 0 8px 0', fontSize: '12px', textTransform: 'uppercase', color: '#64748b', letterSpacing: '0.05em' }}>Transfer History</h4>
                              {unitHistoryLogs.length > 0 ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                  {unitHistoryLogs.map((log, idx) => (
                                    <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', fontFamily: 'monospace' }}>
                                      <span style={{ color: log.type === "TransferRejected" ? '#b91c1c' : undefined, fontWeight: log.type === "TransferRejected" ? 600 : undefined }}>
                                        {log.type === "TransferRejected" ? "Transfer Rejected" : log.type}
                                      </span>
                                      <span>
                                        {log.type === "TransferRejected"
                                          ? `${truncate(log.from || "")} ➔ Rejected by ${truncate(log.rejectedBy || log.to || "")}`
                                          : `${truncate(log.from || "")} ➔ ${truncate(log.to || "")}`}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p style={{ margin: 0, fontSize: '12px', color: '#94a3b8', fontStyle: 'italic' }}>No transfer events recorded yet.</p>
                              )}
                            </div>

                            {partitions.length > 0 && (
                              <div className={styles.inventoryPartitions}>
                                <h4 style={{ margin: '0 0 8px', fontSize: '12px', textTransform: 'uppercase', color: '#1d4ed8', letterSpacing: '0.05em' }}>
                                  Partitions of unit #{role.manufacturer || isAdmin ? unit.displayId : localUnitId(unit)}
                                </h4>
                                <div className={styles.inventoryPartitionList}>
                                  {partitions.map((partition) => {
                                    const partitionExpanded = !!expandedUnits[`inventory-partition-${partition.id}`];
                                    const isRejected = partition.status === 3;
                                    return (
                                      <div key={partition.id} className={styles.inventoryPartitionTile}>
                                        <button
                                          type="button"
                                          className={styles.inventoryPartitionRow}
                                          aria-expanded={partitionExpanded}
                                          onClick={() => setExpandedUnits((prev) => ({
                                            ...prev,
                                            [`inventory-partition-${partition.id}`]: !partitionExpanded,
                                          }))}
                                        >
                                          <strong>#{role.manufacturer || isAdmin ? partition.displayId : localUnitId(partition)}</strong>
                                          <span>Qty {partition.quantity}</span>
                                          {isRejected && partition.rejectedBy ? (
                                            <span className={`${styles.statusBadge} ${styles.statusRejected}`}>
                                              Rejected by {truncate(partition.rejectedBy)}
                                            </span>
                                          ) : (
                                            <span className={`${styles.statusBadge} ${statusClass(partition)}`}>{displayStatus(partition)}</span>
                                          )}
                                          <span className={styles.partitionChevron}>{partitionExpanded ? '−' : '+'}</span>
                                        </button>
                                        {partitionExpanded && (
                                          <div className={styles.partitionDetails}>
                                            <span>Current owner</span>
                                            <strong>{truncate(partition.currentOwner)}</strong>
                                            {isRejected && partition.rejectedBy ? (
                                              <>
                                                <span style={{ color: '#b91c1c' }}>Rejected by</span>
                                                <strong style={{ color: '#b91c1c', fontFamily: 'monospace' }}>{truncate(partition.rejectedBy)}</strong>
                                                <span>Status</span>
                                                <strong style={{ color: '#b91c1c' }}>Returned to sender</strong>
                                              </>
                                            ) : (
                                              <>
                                                <span>To</span>
                                                <strong>{truncate(partition.pendingReceiver)}</strong>
                                              </>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          )}
        </main>
      </div>

      {actionPopup && (
        <div className={`${styles.actionPopup} ${actionPopup.tone === "error" ? styles.actionPopupError : ""}`} role="status" aria-live="polite">
          <strong>{actionPopup.tone === "error" ? "Action failed" : "Action complete"}</strong>
          <span>{actionPopup.message}</span>
          <button type="button" onClick={() => setActionPopup(null)} aria-label="Dismiss message">×</button>
        </div>
      )}

      
        {qrModalUnit && (
          <div className={styles.modalBackdrop} onClick={() => setQrModalUnit(null)}>
            <div
              className={styles.modalContent}
              style={{ maxWidth: '420px', textAlign: 'center', padding: '24px' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <span style={{ fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', color: '#0d9488', letterSpacing: '0.05em' }}>
                  Public Verification QR
                </span>
                <button
                  type="button"
                  onClick={() => setQrModalUnit(null)}
                  style={{ border: 'none', background: 'transparent', fontSize: '18px', cursor: 'pointer', color: '#64748b' }}
                >
                  ✕
                </button>
              </div>

              <h3 style={{ margin: '0 0 4px 0', fontSize: '19px', fontWeight: 700, color: '#0f172a' }}>
                {getMedicineName(qrModalUnit.metadata)}
              </h3>
              <p style={{ margin: '0 0 16px 0', fontSize: '13px', color: '#64748b' }}>
                Unit #{qrModalUnit.id} · {qrModalUnit.quantity} tablets in stock
              </p>

              <div
                style={{
                  backgroundColor: '#ffffff',
                  padding: '16px',
                  borderRadius: '16px',
                  display: 'inline-block',
                  boxShadow: '0 4px 12px rgba(15,23,42,0.08)',
                  border: '1px solid #e2e8f0',
                  marginBottom: '18px',
                }}
              >
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt={`QR Code for Unit #${qrModalUnit.id}`}
                    style={{ width: '220px', height: '220px', display: 'block' }}
                  />
                ) : (
                  <div style={{ width: '220px', height: '220px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b' }}>
                    Generating QR code...
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    style={{ flex: 1, padding: '10px' }}
                    onClick={() => {
                      if (!qrDataUrl) return;
                      const a = document.createElement("a");
                      a.href = qrDataUrl;
                      a.download = `pharmatree-unit-${qrModalUnit.id}-qr.png`;
                      a.click();
                    }}
                  >
                    ⬇ Download PNG
                  </button>

                  <button
                    type="button"
                    className={styles.secondaryButton}
                    style={{ flex: 1, padding: '10px' }}
                    onClick={async () => {
                      const origin = typeof window !== "undefined" ? window.location.origin : "";
                      const link = `${origin}/verify?unitId=${qrModalUnit.id}`;
                      try {
                        await navigator.clipboard.writeText(link);
                        setCopiedLink(true);
                        setTimeout(() => setCopiedLink(false), 2500);
                      } catch {
                        // clipboard fallback
                      }
                    }}
                  >
                    {copiedLink ? "✓ Copied!" : "📋 Copy Link"}
                  </button>
                </div>

                <a
                  href={`/verify?unitId=${qrModalUnit.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className={styles.secondaryButton}
                  style={{ display: 'block', textDecoration: 'none', padding: '10px', textAlign: 'center' }}
                >
                  Open Public Verification Page ↗
                </a>
              </div>
            </div>
          </div>
        )}

        {modalUnit && (
        <div className={styles.unitModalBackdrop} onClick={() => setModalUnit(null)}>
          <div className={styles.unitModalContent} onClick={(e) => e.stopPropagation()}>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
              <h3 style={{margin:0}}>{(modalUnit.metadata || "").split(",")[0] || `Unit ${modalUnit.id}`}</h3>
              <button className={styles.modalClose} onClick={() => setModalUnit(null)}>✕</button>
            </div>
            <div style={{marginTop:12}}>
              <p><strong>Unit ID:</strong> {modalUnit.displayId}</p>
              <p><strong>Manufacturer:</strong> <span style={{ fontFamily: 'monospace' }}>{modalUnit.manufacturer}</span></p>
              <p><strong>Current owner:</strong> <span style={{ fontFamily: 'monospace' }}>{modalUnit.currentOwner}</span></p>
              {modalUnit.status === 3 ? (
                <p style={{ color: '#b91c1c' }}>
                  <strong>Rejected by:</strong>{" "}
                  <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>
                    {modalUnit.rejectedBy
                      ? (modalUnit.rejectedBy.toLowerCase() === account.toLowerCase()
                          ? `You (${modalUnit.rejectedBy})`
                          : modalUnit.rejectedBy)
                      : "Receiver"}
                  </span>
                </p>
              ) : (
                <p>
                  <strong>Pending receiver:</strong>{" "}
                  <span style={{ fontFamily: 'monospace' }}>
                    {modalUnit.pendingReceiver && modalUnit.pendingReceiver !== "0x0000000000000000000000000000000000000000"
                      ? modalUnit.pendingReceiver
                      : "None"}
                  </span>
                </p>
              )}
              <p><strong>Quantity:</strong> {modalUnit.quantity} tablets</p>
              <p><strong>Parent / root:</strong> {modalUnit.parentId === "0" ? "Root" : `${modalUnit.parentId} / ${modalUnit.rootId}`}</p>
              <p><strong>Created:</strong> {formatDate(modalUnit.createdAt)}</p>
              {modalUnit.status === 3 && modalUnit.rejectedAt ? (
                <p><strong>Rejected on:</strong> {formatDate(modalUnit.rejectedAt)}</p>
              ) : (
                <p><strong>Accepted:</strong> {formatDate(modalUnit.acceptedAt)}</p>
              )}
              <p>
                <strong>Status:</strong>{" "}
                <span className={`${styles.statusBadge} ${statusClass(modalUnit)}`}>
                  {modalUnit.status === 3
                    ? (modalUnit.rejectedBy
                        ? `Rejected by ${formatAddress(modalUnit.rejectedBy)}`
                        : "Rejected")
                    : displayStatus(modalUnit)}
                </span>
              </p>
              <p><strong>Medicine Details:</strong> {getMedicineName(modalUnit.metadata)} ({modalUnit.quantity} tablets)</p>

              {modalUnit.status === 1 && modalUnit.pendingReceiver.toLowerCase() === account.toLowerCase() && (
                <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                  <button
                    className={styles.primaryButton}
                    onClick={async () => {
                      if (!modalUnit) return;
                      setActionUnitId(modalUnit.id);
                      setActionReceiver(modalUnit.pendingReceiver);
                      await handleTransferAction('accept', modalUnit.id);
                      setModalUnit(null);
                    }}
                    disabled={loading || !account || (!role.manufacturer && !role.handler)}
                  >
                    Accept
                  </button>
                  <button
                    className={styles.secondaryButton}
                    onClick={async () => {
                      if (!modalUnit) return;
                      setActionUnitId(modalUnit.id);
                      await handleTransferAction('reject', modalUnit.id);
                      setModalUnit(null);
                    }}
                    disabled={loading || !account || (!role.manufacturer && !role.handler)}
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
