"use client";

import React from "react";
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
  const visibleHistory = history.filter((entry) => entry.txHash && entry.type !== "CurrentState");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
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

              let badgeText = entry.type;
              let badgeStatus = 0;
              if (isRejection) {
                badgeText = isRejecter ? "Rejected by You" : "Transfer Rejected";
                badgeStatus = 3;
              } else if (entry.type === "TransferInitiated") {
                badgeText = isInitiator ? "Transfer Sent" : "Transfer Received";
                badgeStatus = 1;
              } else if (entry.type === "TransferCompleted") {
                badgeText = "Transfer Accepted";
                badgeStatus = 0;
              } else if (entry.type === "UnitSold") {
                badgeText = "Dispensed / Sold";
                badgeStatus = 2;
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
                    <StatusBadge status={badgeStatus} label={badgeText} />
                  </div>

                  <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", display: "flex", flexDirection: "column", gap: "2px" }}>
                    <div><strong>Unit:</strong> #{unit?.displayId || entry.id}</div>
                    {(entry.quantity || unit?.quantity) && (
                      <div><strong>Quantity:</strong> {entry.quantity || unit?.quantity} units</div>
                    )}
                    <div><strong>Date:</strong> {formatDate(entry.timestamp)}</div>
                    <div><strong>From:</strong> <CopyableHash hash={entry.from} /></div>
                    {isRejection ? (
                      <div><strong style={{ color: "var(--color-danger)" }}>Rejected By:</strong> <CopyableHash hash={rejecterAddr} /></div>
                    ) : (
                      <div><strong>To:</strong> <CopyableHash hash={entry.to} /></div>
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
