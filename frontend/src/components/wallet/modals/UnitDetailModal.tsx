"use client";

import React from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { CopyableHash } from "@/components/ui/CopyableHash";
import { UnitRecord } from "@/types/pharmatree";
import { unitLevelToName } from "@/lib/pharmaTree";
import { formatDate } from "@/lib/format";
import { QrCode, CheckCircle, XCircle, RotateCcw } from "lucide-react";

interface UnitDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  unit: UnitRecord | null;
  account: string;
  role: { manufacturer: boolean; handler: boolean };
  loading?: boolean;
  onAccept?: (unitId: string) => Promise<void>;
  onReject?: (unitId: string) => Promise<void>;
  onReclaim?: (unitId: string) => Promise<void>;
  onOpenQr?: (unit: UnitRecord) => void;
}

export function UnitDetailModal({
  isOpen,
  onClose,
  unit,
  account,
  role,
  loading = false,
  onAccept,
  onReject,
  onReclaim,
  onOpenQr,
}: UnitDetailModalProps) {
  if (!unit) return null;

  const medicineName = (unit.metadata || "").split(",")[0]?.trim() || "Medicine";
  const lowerAccount = account.toLowerCase();
  const isPendingReceiver =
    unit.status === 1 &&
    unit.pendingReceiver &&
    unit.pendingReceiver.toLowerCase() === lowerAccount;
  const isOwner = unit.currentOwner.toLowerCase() === lowerAccount;
  const isRejected = unit.status === 3;
  const canAct = Boolean(account) && (role.manufacturer || role.handler);

  const rowStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "var(--space-2) 0",
    borderBottom: "1px solid var(--color-border-subtle)",
    fontSize: "var(--text-sm)",
  };

  const labelStyle: React.CSSProperties = {
    color: "var(--color-text-muted)",
    fontWeight: 500,
  };

  const valueStyle: React.CSSProperties = {
    color: "var(--color-text-main)",
    fontWeight: 600,
    textAlign: "right",
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={medicineName}
      subtitle={`Unit #${unit.displayId}`}
      maxWidth="520px"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        {/* Status Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "var(--space-3)",
            backgroundColor: "var(--color-bg-subtle)",
            borderRadius: "var(--radius-control)",
          }}
        >
          <span style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--color-text-muted)" }}>
            Current State
          </span>
          <StatusBadge status={unit.status} />
        </div>

        {/* Details List */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={rowStyle}>
            <span style={labelStyle}>Unit ID</span>
            <span style={valueStyle}>#{unit.id} (Display: #{unit.displayId})</span>
          </div>

          <div style={rowStyle}>
            <span style={labelStyle}>Packaging Level</span>
            <span style={valueStyle}>{unitLevelToName(unit.level)}</span>
          </div>

          <div style={rowStyle}>
            <span style={labelStyle}>Quantity</span>
            <span style={{ ...valueStyle, fontVariantNumeric: "tabular-nums" }}>
              {unit.quantity} units
            </span>
          </div>

          <div style={rowStyle}>
            <span style={labelStyle}>Manufacturer</span>
            <CopyableHash hash={unit.manufacturer} />
          </div>

          <div style={rowStyle}>
            <span style={labelStyle}>Current Owner</span>
            <CopyableHash hash={unit.currentOwner} />
          </div>

          {unit.pendingReceiver && unit.pendingReceiver !== "0x0000000000000000000000000000000000000000" && (
            <div style={rowStyle}>
              <span style={labelStyle}>Pending Receiver</span>
              <CopyableHash hash={unit.pendingReceiver} />
            </div>
          )}

          {isRejected && unit.rejectedBy && (
            <div style={rowStyle}>
              <span style={{ ...labelStyle, color: "var(--color-danger)" }}>Rejected By</span>
              <CopyableHash hash={unit.rejectedBy} />
            </div>
          )}

          <div style={rowStyle}>
            <span style={labelStyle}>Hierarchy (Parent / Root)</span>
            <span style={valueStyle}>
              {unit.parentId === "0" ? "Root Batch" : `Parent #${unit.parentId} / Root #${unit.rootId}`}
            </span>
          </div>

          <div style={rowStyle}>
            <span style={labelStyle}>Registration Date</span>
            <span style={valueStyle}>{formatDate(unit.createdAt)}</span>
          </div>

          {unit.acceptedAt ? (
            <div style={rowStyle}>
              <span style={labelStyle}>Accepted Date</span>
              <span style={valueStyle}>{formatDate(unit.acceptedAt)}</span>
            </div>
          ) : null}

          {isRejected && unit.rejectedAt ? (
            <div style={rowStyle}>
              <span style={{ ...labelStyle, color: "var(--color-danger)" }}>Rejected Date</span>
              <span style={valueStyle}>{formatDate(unit.rejectedAt)}</span>
            </div>
          ) : null}
        </div>

        {/* Action Buttons */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
          {isPendingReceiver && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-2)" }}>
              <Button
                variant="primary"
                onClick={() => onAccept && onAccept(unit.id)}
                loading={loading}
                disabled={!canAct}
                icon={<CheckCircle size={16} />}
              >
                Accept Transfer
              </Button>
              <Button
                variant="danger"
                onClick={() => onReject && onReject(unit.id)}
                loading={loading}
                disabled={!canAct}
                icon={<XCircle size={16} />}
              >
                Reject Transfer
              </Button>
            </div>
          )}

          {isOwner && isRejected && onReclaim && (
            <Button
              variant="outline"
              onClick={() => onReclaim(unit.id)}
              loading={loading}
              icon={<RotateCcw size={16} />}
            >
              Reclaim Rejected Unit
            </Button>
          )}

          {onOpenQr && (
            <Button
              variant="secondary"
              onClick={() => {
                onClose();
                onOpenQr(unit);
              }}
              icon={<QrCode size={16} />}
            >
              View Verification QR Code
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
