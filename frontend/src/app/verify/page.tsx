"use client";

import React, { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ethers } from "ethers";
import {
  PHARMA_TREE_ABI,
  PHARMA_TREE_CONTRACT,
  unitLevelToName,
  unitStatusToName,
} from "../../lib/pharmaTree";
import { readonlyProvider } from "../../lib/rpc";

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

        // Fetch logs for timeline
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
                  description: `Marked as sold by retailer/pharmacy ${formatAddress(parsed.args.soldBy || parsed.args[1])}`,
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
              // Ignore unparseable log
            }
          }
        } catch (eventErr) {
          console.warn("Could not load event timeline logs:", eventErr);
        }

        // If no event logs returned (e.g. log window limitations), provide baseline milestone
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
              : "Could not retrieve unit details. Please check the Unit ID or your network connection."
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

  const formatAddress = (addr?: string) => {
    if (!addr || addr === "0x0000000000000000000000000000000000000000") return "-";
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  const formatDate = (timestamp?: number) => {
    if (!timestamp) return "Recorded on-chain";
    return new Date(timestamp * 1000).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  };

  const getMedicineName = (metadata?: string) => {
    if (!metadata) return "Medicine";
    return metadata.split(",")[0].trim() || metadata;
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanId = inputUnitId.trim();
    if (cleanId && !isNaN(Number(cleanId))) {
      setActiveUnitId(cleanId);
    }
  };

  return (
    <div style={styles.pageWrap}>
      {/* Top Header */}
      <header style={styles.header}>
        <div style={styles.brand}>
          <span style={styles.logoCross}>✚</span>
          <span style={styles.brandTitle}>PHARMATREE VERIFY</span>
        </div>
        <Link href="/" style={styles.navLink}>
          Back to Dashboard →
        </Link>
      </header>

      {/* Main Container */}
      <main style={styles.main}>
        {/* Search / Lookup Bar */}
        <section style={styles.searchSection}>
          <h1 style={styles.mainHeading}>Public Medicine Provenance Verification</h1>
          <p style={styles.subHeading}>
            Verify genuine pharmaceutical authenticity, container custody, and manufacturer origin directly from the Ethereum Sepolia blockchain.
          </p>

          <form onSubmit={handleSearch} style={styles.searchForm}>
            <div style={styles.inputWrapper}>
              <span style={styles.searchIcon}>🔍</span>
              <input
                type="number"
                min="1"
                placeholder="Enter Unit ID (e.g. 1)"
                value={inputUnitId}
                onChange={(e) => setInputUnitId(e.target.value)}
                style={styles.searchInput}
              />
            </div>
            <button type="submit" style={styles.searchBtn} disabled={loading}>
              {loading ? "Verifying..." : "Verify Unit"}
            </button>
          </form>
        </section>

        {/* Verification Status Banner */}
        {error && (
          <div style={styles.errorBox}>
            <span style={{ fontSize: "24px" }}>⚠️</span>
            <div>
              <h3 style={{ margin: "0 0 4px 0", color: "#991b1b" }}>Verification Notice</h3>
              <p style={{ margin: 0, color: "#b91c1c" }}>{error}</p>
            </div>
          </div>
        )}

        {loading && (
          <div style={styles.loadingBox}>
            <div style={styles.spinner} />
            <p style={{ color: "#475569", fontWeight: 500 }}>Querying Ethereum Sepolia smart contract...</p>
          </div>
        )}

        {unit && !loading && (
          <div style={styles.contentGrid}>
            {/* Authenticity Card */}
            <section style={styles.card}>
              <div style={styles.verifiedBanner}>
                <div style={styles.checkCircle}>✓</div>
                <div>
                  <h2 style={styles.verifiedTitle}>Verified Authentic Pharmaceutical</h2>
                  <p style={styles.verifiedSubtitle}>
                    Immutable proof of manufacture registered on Ethereum Sepolia
                  </p>
                </div>
              </div>

              <div style={styles.detailGrid}>
                <div style={styles.detailItem}>
                  <span style={styles.detailLabel}>Medicine Name</span>
                  <span style={styles.detailValueBold}>{getMedicineName(unit.metadata)}</span>
                </div>

                <div style={styles.detailItem}>
                  <span style={styles.detailLabel}>Active Tablet Count</span>
                  <span style={styles.detailValueBold}>{unit.quantity} tablets</span>
                </div>

                <div style={styles.detailItem}>
                  <span style={styles.detailLabel}>Packaging Level</span>
                  <span style={styles.detailValue}>{unitLevelToName(unit.level)}</span>
                </div>

                <div style={styles.detailItem}>
                  <span style={styles.detailLabel}>Current Supply Status</span>
                  <span style={{
                    ...styles.statusBadge,
                    backgroundColor: unit.status === 2 ? "#dcfce7" : unit.status === 1 ? "#fef3c7" : "#e0f2fe",
                    color: unit.status === 2 ? "#15803d" : unit.status === 1 ? "#b45309" : "#0369a1",
                  }}>
                    ● {unitStatusToName(unit.status)}
                  </span>
                </div>

                <div style={styles.detailItem}>
                  <span style={styles.detailLabel}>Unit Identification</span>
                  <span style={styles.detailValue}>Unit #{unit.id} {unit.parentId !== "0" && `(Child of #${unit.parentId})`}</span>
                </div>

                <div style={styles.detailItem}>
                  <span style={styles.detailLabel}>Smart Contract</span>
                  <a
                    href={`https://sepolia.etherscan.io/address/${PHARMA_TREE_CONTRACT}`}
                    target="_blank"
                    rel="noreferrer"
                    style={styles.etherscanLink}
                  >
                    {formatAddress(PHARMA_TREE_CONTRACT)} ↗
                  </a>
                </div>
              </div>
            </section>

            {/* Custody Parties */}
            <section style={styles.card}>
              <h3 style={styles.cardSectionTitle}>Custody & Authorization</h3>
              <div style={styles.partyRow}>
                <div style={styles.partyIcon}>🏭</div>
                <div style={{ flex: 1 }}>
                  <span style={styles.partyRole}>Verified Manufacturer</span>
                  <a
                    href={`https://sepolia.etherscan.io/address/${unit.manufacturer}`}
                    target="_blank"
                    rel="noreferrer"
                    style={styles.etherscanLink}
                  >
                    {unit.manufacturer} ↗
                  </a>
                </div>
              </div>

              <div style={styles.partyRow}>
                <div style={styles.partyIcon}>📦</div>
                <div style={{ flex: 1 }}>
                  <span style={styles.partyRole}>Current Registered Owner</span>
                  <a
                    href={`https://sepolia.etherscan.io/address/${unit.currentOwner}`}
                    target="_blank"
                    rel="noreferrer"
                    style={styles.etherscanLink}
                  >
                    {unit.currentOwner} ↗
                  </a>
                </div>
              </div>

              {unit.status === 1 && unit.pendingReceiver !== ethers.ZeroAddress && (
                <div style={{ ...styles.partyRow, backgroundColor: "#fffbeb", borderColor: "#fde68a" }}>
                  <div style={styles.partyIcon}>🚚</div>
                  <div style={{ flex: 1 }}>
                    <span style={{ ...styles.partyRole, color: "#b45309" }}>Pending Transfer Receiver</span>
                    <a
                      href={`https://sepolia.etherscan.io/address/${unit.pendingReceiver}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ ...styles.etherscanLink, color: "#b45309" }}
                    >
                      {unit.pendingReceiver} ↗
                    </a>
                  </div>
                </div>
              )}
            </section>

            {/* Blockchain Audit Trail */}
            <section style={styles.card}>
              <h3 style={styles.cardSectionTitle}>Chronological Chain of Custody</h3>
              <div style={styles.timelineList}>
                {timeline.map((event, idx) => (
                  <div key={idx} style={styles.timelineItem}>
                    <div style={styles.timelineDot(event.type)}>
                      {event.type === "created" ? "✓" : event.type === "sold" ? "★" : "→"}
                    </div>
                    <div style={styles.timelineBody}>
                      <div style={styles.timelineHeaderRow}>
                        <strong style={styles.timelineTitle}>{event.title}</strong>
                        <span style={styles.timelineTime}>{formatDate(event.timestamp)}</span>
                      </div>
                      <p style={styles.timelineDesc}>{event.description}</p>
                      {event.txHash && (
                        <a
                          href={`https://sepolia.etherscan.io/tx/${event.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          style={styles.txLink}
                        >
                          View Transaction on Etherscan ({formatAddress(event.txHash)}) ↗
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </main>

      <footer style={styles.footer}>
        <p style={{ margin: 0 }}>PharmaTree · Immutable Provenance Verification Engine · Powered by Ethereum</p>
      </footer>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={<div style={{ padding: "40px", textAlign: "center" }}>Loading verification engine...</div>}>
      <VerifyContent />
    </Suspense>
  );
}

const styles = {
  pageWrap: {
    minHeight: "100vh",
    backgroundColor: "#f8fafc",
    fontFamily: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: "#0f172a",
    display: "flex",
    flexDirection: "column" as const,
  },
  header: {
    padding: "16px 28px",
    backgroundColor: "#ffffff",
    borderBottom: "1px solid #e2e8f0",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  logoCross: {
    backgroundColor: "#0d9488",
    color: "#ffffff",
    width: "28px",
    height: "28px",
    borderRadius: "6px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: "bold",
    fontSize: "18px",
  },
  brandTitle: {
    fontWeight: 800,
    fontSize: "18px",
    letterSpacing: "-0.02em",
    color: "#0f172a",
  },
  navLink: {
    fontSize: "14px",
    color: "#0d9488",
    textDecoration: "none",
    fontWeight: 600,
  },
  main: {
    maxWidth: "840px",
    width: "100%",
    margin: "0 auto",
    padding: "36px 20px 60px",
    flex: 1,
  },
  searchSection: {
    textAlign: "center" as const,
    marginBottom: "32px",
  },
  mainHeading: {
    fontSize: "28px",
    fontWeight: 800,
    letterSpacing: "-0.025em",
    color: "#0f172a",
    margin: "0 0 8px 0",
  },
  subHeading: {
    fontSize: "15px",
    color: "#64748b",
    margin: "0 0 24px 0",
    lineHeight: 1.5,
  },
  searchForm: {
    display: "flex",
    gap: "10px",
    maxWidth: "500px",
    margin: "0 auto",
  },
  inputWrapper: {
    position: "relative" as const,
    flex: 1,
  },
  searchIcon: {
    position: "absolute" as const,
    left: "14px",
    top: "50%",
    transform: "translateY(-50%)",
    color: "#94a3b8",
  },
  searchInput: {
    width: "100%",
    padding: "12px 14px 12px 40px",
    borderRadius: "10px",
    border: "1px solid #cbd5e1",
    fontSize: "15px",
    outline: "none",
    backgroundColor: "#ffffff",
    boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
  },
  searchBtn: {
    padding: "12px 22px",
    backgroundColor: "#0d9488",
    color: "#ffffff",
    fontWeight: 600,
    fontSize: "15px",
    borderRadius: "10px",
    border: "none",
    cursor: "pointer",
    boxShadow: "0 1px 3px rgba(13,148,136,0.25)",
  },
  errorBox: {
    display: "flex",
    gap: "14px",
    alignItems: "center",
    padding: "16px 20px",
    backgroundColor: "#fef2f2",
    border: "1px solid #fecaca",
    borderRadius: "12px",
    marginBottom: "24px",
  },
  loadingBox: {
    textAlign: "center" as const,
    padding: "48px 0",
  },
  spinner: {
    width: "36px",
    height: "36px",
    border: "3px solid #e2e8f0",
    borderTopColor: "#0d9488",
    borderRadius: "50%",
    margin: "0 auto 16px auto",
    animation: "spin 0.8s linear infinite",
  },
  contentGrid: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "24px",
  },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: "16px",
    border: "1px solid #e2e8f0",
    padding: "24px 28px",
    boxShadow: "0 2px 8px rgba(15,23,42,0.04)",
  },
  verifiedBanner: {
    display: "flex",
    alignItems: "center",
    gap: "16px",
    padding: "16px 20px",
    backgroundColor: "#f0fdf4",
    border: "1px solid #bbf7d0",
    borderRadius: "12px",
    marginBottom: "24px",
  },
  checkCircle: {
    width: "36px",
    height: "36px",
    borderRadius: "50%",
    backgroundColor: "#16a34a",
    color: "#ffffff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: "bold",
    fontSize: "20px",
  },
  verifiedTitle: {
    margin: "0 0 2px 0",
    fontSize: "17px",
    fontWeight: 700,
    color: "#15803d",
  },
  verifiedSubtitle: {
    margin: 0,
    fontSize: "13px",
    color: "#166534",
  },
  detailGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: "18px 24px",
  },
  detailItem: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "4px",
  },
  detailLabel: {
    fontSize: "12px",
    textTransform: "uppercase" as const,
    fontWeight: 600,
    color: "#64748b",
    letterSpacing: "0.05em",
  },
  detailValue: {
    fontSize: "15px",
    color: "#1e293b",
  },
  detailValueBold: {
    fontSize: "16px",
    fontWeight: 700,
    color: "#0f172a",
  },
  statusBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "3px 10px",
    borderRadius: "999px",
    fontSize: "13px",
    fontWeight: 600,
    width: "fit-content",
  },
  cardSectionTitle: {
    fontSize: "17px",
    fontWeight: 700,
    color: "#0f172a",
    margin: "0 0 16px 0",
    borderBottom: "1px solid #f1f5f9",
    paddingBottom: "10px",
  },
  partyRow: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
    padding: "12px 16px",
    backgroundColor: "#f8fafc",
    borderRadius: "10px",
    border: "1px solid #e2e8f0",
    marginBottom: "10px",
  },
  partyIcon: {
    fontSize: "22px",
  },
  partyRole: {
    display: "block",
    fontSize: "11px",
    textTransform: "uppercase" as const,
    fontWeight: 700,
    color: "#64748b",
    letterSpacing: "0.04em",
    marginBottom: "2px",
  },
  etherscanLink: {
    fontSize: "13px",
    color: "#0d9488",
    textDecoration: "none",
    fontWeight: 500,
    wordBreak: "break-all" as const,
  },
  timelineList: {
    position: "relative" as const,
    paddingLeft: "24px",
    borderLeft: "2px solid #e2e8f0",
    marginLeft: "12px",
    display: "flex",
    flexDirection: "column" as const,
    gap: "24px",
  },
  timelineItem: {
    position: "relative" as const,
  },
  timelineDot: (type: TimelineEvent["type"]) => ({
    position: "absolute" as const,
    left: "-33px",
    top: "2px",
    width: "20px",
    height: "20px",
    borderRadius: "50%",
    backgroundColor: type === "sold" ? "#16a34a" : type === "created" ? "#0d9488" : "#3b82f6",
    color: "#ffffff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "11px",
    fontWeight: "bold",
    boxShadow: "0 0 0 4px #ffffff",
  }),
  timelineBody: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "4px",
  },
  timelineHeaderRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap" as const,
  },
  timelineTitle: {
    fontSize: "15px",
    color: "#0f172a",
  },
  timelineTime: {
    fontSize: "12px",
    color: "#64748b",
  },
  timelineDesc: {
    margin: 0,
    fontSize: "13px",
    color: "#475569",
  },
  txLink: {
    fontSize: "12px",
    color: "#0d9488",
    textDecoration: "none",
    fontWeight: 500,
  },
  footer: {
    padding: "24px",
    textAlign: "center" as const,
    color: "#94a3b8",
    fontSize: "13px",
    borderTop: "1px solid #e2e8f0",
    backgroundColor: "#ffffff",
  },
};
