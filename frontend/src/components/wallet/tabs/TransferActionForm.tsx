"use client";

import React, { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { UnitRecord } from "@/types/pharmatree";
import { ArrowLeftRight, ShoppingCart, AlertCircle } from "lucide-react";
import { ethers } from "ethers";

interface TransferActionFormProps {
  availableStockUnits: UnitRecord[];
  canTransact: boolean;
  loading: boolean;
  onInitiateTransfer: (unitId: string, receiver: string, quantity: number) => Promise<void>;
  onMarkAsSold: (unitId: string, quantity: number) => Promise<void>;
}

export function TransferActionForm({
  availableStockUnits,
  canTransact,
  loading,
  onInitiateTransfer,
  onMarkAsSold,
}: TransferActionFormProps) {
  const [selectedUnitId, setSelectedUnitId] = useState<string>(
    availableStockUnits[0]?.id || ""
  );
  const [receiver, setReceiver] = useState("");
  const [quantity, setQuantity] = useState("1");

  const selectedUnit = availableStockUnits.find((u) => u.id === selectedUnitId);

  const handleInitiate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canTransact || loading || !selectedUnitId) return;
    const qtyNum = Number(quantity);
    if (!Number.isInteger(qtyNum) || qtyNum <= 0) return;
    if (!ethers.isAddress(receiver.trim())) return;
    void onInitiateTransfer(selectedUnitId, receiver.trim(), qtyNum);
  };

  const handleSell = () => {
    if (!canTransact || loading || !selectedUnitId) return;
    const qtyNum = Number(quantity);
    if (!Number.isInteger(qtyNum) || qtyNum <= 0) return;
    void onMarkAsSold(selectedUnitId, qtyNum);
  };

  return (
    <Card padding="lg">
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
          <ArrowLeftRight size={20} />
        </div>
        <div>
          <h2 style={{ margin: 0, fontSize: "var(--text-lg)", fontWeight: 700, color: "var(--color-text-main)" }}>
            Transfer Custody or Dispense
          </h2>
          <p style={{ margin: "2px 0 0 0", fontSize: "var(--text-sm)", color: "var(--color-text-muted)" }}>
            Transfer batch custody to another verified handler, or record a patient sale
          </p>
        </div>
      </div>

      {availableStockUnits.length === 0 ? (
        <EmptyState
          icon={<AlertCircle size={28} />}
          title="No Active Inventory in Stock"
          description={
            canTransact
              ? "Your account has transfer permissions, but you currently hold 0 active stock units in custody. Receive a batch transfer or create a unit first."
              : "You do not have active inventory or authorization to initiate transfers."
          }
        />
      ) : (
        <form onSubmit={handleInitiate} style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: "var(--space-4)",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
              <label
                htmlFor="unit-select"
                style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--color-text-main)", textTransform: "uppercase", letterSpacing: "0.05em" }}
              >
                Source Stock Unit
              </label>
              <select
                id="unit-select"
                value={selectedUnitId}
                onChange={(e) => {
                  setSelectedUnitId(e.target.value);
                  const found = availableStockUnits.find((u) => u.id === e.target.value);
                  if (found) setQuantity(found.quantity);
                }}
                style={{
                  height: "44px",
                  padding: "0 var(--space-3)",
                  borderRadius: "var(--radius-control)",
                  border: "1px solid var(--color-border-default)",
                  backgroundColor: "var(--color-bg-surface)",
                  fontSize: "var(--text-sm)",
                  color: "var(--color-text-main)",
                }}
              >
                {availableStockUnits.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    Unit #{unit.displayId} · {(unit.metadata || "").split(",")[0] || "Medicine"} ({unit.quantity} available)
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
              <label
                htmlFor="transfer-receiver"
                style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--color-text-main)", textTransform: "uppercase", letterSpacing: "0.05em" }}
              >
                Receiver Address (For Transfers)
              </label>
              <input
                id="transfer-receiver"
                type="text"
                value={receiver}
                onChange={(e) => setReceiver(e.target.value)}
                placeholder="0x..."
                style={{
                  height: "44px",
                  padding: "0 var(--space-3)",
                  borderRadius: "var(--radius-control)",
                  border: "1px solid var(--color-border-default)",
                  backgroundColor: "var(--color-bg-surface)",
                  fontSize: "var(--text-sm)",
                  fontFamily: "var(--font-mono)",
                  color: "var(--color-text-main)",
                }}
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
              <label
                htmlFor="transfer-quantity"
                style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--color-text-main)", textTransform: "uppercase", letterSpacing: "0.05em" }}
              >
                Quantity (Max: {selectedUnit?.quantity || "0"})
              </label>
              <input
                id="transfer-quantity"
                type="number"
                min="1"
                max={selectedUnit ? Number(selectedUnit.quantity) : undefined}
                step="1"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                style={{
                  height: "44px",
                  padding: "0 var(--space-3)",
                  borderRadius: "var(--radius-control)",
                  border: "1px solid var(--color-border-default)",
                  backgroundColor: "var(--color-bg-surface)",
                  fontSize: "var(--text-sm)",
                  fontVariantNumeric: "tabular-nums",
                  color: "var(--color-text-main)",
                }}
              />
            </div>
          </div>

          <div>
            <span style={{ display: "block", fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--color-text-muted)", marginBottom: "var(--space-2)" }}>
              Quick Select Available Stock
            </span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
              {availableStockUnits.slice(0, 6).map((unit) => {
                const isSelected = unit.id === selectedUnitId;
                const medName = (unit.metadata || "").split(",")[0]?.trim() || "Unit";
                return (
                  <button
                    key={unit.id}
                    type="button"
                    onClick={() => {
                      setSelectedUnitId(unit.id);
                      setQuantity(unit.quantity);
                    }}
                    style={{
                      minHeight: "44px",
                      padding: "0 var(--space-3)",
                      borderRadius: "var(--radius-control)",
                      border: isSelected ? "2px solid var(--color-primary)" : "1px solid var(--color-border-default)",
                      backgroundColor: isSelected ? "var(--color-primary-subtle)" : "var(--color-bg-subtle)",
                      color: isSelected ? "var(--color-primary)" : "var(--color-text-main)",
                      fontSize: "var(--text-xs)",
                      fontWeight: 600,
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "var(--space-2)",
                      transition: "all var(--transition-fast)",
                    }}
                  >
                    <span>{medName}</span>
                    <span style={{ color: "var(--color-text-muted)", fontVariantNumeric: "tabular-nums" }}>
                      #{unit.displayId} ({unit.quantity} units)
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)", paddingTop: "var(--space-2)" }}>
            <Button
              type="submit"
              variant="primary"
              size="md"
              loading={loading}
              disabled={loading || !canTransact || !receiver.trim() || !ethers.isAddress(receiver.trim())}
              icon={<ArrowLeftRight size={18} />}
            >
              Initiate Transfer
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="md"
              loading={loading}
              disabled={loading || !canTransact}
              onClick={handleSell}
              icon={<ShoppingCart size={18} />}
            >
              Mark as Sold / Dispense
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
