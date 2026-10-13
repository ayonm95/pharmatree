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
import { Package, ChevronDown, ChevronRight, QrCode, FileText } from "lucide-react";

interface InventoryTabProps {
  account: string;
  units: UnitRecord[];
  history: HistoryEntry[];
  role?: { manufacturer: boolean; handler: boolean };
  isAdmin?: boolean;
  onOpenQr: (unit: UnitRecord) => void;
  onSelectUnitDetail: (unit: UnitRecord) => void;
}

export function InventoryTab({
  account,
  units,
  history,
  onOpenQr,
  onSelectUnitDetail,
}: InventoryTabProps) {
  const [expandedUnits, setExpandedUnits] = useState<Record<string, boolean>>({});

  const lowerAccount = account.toLowerCase();

  const inventoryGroups = useMemo(() => {
    const relevant = units.filter(
      (unit) =>
        unit.manufacturer.toLowerCase() === lowerAccount ||
        unit.currentOwner.toLowerCase() === lowerAccount ||
        (unit.status === 1 && unit.pendingReceiver.toLowerCase() === lowerAccount)
    );
    const manufacturerTree = relevant.some((unit) => unit.manufacturer.toLowerCase() === lowerAccount);
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
        const isMfrTree = root?.manufacturer.toLowerCase() === lowerAccount;
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
  }, [lowerAccount, units]);

  const toggleExpand = (key: string) => {
    setExpandedUnits((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const getMedicineName = (metadata?: string) => {
    if (!metadata) return "Medicine";
    return metadata.split(",")[0]?.trim() || metadata;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
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
            description="Your connected wallet currently has no active or past medicine custody records."
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            {inventoryGroups.map(({ root: unit, partitions }) => {
              const isExpanded = !!expandedUnits[`inv-${unit.id}`];
              const medName = getMedicineName(unit.metadata);
              const isMfr = unit.manufacturer.toLowerCase() === lowerAccount;
              const lineage = [unit, ...partitions];
              const totalQuantity = lineage.reduce((sum, c) => sum + Number(c.quantity), 0);
              const currentQuantity = lineage
                .filter((c) => (c.status === 0 || c.status === 3) && c.currentOwner.toLowerCase() === lowerAccount)
                .reduce((sum, c) => sum + Number(c.quantity), 0);
              const isPartial = isMfr && currentQuantity > 0 && currentQuantity < totalQuantity;
              const unitHistoryLogs = history.filter((h) => h.id === unit.id);

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
                          {isMfr ? `${currentQuantity}/${totalQuantity} in stock` : `Qty ${unit.quantity} tablets`}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                      <StatusBadge
                        status={unit.status}
                        label={isPartial ? "Partially transferred" : undefined}
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
                            {unitHistoryLogs.map((log, idx) => (
                              <div
                                key={idx}
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  fontSize: "var(--text-xs)",
                                  fontFamily: "var(--font-mono)",
                                }}
                              >
                                <span style={{ color: log.type === "TransferRejected" ? "var(--color-danger)" : "var(--color-text-main)", fontWeight: 600 }}>
                                  {log.type === "TransferRejected" ? "Transfer Rejected" : log.type}
                                </span>
                                <span style={{ color: "var(--color-text-muted)" }}>
                                  {log.from ? `${log.from.slice(0, 6)}...` : ""} {"->"} {log.to ? `${log.to.slice(0, 6)}...` : ""}
                                </span>
                              </div>
                            ))}
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
                            {partitions.map((part) => (
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
                                    Qty {part.quantity}
                                  </span>
                                </div>
                                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                                  <StatusBadge status={part.status} />
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => onSelectUnitDetail(part)}
                                  >
                                    View
                                  </Button>
                                </div>
                              </div>
                            ))}
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
