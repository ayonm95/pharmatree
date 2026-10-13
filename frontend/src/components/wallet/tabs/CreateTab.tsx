"use client";

import React, { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PackagePlus, ShieldAlert, Sparkles, Wallet } from "lucide-react";

interface CreateTabProps {
  account: string;
  role: { manufacturer: boolean; handler: boolean };
  isAdmin: boolean;
  loading: boolean;
  onCreateMedicine: (name: string, quantity: string) => Promise<void>;
  onConnectWallet: () => void;
}

const SAMPLE_MEDICINES = [
  { name: "Paracetamol", quantity: "100" },
  { name: "Amoxicillin", quantity: "50" },
  { name: "Ibuprofen", quantity: "75" },
  { name: "Vitamin D", quantity: "120" },
];

export function CreateTab({
  account,
  role,
  isAdmin,
  loading,
  onCreateMedicine,
  onConnectWallet,
}: CreateTabProps) {
  const [name, setName] = useState("Paracetamol");
  const [quantity, setQuantity] = useState("100");

  const canCreate = Boolean(account) && (role.manufacturer || isAdmin);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canCreate || loading) return;
    void onCreateMedicine(name, quantity);
  };

  if (!account) {
    return (
      <Card padding="lg">
        <EmptyState
          icon={<Wallet size={28} />}
          title="Wallet Not Connected"
          description="Connect your Web3 wallet to register new medicine units on-chain."
          actionLabel="Connect Wallet"
          onAction={onConnectWallet}
        />
      </Card>
    );
  }

  if (!canCreate) {
    return (
      <Card padding="lg">
        <EmptyState
          icon={<ShieldAlert size={28} />}
          title="Access Restricted"
          description="Only verified Manufacturer or Admin wallets are authorized to mint and register root medicine batches."
        />
      </Card>
    );
  }

  return (
    <div style={{ maxWidth: "720px", display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <Card padding="lg">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginBottom: "var(--space-6)" }}>
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
            <PackagePlus size={22} />
          </div>
          <div>
            <h2 style={{ margin: 0, fontSize: "var(--text-lg)", fontWeight: 700, color: "var(--color-text-main)" }}>
              Create Medicine Batch
            </h2>
            <p style={{ margin: "2px 0 0 0", fontSize: "var(--text-sm)", color: "var(--color-text-muted)" }}>
              Register a genuine pharmaceutical root unit directly onto the Sepolia blockchain
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: "var(--space-4)",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
              <label
                htmlFor="med-name"
                style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--color-text-main)", textTransform: "uppercase", letterSpacing: "0.05em" }}
              >
                Medicine Name
              </label>
              <input
                id="med-name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Paracetamol 500mg"
                style={{
                  height: "44px",
                  padding: "0 var(--space-3)",
                  borderRadius: "var(--radius-control)",
                  border: "1px solid var(--color-border-default)",
                  backgroundColor: "var(--color-bg-surface)",
                  fontSize: "var(--text-sm)",
                  color: "var(--color-text-main)",
                }}
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
              <label
                htmlFor="med-quantity"
                style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--color-text-main)", textTransform: "uppercase", letterSpacing: "0.05em" }}
              >
                Quantity (Tablets / Units)
              </label>
              <input
                id="med-quantity"
                type="number"
                min="1"
                step="1"
                required
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="100"
                style={{
                  height: "44px",
                  padding: "0 var(--space-3)",
                  borderRadius: "var(--radius-control)",
                  border: "1px solid var(--color-border-default)",
                  backgroundColor: "var(--color-bg-surface)",
                  fontSize: "var(--text-sm)",
                  color: "var(--color-text-main)",
                  fontVariantNumeric: "tabular-nums",
                }}
              />
            </div>
          </div>

          {/* Quick presets */}
          <div>
            <span style={{ display: "block", fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--color-text-muted)", marginBottom: "var(--space-2)" }}>
              Suggested Presets
            </span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
              {SAMPLE_MEDICINES.map((item) => (
                <button
                  key={item.name}
                  type="button"
                  onClick={() => {
                    setName(item.name);
                    setQuantity(item.quantity);
                  }}
                  style={{
                    minHeight: "36px",
                    padding: "var(--space-1) var(--space-3)",
                    borderRadius: "var(--radius-control)",
                    border: "1px solid var(--color-border-default)",
                    backgroundColor: "var(--color-bg-subtle)",
                    color: "var(--color-text-main)",
                    fontSize: "var(--text-xs)",
                    fontWeight: 500,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "var(--space-1)",
                    transition: "all var(--transition-fast)",
                  }}
                >
                  <Sparkles size={13} style={{ color: "var(--color-primary)" }} />
                  <span>{item.name}</span>
                  <span style={{ color: "var(--color-text-muted)", fontVariantNumeric: "tabular-nums" }}>· {item.quantity} units</span>
                </button>
              ))}
            </div>
          </div>

          <div style={{ paddingTop: "var(--space-2)" }}>
            <Button
              type="submit"
              variant="primary"
              size="md"
              loading={loading}
              disabled={loading || !name.trim() || !quantity.trim()}
              icon={<PackagePlus size={18} />}
            >
              {loading ? "Registering Batch..." : "Register Medicine Unit"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
