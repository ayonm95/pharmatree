"use client";

import React, { useMemo } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { CopyableHash } from "@/components/ui/CopyableHash";
import { UnitRecord, HistoryEntry } from "@/types/pharmatree";
import { formatDate } from "@/lib/format";
import { CheckCircle, XCircle, Clock, History } from "lucide-react";
import { TransferActionForm } from "./TransferActionForm";

interface TransfersTabProps {
  account: string;
  role: { manufacturer: boolean; handler: boolean };
  isAdmin?: boolean;
  availableStockUnits: UnitRecord[];
  pendingTransferUnits: UnitRecord[];
  history: HistoryEntry[];
  units: UnitRecord[];
  loading: boolean;
  onInitiateTransfer: (unitId: string, receiver: string, quantity: number) => Promise<void>;
  onMarkAsSold: (unitId: string, quantity: number) => Promise<void>;
  onAcceptTransfer: (unitId: string) => Promise<void>;
  onRejectTransfer: (unitId: string) => Promise<void>;
  onSelectUnitDetail: (unit: UnitRecord) => void;
}

export function TransfersTab({
  account,
  role,
  isAdmin = false,
  availableStockUnits,
  pendingTransferUnits,
  history,
  units,
  loading,
  onInitiateTransfer,
  onMarkAsSold,
  onAcceptTransfer,
  onRejectTransfer,
  onSelectUnitDetail,
}: TransfersTabProps) {
  const lowerAccount = account.toLowerCase();
  const canTransact = Boolean(account) && (role.manufacturer || role.handler);

  const visibleHistory = useMemo(() => {
    // Collect all units that reached a resolved transfer state
    const resolvedUnits = new Set<string>();
    for (const entry of history) {
      if (entry.type === "TransferCompleted" || entry.type === "TransferRejected" || entry.type === "UnitSold") {
        resolvedUnits.add(entry.id);
      }
    }

    return history.filter((entry) => {
      if (!entry.txHash || entry.type === "CurrentState" || entry.type === "UnitCreated") return false;

      // Omit preliminary TransferInitiated events if the transfer was already accepted, rejected, or sold
      if (entry.type === "TransferInitiated" && resolvedUnits.has(entry.id)) {
        return false;
      }

      // System admin can inspect all activity
      if (isAdmin) return true;

      const fromAddr = entry.from?.toLowerCase();
      const toAddr = entry.to?.toLowerCase();
      const rejectAddr = entry.rejectedBy?.toLowerCase();

      // Check direct involvement
      const isDirectlyInvolved =
        fromAddr === lowerAccount ||
        toAddr === lowerAccount ||
        rejectAddr === lowerAccount;

      if (isDirectlyInvolved) return true;

      // Manufacturer can inspect activity for their manufactured batches
      if (role.manufacturer) {
        const unit = units.find((u) => u.id === entry.id);
        if (unit && unit.manufacturer.toLowerCase() === lowerAccount) {
          return true;
        }
      }

      return false;
    });
  }, [history, isAdmin, lowerAccount, role.manufacturer, units]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }} className="fade-in">
      {/* 1. Pending Transfer Actions */}
      {pendingTransferUnits.length > 0 && (
        <Card padding="md">
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
            <Clock size={18} style={{ color: "var(--color-warning)" }} />
            <h2 style={{ margin: 0, fontSize: "var(--text-base)", fontWeight: 700, color: "var(--color-text-main)" }}>
              Pending Transfer Approvals ({pendingTransferUnits.length})
            </h2>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
              gap: "var(--space-4)",
            }}
          >
            {pendingTransferUnits.map((unit) => {
              const medName = (unit.metadata || "").split(",")[0]?.trim() || "Medicine";
              const isIncoming = unit.pendingReceiver.toLowerCase() === lowerAccount;

              return (
                <div
                  key={unit.id}
                  style={{
                    border: isIncoming ? "1px solid var(--color-warning-border)" : "1px solid var(--color-border-default)",
                    borderRadius: "var(--radius-control)",
                    padding: "var(--space-4)",
                    backgroundColor: isIncoming ? "var(--color-warning-subtle)" : "var(--color-bg-surface)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--space-3)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div>
                      <strong style={{ fontSize: "var(--text-base)", color: "var(--color-text-main)" }}>{medName}</strong>
                      <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
                        Unit #{unit.displayId} · {unit.quantity} tablets
                      </div>
                    </div>
                    <StatusBadge status={unit.status} />
                  </div>

                  <div style={{ fontSize: "var(--text-xs)", display: "flex", flexDirection: "column", gap: "4px" }}>
                    <div><strong>From:</strong> <CopyableHash hash={unit.currentOwner} /></div>
                    <div><strong>To:</strong> <CopyableHash hash={unit.pendingReceiver} /></div>
                    <div><strong>Initiated:</strong> {formatDate(unit.initiatedAt)}</div>
                  </div>

                  <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-1)" }}>
                    {isIncoming ? (
                      <>
                        <Button
                          variant="primary"
                          size="sm"
                          loading={loading}
                          disabled={!canTransact}
                          onClick={() => void onAcceptTransfer(unit.id)}
                          icon={<CheckCircle size={14} />}
                        >
                          Accept
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          loading={loading}
                          disabled={!canTransact}
                          onClick={() => void onRejectTransfer(unit.id)}
                          icon={<XCircle size={14} />}
                        >
                          Reject
                        </Button>
                      </>
                    ) : (
                      <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", fontStyle: "italic" }}>
                        Waiting for recipient to accept
                      </span>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onSelectUnitDetail(unit)}
                      style={{ marginLeft: "auto" }}
                    >
                      Details
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* 2. Transfer and Dispensing Form */}
      <TransferActionForm
        availableStockUnits={availableStockUnits}
        canTransact={canTransact}
        loading={loading}
        onInitiateTransfer={onInitiateTransfer}
        onMarkAsSold={onMarkAsSold}
      />

      {/* 3. Chain Activity History */}
      <Card padding="md">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
          <History size={18} style={{ color: "var(--color-primary)" }} />
          <h2 style={{ margin: 0, fontSize: "var(--text-base)", fontWeight: 700, color: "var(--color-text-main)" }}>
            Custody Audit Trail & Activity
          </h2>
        </div>

        {visibleHistory.length === 0 ? (
          <EmptyState
            icon={<History size={24} />}
            title="No Activity Logged"
            description="No recent custody transfers or events recorded for this account."
          />
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
              gap: "var(--space-3)",
            }}
          >
            {visibleHistory.map((entry) => {
              const unit = units.find((u) => u.id === entry.id);
              const medName = unit ? (unit.metadata || "").split(",")[0] : `Unit ${entry.id}`;
              const isRejection = entry.type === "TransferRejected";
              const isInitiator = Boolean(entry.from && entry.from.toLowerCase() === lowerAccount);
              const rejecterAddr = entry.rejectedBy || entry.to;
              const isRejecter = Boolean(rejecterAddr && rejecterAddr.toLowerCase() === lowerAccount);
              const isReceiver = Boolean(entry.to && entry.to.toLowerCase() === lowerAccount);

              let badgeText = entry.type;
              let badgeStatus: number | undefined = undefined;
              let badgeVariant: "success" | "warning" | "danger" | "info" | "neutral" | undefined = undefined;

              if (isRejection) {
                badgeText = isRejecter ? "Rejected by You" : "Transfer Rejected";
                badgeStatus = 3;
                badgeVariant = "danger";
              } else if (entry.type === "TransferInitiated") {
                if (unit?.status === 1) {
                  badgeText = isInitiator ? "Transfer Sent" : "Inbound Pending";
                  badgeStatus = 1;
                  badgeVariant = "warning";
                } else if (unit?.status === 3) {
                  badgeText = isInitiator ? "Transfer Attempt (Rejected)" : isRejecter ? "Offer Rejected by You" : "Transfer Rejected";
                  badgeStatus = 3;
                  badgeVariant = "danger";
                } else {
                  badgeText = isInitiator ? "Transfer Initiated" : "Offer Received";
                  badgeVariant = "neutral";
                }
              } else if (entry.type === "TransferCompleted") {
                badgeText = isReceiver ? "Transfer Accepted" : "Transfer Delivered";
                badgeStatus = 0;
                badgeVariant = "success";
              } else if (entry.type === "UnitSold") {
                badgeText = "Dispensed / Sold";
                badgeStatus = 2;
                badgeVariant = "info";
              } else if (entry.type === "TransferCancelled") {
                badgeText = "Transfer Cancelled";
                badgeVariant = "neutral";
              } else if (entry.type === "UnitReclaimed") {
                badgeText = "Unit Reclaimed";
                badgeVariant = "warning";
              }

              return (
                <div
                  key={`${entry.id}-${entry.txHash}-${entry.timestamp}`}
                  onClick={() => unit && onSelectUnitDetail(unit)}
                  style={{
                    border: "1px solid var(--color-border-default)",
                    borderRadius: "var(--radius-control)",
                    padding: "var(--space-3)",
                    backgroundColor: "var(--color-bg-surface)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--space-2)",
                    cursor: unit ? "pointer" : "default",
                    transition: "border-color var(--transition-fast)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <strong style={{ fontSize: "var(--text-sm)", color: "var(--color-text-main)" }}>
                      {medName}
                    </strong>
                    <StatusBadge status={badgeStatus} label={badgeText} variant={badgeVariant} />
                  </div>

                  <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", display: "flex", flexDirection: "column", gap: "2px" }}>
                    <div><strong>Unit:</strong> #{unit?.displayId || entry.id}</div>
                    {(entry.quantity || unit?.quantity) && (
                      <div><strong>Quantity:</strong> {entry.quantity || unit?.quantity} tablets</div>
                    )}
                    <div><strong>Date:</strong> {formatDate(entry.timestamp)}</div>
                    {entry.from && <div><strong>From:</strong> <CopyableHash hash={entry.from} /></div>}
                    {isRejection ? (
                      <div><strong style={{ color: "var(--color-danger)" }}>Rejected By:</strong> <CopyableHash hash={rejecterAddr} /></div>
                    ) : entry.to ? (
                      <div><strong>To:</strong> <CopyableHash hash={entry.to} /></div>
                    ) : null}
                    {entry.txHash && entry.txHash.startsWith("0x") && (
                      <div><strong>Tx:</strong> <CopyableHash hash={entry.txHash} /></div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
