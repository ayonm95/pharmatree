"use client";

import React, { useState, useMemo } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { CopyableHash } from "@/components/ui/CopyableHash";
import { UnitRecord, HistoryEntry } from "@/types/pharmatree";
import { unitLevelToName } from "@/lib/pharmaTree";
import { formatDate } from "@/lib/format";
import { getPartitionBranchStats } from "@/lib/lineage";
import { Package, ChevronDown, ChevronRight, QrCode, FileText } from "lucide-react";

interface InventoryTabProps {
  account: string;
  units: UnitRecord[];
  history: HistoryEntry[];
  role?: { manufacturer: boolean; handler: boolean };
  isAdmin?: boolean;
  onOpenQr: (unit: UnitRecord) => void;
  onSelectUnitDetail: (unit: UnitRecord) => void;
  onReclaim?: (unitId: string) => Promise<void>;
}

export function InventoryTab({
  account,
  units,
  history,
  role = { manufacturer: false, handler: false },
  isAdmin = false,
  onOpenQr,
  onSelectUnitDetail,
  onReclaim,
}: InventoryTabProps) {
  const [expandedUnits, setExpandedUnits] = useState<Record<string, boolean>>({});

  const lowerAccount = account.toLowerCase();

  const inventoryGroups = useMemo(() => {
    const relevant = isAdmin
      ? units
      : units.filter(
          (unit) =>
            unit.manufacturer.toLowerCase() === lowerAccount ||
            unit.currentOwner.toLowerCase() === lowerAccount ||
            (unit.status === 1 && unit.pendingReceiver.toLowerCase() === lowerAccount)
        );
    const manufacturerTree = isAdmin || relevant.some((unit) => unit.manufacturer.toLowerCase() === lowerAccount);
    if (!manufacturerTree) {
      return relevant
        .filter(
          (unit) =>
            (unit.currentOwner.toLowerCase() === lowerAccount && unit.status !== 2) ||
            (unit.status === 1 && unit.pendingReceiver.toLowerCase() === lowerAccount)
        )
        .sort((left, right) => Number(left.id) - Number(right.id))
        .map((unit) => ({ root: unit, partitions: [] }));
    }
    const rootIds = [...new Set(relevant.map((unit) => (unit.rootId === "0" ? unit.id : unit.rootId)))];

    return rootIds
      .map((rootId) => {
        const root = units.find((unit) => unit.id === rootId);
        const isMfrTree = isAdmin || root?.manufacturer.toLowerCase() === lowerAccount;
        const visibleUnits = isMfrTree
          ? units.filter((unit) => unit.id === rootId || unit.rootId === rootId)
          : relevant.filter((unit) => unit.rootId === rootId);
        const representative = root && (isMfrTree || relevant.some((unit) => unit.id === root.id))
          ? root
          : visibleUnits[0];

        return {
          root: representative,
          partitions: visibleUnits.filter((unit) => unit.id !== representative?.id),
        };
      })
      .filter((group): group is { root: UnitRecord; partitions: UnitRecord[] } => Boolean(group.root));
  }, [isAdmin, lowerAccount, units]);

  const toggleExpand = (key: string) => {
    setExpandedUnits((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const getMedicineName = (metadata?: string) => {
    if (!metadata) return "Medicine";
    return metadata.split(",")[0]?.trim() || metadata;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }} className="fade-in">
      <Card padding="md">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginBottom: "var(--space-5)" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "40px",
              height: "40px",
              borderRadius: "var(--radius-control)",
              backgroundColor: "var(--color-primary-subtle)",
              color: "var(--color-primary)",
            }}
            aria-hidden="true"
          >
            <Package size={20} />
          </div>
          <div>
            <h2 style={{ margin: 0, fontSize: "var(--text-lg)", fontWeight: 700, color: "var(--color-text-main)" }}>
              Medicine Inventory ({inventoryGroups.length})
            </h2>
            <p style={{ margin: "2px 0 0 0", fontSize: "var(--text-sm)", color: "var(--color-text-muted)" }}>
              Tracked pharmaceutical packages, batch partitions, and verification certificates
            </p>
          </div>
        </div>

        {inventoryGroups.length === 0 ? (
          <EmptyState
            icon={<Package size={28} />}
            title="No Medicine Inventory Records"
            description={
              isAdmin
                ? "No medicine batches or inventory records found across the contract."
                : role.handler
                ? "You are registered as an authorized Handler. You do not currently have any medicines in your custody or pending transfer. Check 'Transfers' for incoming shipments."
                : role.manufacturer
                ? "You are registered as an authorized Manufacturer, but haven't created any medicine batches yet. Go to 'Create Unit' to mint your first batch."
                : "Your connected wallet currently has no active or past medicine custody records."
            }
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            {inventoryGroups.map(({ root: unit, partitions }) => {
              const isExpanded = !!expandedUnits[`inv-${unit.id}`];
              const medName = getMedicineName(unit.metadata);
              const isMfr = unit.manufacturer.toLowerCase() === lowerAccount;
              const lineage = [unit, ...partitions];
              const totalQuantity = lineage.reduce((sum, c) => sum + Number(c.quantity), 0);
              const mfrAddress = unit.manufacturer.toLowerCase();
              
              let currentQuantity: number;
              let batchStatusText: string;

              if (isMfr || isAdmin) {
                currentQuantity = lineage
                  .filter((c) => (c.status === 0 || c.status === 3) && c.currentOwner.toLowerCase() === mfrAddress)
                  .reduce((sum, c) => sum + Number(c.quantity), 0);
                const hasSoldPortion = lineage.some((c) => c.status === 2);
                const hasTransferredPortion = lineage.some((c) => c.currentOwner.toLowerCase() !== mfrAddress);

                batchStatusText = currentQuantity === totalQuantity
                  ? "In stock"
                  : currentQuantity > 0
                  ? "Partially transferred"
                  : hasSoldPortion
                  ? "Sold"
                  : hasTransferredPortion
                  ? "Transferred"
                  : "Active";
              } else {
                // Connected user is Handler / Custody Holder
                const ownedQuantity = lineage
                  .filter((c) => c.status === 0 && c.currentOwner.toLowerCase() === lowerAccount)
                  .reduce((sum, c) => sum + Number(c.quantity), 0);
                currentQuantity = ownedQuantity;

                const hasSoldPortion = lineage.some((c) => c.status === 2);
                const hasTransferredPortion = lineage.some(
                  (c) => c.currentOwner.toLowerCase() !== lowerAccount && c.status !== 3
                );

                if (ownedQuantity === totalQuantity && unit.status === 0) {
                  batchStatusText = "In stock";
                } else if (ownedQuantity > 0) {
                  batchStatusText = hasTransferredPortion
                    ? "Partially transferred"
                    : hasSoldPortion
                    ? "Partially sold"
                    : "In stock";
                } else if (hasSoldPortion && !hasTransferredPortion) {
                  batchStatusText = "Sold";
                } else if (hasTransferredPortion) {
                  batchStatusText = "Transferred";
                } else if (unit.status === 1) {
                  batchStatusText = "Pending transfer";
                } else if (unit.status === 3) {
                  batchStatusText = "Rejected";
                } else {
                  batchStatusText = "Active";
                }
              }

              const batchUnitIds = new Set([unit.id, ...partitions.map((p) => p.id)]);
              const unitHistoryLogs = history.filter((h) => batchUnitIds.has(h.id));

              return (
                <div
                  key={unit.id}
                  style={{
                    border: "1px solid var(--color-border-default)",
                    borderRadius: "var(--radius-surface)",
                    backgroundColor: "var(--color-bg-surface)",
                    overflow: "hidden",
                    transition: "box-shadow var(--transition-fast)",
                  }}
                >
                  {/* Collapsible Header */}
                  <button
                    type="button"
                    onClick={() => toggleExpand(`inv-${unit.id}`)}
                    aria-expanded={isExpanded}
                    style={{
                      width: "100%",
                      minHeight: "56px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "var(--space-3) var(--space-4)",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                      <div
                        style={{
                          color: "var(--color-text-muted)",
                          display: "flex",
                          alignItems: "center",
                        }}
                      >
                        {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                      </div>
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                          <strong style={{ fontSize: "var(--text-sm)", color: "var(--color-text-main)" }}>
                            UNIT #{unit.displayId}
                          </strong>
                          <span style={{ fontSize: "var(--text-sm)", color: "var(--color-text-muted)" }}>
                            · {medName}
                          </span>
                        </div>
                        <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", fontVariantNumeric: "tabular-nums" }}>
                          {isMfr || isAdmin ? `${currentQuantity}/${totalQuantity} in stock` : `Qty ${unit.quantity} tablets`}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                      <StatusBadge
                        status={
                          batchStatusText === "In stock" || batchStatusText === "Active"
                            ? 0
                            : batchStatusText === "Sold"
                            ? 2
                            : batchStatusText === "Rejected"
                            ? 3
                            : 1
                        }
                        label={batchStatusText}
                      />
                    </div>
                  </button>

                  {/* Expanded Content */}
                  {isExpanded && (
                    <div
                      style={{
                        padding: "var(--space-4)",
                        borderTop: "1px solid var(--color-border-subtle)",
                        backgroundColor: "var(--color-bg-subtle)",
                        display: "flex",
                        flexDirection: "column",
                        gap: "var(--space-4)",
                      }}
                    >
                      {/* Metadata Grid */}
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                          gap: "var(--space-3)",
                          fontSize: "var(--text-xs)",
                        }}
                      >
                        <div>
                          <span style={{ color: "var(--color-text-muted)", display: "block" }}>Manufacturer</span>
                          <CopyableHash hash={unit.manufacturer} />
                        </div>
                        <div>
                          <span style={{ color: "var(--color-text-muted)", display: "block" }}>Current Owner</span>
                          <CopyableHash hash={unit.currentOwner} />
                        </div>
                        {unit.pendingReceiver && unit.pendingReceiver !== "0x0000000000000000000000000000000000000000" && (
                          <div>
                            <span style={{ color: "var(--color-text-muted)", display: "block" }}>Pending Receiver</span>
                            <CopyableHash hash={unit.pendingReceiver} />
                          </div>
                        )}
                        <div>
                          <span style={{ color: "var(--color-text-muted)", display: "block" }}>Packaging Level</span>
                          <strong style={{ color: "var(--color-text-main)" }}>{unitLevelToName(unit.level)}</strong>
                        </div>
                        <div>
                          <span style={{ color: "var(--color-text-muted)", display: "block" }}>Registration Date</span>
                          <strong style={{ color: "var(--color-text-main)" }}>{formatDate(unit.createdAt)}</strong>
                        </div>
                      </div>

                      {/* Action Bar */}
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => onOpenQr(unit)}
                          icon={<QrCode size={14} />}
                        >
                          Public QR Code
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onSelectUnitDetail(unit)}
                          icon={<FileText size={14} />}
                        >
                          Audit Details
                        </Button>
                      </div>

                      {/* Transfer History Log */}
                      {unitHistoryLogs.length > 0 && (
                        <div
                          style={{
                            backgroundColor: "var(--color-bg-surface)",
                            border: "1px solid var(--color-border-default)",
                            borderRadius: "var(--radius-control)",
                            padding: "var(--space-3)",
                          }}
                        >
                          <span
                            style={{
                              display: "block",
                              fontSize: "var(--text-xs)",
                              fontWeight: 700,
                              textTransform: "uppercase",
                              letterSpacing: "0.05em",
                              color: "var(--color-text-muted)",
                              marginBottom: "var(--space-2)",
                            }}
                          >
                            Custody History
                          </span>
                          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                            {unitHistoryLogs.map((log, idx) => {
                              const logUnit = units.find((u) => u.id === log.id);
                              const displayId = logUnit?.displayId || log.id;
                              const isReject = log.type === "TransferRejected";
                              const typeLabel = isReject
                                ? "Transfer Rejected"
                                : log.type === "TransferInitiated"
                                ? "Transfer Initiated"
                                : log.type === "TransferCompleted"
                                ? "Transfer Accepted"
                                : log.type === "UnitSold"
                                ? "Dispensed / Sold"
                                : log.type === "UnitCreated"
                                ? "Unit Created"
                                : log.type;

                              return (
                                <div
                                  key={`${log.id}-${log.txHash}-${idx}`}
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    fontSize: "var(--text-xs)",
                                    padding: "var(--space-1) 0",
                                    borderBottom: "1px dashed var(--color-border-subtle)",
                                  }}
                                >
                                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                                    <strong style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-muted)" }}>
                                      #{displayId}
                                    </strong>
                                    <span
                                      style={{
                                        color: isReject ? "var(--color-danger)" : "var(--color-text-main)",
                                        fontWeight: 600,
                                      }}
                                    >
                                      {typeLabel}
                                    </span>
                                  </div>
                                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", color: "var(--color-text-muted)", fontFamily: "var(--font-mono)" }}>
                                    {log.from && (
                                      <span>
                                        {log.from.slice(0, 6)}... {isReject ? "x" : "->"} {(log.rejectedBy || log.to || "").slice(0, 6)}...
                                      </span>
                                    )}
                                    {log.timestamp && (
                                      <span style={{ fontSize: "11px", color: "var(--color-text-subtle)" }}>
                                        {formatDate(log.timestamp)}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Partitions List */}
                      {partitions.length > 0 && (
                        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                          <span
                            style={{
                              fontSize: "var(--text-xs)",
                              fontWeight: 700,
                              textTransform: "uppercase",
                              letterSpacing: "0.05em",
                              color: "var(--color-primary)",
                            }}
                          >
                            Sub-Unit Partitions ({partitions.length})
                          </span>
                          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                            {partitions.map((part) => {
                              const stats = getPartitionBranchStats(part, units, account);
                              return (
                                <div
                                  key={part.id}
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    padding: "var(--space-2) var(--space-3)",
                                    border: "1px solid var(--color-border-subtle)",
                                    borderRadius: "var(--radius-control)",
                                    backgroundColor: "var(--color-bg-surface)",
                                    fontSize: "var(--text-xs)",
                                  }}
                                >
                                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                                    <strong style={{ fontFamily: "var(--font-mono)" }}>#{part.displayId}</strong>
                                    <span style={{ color: "var(--color-text-muted)", fontVariantNumeric: "tabular-nums" }}>
                                      Qty {stats.displayQty}
                                    </span>
                                  </div>
                                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                                    <StatusBadge
                                      variant={stats.variant}
                                      label={stats.statusText}
                                    />
                                    {stats.statusText === "Rejected" && part.currentOwner.toLowerCase() === lowerAccount && onReclaim && (
                                      <Button
                                        variant="primary"
                                        size="sm"
                                        onClick={() => void onReclaim(part.id)}
                                      >
                                        Reclaim
                                      </Button>
                                    )}
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => onSelectUnitDetail(part)}
                                    >
                                      View
                                    </Button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
