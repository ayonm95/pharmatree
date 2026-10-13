"use client";

import React, { Suspense, useEffect, useState } from "react";
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
import { formatAddress, formatDate } from "@/lib/format";
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
  Activity,
  Plus,
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
};

type TimelineEvent = {
  title: string;
  description: string;
  timestamp?: number;
  txHash?: string;
  type: "created" | "transferred" | "sold" | "rejected";
};

function VerifyContent() {
  const searchParams = useSearchParams();
  const initialId = searchParams.get("unitId") || "1";

  const [inputUnitId, setInputUnitId] = useState(initialId);
  const [activeUnitId, setActiveUnitId] = useState(initialId);
  const [unit, setUnit] = useState<UnitRecord | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setTimeline([]);

      try {
        const provider = readonlyProvider;
        const contract = new ethers.Contract(PHARMA_TREE_CONTRACT, PHARMA_TREE_ABI, provider);

        const idBigInt = BigInt(activeUnitId);
        if (idBigInt <= BigInt(0)) throw new Error("Invalid Unit ID.");

        const detail = await contract.getUnitDetails(idBigInt);
        if (cancelled) return;

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
        };

        setUnit(loadedUnit);

        const events: TimelineEvent[] = [];
        try {
          const latestBlock = await provider.getBlockNumber();
          const configuredStart = Number(process.env.NEXT_PUBLIC_DEPLOYMENT_BLOCK || "11683269");
          const fromBlock = configuredStart > 0 ? configuredStart : Math.max(0, latestBlock - 15000);

          const rawLogs = await provider.getLogs({
            address: PHARMA_TREE_CONTRACT,
            fromBlock,
            toBlock: latestBlock,
          });

          const iface = new ethers.Interface(PHARMA_TREE_ABI);
          const blockTimes = new Map<number, number>();

          for (const rawLog of rawLogs) {
            try {
              const parsed = iface.parseLog(rawLog);
              if (!parsed || !parsed.args) continue;

              const eventUnitId = String(parsed.args[0]);
              if (eventUnitId !== String(activeUnitId)) continue;

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
                  title: "Manufactured & Registered",
                  description: `Created by manufacturer ${formatAddress(parsed.args.owner || parsed.args[3])}`,
                  timestamp: time,
                  txHash: rawLog.transactionHash,
                  type: "created",
                });
              } else if (parsed.name === "TransferInitiated") {
                events.push({
                  title: "Transfer Dispatched",
                  description: `Sent to receiver ${formatAddress(parsed.args.to || parsed.args[2])}`,
                  timestamp: time,
                  txHash: rawLog.transactionHash,
                  type: "transferred",
                });
              } else if (parsed.name === "TransferCompleted") {
                events.push({
                  title: "Custody Accepted",
                  description: `Accepted by ${formatAddress(parsed.args.to || parsed.args[2])}`,
                  timestamp: time,
                  txHash: rawLog.transactionHash,
                  type: "transferred",
                });
              } else if (parsed.name === "UnitSold") {
                events.push({
                  title: "Dispensed / Sold to Patient",
                  description: `Marked as sold by retailer ${formatAddress(parsed.args.soldBy || parsed.args[1])}`,
                  timestamp: time,
                  txHash: rawLog.transactionHash,
                  type: "sold",
                });
              } else if (parsed.name === "TransferRejected") {
                events.push({
                  title: "Transfer Rejected",
                  description: `Rejected by receiver ${formatAddress(parsed.args.rejectedBy || parsed.args[2])}`,
                  timestamp: time,
                  txHash: rawLog.transactionHash,
                  type: "rejected",
                });
              }
            } catch {
              // skip unparseable
            }
          }
        } catch (eventErr) {
          console.warn("Could not load event timeline logs:", eventErr);
        }

        if (events.length === 0) {
          events.push({
            title: "Manufactured on Ethereum Sepolia",
            description: `Registered by manufacturer ${formatAddress(loadedUnit.manufacturer)}`,
            type: "created",
          });
          if (loadedUnit.status === 2) {
            events.push({
              title: "Sold to Consumer",
              description: `Dispensed by pharmacy ${formatAddress(loadedUnit.currentOwner)}`,
              type: "sold",
            });
          }
        }

        if (!cancelled) {
          setTimeline(events);
        }
      } catch (err: any) {
        if (!cancelled) {
          console.error("Verification query error:", err);
          setError(
            err.message?.includes("Unit does not exist")
              ? `Unit #${activeUnitId} was not found on the blockchain.`
              : `Could not find Unit #${activeUnitId}. Verify the ID or check network connectivity.`
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
  }, [activeUnitId]);

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

  const isRejected = unit?.status === 3;

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

        <Link
          href="/"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--space-2)",
            minHeight: "44px",
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
            Verify pharmaceutical authenticity, container custody, and manufacturer origin directly from the immutable Ethereum Sepolia ledger.
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

        {/* Loading Shimmer */}
        {loading && (
          <Card padding="lg" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--space-3)", padding: "var(--space-8)" }}>
            <Activity size={28} style={{ color: "var(--color-primary)", animation: "spin 1s linear infinite" }} />
            <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--color-text-muted)", fontWeight: 500 }}>
              Querying Ethereum Sepolia smart contract...
            </p>
          </Card>
        )}

        {/* State 2 & 3: Loaded Unit (Authentic OR Flagged/Rejected) */}
        {unit && !loading && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
            {/* Header Verdict Card */}
            <Card
              padding="lg"
              style={{
                border: isRejected ? "1px solid var(--color-danger-border)" : "1px solid var(--color-success-border)",
                backgroundColor: isRejected ? "var(--color-danger-subtle)" : "var(--color-success-subtle)",
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-4)" }}>
                <div
                  style={{
                    width: "48px",
                    height: "48px",
                    borderRadius: "var(--radius-pill)",
                    backgroundColor: isRejected ? "#fee2e2" : "#dcfce7",
                    color: isRejected ? "var(--color-danger)" : "var(--color-success)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {isRejected ? <AlertTriangle size={28} /> : <CheckCircle2 size={28} />}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <h2
                    style={{
                      margin: 0,
                      fontSize: "var(--text-lg)",
                      fontWeight: 800,
                      color: isRejected ? "var(--color-danger)" : "var(--color-success)",
                    }}
                  >
                    {isRejected ? "Custody Flagged / Transfer Rejected" : "Verified Authentic Pharmaceutical"}
                  </h2>
                  <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--color-text-main)" }}>
                    {isRejected
                      ? "This medicine unit was rejected by a downstream handler during transit or inspection. Returned to sender."
                      : "Cryptographically verified on Ethereum Sepolia. Direct unbroken provenance from certified manufacturer."}
                  </p>
                </div>
              </div>
            </Card>

            {/* Batch Specifications Grid */}
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
                    Packaging Classification
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

            {/* Custody Parties Card */}
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

            {/* Chain of Custody Timeline */}
            <Card padding="md">
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
                <History size={18} style={{ color: "var(--color-primary)" }} />
                <h3 style={{ margin: 0, fontSize: "var(--text-base)", fontWeight: 700, color: "var(--color-text-main)" }}>
                  Chain of Custody Timeline
                </h3>
              </div>

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
                            : "var(--color-primary)",
                        marginTop: "5px",
                        flexShrink: 0,
                      }}
                    />
                    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                      <strong style={{ fontSize: "var(--text-sm)", color: "var(--color-text-main)" }}>
                        {evt.title}
                      </strong>
                      <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
                        {evt.description}
                      </span>
                      {evt.timestamp && (
                        <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", fontVariantNumeric: "tabular-nums" }}>
                          {formatDate(evt.timestamp)}
                        </span>
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
