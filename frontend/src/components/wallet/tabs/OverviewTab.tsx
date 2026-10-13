"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Factory, Package, ChevronRight, ChevronDown, PlusCircle } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { StockDonutChart } from "../charts/StockDonutChart";
import { UnitRecord } from "@/types/pharmatree";
import { formatDateOnly, formatAddress } from "@/lib/format";
import { getPartitionBranchStats } from "@/lib/lineage";

interface OverviewTabProps {
  account: string;
  units: UnitRecord[];
  role: { manufacturer: boolean; handler: boolean };
  isAdmin: boolean;
  canCreateUnit: boolean;
}

export function OverviewTab({
  account,
  units,
  role,
  isAdmin,
  canCreateUnit,
}: OverviewTabProps) {
  const router = useRouter();
  const [expandedUnits, setExpandedUnits] = useState<Record<string, boolean>>({});

  const lowerAccount = account.toLowerCase();

  const createdRootSummaries = useMemo(() => {
    if (!account) return [];
    return units
      .filter((unit) => (isAdmin || unit.manufacturer.toLowerCase() === lowerAccount) && unit.parentId === "0")
      .map((root) => {
        const descendants = units.filter((unit) => unit.rootId === root.id && unit.id !== root.id);
        const lineage = [root, ...descendants];
        const totalQuantity = lineage.reduce((sum, unit) => sum + Number(unit.quantity), 0);
        const mfrAddress = root.manufacturer.toLowerCase();
        const manufacturerQuantity = lineage
          .filter((unit) => unit.currentOwner.toLowerCase() === mfrAddress && (unit.status === 0 || unit.status === 3))
          .reduce((sum, unit) => sum + Number(unit.quantity), 0);
        const directDescendants = descendants.filter((unit) => unit.parentId === root.id);
        const partitions = directDescendants.length > 0 ? directDescendants : descendants.filter((unit) =>
          isAdmin ||
          unit.manufacturer.toLowerCase() === lowerAccount ||
          unit.currentOwner.toLowerCase() === lowerAccount ||
          unit.pendingReceiver.toLowerCase() === lowerAccount
        );
        return { root, partitions, totalQuantity, manufacturerQuantity };
      })
      .filter((summary) => summary.totalQuantity > 0);
  }, [account, isAdmin, lowerAccount, units]);

  const ownedUnits = useMemo(
    () =>
      units.filter(
        (unit) =>
          unit.currentOwner.toLowerCase() === lowerAccount &&
          unit.status !== 2
      ),
    [lowerAccount, units]
  );

  const activeCount = units.filter((u) => u.status === 0 && u.currentOwner.toLowerCase() === lowerAccount).length;
  const pendingCount = units.filter((u) => u.status === 1 && (u.currentOwner.toLowerCase() === lowerAccount || u.pendingReceiver.toLowerCase() === lowerAccount)).length;
  const soldCount = units.filter((u) => u.status === 2 && u.currentOwner.toLowerCase() === lowerAccount).length;
  const rejectedCount = units.filter((u) => u.status === 3 && u.currentOwner.toLowerCase() === lowerAccount).length;

  const toggleExpand = (id: string) => {
    setExpandedUnits((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }} className="fade-in">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: role.manufacturer || isAdmin ? "repeat(auto-fit, minmax(420px, 1fr))" : "1fr",
          gap: "var(--space-6)",
        }}
      >
        {/* Manufacturer Panel (if applicable) */}
        {(role.manufacturer || isAdmin) && (
          <Card padding="md" style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: "36px",
                    height: "36px",
                    borderRadius: "var(--radius-control)",
                    backgroundColor: "var(--color-primary-subtle)",
                    color: "var(--color-primary)",
                  }}
                  aria-hidden="true"
                >
                  <Factory size={20} />
                </div>
                <div>
                  <h2 style={{ margin: 0, fontSize: "var(--text-base)", fontWeight: 700, color: "var(--color-text-main)" }}>
                    Production Batches
                  </h2>
                  <p style={{ margin: "2px 0 0 0", fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
                    Active manufacturing units and batch tracking
                  </p>
                </div>
              </div>
            </div>

            {createdRootSummaries.length === 0 ? (
              <EmptyState
                icon={<Factory size={24} />}
                title={isAdmin ? "No System Batches Found" : "No Medicines Created"}
                description={
                  isAdmin
                    ? "No medicine batches have been registered in the contract yet."
                    : role.manufacturer
                    ? "Your manufacturer wallet has not registered any root medicine batches yet. Create your first batch to begin tracking."
                    : "Your account is not registered as a manufacturer. Only authorized manufacturers can produce root batches."
                }
                actionLabel={canCreateUnit ? "Create First Unit" : undefined}
                onAction={canCreateUnit ? () => router.push("/create") : undefined}
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                {createdRootSummaries.map(({ root, partitions, totalQuantity, manufacturerQuantity }) => {
                  const medName = (root.metadata || "").split(",")[0] || root.metadata;
                  const isExpanded = !!expandedUnits[`overview-${root.id}`];

                  const hasSoldPortion = [root, ...partitions].some((u) => u.status === 2);
                  const rootStatus = manufacturerQuantity === totalQuantity
                    ? "In stock"
                    : manufacturerQuantity > 0
                    ? "Partially transferred"
                    : hasSoldPortion
                    ? "Sold"
                    : "Transferred";

                  return (
                    <div
                      key={root.id}
                      style={{
                        border: "1px solid var(--color-border-default)",
                        borderRadius: "var(--radius-control)",
                        overflow: "hidden",
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => partitions.length > 0 && toggleExpand(`overview-${root.id}`)}
                        style={{
                          width: "100%",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "var(--space-3) var(--space-4)",
                          backgroundColor: "var(--color-bg-surface)",
                          border: "none",
                          cursor: partitions.length > 0 ? "pointer" : "default",
                          textAlign: "left",
                          transition: "var(--transition-bg)",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                          <span style={{ fontWeight: 700, fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}>
                            #{root.displayId}
                          </span>
                          <span style={{ fontWeight: 600, color: "var(--color-text-main)" }}>{medName}</span>
                          <span className="tabular-nums" style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
                            ({manufacturerQuantity}/{totalQuantity} in stock)
                          </span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                          <StatusBadge
                            status={rootStatus === "In stock" ? 0 : rootStatus === "Sold" ? 2 : 1}
                            label={rootStatus}
                            size="sm"
                          />
                          {partitions.length > 0 && (
                            <span style={{ color: "var(--color-text-subtle)", display: "inline-flex" }}>
                              {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                            </span>
                          )}
                        </div>
                      </button>

                      {partitions.length > 0 && isExpanded && (
                        <div
                          style={{
                            padding: "var(--space-2) var(--space-4)",
                            backgroundColor: "var(--color-bg-subtle)",
                            borderTop: "1px solid var(--color-border-default)",
                            display: "flex",
                            flexDirection: "column",
                            gap: "var(--space-2)",
                          }}
                        >
                          {partitions.map((partition) => {
                            const stats = getPartitionBranchStats(partition, units, account);
                            return (
                              <div
                                key={partition.id}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  fontSize: "var(--text-xs)",
                                  padding: "var(--space-1) 0",
                                }}
                              >
                                <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>
                                  #{partition.displayId}
                                </span>
                                <span className="tabular-nums" style={{ color: "var(--color-text-muted)" }}>
                                  Qty: {stats.displayQty}
                                </span>
                                <StatusBadge
                                  variant={stats.variant}
                                  label={
                                    partition.status === 3 && partition.rejectedBy
                                      ? `Rejected by ${formatAddress(partition.rejectedBy)}`
                                      : stats.statusText
                                  }
                                  size="sm"
                                />
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

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                paddingTop: "var(--space-4)",
                borderTop: "1px solid var(--color-border-default)",
                marginTop: "auto",
              }}
            >
              <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
                Total Created Batches:{" "}
                <strong className="tabular-nums" style={{ color: "var(--color-text-main)" }}>
                  {createdRootSummaries.length}
                </strong>
              </div>
              {canCreateUnit && (
                <Link href="/create">
                  <Button variant="primary" size="sm" icon={<PlusCircle size={14} />}>
                    New Batch
                  </Button>
                </Link>
              )}
            </div>
          </Card>
        )}

        {/* Owned Inventory Panel */}
        <Card padding="md" style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "36px",
                  height: "36px",
                  borderRadius: "var(--radius-control)",
                  backgroundColor: "var(--color-primary-subtle)",
                  color: "var(--color-primary)",
                }}
                aria-hidden="true"
              >
                <Package size={20} />
              </div>
              <div>
                <h2 style={{ margin: 0, fontSize: "var(--text-base)", fontWeight: 700, color: "var(--color-text-main)" }}>
                  Current Inventory
                </h2>
                <p style={{ margin: "2px 0 0 0", fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
                  Custody stock and fulfillment readiness
                </p>
              </div>
            </div>
            <Link href="/inventory">
              <Button variant="ghost" size="sm">
                View All
              </Button>
            </Link>
          </div>

          {ownedUnits.length === 0 ? (
            <EmptyState
              icon={<Package size={24} />}
              title="No Inventory in Custody"
              description={
                isAdmin
                  ? "No active medicine units found in the system."
                  : role.handler
                  ? `You are an authorized Handler (${formatAddress(account)}), but currently hold 0 medicine units in your custody. Review incoming shipments or request a batch transfer to begin processing.`
                  : role.manufacturer
                  ? "Your manufacturer wallet has no active units in stock. Create a new batch or review transferred units."
                  : "No active items currently held under your custody."
              }
              actionLabel={role.handler ? "View Transfers" : undefined}
              onAction={role.handler ? () => router.push("/transfers") : undefined}
            />
          ) : (
            <div
              style={{
                overflowX: "auto",
                border: "1px solid var(--color-border-default)",
                borderRadius: "var(--radius-control)",
              }}
            >
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--text-xs)" }}>
                <thead>
                  <tr style={{ backgroundColor: "var(--color-bg-subtle)", borderBottom: "1px solid var(--color-border-default)" }}>
                    <th style={{ textAlign: "left", padding: "var(--space-2) var(--space-3)", fontWeight: 600 }}>ID</th>
                    <th style={{ textAlign: "left", padding: "var(--space-2) var(--space-3)", fontWeight: 600 }}>Medicine</th>
                    <th style={{ textAlign: "right", padding: "var(--space-2) var(--space-3)", fontWeight: 600 }}>Qty</th>
                    <th style={{ textAlign: "left", padding: "var(--space-2) var(--space-3)", fontWeight: 600 }}>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {ownedUnits.slice(0, 5).map((unit) => {
                    const medName = (unit.metadata || "").split(",")[0] || unit.metadata;
                    return (
                      <tr
                        key={unit.id}
                        style={{ borderBottom: "1px solid var(--color-border-default)" }}
                      >
                        <td style={{ padding: "var(--space-2) var(--space-3)", fontFamily: "var(--font-mono)" }}>
                          #{unit.displayId}
                        </td>
                        <td style={{ padding: "var(--space-2) var(--space-3)", fontWeight: 600 }}>
                          {medName}
                        </td>
                        <td className="tabular-nums" style={{ padding: "var(--space-2) var(--space-3)", textAlign: "right" }}>
                          {unit.quantity}
                        </td>
                        <td className="tabular-nums" style={{ padding: "var(--space-2) var(--space-3)", color: "var(--color-text-muted)" }}>
                          {formatDateOnly(unit.createdAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              paddingTop: "var(--space-4)",
              borderTop: "1px solid var(--color-border-default)",
              marginTop: "auto",
            }}
          >
            <div>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", display: "block" }}>
                Total Stock Volume:
              </span>
              <strong className="tabular-nums" style={{ fontSize: "var(--text-base)", color: "var(--color-text-main)" }}>
                {ownedUnits.reduce((sum, unit) => sum + Number(unit.quantity || 0), 0)} Units
              </strong>
              <div
                style={{
                  fontSize: "11px",
                  color: "var(--color-text-muted)",
                  marginTop: "var(--space-1)",
                  display: "flex",
                  gap: "var(--space-2)",
                  flexWrap: "wrap",
                }}
              >
                <span style={{ color: "var(--color-success-fg)", fontWeight: 600 }}>
                  ● {activeCount} Active
                </span>
                <span style={{ color: "var(--color-warning-fg)", fontWeight: 600 }}>
                  ● {pendingCount} Pending
                </span>
                {rejectedCount > 0 && (
                  <span style={{ color: "var(--color-danger-fg)", fontWeight: 600 }}>
                    ● {rejectedCount} Rejected
                  </span>
                )}
                <span style={{ color: "var(--color-text-muted)", fontWeight: 600 }}>
                  ● {soldCount} Sold
                </span>
              </div>
            </div>
            <StockDonutChart activeCount={activeCount} pendingCount={pendingCount} soldCount={soldCount} />
          </div>
        </Card>
      </div>
    </div>
  );
}
