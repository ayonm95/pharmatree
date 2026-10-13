"use client";

import React, { useState, useMemo } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { ViewMode, UnitRecord } from "@/types/pharmatree";
import { useChainData } from "@/hooks/useChainData";
import { useWalletActions } from "@/hooks/useWalletActions";
import { useToast } from "@/hooks/useToast";
import { Sidebar } from "./Sidebar";
import { MobileNavDrawer } from "./MobileNavDrawer";
import { ToastContainer } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CopyableHash } from "@/components/ui/CopyableHash";
import { UnitDetailModal } from "./modals/UnitDetailModal";
import { QrCodeModal } from "./modals/QrCodeModal";
import { NotificationsModal } from "./modals/NotificationsModal";
import { formatAddress } from "@/lib/format";
import { Bell, Menu, Wallet, AlertTriangle, Plus } from "lucide-react";

const OverviewTab = dynamic(() => import("./tabs/OverviewTab").then((m) => m.OverviewTab));
const CreateTab = dynamic(() => import("./tabs/CreateTab").then((m) => m.CreateTab));
const AdminTab = dynamic(() => import("./tabs/AdminTab").then((m) => m.AdminTab));
const TransfersTab = dynamic(() => import("./tabs/TransfersTab").then((m) => m.TransfersTab));
const InventoryTab = dynamic(() => import("./tabs/InventoryTab").then((m) => m.InventoryTab));

export function PharmaWalletView({ mode }: { mode: ViewMode }) {
  const { account, contract, connected, role, isAdmin, units, history, loading: chainLoading, pendingApprovalCount, readonlyContract, connectWallet, loadWalletData } = useChainData();
  const { toasts, addToast, removeToast } = useToast();
  const actions = useWalletActions({
    contract, readonlyContract, account, role, isAdmin,
    refreshData: loadWalletData,
    notify: (msg, tone = "success") => addToast(msg, tone === "error" ? "error" : "success"),
  });

  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [modalUnit, setModalUnit] = useState<UnitRecord | null>(null);
  const [qrUnit, setQrUnit] = useState<UnitRecord | null>(null);
  const [notifOpen, setNotifOpen] = useState(false);

  const lowerAccount = account.toLowerCase();
  const pendingIncoming = useMemo(() => units.filter((u) => u.pendingReceiver.toLowerCase() === lowerAccount && u.status === 1), [lowerAccount, units]);
  const pendingTransferUnits = useMemo(() => units.filter((u) => u.status === 1 && (u.currentOwner.toLowerCase() === lowerAccount || u.pendingReceiver.toLowerCase() === lowerAccount)), [lowerAccount, units]);
  const availableStockUnits = useMemo(() => units.filter((u) => u.status === 0 && u.currentOwner.toLowerCase() === lowerAccount), [lowerAccount, units]);
  const canCreate = Boolean(account) && (role.manufacturer || isAdmin);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", backgroundColor: "var(--color-bg-page)" }}>
      <header style={{ height: "64px", borderBottom: "1px solid var(--color-border-default)", backgroundColor: "var(--color-bg-surface)", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 var(--space-4)", position: "sticky", top: 0, zIndex: "var(--z-sticky)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <button type="button" className="mobile-nav-toggle" onClick={() => setMobileNavOpen(true)} aria-label="Open menu" style={{ minWidth: "44px", minHeight: "44px", display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "1px solid var(--color-border-default)", borderRadius: "var(--radius-control)", cursor: "pointer", color: "var(--color-text-main)" }}>
            <Menu size={20} />
          </button>
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <div style={{ width: "32px", height: "32px", borderRadius: "var(--radius-control)", backgroundColor: "var(--color-primary)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }} aria-hidden="true">
              <Plus size={18} strokeWidth={3} />
            </div>
            <span style={{ fontSize: "var(--text-base)", fontWeight: 800, letterSpacing: "-0.02em", color: "var(--color-text-main)" }}>PHARMATREE</span>
          </Link>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <Button variant={connected ? "outline" : "primary"} size="sm" onClick={() => void connectWallet()} loading={chainLoading} icon={<Wallet size={16} />}>
            {connected ? formatAddress(account) : "Connect Wallet"}
          </Button>
          <button type="button" onClick={() => setNotifOpen(true)} aria-label={`Pending approvals: ${pendingIncoming.length}`} style={{ minWidth: "44px", minHeight: "44px", position: "relative", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "var(--radius-control)", border: "1px solid var(--color-border-default)", background: "var(--color-bg-surface)", cursor: "pointer", color: "var(--color-text-muted)" }}>
            <Bell size={18} />
            {pendingIncoming.length > 0 && <span style={{ position: "absolute", top: "6px", right: "6px", width: "18px", height: "18px", borderRadius: "var(--radius-pill)", backgroundColor: "var(--color-danger)", color: "#fff", fontSize: "11px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>{pendingIncoming.length}</span>}
          </button>
        </div>
      </header>

      <div style={{ display: "flex", flex: 1 }}>
        <Sidebar activeMode={mode} canCreateUnit={canCreate} />
        <MobileNavDrawer isOpen={mobileNavOpen} onClose={() => setMobileNavOpen(false)} activeMode={mode} canCreateUnit={canCreate} />

        <main id="main-content" style={{ flex: 1, padding: "var(--space-6) var(--space-4)", maxWidth: "1280px", margin: "0 auto", width: "100%", display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
          <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "var(--space-4)" }}>
            <Card padding="sm" style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", fontWeight: 600, textTransform: "uppercase" }}>Wallet Account</span>
              <strong style={{ fontSize: "var(--text-sm)", color: "var(--color-text-main)" }}>{connected ? <CopyableHash hash={account} /> : "Not Connected"}</strong>
            </Card>
            <Card padding="sm" style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", fontWeight: 600, textTransform: "uppercase" }}>Role Authorization</span>
              <strong style={{ fontSize: "var(--text-sm)", color: "var(--color-text-main)" }}>{role.manufacturer && role.handler ? "Manufacturer + Handler" : role.manufacturer ? "Manufacturer" : role.handler ? "Handler" : isAdmin ? "System Admin" : "Standard Account"}</strong>
            </Card>
            <Card padding="sm" style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)", cursor: "pointer" }} onClick={() => setNotifOpen(true)}>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", fontWeight: 600, textTransform: "uppercase" }}>Pending Inbound</span>
              <strong style={{ fontSize: "var(--text-lg)", color: pendingIncoming.length > 0 ? "var(--color-warning)" : "var(--color-text-main)", fontVariantNumeric: "tabular-nums" }}>{pendingApprovalCount} batches</strong>
            </Card>
          </section>

          {pendingIncoming.length > 0 && (
            <div style={{ padding: "var(--space-3) var(--space-4)", borderRadius: "var(--radius-control)", backgroundColor: "var(--color-warning-subtle)", border: "1px solid var(--color-warning-border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", color: "var(--color-warning)", fontSize: "var(--text-sm)" }}>
                <AlertTriangle size={18} />
                <strong>Action Required:</strong>
                <span>{pendingIncoming.length} transfer{pendingIncoming.length === 1 ? "" : "s"} awaiting your confirmation.</span>
              </div>
              <Button variant="secondary" size="sm" onClick={() => setNotifOpen(true)}>Review Batches</Button>
            </div>
          )}

          {mode === "overview" && <OverviewTab account={account} units={units} role={role} isAdmin={isAdmin} canCreateUnit={canCreate} />}
          {mode === "create" && <CreateTab account={account} role={role} isAdmin={isAdmin} loading={actions.loading} onCreateMedicine={actions.createMedicine} onConnectWallet={connectWallet} />}
          {mode === "admin" && <AdminTab account={account} role={role} isAdmin={isAdmin} loading={actions.loading} onAssignRole={actions.assignRole} onConnectWallet={connectWallet} />}
          {mode === "transfers" && <TransfersTab account={account} role={role} availableStockUnits={availableStockUnits} pendingTransferUnits={pendingTransferUnits} history={history} units={units} loading={actions.loading} onInitiateTransfer={actions.initiateTransfer} onMarkAsSold={actions.markAsSold} onAcceptTransfer={actions.acceptTransfer} onRejectTransfer={actions.rejectTransfer} onSelectUnitDetail={setModalUnit} />}
          {mode === "inventory" && <InventoryTab account={account} units={units} history={history} role={role} isAdmin={isAdmin} onOpenQr={setQrUnit} onSelectUnitDetail={setModalUnit} />}
        </main>
      </div>

      <UnitDetailModal isOpen={Boolean(modalUnit)} onClose={() => setModalUnit(null)} unit={modalUnit} account={account} role={role} loading={actions.loading} onAccept={actions.acceptTransfer} onReject={actions.rejectTransfer} onReclaim={actions.reclaimUnit} onOpenQr={setQrUnit} />
      <QrCodeModal isOpen={Boolean(qrUnit)} onClose={() => setQrUnit(null)} unit={qrUnit} />
      <NotificationsModal isOpen={notifOpen} onClose={() => setNotifOpen(false)} pendingIncoming={pendingIncoming} loading={actions.loading} onAcceptTransfer={actions.acceptTransfer} onRejectTransfer={actions.rejectTransfer} onSelectUnitDetail={setModalUnit} />
      <ToastContainer toasts={toasts} onClose={removeToast} />
    </div>
  );
}
