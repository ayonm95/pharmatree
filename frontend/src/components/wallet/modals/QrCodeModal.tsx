"use client";

import React from "react";
import { Modal } from "@/components/ui/Modal";
import { QrCard } from "@/components/ui/QrCard";
import { UnitRecord } from "@/types/pharmatree";

interface QrCodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  unit: UnitRecord | null;
}

export function QrCodeModal({ isOpen, onClose, unit }: QrCodeModalProps) {
  if (!unit) return null;

  const medicineName = (unit.metadata || "").split(",")[0]?.trim() || "Medicine";

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Public Verification QR"
      maxWidth="440px"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        <QrCard
          unitId={unit.id}
          displayId={unit.displayId}
          medicineName={medicineName}
          quantity={unit.quantity}
        />
      </div>
    </Modal>
  );
}
