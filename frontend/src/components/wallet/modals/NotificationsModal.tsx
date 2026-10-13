"use client";

import React from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { CopyableHash } from "@/components/ui/CopyableHash";
import { UnitRecord } from "@/types/pharmatree";
import { Bell, CheckCircle, XCircle } from "lucide-react";

interface NotificationsModalProps {
  isOpen: boolean;
  onClose: () => void;
  pendingIncoming: UnitRecord[];
  loading: boolean;
  onAcceptTransfer: (unitId: string) => Promise<void>;
  onRejectTransfer: (unitId: string) => Promise<void>;
  onSelectUnitDetail: (unit: UnitRecord) => void;
}

export function NotificationsModal({
  isOpen,
  onClose,
  pendingIncoming,
  loading,
  onAcceptTransfer,
  onRejectTransfer,
  onSelectUnitDetail,
}: NotificationsModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Custody Transfer Notifications"
      subtitle={`${pendingIncoming.length} action${pendingIncoming.length === 1 ? "" : "s"} required`}
      maxWidth="520px"
    >
      {pendingIncoming.length === 0 ? (
        <EmptyState
          icon={<Bell size={28} />}
          title="All Caught Up"
          description="You have no pending incoming custody transfers waiting for your verification or approval."
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          {pendingIncoming.map((unit) => {
            const medName = (unit.metadata || "").split(",")[0]?.trim() || "Medicine";

            return (
              <div
                key={unit.id}
                style={{
                  border: "1px solid var(--color-warning-border)",
                  borderRadius: "var(--radius-control)",
                  padding: "var(--space-3)",
                  backgroundColor: "var(--color-warning-subtle)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-2)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <strong style={{ fontSize: "var(--text-sm)", color: "var(--color-text-main)" }}>
                      {medName}
                    </strong>
                    <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
                      Unit #{unit.displayId} · {unit.quantity} tablets
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      onClose();
                      onSelectUnitDetail(unit);
                    }}
                  >
                    Details
                  </Button>
                </div>

                <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
                  From: <CopyableHash hash={unit.currentOwner} />
                </div>

                <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-1)" }}>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={loading}
                    onClick={() => void onAcceptTransfer(unit.id)}
                    icon={<CheckCircle size={14} />}
                  >
                    Accept Custody
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    loading={loading}
                    onClick={() => void onRejectTransfer(unit.id)}
                    icon={<XCircle size={14} />}
                  >
                    Reject
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
