"use client";

import React, { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ShieldCheck, ShieldAlert, UserCheck, Wallet } from "lucide-react";
import { ethers } from "ethers";

interface AdminTabProps {
  account: string;
  role: { manufacturer: boolean; handler: boolean };
  isAdmin: boolean;
  loading: boolean;
  onAssignRole: (target: string, type: "manufacturer" | "handler") => Promise<void>;
  onConnectWallet: () => void;
}

export function AdminTab({
  account,
  role,
  isAdmin,
  loading,
  onAssignRole,
  onConnectWallet,
}: AdminTabProps) {
  const [roleTarget, setRoleTarget] = useState("");
  const [roleType, setRoleType] = useState<"manufacturer" | "handler">("manufacturer");

  const canManage = Boolean(account) && isAdmin;
  const canAddManufacturer = isAdmin;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManage || loading) return;
    const cleanTarget = roleTarget.trim();
    if (!ethers.isAddress(cleanTarget)) return;
    void onAssignRole(cleanTarget, roleType);
  };

  if (!account) {
    return (
      <Card padding="lg">
        <EmptyState
          icon={<Wallet size={28} />}
          title="Wallet Not Connected"
          description="Connect an authorized Admin wallet to manage system roles."
          actionLabel="Connect Wallet"
          onAction={onConnectWallet}
        />
      </Card>
    );
  }

  if (!canManage) {
    const roleLabel = role.manufacturer && role.handler ? "Manufacturer & Handler" : role.manufacturer ? "Manufacturer" : role.handler ? "Handler" : "Standard Account";
    return (
      <Card padding="lg">
        <EmptyState
          icon={<ShieldAlert size={28} />}
          title="Administrator Privileges Required"
          description={`Your connected wallet is recognized as a ${roleLabel}. In accordance with smart-contract access control, only the System Administrator (DEFAULT_ADMIN_ROLE) can grant or assign roles to other accounts.`}
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
            <ShieldCheck size={22} />
          </div>
          <div>
            <h2 style={{ margin: 0, fontSize: "var(--text-lg)", fontWeight: 700, color: "var(--color-text-main)" }}>
              Access & Role Management
            </h2>
            <p style={{ margin: "2px 0 0 0", fontSize: "var(--text-sm)", color: "var(--color-text-muted)" }}>
              Authorize certified pharmaceutical manufacturers and supply-chain handlers
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
            <label
              htmlFor="target-address"
              style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--color-text-main)", textTransform: "uppercase", letterSpacing: "0.05em" }}
            >
              Target Wallet Address
            </label>
            <input
              id="target-address"
              type="text"
              required
              value={roleTarget}
              onChange={(e) => setRoleTarget(e.target.value)}
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
            {roleTarget && !ethers.isAddress(roleTarget.trim()) && (
              <span style={{ fontSize: "var(--text-xs)", color: "var(--color-danger)" }}>
                Please enter a valid Ethereum address.
              </span>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
            <label
              htmlFor="role-select"
              style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--color-text-main)", textTransform: "uppercase", letterSpacing: "0.05em" }}
            >
              Role Designation
            </label>
            <select
              id="role-select"
              value={roleType}
              onChange={(e) => setRoleType(e.target.value as "manufacturer" | "handler")}
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
              <option value="manufacturer" disabled={!canAddManufacturer}>
                Manufacturer {!canAddManufacturer ? "(Admin only)" : ""}
              </option>
              <option value="handler">Handler (Distributor / Pharmacy / Wholesaler)</option>
            </select>
          </div>

          <div style={{ paddingTop: "var(--space-2)" }}>
            <Button
              type="submit"
              variant="primary"
              size="md"
              loading={loading}
              disabled={loading || !roleTarget.trim() || !ethers.isAddress(roleTarget.trim())}
              icon={<UserCheck size={18} />}
            >
              {loading ? "Granting Role..." : `Grant ${roleType === "manufacturer" ? "Manufacturer" : "Handler"} Role`}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
