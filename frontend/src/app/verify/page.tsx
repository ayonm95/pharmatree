"use client";

import React, { Suspense, useEffect, useState, useRef } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ethers } from "ethers";
import {
  PHARMA_TREE_ABI,
  PHARMA_TREE_CONTRACT,
  unitLevelToName,
} from "../../lib/pharmaTree";
import { readonlyProvider } from "../../lib/rpc";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { CopyableHash } from "@/components/ui/CopyableHash";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatAddress, formatDate } from "@/lib/format";
import { playBeepSuccess, playSirenAlarm } from "@/lib/audio-alerts";
import {
  AlertTriangle,
  XCircle,
  Search,
  CheckCircle2,
  Factory,
  Package,
  Truck,
  ArrowLeft,
  ExternalLink,
  History,
  Plus,
  ShieldCheck,
  Layers,
  Clock,
  Eye,
  Pill,
  Box,
  ShoppingCart,
  Volume2,
  VolumeX,
  UserCheck,
} from "lucide-react";

type UnitRecord = {
  id: string;
  parentId: string;
  rootId: string;
  level: number;
  manufacturer: string;
  currentOwner: string;
  pendingReceiver: string;
  status: number;
  quantity: string;
  metadata: string;
  serialHash?: string;
  expiry?: number;
  isRecalled?: boolean;
  isExpired?: boolean;
};

type TimelineEvent = {
  unitId: string;
  unitLevel: number;
  unitLabel: string;
  isScannedUnit: boolean;
  title: string;
  description: string;
  timestamp?: number;
  txHash?: string;
  type: "created" | "transferred" | "sold" | "rejected";
};

type ScanRecord = {
  scanCount: number;
  firstScanTime: number | null;
  lastScanTime: number | null;
  isFirstScan: boolean;
};

function VerifyContent() {
  const searchParams = useSearchParams();
  const initialId = searchParams.get("unitId") || "1";

  const [inputUnitId, setInputUnitId] = useState(initialId);
  const [activeUnitId, setActiveUnitId] = useState(initialId);
  const [unit, setUnit] = useState<UnitRecord | null>(null);
  const [lineage, setLineage] = useState<UnitRecord[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [scanData, setScanData] = useState<ScanRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Scratch seal verification state
  const [scratchInput, setScratchInput] = useState("");
  const [sealStatus, setSealStatus] = useState<"unverified" | "verified" | "consumed" | "invalid" | "locked">("unverified");
  const [sealMessage, setSealMessage] = useState<string | null>(null);
  const [sealVerifying, setSealVerifying] = useState(false);

  // Role-adaptive wallet & sound state
  const [account, setAccount] = useState<string | null>(null);
  const [isHandlerOrAdmin, setIsHandlerOrAdmin] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionSuccessMsg, setActionSuccessMsg] = useState<string | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const soundEnabledRef = useRef(soundEnabled);
  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  // Auto-detect connected wallet for role-adaptive view
  useEffect(() => {
    if (typeof window !== "undefined" && (window as any).ethereum) {
      (window as any).ethereum
        .request({ method: "eth_accounts" })
        .then((accounts: string[]) => {
          if (accounts && accounts[0]) {
            const userAddr = accounts[0].toLowerCase();
            setAccount(userAddr);
            const contract = new ethers.Contract(PHARMA_TREE_CONTRACT, PHARMA_TREE_ABI, readonlyProvider);
            Promise.all([contract.isHandler(userAddr), contract.isManufacturer(userAddr)])
              .then(([isHandler, isMfr]) => {
                setIsHandlerOrAdmin(Boolean(isHandler || isMfr));
              })
              .catch(() => {});
          }
        })
        .catch(() => {});
    }
  }, []);

  async function handleAcceptTransfer() {
    if (!unit || !(window as any).ethereum) return;
    setActionLoading(true);
    setActionSuccessMsg(null);
    try {
      const provider = new ethers.BrowserProvider((window as any).ethereum);
      const signer = await provider.getSigner();
      const contract = new ethers.Contract(PHARMA_TREE_CONTRACT, PHARMA_TREE_ABI, signer);
      const tx = await contract.acceptTransfer(BigInt(unit.id));
      await tx.wait(1);
      setActionSuccessMsg(`Shipment #${unit.id} accepted into your custody! Tx: ${formatAddress(tx.hash)}`);
      setUnit((prev) =>
        prev
          ? {
              ...prev,
              status: 0,
              currentOwner: account || prev.currentOwner,
              pendingReceiver: ethers.ZeroAddress,
            }
          : prev
      );
      if (soundEnabled) playBeepSuccess();
    } catch (err: any) {
      alert(err.reason || err.message || "Failed to accept shipment.");
      if (soundEnabled) playSirenAlarm();
    } finally {
      setActionLoading(false);
    }
  }

  async function handleRejectTransfer() {
    if (!unit || !(window as any).ethereum) return;
    setActionLoading(true);
    setActionSuccessMsg(null);
    try {
      const provider = new ethers.BrowserProvider((window as any).ethereum);
      const signer = await provider.getSigner();
      const contract = new ethers.Contract(PHARMA_TREE_CONTRACT, PHARMA_TREE_ABI, signer);
      const tx = await contract.rejectTransfer(BigInt(unit.id));
      await tx.wait(1);
      setActionSuccessMsg(`Shipment #${unit.id} rejected and returned to sender. Tx: ${formatAddress(tx.hash)}`);
      setUnit((prev) =>
        prev
          ? {
              ...prev,
              status: 3,
              pendingReceiver: ethers.ZeroAddress,
            }
          : prev
      );
      if (soundEnabled) playSirenAlarm();
    } catch (err: any) {
      alert(err.reason || err.message || "Failed to reject shipment.");
    } finally {
      setActionLoading(false);
    }
  }

  useEffect(() => {
    const id = searchParams.get("unitId");
    if (id) {
      setInputUnitId(id);
      setActiveUnitId(id);
    }
  }, [searchParams]);

  useEffect(() => {
    if (!activeUnitId) return;

    let cancelled = false;

    async function loadUnitData() {
      setLoading(true);
      setError(null);
      setUnit(null);
      setLineage([]);
      setTimeline([]);
      setScanData(null);

      // 1. Post to scan tracking API
      try {
        const scanRes = await fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ unitId: activeUnitId }),
        });
        if (scanRes.ok) {
          const scanJson = await scanRes.json();
          if (!cancelled && scanJson.scanCount) {
            setScanData(scanJson);
            if (scanJson.seal) {
              if (scanJson.seal.state === "VERIFIED" || scanJson.seal.consumedAt) {
                setSealStatus("consumed");
              } else if (scanJson.seal.state === "LOCKED_REVIEW") {
                setSealStatus("locked");
              }
            }
          }
        }
      } catch (scanErr) {
        console.warn("Could not log scan count:", scanErr);
      }

      try {
        const provider = readonlyProvider;
        const contract = new ethers.Contract(PHARMA_TREE_CONTRACT, PHARMA_TREE_ABI, provider);

        const idBigInt = BigInt(activeUnitId);
        if (idBigInt <= BigInt(0)) throw new Error("Invalid Unit ID.");

        const detail = await contract.getUnitDetails(idBigInt);
        if (cancelled) return;

        const onChainSerialHash = detail[9] ? String(detail[9]) : undefined;
        const onChainExpiry = detail[10] ? Number(detail[10]) : 0;
        const serialParam = searchParams.get("serial");

        // Uniform 404 anti-cloning defense: If unit has a registered serialHash, require correct matching serial
        if (
          onChainSerialHash &&
          onChainSerialHash !== ethers.ZeroHash &&
          onChainSerialHash !== "0x0000000000000000000000000000000000000000000000000000000000000000"
        ) {
          const isSerialValid =
            typeof serialParam === "string" &&
            serialParam.length > 0 &&
            ethers.keccak256(ethers.toUtf8Bytes(serialParam)) === onChainSerialHash;

          if (!isSerialValid) {
            setError(`Unit #${activeUnitId} was not found on the blockchain.`);
            setUnit(null);
            setLoading(false);
            return;
          }
        }

        // Check recall status on root
        let isRecalled = false;
        try {
          const rootBigInt = detail[1] === BigInt(0) ? idBigInt : detail[1];
          isRecalled = await contract.recalledRoots(rootBigInt);
        } catch {}

        const nowSec = Math.floor(Date.now() / 1000);
        const isExpired = onChainExpiry > 0 && nowSec > onChainExpiry;

        const loadedUnit: UnitRecord = {
          id: String(activeUnitId),
          parentId: String(detail[0]),
          rootId: String(detail[1]),
          level: Number(detail[2]),
          manufacturer: detail[3],
          currentOwner: detail[4],
          pendingReceiver: detail[5],
          status: Number(detail[6]),
          quantity: String(detail[7]),
          metadata: detail[8],
          serialHash: onChainSerialHash,
          expiry: onChainExpiry,
          isRecalled,
          isExpired,
        };

        // 2. Recursive Lineage Resolution: traverse up the parent tree
        const lineageUnits: UnitRecord[] = [loadedUnit];
        const visitedIds = new Set<string>([loadedUnit.id]);
        let nextParentId = loadedUnit.parentId;

        while (nextParentId && nextParentId !== "0" && !visitedIds.has(nextParentId)) {
          visitedIds.add(nextParentId);
          try {
            const pDetail = await contract.getUnitDetails(BigInt(nextParentId));
            const pUnit: UnitRecord = {
              id: String(nextParentId),
              parentId: String(pDetail[0]),
              rootId: String(pDetail[1]),
              level: Number(pDetail[2]),
              manufacturer: pDetail[3],
              currentOwner: pDetail[4],
              pendingReceiver: pDetail[5],
              status: Number(pDetail[6]),
              quantity: String(pDetail[7]),
              metadata: pDetail[8],
            };
            lineageUnits.push(pUnit);
            nextParentId = pUnit.parentId;
          } catch (pErr) {
            console.warn(`Lineage lookup halted at parent #${nextParentId}:`, pErr);
            break;
          }
        }

        if (cancelled) return;
        setUnit(loadedUnit);
        setLineage(lineageUnits);

        // Sound cues for consumer/handler
        if (soundEnabledRef.current) {
          if (loadedUnit.status === 3) {
            playSirenAlarm();
          } else {
            playBeepSuccess();
          }
        }

        // Map unit ID to record for quick lookup
        const unitMap = new Map<string, UnitRecord>();
        for (const u of lineageUnits) {
          unitMap.set(u.id, u);
        }

        // 3. Multi-tier Blockchain Event Timeline
        const events: TimelineEvent[] = [];
        try {
          const latestBlock = await provider.getBlockNumber();
          const configuredStart = Number(process.env.NEXT_PUBLIC_DEPLOYMENT_BLOCK || "11683269");
          const fromBlock = configuredStart > 0 ? configuredStart : Math.max(0, latestBlock - 20000);

          const LOG_CHUNK_SIZE = 40_000;
          const ranges: { from: number; to: number }[] = [];
          for (let start = fromBlock; start <= latestBlock; start += LOG_CHUNK_SIZE) {
            ranges.push({ from: start, to: Math.min(start + LOG_CHUNK_SIZE - 1, latestBlock) });
          }

          const chunkResults = await Promise.all(
            ranges.map((r) =>
              provider.getLogs({
                address: PHARMA_TREE_CONTRACT,
                fromBlock: r.from,
                toBlock: r.to,
              })
            )
          );
          const rawLogs = chunkResults.flat();

          const iface = new ethers.Interface(PHARMA_TREE_ABI);
          const blockTimes = new Map<number, number>();

          for (const rawLog of rawLogs) {
            try {
              const parsed = iface.parseLog(rawLog);
              if (!parsed || !parsed.args) continue;

              const eventUnitId = String(parsed.args[0]);
              // Only capture events relevant to this unit or any of its packaging ancestors
              if (!visitedIds.has(eventUnitId)) continue;

              const relatedUnit = unitMap.get(eventUnitId);
              const unitLvl = relatedUnit ? relatedUnit.level : 4;
              const lvlName = unitLevelToName(unitLvl);
              const isScanned = eventUnitId === String(activeUnitId);
              const label = isScanned
                ? `Scanned Medicine (#${eventUnitId})`
                : `${lvlName} (#${eventUnitId})`;

              if (!blockTimes.has(rawLog.blockNumber)) {
                try {
                  const block = await provider.getBlock(rawLog.blockNumber);
                  if (block) blockTimes.set(rawLog.blockNumber, Number(block.timestamp));
                } catch {
                  blockTimes.set(rawLog.blockNumber, Math.floor(Date.now() / 1000));
                }
              }

              const time = blockTimes.get(rawLog.blockNumber);

              if (parsed.name === "UnitCreated") {
                events.push({
                  unitId: eventUnitId,
                  unitLevel: unitLvl,
                  unitLabel: label,
                  isScannedUnit: isScanned,
                  title: isScanned
                    ? "Medicine Registered & Packaged"
                    : `${lvlName} Packaged & Serialized`,
                  description: `Registered at manufacturing facility by ${formatAddress(parsed.args.owner || parsed.args[3])}`,
                  timestamp: time,
                  txHash: rawLog.transactionHash,
                  type: "created",
                });
              } else if (parsed.name === "TransferInitiated") {
                events.push({
                  unitId: eventUnitId,
                  unitLevel: unitLvl,
                  unitLabel: label,
                  isScannedUnit: isScanned,
                  title: `${lvlName} In-Transit (Dispatched)`,
                  description: `Dispatched from ${formatAddress(parsed.args.from || parsed.args[1])} to ${formatAddress(parsed.args.to || parsed.args[2])}`,
                  timestamp: time,
                  txHash: rawLog.transactionHash,
                  type: "transferred",
                });
              } else if (parsed.name === "TransferCompleted") {
                events.push({
                  unitId: eventUnitId,
                  unitLevel: unitLvl,
                  unitLabel: label,
                  isScannedUnit: isScanned,
                  title: `${lvlName} Custody Accepted`,
                  description: `Received and custody accepted by ${formatAddress(parsed.args.to || parsed.args[2])}`,
                  timestamp: time,
                  txHash: rawLog.transactionHash,
                  type: "transferred",
                });
              } else if (parsed.name === "UnitSold") {
                events.push({
                  unitId: eventUnitId,
                  unitLevel: unitLvl,
                  unitLabel: label,
                  isScannedUnit: isScanned,
                  title: isScanned
                    ? "Dispensed to Patient"
                    : `${lvlName} Dispensed / Sold`,
                  description: `Officially dispensed by retailer/pharmacy ${formatAddress(parsed.args.soldBy || parsed.args[1])}`,
                  timestamp: time,
                  txHash: rawLog.transactionHash,
                  type: "sold",
                });
              } else if (parsed.name === "TransferRejected") {
                events.push({
                  unitId: eventUnitId,
                  unitLevel: unitLvl,
                  unitLabel: label,
                  isScannedUnit: isScanned,
                  title: `${lvlName} Custody Rejected`,
                  description: `Rejected by downstream receiver ${formatAddress(parsed.args.rejectedBy || parsed.args[2])}`,
                  timestamp: time,
                  txHash: rawLog.transactionHash,
                  type: "rejected",
                });
              }
            } catch {
              // skip unparseable logs
            }
          }
        } catch (eventErr) {
          console.warn("Could not load event timeline logs:", eventErr);
        }

        // Fallback default events if no logs indexed
        if (events.length === 0) {
          events.push({
            unitId: loadedUnit.id,
            unitLevel: loadedUnit.level,
            unitLabel: `Unit #${loadedUnit.id}`,
            isScannedUnit: true,
            title: "Manufactured on Ethereum Sepolia",
            description: `Registered by certified manufacturer ${formatAddress(loadedUnit.manufacturer)}`,
            type: "created",
          });
          if (loadedUnit.status === 2) {
            events.push({
              unitId: loadedUnit.id,
              unitLevel: loadedUnit.level,
              unitLabel: `Unit #${loadedUnit.id}`,
              isScannedUnit: true,
              title: "Sold to Consumer",
              description: `Dispensed by pharmacy ${formatAddress(loadedUnit.currentOwner)}`,
              type: "sold",
            });
          }
        }

        // Sort events chronologically
        events.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

        if (!cancelled) {
          setTimeline(events);
        }
      } catch (err: any) {
        if (!cancelled) {
          console.error("Verification query error:", err);
          setError(
            err.message?.includes("Unit does not exist")
              ? `Unit #${activeUnitId} was not found on the blockchain.`
              : `Could not find Unit #${activeUnitId}. Verify the numerical ID or check network connectivity.`
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadUnitData();

    return () => {
      cancelled = true;
    };
  }, [activeUnitId, searchParams]);

  const getMedicineName = (metadata?: string) => {
    if (!metadata) return "Medicine";
    return metadata.split(",")[0]?.trim() || metadata;
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanId = inputUnitId.trim();
    if (cleanId && !isNaN(Number(cleanId))) {
      setActiveUnitId(cleanId);
    }
  };

  async function handleVerifySeal(e: React.FormEvent) {
    e.preventDefault();
    if (!scratchInput.trim() || !activeUnitId) return;
    setSealVerifying(true);
    setSealMessage(null);
    try {
      const serialParam = searchParams.get("serial") || undefined;
      const res = await fetch("/api/pos/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          unitId: Number(activeUnitId),
          scratchSecret: scratchInput.trim(),
          serial: serialParam,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.tamperSealStatus === "verified" || data.tamperSealStatus === "consumed") {
          setSealStatus(data.tamperSealStatus);
          setSealMessage("✓ Security scratch seal verified authentic against manufacturer cryptographic HMAC.");
          if (soundEnabledRef.current) playBeepSuccess();
        } else if (data.tamperSealStatus === "locked") {
          setSealStatus("locked");
          setSealMessage("Tamper seal is locked due to multiple failed verification attempts.");
          if (soundEnabledRef.current) playSirenAlarm();
        } else {
          setSealStatus("invalid");
          setSealMessage("Invalid scratch seal code. Packaging may be counterfeit or tampered.");
          if (soundEnabledRef.current) playSirenAlarm();
        }
      } else {
        if (data.reason === "UNIT_NOT_FOUND") {
          setError(`Unit #${activeUnitId} was not found on the blockchain.`);
        } else {
          setSealStatus("invalid");
          setSealMessage(data.message || "Failed to verify scratch seal.");
        }
        if (soundEnabledRef.current) playSirenAlarm();
      }
    } catch (err: any) {
      setSealStatus("invalid");
      setSealMessage(err.message || "Network error verifying scratch seal.");
    } finally {
      setSealVerifying(false);
    }
  }

  // Hierarchy top-to-bottom: [Container, Shipment, Batch, Box, IndividualItem]
  const hierarchy = [...lineage].reverse();

  // Evaluate consumer status verdicts across the hierarchy
  const isDirectlyRejected = unit?.status === 3;
  const anyAncestorRejected = lineage.some((u) => u.status === 3);
  const isFlagged = isDirectlyRejected || anyAncestorRejected;
  const isPending = unit?.status === 1 || lineage.some((u) => u.status === 1);
  const isSold = unit?.status === 2;
  const isActive = unit?.status === 0;
  const isRecalled = unit?.isRecalled === true;
  const isExpired = unit?.isExpired === true;

  let verdict = {
    title: "Verified Authentic Pharmaceutical",
    description: "Cryptographically verified on Ethereum Sepolia. In active pharmacy custody, verified unbroken provenance.",
    variant: "success" as "success" | "warning" | "danger" | "info",
    icon: CheckCircle2,
  };

  if (isRecalled) {
    verdict = {
      title: "CRITICAL RECALL ALERT: Product Officially Recalled",
      description: `Unit #${unit?.id} belongs to a batch that has been officially recalled by the manufacturer or QA authority. DO NOT CONSUME. Quarantined for return.`,
      variant: "danger",
      icon: XCircle,
    };
  } else if (isExpired) {
    const expDate = unit?.expiry
      ? new Date(unit.expiry * 1000).toISOString().split("T")[0]
      : "Unknown";
    verdict = {
      title: "EXPIRY ALERT: Medication Past Safe Shelf Life",
      description: `Unit #${unit?.id} expired on ${expDate}. This pharmaceutical has exceeded its authorized shelf life and must not be consumed.`,
      variant: "danger",
      icon: XCircle,
    };
  } else if (isFlagged) {
    verdict = {
      title: "DANGER: Custody Flagged / Transfer Rejected",
      description: isDirectlyRejected
        ? "This medicine unit was formally rejected during inspection or transit. DO NOT CONSUME."
        : "An upstream shipping container or batch carrying this unit was rejected during transit. Unsafe custody integrity.",
      variant: "danger",
      icon: XCircle,
    };
  } else if (isPending) {
    verdict = {
      title: "Notice: Medicine Currently In Transit",
      description: "This item or its bulk carrier container is currently in dispatch and has not yet been accepted into pharmacy inventory.",
      variant: "warning",
      icon: AlertTriangle,
    };
  } else if (isSold) {
    if (sealStatus === "verified" || sealStatus === "consumed") {
      verdict = {
        title: "✅ Seal Verified Genuine: Single-Use Dispensed Unit",
        description: `Cryptographically verified on Ethereum Sepolia. Tamper seal secret matched manufacturer HMAC. Legally dispensed to patient by authorized pharmacy ${unit ? formatAddress(unit.currentOwner) : ""}.`,
        variant: "success",
        icon: CheckCircle2,
      };
    } else if (sealStatus === "locked") {
      verdict = {
        title: "⚠️ Security Lockout: Tamper Seal Verification Locked",
        description: "Multiple incorrect scratch-off attempts have temporarily locked verification for this unit. Do not consume. Contact your dispensing pharmacist immediately.",
        variant: "danger",
        icon: XCircle,
      };
    } else if (sealStatus === "invalid") {
      verdict = {
        title: "⚠️ Tamper Seal Mismatch: Potential Cloned Packaging",
        description: "The entered scratch-off code does not match the manufacturer cryptographic HMAC verifier. The packaging may be counterfeit, photocopied, or tampered with.",
        variant: "danger",
        icon: XCircle,
      };
    } else {
      // Unverified seal state
      verdict = {
        title: "Dispensed Packaging: Scratch Seal Verification Required",
        description: `This medicine was registered as dispensed on-chain. To eliminate photocopy/cloning risks, scratch off the security strip on your box and verify the secret code below.`,
        variant: "warning",
        icon: AlertTriangle,
      };
    }
  } else if (isActive) {
    const isParentDispensed = unit && unit.parentId === "0" && Number(unit.quantity) > 0;
    verdict = {
      title: "Verified Authentic Pharmaceutical - In Stock",
      description: isParentDispensed
        ? `Direct unbroken provenance from certified manufacturer. Authorized pharmacy stock (${unit.quantity} active units remaining in inventory).`
        : "Direct unbroken provenance from certified manufacturer. Available in authorized retail stock, ready for patient purchase.",
      variant: "success",
      icon: CheckCircle2,
    };
  }

  const getTierIcon = (level: number) => {
    switch (level) {
      case 0: // Container
      case 1: // Shipment
        return <Truck size={18} />;
      case 2: // Batch
      case 3: // Box
        return <Box size={18} />;
      case 4: // IndividualItem
      default:
        return <Pill size={18} />;
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", backgroundColor: "var(--color-bg-page)" }}>
      {/* Top Header */}
      <header
        style={{
          height: "64px",
          borderBottom: "1px solid var(--color-border-default)",
          backgroundColor: "var(--color-bg-surface)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 var(--space-4)",
          position: "sticky",
          top: 0,
          zIndex: "var(--z-sticky)",
        }}
      >
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <div
            style={{
              width: "32px",
              height: "32px",
              borderRadius: "var(--radius-control)",
              backgroundColor: "var(--color-primary)",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            aria-hidden="true"
          >
            <Plus size={18} strokeWidth={3} />
          </div>
          <span style={{ fontSize: "var(--text-base)", fontWeight: 800, letterSpacing: "-0.02em", color: "var(--color-text-main)" }}>
            PHARMATREE VERIFY
          </span>
        </Link>

        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          {account && (
            <span
              style={{
                fontSize: "11px",
                color: "var(--color-primary)",
                backgroundColor: "var(--color-primary-subtle)",
                padding: "4px 8px",
                borderRadius: "var(--radius-pill)",
                fontWeight: 600,
                border: "1px solid var(--color-primary-border)",
              }}
            >
              {isHandlerOrAdmin ? "Handler: " : "Wallet: "}
              {formatAddress(account)}
            </span>
          )}

          <button
            type="button"
            onClick={() => setSoundEnabled(!soundEnabled)}
            aria-label={soundEnabled ? "Mute audio cues" : "Unmute audio cues"}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              padding: "6px 10px",
              borderRadius: "var(--radius-control)",
              border: "1px solid var(--color-border-default)",
              backgroundColor: "var(--color-bg-subtle)",
              color: soundEnabled ? "var(--color-primary)" : "var(--color-text-muted)",
              cursor: "pointer",
              fontSize: "var(--text-xs)",
              fontWeight: 600,
            }}
          >
            {soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
            <span>{soundEnabled ? "Audio ON" : "Audio OFF"}</span>
          </button>

          <Link
            href="/"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-2)",
              minHeight: "36px",
              padding: "0 var(--space-3)",
              borderRadius: "var(--radius-control)",
              border: "1px solid var(--color-border-default)",
              backgroundColor: "var(--color-bg-surface)",
              fontSize: "var(--text-xs)",
              fontWeight: 600,
              color: "var(--color-text-main)",
              transition: "all var(--transition-fast)",
            }}
          >
            <ArrowLeft size={16} />
            <span>Dashboard</span>
          </Link>
        </div>
      </header>

      {/* Main Container */}
      <main
        id="main-content"
        style={{
          flex: 1,
          maxWidth: "880px",
          margin: "0 auto",
          width: "100%",
          padding: "var(--space-8) var(--space-4)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-6)",
        }}
      >
        {/* Search Header */}
        <section style={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--space-3)" }}>
          <h1 style={{ margin: 0, fontSize: "var(--text-2xl)", fontWeight: 800, color: "var(--color-text-main)", letterSpacing: "-0.02em" }}>
            Public Medicine Provenance Verification
          </h1>
          <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--color-text-muted)", maxWidth: "580px" }}>
            Verify pharmaceutical authenticity, container custody, and multi-tier packaging provenance directly from the immutable Ethereum Sepolia ledger.
          </p>

          <form
            onSubmit={handleSearch}
            style={{
              width: "100%",
              maxWidth: "480px",
              display: "flex",
              gap: "var(--space-2)",
              marginTop: "var(--space-2)",
            }}
          >
            <div style={{ position: "relative", flex: 1 }}>
              <Search
                size={18}
                style={{
                  position: "absolute",
                  left: "14px",
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--color-text-muted)",
                }}
              />
              <input
                type="number"
                min="1"
                placeholder="Enter Unit ID (e.g. 1)"
                value={inputUnitId}
                onChange={(e) => setInputUnitId(e.target.value)}
                style={{
                  width: "100%",
                  height: "44px",
                  padding: "0 var(--space-4) 0 42px",
                  borderRadius: "var(--radius-control)",
                  border: "1px solid var(--color-border-default)",
                  backgroundColor: "var(--color-bg-surface)",
                  fontSize: "var(--text-sm)",
                  color: "var(--color-text-main)",
                }}
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              size="md"
              loading={loading}
              disabled={loading || !inputUnitId.trim()}
            >
              Verify Unit
            </Button>
          </form>
        </section>

        {/* State 1: Error / Not Found */}
        {error && (
          <Card padding="lg" style={{ border: "1px solid var(--color-danger-border)", backgroundColor: "var(--color-danger-subtle)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-4)" }}>
              <div
                style={{
                  width: "44px",
                  height: "44px",
                  borderRadius: "var(--radius-pill)",
                  backgroundColor: "#fee2e2",
                  color: "var(--color-danger)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <XCircle size={26} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                <h2 style={{ margin: 0, fontSize: "var(--text-base)", fontWeight: 700, color: "var(--color-danger)" }}>
                  Unit Record Not Found
                </h2>
                <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--color-text-main)" }}>
                  {error}
                </p>
                <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", marginTop: "var(--space-1)" }}>
                  Confirm you scanned or entered the exact numerical identifier printed on the packaging QR code.
                </span>
              </div>
            </div>
          </Card>
        )}

        {/* Loading Shimmer Skeleton */}
        {loading && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }} className="fade-in">
            <Card padding="lg" style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-4)" }}>
              <Skeleton width="48px" height="48px" borderRadius="var(--radius-pill)" />
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", flex: 1 }}>
                <Skeleton width="260px" height="24px" />
                <Skeleton width="380px" height="16px" />
                <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
                  <Skeleton width="100px" height="24px" borderRadius="var(--radius-pill)" />
                  <Skeleton width="100px" height="24px" borderRadius="var(--radius-pill)" />
                </div>
              </div>
            </Card>

            <Card padding="lg">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "var(--space-4)" }}>
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                    <Skeleton width="80px" height="12px" />
                    <Skeleton width="140px" height="18px" />
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}

        {/* State 2 & 3: Loaded Unit (Authentic, In-Transit, Sold, or Flagged) */}
        {unit && !loading && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }} className="fade-in">
            
            {/* 1. Header Verdict Banner */}
            <Card
              padding="lg"
              style={{
                border:
                  verdict.variant === "danger"
                    ? "1px solid var(--color-danger-border)"
                    : verdict.variant === "warning"
                    ? "1px solid var(--color-warning-border)"
                    : verdict.variant === "info"
                    ? "1px solid #bfdbfe"
                    : "1px solid var(--color-success-border)",
                backgroundColor:
                  verdict.variant === "danger"
                    ? "var(--color-danger-subtle)"
                    : verdict.variant === "warning"
                    ? "var(--color-warning-subtle)"
                    : verdict.variant === "info"
                    ? "#eff6ff"
                    : "var(--color-success-subtle)",
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-4)" }}>
                <div
                  style={{
                    width: "48px",
                    height: "48px",
                    borderRadius: "var(--radius-pill)",
                    backgroundColor:
                      verdict.variant === "danger"
                        ? "#fee2e2"
                        : verdict.variant === "warning"
                        ? "#fef3c7"
                        : verdict.variant === "info"
                        ? "#dbeafe"
                        : "#dcfce7",
                    color:
                      verdict.variant === "danger"
                        ? "var(--color-danger)"
                        : verdict.variant === "warning"
                        ? "var(--color-warning)"
                        : verdict.variant === "info"
                        ? "#2563eb"
                        : "var(--color-success)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <verdict.icon size={28} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <h2
                    style={{
                      margin: 0,
                      fontSize: "var(--text-lg)",
                      fontWeight: 800,
                      color:
                        verdict.variant === "danger"
                          ? "var(--color-danger)"
                          : verdict.variant === "warning"
                          ? "var(--color-warning)"
                          : verdict.variant === "info"
                          ? "#1e40af"
                          : "var(--color-success)",
                    }}
                  >
                    {verdict.title}
                  </h2>
                  <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--color-text-main)" }}>
                    {verdict.description}
                  </p>
                </div>
              </div>
            </Card>

            {/* 2. Rescan Notice & Integrity Advisory */}
            {isSold && scanData && scanData.scanCount > 1 && (
              <Card
                padding="md"
                style={{
                  border: "1px solid var(--color-warning-border, #fcd34d)",
                  backgroundColor: "var(--color-warning-subtle, #fefce8)",
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-3)" }}>
                  <AlertTriangle size={24} style={{ color: "var(--color-warning, #d97706)", flexShrink: 0, marginTop: "2px" }} />
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
                      <strong style={{ fontSize: "var(--text-sm)", color: "var(--color-text-main)" }}>
                        Notice: Previous Scans Recorded
                      </strong>
                      <span
                        style={{
                          fontSize: "11px",
                          fontWeight: 700,
                          padding: "2px 8px",
                          borderRadius: "var(--radius-pill)",
                          backgroundColor: "#fef3c7",
                          color: "#b45309",
                          border: "1px solid #fde68a",
                        }}
                      >
                        Scanned {scanData.scanCount} times
                      </span>
                    </div>
                    <p style={{ margin: "4px 0 0", fontSize: "var(--text-xs)", color: "var(--color-text-muted)", lineHeight: 1.5 }}>
                      This medicine was registered as dispensed on Ethereum Sepolia. If you or a family member scanned this item previously, this count is expected. If you are examining an unpurchased box in a retail setting, verify that the packaging and physical scratch seal remain unopened and authentic.
                    </p>
                  </div>
                </div>
              </Card>
            )}

            {/* 2b. Patient Physical Scratch Seal Verification Card */}
            {isSold && (
              <Card
                padding="md"
                style={{
                  border:
                    sealStatus === "verified" || sealStatus === "consumed"
                      ? "1px solid var(--color-success-border)"
                      : sealStatus === "locked" || sealStatus === "invalid"
                      ? "1px solid var(--color-danger-border)"
                      : "1px solid var(--color-primary-border)",
                  backgroundColor:
                    sealStatus === "verified" || sealStatus === "consumed"
                      ? "var(--color-success-subtle)"
                      : sealStatus === "locked" || sealStatus === "invalid"
                      ? "var(--color-danger-subtle)"
                      : "var(--color-bg-surface)",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "var(--space-2)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                      <ShieldCheck
                        size={20}
                        style={{
                          color:
                            sealStatus === "verified" || sealStatus === "consumed"
                              ? "var(--color-success)"
                              : sealStatus === "locked" || sealStatus === "invalid"
                              ? "var(--color-danger)"
                              : "var(--color-primary)",
                        }}
                      />
                      <strong style={{ fontSize: "var(--text-sm)", color: "var(--color-text-main)" }}>
                        Physical Packaging Scratch-Off Security Seal
                      </strong>
                    </div>
                    <span
                      style={{
                        fontSize: "11px",
                        fontWeight: 700,
                        padding: "2px 8px",
                        borderRadius: "var(--radius-pill)",
                        backgroundColor:
                          sealStatus === "verified" || sealStatus === "consumed"
                            ? "#dcfce7"
                            : sealStatus === "locked" || sealStatus === "invalid"
                            ? "#fee2e2"
                            : "#dbeafe",
                        color:
                          sealStatus === "verified" || sealStatus === "consumed"
                            ? "var(--color-success)"
                            : sealStatus === "locked" || sealStatus === "invalid"
                            ? "var(--color-danger)"
                            : "#1e40af",
                      }}
                    >
                      {sealStatus === "consumed"
                        ? "Seal Authenticated"
                        : sealStatus === "verified"
                        ? "Verified Genuine"
                        : sealStatus === "locked"
                        ? "Security Lockout"
                        : sealStatus === "invalid"
                        ? "Seal Mismatch"
                        : "Verification Required"}
                    </span>
                  </div>

                  <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--color-text-muted)", lineHeight: 1.5 }}>
                    {sealStatus === "consumed" || sealStatus === "verified"
                      ? "This packaging's single-use scratch-off seal has been cryptographically matched against the manufacturer's HMAC verifier. Replay or photocopy attempts on this carton are blocked."
                      : "To eliminate photocopy attacks where counterfeiters photocopy a legitimate packaging QR code, scratch off the silver security seal on your box to reveal the secret code, then verify it below:"}
                  </p>

                  {sealMessage && (
                    <div
                      style={{
                        padding: "8px 12px",
                        borderRadius: "var(--radius-control)",
                        fontSize: "var(--text-xs)",
                        fontWeight: 600,
                        backgroundColor:
                          sealStatus === "verified" || sealStatus === "consumed"
                            ? "var(--color-success-bg)"
                            : "var(--color-danger-subtle)",
                        color:
                          sealStatus === "verified" || sealStatus === "consumed"
                            ? "var(--color-success)"
                            : "var(--color-danger)",
                        border:
                          sealStatus === "verified" || sealStatus === "consumed"
                            ? "1px solid var(--color-success-border)"
                            : "1px solid var(--color-danger-border)",
                      }}
                    >
                      {sealMessage}
                    </div>
                  )}

                  {sealStatus !== "verified" && sealStatus !== "consumed" && sealStatus !== "locked" && (
                    <form
                      onSubmit={handleVerifySeal}
                      style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-1)", flexWrap: "wrap" }}
                    >
                      <input
                        type="text"
                        placeholder="Enter 12-char scratch seal code"
                        value={scratchInput}
                        onChange={(e) => setScratchInput(e.target.value.toUpperCase())}
                        style={{
                          flex: 1,
                          minWidth: "200px",
                          height: "40px",
                          padding: "0 var(--space-3)",
                          borderRadius: "var(--radius-control)",
                          border: "1px solid var(--color-border-default)",
                          fontFamily: "var(--font-mono)",
                          fontSize: "var(--text-sm)",
                          textTransform: "uppercase",
                        }}
                      />
                      <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        loading={sealVerifying}
                        disabled={sealVerifying || !scratchInput.trim()}
                      >
                        Verify Seal Code
                      </Button>
                    </form>
                  )}
                </div>
              </Card>
            )}

            {/* 3. Interactive Visual Journey Stepper (Manufacturer -> B2B Handshake -> POS Dispensed -> Patient Verified) */}
            <Card padding="md">
              <h3 style={{ margin: "0 0 var(--space-3)", fontSize: "var(--text-sm)", fontWeight: 700, color: "var(--color-text-main)" }}>
                Verified End-to-End Pharmaceutical Supply Chain Journey
              </h3>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
                  gap: "var(--space-3)",
                  position: "relative",
                }}
              >
                {/* Step 1: Factory Genesis */}
                <div
                  style={{
                    padding: "var(--space-3)",
                    borderRadius: "var(--radius-control)",
                    backgroundColor: "var(--color-bg-subtle)",
                    border: "1px solid var(--color-success-border)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "var(--color-success)", fontWeight: 700, fontSize: "var(--text-xs)" }}>
                      <Factory size={16} /> 1. Genesis Packaged
                    </div>
                    <CheckCircle2 size={14} style={{ color: "var(--color-success)" }} />
                  </div>
                  <span style={{ fontSize: "11px", color: "var(--color-text-muted)" }}>
                    Mfr: {unit ? formatAddress(unit.manufacturer) : "--"}
                  </span>
                  <span style={{ fontSize: "10px", color: "var(--color-success)", fontWeight: 600 }}>
                    ✓ Serialized On-Chain
                  </span>
                </div>

                {/* Step 2: B2B Custody Handshake */}
                <div
                  style={{
                    padding: "var(--space-3)",
                    borderRadius: "var(--radius-control)",
                    backgroundColor: "var(--color-bg-subtle)",
                    border: isFlagged
                      ? "1px solid var(--color-danger-border)"
                      : isPending
                      ? "1px solid var(--color-warning-border)"
                      : "1px solid var(--color-success-border)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                        color: isFlagged ? "var(--color-danger)" : isPending ? "var(--color-warning)" : "var(--color-success)",
                        fontWeight: 700,
                        fontSize: "var(--text-xs)",
                      }}
                    >
                      <Truck size={16} /> 2. B2B Handshakes
                    </div>
                    {isFlagged ? (
                      <XCircle size={14} style={{ color: "var(--color-danger)" }} />
                    ) : isPending ? (
                      <Clock size={14} style={{ color: "var(--color-warning)" }} />
                    ) : (
                      <CheckCircle2 size={14} style={{ color: "var(--color-success)" }} />
                    )}
                  </div>
                  <span style={{ fontSize: "11px", color: "var(--color-text-muted)" }}>
                    {isPending ? `Pending -> ${formatAddress(unit?.pendingReceiver || "")}` : `Current: ${unit ? formatAddress(unit.currentOwner) : "--"}`}
                  </span>
                  <span
                    style={{
                      fontSize: "10px",
                      color: isFlagged ? "var(--color-danger)" : isPending ? "var(--color-warning)" : "var(--color-success)",
                      fontWeight: 600,
                    }}
                  >
                    {isFlagged ? "✕ Transfer Rejected" : isPending ? "⏳ In-Transit Dispatched" : "✓ Unbroken Custody"}
                  </span>
                </div>

                {/* Step 3: Retail POS Dispensing */}
                <div
                  style={{
                    padding: "var(--space-3)",
                    borderRadius: "var(--radius-control)",
                    backgroundColor: "var(--color-bg-subtle)",
                    border: isSold
                      ? "1px solid var(--color-success-border)"
                      : isActive
                      ? "1px solid #bfdbfe"
                      : "1px solid var(--color-border-default)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                        color: isSold ? "var(--color-success)" : isActive ? "#2563eb" : "var(--color-text-muted)",
                        fontWeight: 700,
                        fontSize: "var(--text-xs)",
                      }}
                    >
                      <ShoppingCart size={16} /> 3. Pharmacy POS
                    </div>
                    {isSold ? (
                      <CheckCircle2 size={14} style={{ color: "var(--color-success)" }} />
                    ) : isActive ? (
                      <span style={{ fontSize: "10px", color: "#2563eb", fontWeight: 700 }}>IN STOCK</span>
                    ) : (
                      <Clock size={14} style={{ color: "var(--color-text-muted)" }} />
                    )}
                  </div>
                  <span style={{ fontSize: "11px", color: "var(--color-text-muted)" }}>
                    {isSold ? "Marked Sold at POS" : isActive ? "Available at Pharmacy" : "Awaiting Delivery"}
                  </span>
                  <span
                    style={{
                      fontSize: "10px",
                      color: isSold ? "var(--color-success)" : isActive ? "#2563eb" : "var(--color-text-muted)",
                      fontWeight: 600,
                    }}
                  >
                    {isSold ? "✓ Sepolia Relayer Sold" : isActive ? "Ready for Dispensing" : "Pending Handshake"}
                  </span>
                </div>

                {/* Step 4: Patient Verification */}
                <div
                  style={{
                    padding: "var(--space-3)",
                    borderRadius: "var(--radius-control)",
                    backgroundColor: "var(--color-bg-subtle)",
                    border:
                      isSold && scanData && scanData.scanCount > 1
                        ? "1px solid var(--color-danger-border)"
                        : isSold
                        ? "1px solid var(--color-success-border)"
                        : "1px solid var(--color-border-default)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                        color:
                          isSold && scanData && scanData.scanCount > 1
                            ? "var(--color-danger)"
                            : isSold
                            ? "var(--color-success)"
                            : "var(--color-text-muted)",
                        fontWeight: 700,
                        fontSize: "var(--text-xs)",
                      }}
                    >
                      <ShieldCheck size={16} /> 4. Patient Check
                    </div>
                    {isSold && scanData && scanData.scanCount > 1 ? (
                      <AlertTriangle size={14} style={{ color: "var(--color-danger)" }} />
                    ) : isSold ? (
                      <CheckCircle2 size={14} style={{ color: "var(--color-success)" }} />
                    ) : (
                      <Eye size={14} style={{ color: "var(--color-text-muted)" }} />
                    )}
                  </div>
                  <span style={{ fontSize: "11px", color: "var(--color-text-muted)" }}>
                    {scanData ? `Verified ${scanData.scanCount} Times` : "Live Verification"}
                  </span>
                  <span
                    style={{
                      fontSize: "10px",
                      color:
                        isSold && scanData && scanData.scanCount > 1
                          ? "var(--color-warning, #f59e0b)"
                          : isSold
                          ? "var(--color-success)"
                          : "var(--color-text-muted)",
                      fontWeight: 700,
                    }}
                  >
                    {isSold && scanData && scanData.scanCount > 1
                      ? "⚠️ Dispensed Unit (Rescanned)"
                      : isSold
                      ? "✓ Authentic Patient Unit"
                      : "Unpurchased Unit"}
                  </span>
                </div>
              </div>
            </Card>

            {/* 4. Role-Adaptive Handler Reception Suite (1-Click Accept / Reject) */}
            {unit.status === 1 && account && unit.pendingReceiver.toLowerCase() === account && (
              <Card
                padding="md"
                style={{
                  border: "2px solid var(--color-primary)",
                  backgroundColor: "var(--color-primary-subtle)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "var(--space-2)", marginBottom: "var(--space-2)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", color: "var(--color-primary)", fontWeight: 700 }}>
                    <Truck size={20} />
                    <span>Inbound Shipment Assigned to Your Wallet</span>
                  </div>
                  <span style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "var(--radius-pill)", backgroundColor: "var(--color-primary)", color: "#fff", fontWeight: 700 }}>
                    Authorized Handler Action Required
                  </span>
                </div>
                <p style={{ margin: "0 0 var(--space-3)", fontSize: "var(--text-xs)", color: "var(--color-text-main)", lineHeight: 1.5 }}>
                  This package was dispatched from <strong>{formatAddress(unit.currentOwner)}</strong> directly to you. Inspect packaging condition, tamper seals, and temperature monitors, then accept or reject custody:
                </p>

                {actionSuccessMsg && (
                  <div style={{ padding: "8px 12px", borderRadius: "var(--radius-control)", backgroundColor: "var(--color-success-bg)", border: "1px solid var(--color-success-border)", color: "var(--color-success)", fontSize: "var(--text-xs)", fontWeight: 700, marginBottom: "var(--space-3)" }}>
                    ✓ {actionSuccessMsg}
                  </div>
                )}

                <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
                  <Button
                    variant="primary"
                    size="md"
                    loading={actionLoading}
                    disabled={actionLoading}
                    onClick={handleAcceptTransfer}
                    icon={<CheckCircle2 size={16} />}
                  >
                    Accept Shipment into Custody
                  </Button>
                  <Button
                    variant="danger"
                    size="md"
                    loading={actionLoading}
                    disabled={actionLoading}
                    onClick={handleRejectTransfer}
                    icon={<XCircle size={16} />}
                  >
                    Reject Damaged / Tampered Shipment
                  </Button>
                </div>
              </Card>
            )}

            {/* 5. Role-Adaptive Handler Diagnostics (For Logisticians / Pharmacists) */}
            {account && isHandlerOrAdmin && (
              <Card padding="md" style={{ border: "1px solid var(--color-border-default)", backgroundColor: "var(--color-bg-surface)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-2)" }}>
                  <UserCheck size={18} style={{ color: "var(--color-primary)" }} />
                  <h4 style={{ margin: 0, fontSize: "var(--text-sm)", fontWeight: 700, color: "var(--color-text-main)" }}>
                    Authorized Handler Diagnostics
                  </h4>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "var(--space-2)", fontSize: "var(--text-xs)" }}>
                  <div>
                    <span style={{ color: "var(--color-text-muted)", display: "block" }}>Root Ancestor ID:</span>
                    <strong>Unit #{unit.rootId || unit.id}</strong>
                  </div>
                  <div>
                    <span style={{ color: "var(--color-text-muted)", display: "block" }}>Parent Container ID:</span>
                    <strong>{unit.parentId && unit.parentId !== "0" ? `Unit #${unit.parentId}` : "None (Root Unit)"}</strong>
                  </div>
                  <div>
                    <span style={{ color: "var(--color-text-muted)", display: "block" }}>Cold-Chain & Transit Integrity:</span>
                    <strong style={{ color: isFlagged ? "var(--color-danger)" : "var(--color-success)" }}>
                      {isFlagged ? "⚠️ Transit Breach / Flagged" : "✓ Sealed & Intact"}
                    </strong>
                  </div>
                  <div>
                    <span style={{ color: "var(--color-text-muted)", display: "block" }}>On-Hand Stock Qty:</span>
                    <strong>{unit.quantity} Units Available</strong>
                  </div>
                </div>
              </Card>
            )}

            {/* 6. Anti-Counterfeit Verification Frequency Badge */}
            {scanData && (
              <Card
                padding="md"
                style={{
                  border:
                    scanData.scanCount > 1
                      ? "1px solid var(--color-warning-border)"
                      : "1px solid var(--color-success-border)",
                  backgroundColor:
                    scanData.scanCount > 1
                      ? "var(--color-warning-subtle)"
                      : "var(--color-success-subtle)",
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-3)" }}>
                  {scanData.scanCount === 1 ? (
                    <ShieldCheck size={22} style={{ color: "var(--color-success)", flexShrink: 0, marginTop: "2px" }} />
                  ) : (
                    <Eye size={22} style={{ color: "var(--color-warning)", flexShrink: 0, marginTop: "2px" }} />
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
                      <strong style={{ fontSize: "var(--text-sm)", color: "var(--color-text-main)" }}>
                        {scanData.scanCount === 1
                          ? "First Verification Scan Recorded"
                          : `QR Code Verified ${scanData.scanCount} Times`}
                      </strong>
                      <span
                        style={{
                          fontSize: "11px",
                          fontWeight: 700,
                          padding: "2px 8px",
                          borderRadius: "var(--radius-pill)",
                          backgroundColor: scanData.scanCount === 1 ? "#dcfce7" : "#fef3c7",
                          color: scanData.scanCount === 1 ? "var(--color-success)" : "var(--color-warning)",
                        }}
                      >
                        {scanData.scanCount === 1 ? "Tamper Seal Intact" : "Multiple Scans Observed"}
                      </span>
                    </div>
                    <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
                      {scanData.scanCount === 1
                        ? "This is the very first time this unit's unique QR code was scanned. The serial label has not been previously read."
                        : `First verified on ${scanData.firstScanTime ? formatDate(scanData.firstScanTime) : "earlier"}. If you are purchasing this unopened from a shelf, consult your pharmacist to confirm this label was not duplicated.`}
                    </p>
                  </div>
                </div>
              </Card>
            )}

            {/* 3. Multi-tier Packaging Hierarchy Stepper */}
            {hierarchy.length > 1 && (
              <Card padding="md">
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
                  <Layers size={18} style={{ color: "var(--color-primary)" }} />
                  <h3 style={{ margin: 0, fontSize: "var(--text-base)", fontWeight: 700, color: "var(--color-text-main)" }}>
                    Packaging Lineage Hierarchy
                  </h3>
                </div>
                <p style={{ margin: "0 0 var(--space-4) 0", fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
                  Traceability path from bulk shipping container down to your individual retail medicine:
                </p>

                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--space-2)",
                    position: "relative",
                  }}
                >
                  {hierarchy.map((tier, idx) => {
                    const isTarget = tier.id === unit.id;
                    const isRoot = idx === 0;

                    return (
                      <div
                        key={tier.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "var(--space-3)",
                          padding: "var(--space-3)",
                          borderRadius: "var(--radius-control)",
                          backgroundColor: isTarget ? "var(--color-bg-subtle)" : "transparent",
                          border: isTarget
                            ? "1px solid var(--color-primary)"
                            : "1px solid var(--color-border-subtle)",
                        }}
                      >
                        <div
                          style={{
                            width: "32px",
                            height: "32px",
                            borderRadius: "var(--radius-pill)",
                            backgroundColor: isTarget ? "var(--color-primary)" : "var(--color-bg-subtle)",
                            color: isTarget ? "#ffffff" : "var(--color-text-muted)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                          }}
                        >
                          {getTierIcon(tier.level)}
                        </div>

                        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                            <strong style={{ fontSize: "var(--text-sm)", color: "var(--color-text-main)" }}>
                              {unitLevelToName(tier.level)} #{tier.id}
                            </strong>
                            {isTarget && (
                              <span
                                style={{
                                  fontSize: "10px",
                                  fontWeight: 700,
                                  backgroundColor: "var(--color-primary)",
                                  color: "#ffffff",
                                  padding: "1px 6px",
                                  borderRadius: "var(--radius-pill)",
                                }}
                              >
                                Scanned Unit
                              </span>
                            )}
                            {isRoot && (
                              <span
                                style={{
                                  fontSize: "10px",
                                  fontWeight: 600,
                                  backgroundColor: "var(--color-bg-subtle)",
                                  color: "var(--color-text-muted)",
                                  padding: "1px 6px",
                                  borderRadius: "var(--radius-pill)",
                                }}
                              >
                                Bulk Origin
                              </span>
                            )}
                          </div>
                          <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
                            Custodian: {formatAddress(tier.currentOwner)} · {tier.quantity} units
                          </span>
                        </div>

                        <StatusBadge status={tier.status} />
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

            {/* 4. Batch Specifications Grid */}
            <Card padding="md">
              <h3 style={{ margin: "0 0 var(--space-4) 0", fontSize: "var(--text-base)", fontWeight: 700, color: "var(--color-text-main)" }}>
                Batch Specifications
              </h3>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: "var(--space-4)",
                  fontSize: "var(--text-sm)",
                }}
              >
                <div>
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", display: "block" }}>
                    Product Name
                  </span>
                  <strong style={{ fontSize: "var(--text-base)", color: "var(--color-text-main)" }}>
                    {getMedicineName(unit.metadata)}
                  </strong>
                </div>

                <div>
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", display: "block" }}>
                    Tablet / Unit Count
                  </span>
                  <strong style={{ fontSize: "var(--text-base)", color: "var(--color-text-main)", fontVariantNumeric: "tabular-nums" }}>
                    {unit.quantity} units
                  </strong>
                </div>

                <div>
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", display: "block" }}>
                    Packaging Tier
                  </span>
                  <strong style={{ color: "var(--color-text-main)" }}>
                    {unitLevelToName(unit.level)}
                  </strong>
                </div>

                <div>
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", display: "block" }}>
                    On-Chain State
                  </span>
                  <div style={{ marginTop: "4px" }}>
                    <StatusBadge status={unit.status} />
                  </div>
                </div>

                <div>
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", display: "block" }}>
                    Unit Identifier
                  </span>
                  <strong style={{ color: "var(--color-text-main)", fontFamily: "var(--font-mono)" }}>
                    Unit #{unit.id} {unit.parentId !== "0" && `(Child of #${unit.parentId})`}
                  </strong>
                </div>

                <div>
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", display: "block" }}>
                    Verified Contract
                  </span>
                  <a
                    href={`https://sepolia.etherscan.io/address/${PHARMA_TREE_CONTRACT}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                      color: "var(--color-primary)",
                      fontWeight: 600,
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    <span>{formatAddress(PHARMA_TREE_CONTRACT)}</span>
                    <ExternalLink size={13} />
                  </a>
                </div>
              </div>
            </Card>

            {/* 5. Custody Parties Card */}
            <Card padding="md">
              <h3 style={{ margin: "0 0 var(--space-4) 0", fontSize: "var(--text-base)", fontWeight: 700, color: "var(--color-text-main)" }}>
                Custody & Parties
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-3)",
                    padding: "var(--space-3)",
                    border: "1px solid var(--color-border-subtle)",
                    borderRadius: "var(--radius-control)",
                    backgroundColor: "var(--color-bg-subtle)",
                  }}
                >
                  <Factory size={20} style={{ color: "var(--color-primary)", flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", display: "block" }}>
                      Certified Manufacturer
                    </span>
                    <CopyableHash hash={unit.manufacturer} />
                  </div>
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-3)",
                    padding: "var(--space-3)",
                    border: "1px solid var(--color-border-subtle)",
                    borderRadius: "var(--radius-control)",
                    backgroundColor: "var(--color-bg-subtle)",
                  }}
                >
                  <Package size={20} style={{ color: "var(--color-primary)", flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", display: "block" }}>
                      Current Registered Custodian
                    </span>
                    <CopyableHash hash={unit.currentOwner} />
                  </div>
                </div>

                {unit.pendingReceiver && unit.pendingReceiver !== "0x0000000000000000000000000000000000000000" && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--space-3)",
                      padding: "var(--space-3)",
                      border: "1px solid var(--color-warning-border)",
                      borderRadius: "var(--radius-control)",
                      backgroundColor: "var(--color-warning-subtle)",
                    }}
                  >
                    <Truck size={20} style={{ color: "var(--color-warning)", flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: "var(--text-xs)", color: "var(--color-warning)", display: "block", fontWeight: 600 }}>
                        Pending Transfer Receiver
                      </span>
                      <CopyableHash hash={unit.pendingReceiver} />
                    </div>
                  </div>
                )}
              </div>
            </Card>

            {/* 6. Chain of Custody Timeline */}
            <Card padding="md">
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
                <History size={18} style={{ color: "var(--color-primary)" }} />
                <h3 style={{ margin: 0, fontSize: "var(--text-base)", fontWeight: 700, color: "var(--color-text-main)" }}>
                  Chain of Custody Timeline
                </h3>
              </div>
              <p style={{ margin: "0 0 var(--space-4) 0", fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
                Aggregated multi-tier blockchain events across bulk containers and retail medicine:
              </p>

              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", paddingLeft: "var(--space-2)" }}>
                {timeline.map((evt, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: "flex",
                      gap: "var(--space-3)",
                      position: "relative",
                    }}
                  >
                    <div
                      style={{
                        width: "10px",
                        height: "10px",
                        borderRadius: "var(--radius-pill)",
                        backgroundColor:
                          evt.type === "rejected"
                            ? "var(--color-danger)"
                            : evt.type === "sold"
                            ? "var(--color-success)"
                            : evt.isScannedUnit
                            ? "var(--color-primary)"
                            : "#94a3b8",
                        marginTop: "5px",
                        flexShrink: 0,
                      }}
                    />
                    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                        <span
                          style={{
                            fontSize: "10px",
                            fontWeight: 700,
                            padding: "1px 6px",
                            borderRadius: "var(--radius-pill)",
                            backgroundColor: evt.isScannedUnit ? "var(--color-primary)" : "var(--color-bg-subtle)",
                            color: evt.isScannedUnit ? "#ffffff" : "var(--color-text-muted)",
                          }}
                        >
                          {evt.unitLabel}
                        </span>
                        <strong style={{ fontSize: "var(--text-sm)", color: "var(--color-text-main)" }}>
                          {evt.title}
                        </strong>
                      </div>
                      <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
                        {evt.description}
                      </span>
                      {evt.timestamp && (
                        <div style={{ display: "flex", alignItems: "center", gap: "4px", marginTop: "2px" }}>
                          <Clock size={11} style={{ color: "var(--color-text-muted)" }} />
                          <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", fontVariantNumeric: "tabular-nums" }}>
                            {formatDate(evt.timestamp)}
                          </span>
                        </div>
                      )}
                      {evt.txHash && (
                        <a
                          href={`https://sepolia.etherscan.io/tx/${evt.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px",
                            fontSize: "var(--text-xs)",
                            color: "var(--color-primary)",
                            fontFamily: "var(--font-mono)",
                            marginTop: "2px",
                          }}
                        >
                          <span>tx: {formatAddress(evt.txHash)}</span>
                          <ExternalLink size={11} />
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense
      fallback={
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
          Loading verification service...
        </div>
      }
    >
      <VerifyContent />
    </Suspense>
  );
}
