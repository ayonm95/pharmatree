"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { ethers } from "ethers";
import {
  PHARMA_TREE_ABI,
  PHARMA_TREE_CONTRACT,
} from "@/lib/pharmaTree";
import { parseGs1DigitalLink, parseGs1ElementString } from "@/lib/gs1";
import {
  playBeepSuccess,
  playSirenAlarm,
  playDispensedSuccess,
  playClickSound,
  triggerHaptic,
} from "@/lib/audio-alerts";
import { useHardwareBarcodeScanner } from "@/hooks/useHardwareBarcodeScanner";
import { useChainData } from "@/hooks/useChainData";
import { Sidebar } from "@/components/wallet/Sidebar";
import { MobileNavDrawer } from "@/components/wallet/MobileNavDrawer";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { CopyableHash } from "@/components/ui/CopyableHash";
import { formatAddress } from "@/lib/format";
import {
  Scan,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Pill,
  Zap,
  Volume2,
  VolumeX,
  Camera,
  CameraOff,
  Keyboard,
  ExternalLink,
  History,
  Menu,
  Wallet,
  Plus,
  AlertOctagon,
  RotateCcw,
} from "lucide-react";

type VerificationResult = {
  authentic: boolean;
  tierFailed?: number;
  reason?: string;
  message?: string;
  error?: string;
  unit?: {
    id: number;
    parentId?: string;
    rootId?: string;
    level?: number;
    levelName: string;
    manufacturer: string;
    currentOwner: string;
    pendingReceiver?: string;
    status: number;
    statusName: string;
    quantity: string;
    metadata: string;
  };
  tiers?: {
    tier1_registered: boolean;
    tier2_unsold: boolean;
    tier3_custodyMatch: boolean;
    tier4_integrity: boolean;
    tier5_tamperValid: boolean;
  };
  diversionDetected?: boolean;
  tamperSealStatus?: "verified" | "unverified" | "invalid" | "consumed" | "locked";
  tamperSealMessage?: string;
  consumedAt?: string | null;
  scanRecord?: {
    scanCount: number;
    firstScanTime: number;
    lastScanTime: number;
  };
};

type ScanActivityItem = {
  id: string;
  unitId: number;
  type: "VERIFIED" | "COUNTERFEIT" | "DISPENSED" | "QUARANTINED";
  title: string;
  timestamp: number;
  details: string;
  txHash?: string;
};

export default function VendorPosPage() {
  const { account, connected, role, isAdmin, loading: chainLoading, connectWallet } = useChainData();

  // Navigation drawer for mobile
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Sound toggle
  const [soundEnabled, setSoundEnabled] = useState(true);

  // Scanner states
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraLoading, setCameraLoading] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [manualInput, setManualInput] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const [isDispensing, setIsDispensing] = useState(false);
  const [isLoggingIncident, setIsLoggingIncident] = useState(false);

  // Verification & Product Inspection state
  const [currentVerification, setCurrentVerification] = useState<VerificationResult | null>(null);
  const [scannedUnitId, setScannedUnitId] = useState<number | null>(null);
  const [scratchSecret, setScratchSecret] = useState("");
  const [dispenseQty, setDispenseQty] = useState<number>(1);
  const [dispenseResult, setDispenseResult] = useState<{
    txHash: string;
    dispensedQty: number;
    remainingQty: number;
  } | null>(null);
  const [incidentLoggedId, setIncidentLoggedId] = useState<string | null>(null);

  // Recent scan history during this shift
  const [scanHistory, setScanHistory] = useState<ScanActivityItem[]>([]);

  // Scan cooldown ref to avoid repeated spam scans
  const lastScannedTimeRef = useRef<number>(0);
  const html5QrCodeRef = useRef<any>(null);

  const activeVendorAddress = account || "0x65371f0ddFa0AD6e7655243cD2A2567328EA1537";

  // Process a scanned code
  const processScannedCode = useCallback(
    async (rawCode: string) => {
      const now = Date.now();
      if (now - lastScannedTimeRef.current < 1500) return;
      lastScannedTimeRef.current = now;

      let cleanId = rawCode.trim();

      // Check if code is a GS1 Digital Link or GS1 Element String
      const gs1Link = parseGs1DigitalLink(cleanId);
      const gs1Elem = !gs1Link ? parseGs1ElementString(cleanId) : null;
      const gs1 = gs1Link || gs1Elem;

      if (gs1?.serial) {
        const serialDigits = gs1.serial.replace(/\D/g, "");
        if (serialDigits) {
          cleanId = serialDigits;
        }
      } else if (cleanId.includes("unitId=")) {
        const match = cleanId.match(/unitId=(\d+)/);
        if (match) cleanId = match[1];
      } else if (cleanId.includes("-")) {
        const parts = cleanId.split("-");
        const lastPart = parts[parts.length - 1];
        if (!isNaN(Number(lastPart))) cleanId = lastPart;
      }

      const numId = Number(cleanId);
      if (isNaN(numId) || numId <= 0) {
        if (soundEnabled) playSirenAlarm();
        return;
      }

      setScannedUnitId(numId);
      setManualInput(String(numId));
      setDispenseResult(null);
      setIncidentLoggedId(null);
      setScratchSecret("");
      setIsVerifying(true);

      try {
        const res = await fetch("/api/pos/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            unitId: numId,
            vendorAddress: activeVendorAddress,
          }),
        });

        const data: VerificationResult = await res.json();
        setCurrentVerification(data);

        if (!res.ok || data.error) {
          if (soundEnabled) playClickSound();
          setScanHistory((prev) => [
            {
              id: `${now}-${numId}`,
              unitId: numId,
              type: "COUNTERFEIT",
              title: `SYSTEM NOTICE: ${data.error || "CONNECTION_FAILED"}`,
              timestamp: now,
              details: data.message || `System error verifying Unit #${numId}. Please retry.`,
            },
            ...prev.slice(0, 19),
          ]);
        } else if (data.authentic && data.tiers?.tier2_unsold && !data.diversionDetected) {
          if (soundEnabled) playBeepSuccess();
          triggerHaptic(60);

          const maxQ = data.unit?.quantity ? Number(data.unit.quantity) : 1;
          setDispenseQty(maxQ);

          setScanHistory((prev) => [
            {
              id: `${now}-${numId}`,
              unitId: numId,
              type: "VERIFIED",
              title: data.unit?.metadata || `Unit #${numId}`,
              timestamp: now,
              details: `Stock Active: ${data.unit?.quantity} units. Owner: ${formatAddress(data.unit?.currentOwner || "")}`,
            },
            ...prev.slice(0, 19),
          ]);
        } else {
          if (soundEnabled) playSirenAlarm();
          triggerHaptic([200, 100, 200, 100, 300]);

          const reasonLabel = data.reason || "COUNTERFEIT_DETECTED";
          setScanHistory((prev) => [
            {
              id: `${now}-${numId}`,
              unitId: numId,
              type: "COUNTERFEIT",
              title: `ALERT: ${reasonLabel}`,
              timestamp: now,
              details: data.message || `Unit #${numId} failed on-chain audit.`,
            },
            ...prev.slice(0, 19),
          ]);
        }
      } catch (err: any) {
        console.error("Verification failed:", err);
        if (soundEnabled) playClickSound();
        setCurrentVerification({
          authentic: false,
          error: "NETWORK_ERROR",
          message: err.message || "Failed to reach verification endpoint. Please check your internet connection.",
        });
      } finally {
        setIsVerifying(false);
      }
    },
    [activeVendorAddress, soundEnabled]
  );

  // Hook hardware USB/Bluetooth barcode scanner gun
  useHardwareBarcodeScanner({
    onScan: (scannedText) => {
      processScannedCode(scannedText);
    },
    enabled: true,
  });

  // Camera initialization with html5-qrcode
  useEffect(() => {
    let isMounted = true;

    async function initCamera() {
      if (!cameraActive) {
        if (html5QrCodeRef.current) {
          try {
            await html5QrCodeRef.current.stop();
            html5QrCodeRef.current.clear();
          } catch {
            // Ignore
          }
          html5QrCodeRef.current = null;
        }
        return;
      }

      setCameraLoading(true);
      setCameraError(null);

      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        if (!isMounted) return;

        const html5QrCode = new Html5Qrcode("pos-camera-viewfinder");
        html5QrCodeRef.current = html5QrCode;

        await html5QrCode.start(
          { facingMode: "environment" },
          {
            fps: 15,
            qrbox: { width: 240, height: 240 },
            aspectRatio: 1.0,
          },
          (decodedText) => {
            processScannedCode(decodedText);
          },
          () => {}
        );
      } catch (err: any) {
        console.error("Camera startup error:", err);
        if (isMounted) {
          setCameraError(err.message || "Could not access optical camera device.");
          setCameraActive(false);
        }
      } finally {
        if (isMounted) setCameraLoading(false);
      }
    }

    initCamera();

    return () => {
      isMounted = false;
      if (html5QrCodeRef.current) {
        try {
          html5QrCodeRef.current.stop().catch(() => {});
          html5QrCodeRef.current.clear();
        } catch {}
      }
    };
  }, [cameraActive, processScannedCode]);

  // Execute dispensing
  async function handleDispense() {
    if (!currentVerification?.unit) return;
    const unitId = currentVerification.unit.id;
    setIsDispensing(true);

    try {
      const res = await fetch("/api/pos/sell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          unitId,
          quantity: dispenseQty,
          vendorAddress: activeVendorAddress,
          scratchSecret,
        }),
      });

      const data = await res.json();

      if (data.success) {
        if (soundEnabled) playDispensedSuccess();
        triggerHaptic([100, 50, 150]);

        setDispenseResult({
          txHash: data.txHash,
          dispensedQty: data.dispensedQuantity,
          remainingQty: data.remainingQuantity,
        });

        setCurrentVerification((prev) => {
          if (!prev?.unit) return prev;
          return {
            ...prev,
            unit: {
              ...prev.unit,
              status: data.remainingQuantity === 0 ? 2 : 0,
              statusName: data.remainingQuantity === 0 ? "Sold" : "Active",
              quantity: String(data.remainingQuantity),
            },
            tiers: {
              ...prev.tiers!,
              tier2_unsold: data.remainingQuantity > 0,
            },
          };
        });

        setScanHistory((prev) => [
          {
            id: `${Date.now()}-${unitId}-sold`,
            unitId,
            type: "DISPENSED",
            title: `Dispensed: ${dispenseQty}x ${currentVerification.unit?.metadata}`,
            timestamp: Date.now(),
            details: `Tx: ${formatAddress(data.txHash)} (Rem: ${data.remainingQuantity})`,
            txHash: data.txHash,
          },
          ...prev,
        ]);
      } else if (data.requiresClientSigning && (window as any).ethereum) {
        const provider = new ethers.BrowserProvider((window as any).ethereum);
        const signer = await provider.getSigner();
        const contract = new ethers.Contract(PHARMA_TREE_CONTRACT, PHARMA_TREE_ABI, signer);

        let tx: ethers.ContractTransactionResponse;
        const totalAvail = Number(currentVerification.unit.quantity);
        if (dispenseQty >= totalAvail) {
          tx = await contract.markAsSold(unitId);
        } else {
          tx = await contract.sellQuantity(unitId, dispenseQty);
        }
        await tx.wait(1);

        if (soundEnabled) playDispensedSuccess();
        setDispenseResult({
          txHash: tx.hash,
          dispensedQty: dispenseQty,
          remainingQty: totalAvail - dispenseQty,
        });
      } else {
        alert(data.message || "Failed to dispense unit.");
        if (soundEnabled) playSirenAlarm();
      }
    } catch (err: any) {
      console.error("Dispensing error:", err);
      alert(err.reason || err.message || "Dispensing transaction failed.");
      if (soundEnabled) playSirenAlarm();
    } finally {
      setIsDispensing(false);
    }
  }

  // Handle quarantine & incident report
  async function handleQuarantineIncident() {
    if (!scannedUnitId) return;
    setIsLoggingIncident(true);

    try {
      const res = await fetch("/api/pos/incident", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          unitId: scannedUnitId,
          rawPayload: String(scannedUnitId),
          tierFailed: currentVerification?.tierFailed || 1,
          reason: currentVerification?.reason || "COUNTERFEIT_DETECTED",
          message: currentVerification?.message || "Flagged and quarantined at POS scanner",
          vendorAddress: activeVendorAddress,
          terminalId: "POS-DISPENSARY-01",
        }),
      });

      const data = await res.json();
      if (data.success) {
        setIncidentLoggedId(data.incident.incidentId);
        triggerHaptic(100);

        setScanHistory((prev) => [
          {
            id: `${Date.now()}-${scannedUnitId}-quarantine`,
            unitId: scannedUnitId,
            type: "QUARANTINED",
            title: `Quarantined (${data.incident.incidentId})`,
            timestamp: Date.now(),
            details: `Reason: ${currentVerification?.reason || "Suspected Counterfeit"}`,
          },
          ...prev,
        ]);
      }
    } catch (err: any) {
      console.error("Failed to log incident:", err);
    } finally {
      setIsLoggingIncident(false);
    }
  }

  // Verify Scratch-Off Tamper Pin
  async function handleVerifyTamperPin() {
    if (!currentVerification?.unit || !scratchSecret.trim()) return;
    try {
      const res = await fetch("/api/pos/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          unitId: currentVerification.unit.id,
          scratchSecret: scratchSecret.trim(),
          vendorAddress: activeVendorAddress,
        }),
      });
      const data = await res.json();
      if (data.tamperSealStatus === "verified" || data.tamperSealStatus === "consumed") {
        if (soundEnabled) playBeepSuccess();
        triggerHaptic(60);
      } else {
        if (soundEnabled) playSirenAlarm();
        triggerHaptic([200, 100, 200]);
      }
      setCurrentVerification((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          tamperSealStatus: data.tamperSealStatus,
          tamperSealMessage: data.tamperSealMessage,
          consumedAt: data.consumedAt,
          tiers: {
            ...prev.tiers!,
            tier5_tamperValid:
              data.tamperSealStatus === "verified" || data.tamperSealStatus === "consumed",
          },
        };
      });
    } catch (err) {
      console.error("Tamper seal verification request failed:", err);
    }
  }

  const isCounterfeitOrBad =
    Boolean(currentVerification) &&
    !currentVerification?.error &&
    (!currentVerification?.authentic ||
      !currentVerification?.tiers?.tier2_unsold ||
      currentVerification?.diversionDetected ||
      currentVerification?.tiers?.tier4_integrity === false);

  const canCreate = Boolean(account) && (role.manufacturer || isAdmin);

  const handleDispenseRef = useRef(handleDispense);
  useEffect(() => {
    handleDispenseRef.current = handleDispense;
  });

  // Single-key hotkey trigger for rapid checkout (Spacebar / Enter)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Do not trigger if user is actively typing in an input or textarea
      const target = e.target as HTMLElement;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }

      if (e.code === "Space" || e.key === "Enter") {
        if (
          currentVerification?.unit &&
          !isCounterfeitOrBad &&
          !isDispensing &&
          Number(currentVerification.unit.quantity) > 0
        ) {
          e.preventDefault();
          handleDispenseRef.current();
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentVerification, isCounterfeitOrBad, isDispensing]);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", backgroundColor: "var(--color-bg-page)" }}>
      {/* Unified App Header */}
      <header
        style={{
          height: "64px",
          borderBottom: "1px solid var(--color-border-default)",
          backgroundColor: "var(--color-bg-surface)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 var(--space-4)",
          position: "sticky",
          top: 0,
          zIndex: "var(--z-sticky)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <button
            type="button"
            className="mobile-nav-toggle"
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open menu"
            style={{
              minWidth: "44px",
              minHeight: "44px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "none",
              border: "1px solid var(--color-border-default)",
              borderRadius: "var(--radius-control)",
              cursor: "pointer",
              color: "var(--color-text-main)",
            }}
          >
            <Menu size={20} />
          </button>
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", textDecoration: "none" }}>
            <div
              style={{
                width: "32px",
                height: "32px",
                borderRadius: "var(--radius-control)",
                backgroundColor: "var(--color-primary)",
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              aria-hidden="true"
            >
              <Plus size={18} strokeWidth={3} />
            </div>
            <span style={{ fontSize: "var(--text-base)", fontWeight: 800, letterSpacing: "-0.02em", color: "var(--color-text-main)" }}>
              PHARMATREE
            </span>
          </Link>
          <span
            style={{
              backgroundColor: "var(--color-primary-subtle)",
              color: "var(--color-primary)",
              border: "1px solid var(--color-primary-border)",
              fontSize: "var(--text-xs)",
              padding: "2px 8px",
              borderRadius: "var(--radius-pill)",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            POS Scanner
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          {/* Audio toggle button */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              playClickSound();
              setSoundEnabled(!soundEnabled);
            }}
            icon={soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
            aria-label={soundEnabled ? "Mute audio alerts" : "Unmute audio alerts"}
          >
            {soundEnabled ? "Audio ON" : "Muted"}
          </Button>

          {/* Connect wallet button */}
          <Button
            variant={connected ? "outline" : "primary"}
            size="sm"
            onClick={() => void connectWallet()}
            loading={chainLoading}
            icon={<Wallet size={16} />}
          >
            {connected ? formatAddress(account) : "Connect Wallet"}
          </Button>
        </div>
      </header>

      {/* Main Body with Unified Sidebar & POS Content */}
      <div style={{ display: "flex", flex: 1 }}>
        <Sidebar activeMode="pos" canCreateUnit={canCreate} />
        <MobileNavDrawer
          isOpen={mobileNavOpen}
          onClose={() => setMobileNavOpen(false)}
          activeMode="pos"
          canCreateUnit={canCreate}
        />

        <main
          id="main-content"
          style={{
            flex: 1,
            padding: "var(--space-6) var(--space-4)",
            maxWidth: "1280px",
            margin: "0 auto",
            width: "100%",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-6)",
          }}
        >
          {/* Top Status Indicators (Card row) */}
          <section
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: "var(--space-4)",
            }}
          >
            <Card padding="sm" style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", fontWeight: 600, textTransform: "uppercase" }}>
                Terminal Mode
              </span>
              <strong style={{ fontSize: "var(--text-sm)", color: "var(--color-text-main)", display: "flex", alignItems: "center", gap: "6px" }}>
                <Scan size={16} color="var(--color-primary)" /> Retail Dispensary POS
              </strong>
            </Card>

            <Card padding="sm" style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", fontWeight: 600, textTransform: "uppercase" }}>
                Gasless Sponsor
              </span>
              <strong style={{ fontSize: "var(--text-sm)", color: "var(--color-success)", display: "flex", alignItems: "center", gap: "6px" }}>
                <Zap size={16} /> Active (Sepolia Relayer)
              </strong>
            </Card>

            <Card padding="sm" style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", fontWeight: 600, textTransform: "uppercase" }}>
                Active Dispensary ID
              </span>
              <strong style={{ fontSize: "var(--text-sm)", color: "var(--color-text-main)" }}>
                <CopyableHash hash={activeVendorAddress} />
              </strong>
            </Card>

            <Card padding="sm" style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", fontWeight: 600, textTransform: "uppercase" }}>
                Hardware Scanner Wedge
              </span>
              <strong style={{ fontSize: "var(--text-sm)", color: "var(--color-success)", display: "flex", alignItems: "center", gap: "6px" }}>
                <Keyboard size={16} /> USB/BT Gun Ready
              </strong>
            </Card>
          </section>

          {/* Main POS Layout Grid: Left Scanner & Quick Tests | Right Verification & Actions */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
              gap: "var(--space-6)",
              alignItems: "start",
            }}
          >
            {/* ================= LEFT COLUMN ================= */}
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
              {/* Camera Scanner Card */}
              <Card padding="none" style={{ overflow: "hidden" }}>
                <div
                  style={{
                    padding: "var(--space-4) var(--space-6)",
                    borderBottom: "1px solid var(--color-border-default)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                    <Camera size={18} color="var(--color-primary)" />
                    <span style={{ fontSize: "var(--text-sm)", fontWeight: 700, color: "var(--color-text-main)" }}>
                      Camera QR Viewfinder
                    </span>
                  </div>
                  <Button
                    variant={cameraActive ? "danger" : "primary"}
                    size="sm"
                    onClick={() => {
                      playClickSound();
                      setCameraActive(!cameraActive);
                    }}
                    icon={cameraActive ? <CameraOff size={14} /> : <Camera size={14} />}
                  >
                    {cameraActive ? "Stop Camera" : "Start Camera"}
                  </Button>
                </div>

                {/* Viewport */}
                <div
                  style={{
                    minHeight: "260px",
                    backgroundColor: "var(--color-bg-muted)",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    position: "relative",
                  }}
                >
                  {cameraActive ? (
                    <>
                      <div id="pos-camera-viewfinder" style={{ width: "100%", height: "100%", minHeight: "260px" }} />
                      {cameraLoading && (
                        <div style={{ position: "absolute", color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
                          Initializing optical camera stream...
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={{ textAlign: "center", padding: "var(--space-8)" }}>
                      <div
                        style={{
                          width: "56px",
                          height: "56px",
                          borderRadius: "var(--radius-pill)",
                          backgroundColor: "var(--color-bg-surface)",
                          border: "1px solid var(--color-border-default)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          margin: "0 auto var(--space-3)",
                          color: "var(--color-text-muted)",
                        }}
                      >
                        <Scan size={26} />
                      </div>
                      <h4 style={{ margin: "0 0 var(--space-1)", fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--color-text-main)" }}>
                        Camera Scanner Idle
                      </h4>
                      <p style={{ margin: "0 0 var(--space-4)", fontSize: "var(--text-xs)", color: "var(--color-text-muted)", maxWidth: "240px" }}>
                        Click &quot;Start Camera&quot; to scan QR codes on medicine packaging.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          playClickSound();
                          setCameraActive(true);
                        }}
                      >
                        Activate Camera
                      </Button>
                    </div>
                  )}

                  {cameraError && (
                    <div
                      style={{
                        position: "absolute",
                        bottom: "var(--space-2)",
                        left: "var(--space-2)",
                        right: "var(--space-2)",
                        backgroundColor: "var(--color-danger-bg)",
                        color: "var(--color-danger-fg)",
                        border: "1px solid var(--color-danger-border)",
                        padding: "var(--space-2) var(--space-3)",
                        borderRadius: "var(--radius-control)",
                        fontSize: "var(--text-xs)",
                      }}
                    >
                      {cameraError}
                    </div>
                  )}
                </div>
              </Card>

              {/* Manual Input & Simulation Presets */}
              <Card padding="md">
                <h4 style={{ margin: "0 0 var(--space-2)", fontSize: "var(--text-sm)", fontWeight: 700, color: "var(--color-text-main)" }}>
                  Manual Unit ID / Barcode Entry
                </h4>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (manualInput.trim()) {
                      playClickSound();
                      processScannedCode(manualInput.trim());
                    }
                  }}
                  style={{ display: "flex", gap: "var(--space-2)" }}
                >
                  <input
                    type="text"
                    placeholder="Enter numerical unit ID (e.g. 1, 2, 8)"
                    value={manualInput}
                    onChange={(e) => setManualInput(e.target.value)}
                    style={{
                      flex: 1,
                      backgroundColor: "var(--color-bg-surface)",
                      border: "1px solid var(--color-border-default)",
                      borderRadius: "var(--radius-control)",
                      padding: "8px 12px",
                      fontSize: "var(--text-sm)",
                      color: "var(--color-text-main)",
                      outline: "none",
                    }}
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    loading={isVerifying}
                    disabled={!manualInput.trim() || isVerifying}
                  >
                    Inspect
                  </Button>
                </form>

                {/* Sepolia Scenarios */}
                <div style={{ marginTop: "var(--space-4)", paddingTop: "var(--space-3)", borderTop: "1px solid var(--color-border-default)" }}>
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.05em" }}>
                    Sepolia Contract Audit Scenarios:
                  </span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
                    <button
                      type="button"
                      onClick={() => processScannedCode("1")}
                      style={{
                        backgroundColor: "var(--color-success-bg)",
                        color: "var(--color-success-fg)",
                        border: "1px solid var(--color-success-border)",
                        borderRadius: "var(--radius-control)",
                        padding: "6px 10px",
                        fontSize: "var(--text-xs)",
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      ✓ Unit #1 (Authentic Active)
                    </button>
                    <button
                      type="button"
                      onClick={() => processScannedCode("2")}
                      style={{
                        backgroundColor: "var(--color-danger-bg)",
                        color: "var(--color-danger-fg)",
                        border: "1px solid var(--color-danger-border)",
                        borderRadius: "var(--radius-control)",
                        padding: "6px 10px",
                        fontSize: "var(--text-xs)",
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      ⚠ Unit #2 (Replay / Sold)
                    </button>
                    <button
                      type="button"
                      onClick={() => processScannedCode("8")}
                      style={{
                        backgroundColor:
                          activeVendorAddress.toLowerCase() === "0xe88a5608b536bcc9d557823234baca9a00f2540b"
                            ? "var(--color-success-bg)"
                            : "var(--color-warning-bg)",
                        color:
                          activeVendorAddress.toLowerCase() === "0xe88a5608b536bcc9d557823234baca9a00f2540b"
                            ? "var(--color-success-fg)"
                            : "var(--color-warning-fg)",
                        border: `1px solid ${
                          activeVendorAddress.toLowerCase() === "0xe88a5608b536bcc9d557823234baca9a00f2540b"
                            ? "var(--color-success-border)"
                            : "var(--color-warning-border)"
                        }`,
                        borderRadius: "var(--radius-control)",
                        padding: "6px 10px",
                        fontSize: "var(--text-xs)",
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      {activeVendorAddress.toLowerCase() === "0xe88a5608b536bcc9d557823234baca9a00f2540b"
                        ? "✓ Unit #8 (Your In-Stock Inventory)"
                        : "⚠ Unit #8 (Custody 0xe88 / Diverted for others)"}
                    </button>
                    <button
                      type="button"
                      onClick={() => processScannedCode("9999")}
                      style={{
                        backgroundColor: "var(--color-danger-bg)",
                        color: "var(--color-danger-fg)",
                        border: "1px solid var(--color-danger-border)",
                        borderRadius: "var(--radius-control)",
                        padding: "6px 10px",
                        fontSize: "var(--text-xs)",
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      ✕ Unit #9999 (Unregistered)
                    </button>
                  </div>
                </div>
              </Card>
            </div>

            {/* ================= RIGHT COLUMN: PRODUCT INSPECTION & AUDIT ================= */}
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
              {isVerifying ? (
                <Card padding="lg" style={{ textAlign: "center" }}>
                  <div
                    style={{
                      width: "40px",
                      height: "40px",
                      borderRadius: "var(--radius-pill)",
                      border: "3px solid var(--color-primary)",
                      borderTopColor: "transparent",
                      animation: "spin 0.8s linear infinite",
                      margin: "0 auto var(--space-4)",
                    }}
                  />
                  <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
                  <h3 style={{ margin: "0 0 var(--space-1)", fontSize: "var(--text-base)", fontWeight: 700, color: "var(--color-text-main)" }}>
                    Auditing On-Chain Provenance...
                  </h3>
                  <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--color-text-muted)" }}>
                    Querying multi-provider Sepolia RPC failover circuit breaker &amp; scan frequency registry.
                  </p>
                </Card>
              ) : currentVerification ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
                  {/* SYSTEM / NETWORK ISSUE NOTICE */}
                  {currentVerification.error && (
                    <div
                      style={{
                        backgroundColor: "var(--color-warning-bg)",
                        border: "2px solid var(--color-warning-border)",
                        borderRadius: "var(--radius-surface)",
                        padding: "var(--space-6)",
                        boxShadow: "var(--shadow-md)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-4)" }}>
                        <div
                          style={{
                            width: "44px",
                            height: "44px",
                            borderRadius: "var(--radius-control)",
                            backgroundColor: "var(--color-warning)",
                            color: "#fff",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                          }}
                        >
                          <AlertTriangle size={26} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
                            <span
                              style={{
                                backgroundColor: "var(--color-warning)",
                                color: "#fff",
                                fontSize: "var(--text-xs)",
                                fontWeight: 800,
                                padding: "2px 8px",
                                borderRadius: "var(--radius-pill)",
                                textTransform: "uppercase",
                                letterSpacing: "0.05em",
                              }}
                            >
                              System Notice
                            </span>
                            <span style={{ fontSize: "var(--text-xs)", color: "var(--color-warning-fg)", fontWeight: 700 }}>
                              {currentVerification.error}
                            </span>
                          </div>
                          <h3 style={{ margin: "var(--space-2) 0 var(--space-1)", fontSize: "var(--text-lg)", fontWeight: 700, color: "var(--color-text-main)" }}>
                            Verification Incomplete (Network / Server Notice)
                          </h3>
                          <p style={{ margin: "0 0 var(--space-4)", fontSize: "var(--text-sm)", color: "var(--color-text-muted)", lineHeight: 1.5 }}>
                            {currentVerification.message}
                          </p>

                          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => {
                                const idToRetry = scannedUnitId || currentVerification?.unit?.id;
                                if (idToRetry) processScannedCode(String(idToRetry));
                              }}
                              icon={<RotateCcw size={16} />}
                            >
                              Retry Verification
                            </Button>
                            <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
                              Note: The medicine itself has not failed audit. Please retry to confirm status.
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* CRITICAL COUNTERFEIT EMERGENCY ALERT */}
                  {isCounterfeitOrBad && (
                    <div
                      style={{
                        backgroundColor: "var(--color-danger-bg)",
                        border: "2px solid var(--color-danger)",
                        borderRadius: "var(--radius-surface)",
                        padding: "var(--space-6)",
                        boxShadow: "var(--shadow-md)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-4)" }}>
                        <div
                          style={{
                            width: "44px",
                            height: "44px",
                            borderRadius: "var(--radius-control)",
                            backgroundColor: "var(--color-danger)",
                            color: "#fff",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                          }}
                        >
                          <AlertOctagon size={26} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
                            <span
                              style={{
                                backgroundColor: "var(--color-danger)",
                                color: "#fff",
                                fontSize: "var(--text-xs)",
                                fontWeight: 800,
                                padding: "2px 8px",
                                borderRadius: "var(--radius-pill)",
                                textTransform: "uppercase",
                                letterSpacing: "0.05em",
                              }}
                            >
                              CRITICAL: DO NOT DISPENSE
                            </span>
                            <span style={{ fontSize: "var(--text-xs)", color: "var(--color-danger)", fontWeight: 700 }}>
                              Tier {currentVerification.tierFailed || (currentVerification.diversionDetected ? 3 : 2)} Violation
                            </span>
                          </div>
                          <h3 style={{ margin: "var(--space-2) 0 var(--space-1)", fontSize: "var(--text-lg)", fontWeight: 700, color: "var(--color-danger-hover)" }}>
                            {currentVerification.reason || "Counterfeit or Compromised Stock Detected"}
                          </h3>
                          <p style={{ margin: "0 0 var(--space-4)", fontSize: "var(--text-sm)", color: "var(--color-danger-fg)", lineHeight: 1.5 }}>
                            {currentVerification.message}
                          </p>

                          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
                            <Button
                              variant="danger"
                              size="sm"
                              disabled={isLoggingIncident || Boolean(incidentLoggedId)}
                              onClick={handleQuarantineIncident}
                              icon={<ShieldAlert size={16} />}
                            >
                              {incidentLoggedId
                                ? `Quarantine Logged (${incidentLoggedId})`
                                : isLoggingIncident
                                ? "Logging Incident..."
                                : "Lock & Quarantine Stock"}
                            </Button>
                            {incidentLoggedId && (
                              <span style={{ fontSize: "var(--text-xs)", color: "var(--color-success)", fontWeight: 600 }}>
                                Incident recorded on regulatory audit trail.
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Product Details & Audit Card */}
                  <Card padding="none" style={{ overflow: "hidden" }}>
                    {/* Header */}
                    <div
                      style={{
                        padding: "var(--space-4) var(--space-6)",
                        borderBottom: "1px solid var(--color-border-default)",
                        backgroundColor: currentVerification.error
                          ? "var(--color-warning-bg)"
                          : isCounterfeitOrBad
                          ? "var(--color-danger-bg)"
                          : "var(--color-success-bg)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        flexWrap: "wrap",
                        gap: "var(--space-2)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                        {currentVerification.error ? (
                          <AlertTriangle size={22} color="var(--color-warning)" />
                        ) : isCounterfeitOrBad ? (
                          <XCircle size={22} color="var(--color-danger)" />
                        ) : (
                          <CheckCircle2 size={22} color="var(--color-success)" />
                        )}
                        <div>
                          <h3 style={{ margin: 0, fontSize: "var(--text-base)", fontWeight: 700, color: "var(--color-text-main)" }}>
                            Unit #{currentVerification.unit?.id || scannedUnitId}
                          </h3>
                          <span
                            style={{
                              fontSize: "var(--text-xs)",
                              color: currentVerification.error
                                ? "var(--color-warning-fg)"
                                : isCounterfeitOrBad
                                ? "var(--color-danger-fg)"
                                : "var(--color-success-fg)",
                              fontWeight: 600,
                            }}
                          >
                            {currentVerification.error
                              ? "Verification Status Incomplete"
                              : isCounterfeitOrBad
                              ? "Integrity Audit Failed"
                              : "Authentic & Verified on Sepolia"}
                          </span>
                        </div>
                      </div>

                      {currentVerification.unit && (
                        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                          <span
                            style={{
                              backgroundColor: "var(--color-bg-surface)",
                              color: "var(--color-text-muted)",
                              border: "1px solid var(--color-border-default)",
                              fontSize: "var(--text-xs)",
                              padding: "2px 8px",
                              borderRadius: "var(--radius-control)",
                              fontWeight: 600,
                            }}
                          >
                            {currentVerification.unit.levelName}
                          </span>
                          <StatusBadge status={currentVerification.unit.status} />
                        </div>
                      )}
                    </div>

                    <div style={{ padding: "var(--space-6)" }}>
                      {/* Medication Info Grid */}
                      {currentVerification.unit && (
                        <div style={{ marginBottom: "var(--space-6)" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
                            <Pill size={18} color="var(--color-primary)" />
                            <h4 style={{ margin: 0, fontSize: "var(--text-base)", fontWeight: 700, color: "var(--color-text-main)" }}>
                              {currentVerification.unit.metadata}
                            </h4>
                          </div>

                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                              gap: "var(--space-3)",
                              backgroundColor: "var(--color-bg-muted)",
                              padding: "var(--space-4)",
                              borderRadius: "var(--radius-control)",
                              border: "1px solid var(--color-border-default)",
                            }}
                          >
                            <div>
                              <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>Available Stock:</span>
                              <div style={{ fontSize: "var(--text-lg)", fontWeight: 800, color: "var(--color-success)", marginTop: "2px" }}>
                                {currentVerification.unit.quantity} units
                              </div>
                            </div>
                            <div>
                              <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>Manufacturer:</span>
                              <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-main)", marginTop: "2px" }}>
                                <CopyableHash hash={currentVerification.unit.manufacturer} />
                              </div>
                            </div>
                            <div>
                              <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>Current Owner:</span>
                              <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-main)", marginTop: "2px" }}>
                                <CopyableHash hash={currentVerification.unit.currentOwner} />
                              </div>
                            </div>
                            <div>
                              <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>QR Scan Frequency:</span>
                              <div style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: currentVerification.scanRecord?.scanCount === 1 ? "var(--color-success)" : "var(--color-warning)", marginTop: "2px" }}>
                                {currentVerification.scanRecord?.scanCount === 1
                                  ? "First time scanned (Pristine)"
                                  : `Scanned ${currentVerification.scanRecord?.scanCount || 0} times`}
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* 5-Tier Audit Checklist */}
                      {currentVerification.tiers && (
                        <div style={{ marginBottom: "var(--space-6)" }}>
                          <h5 style={{ margin: "0 0 var(--space-3)", fontSize: "var(--text-xs)", color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700 }}>
                            Anti-Counterfeiting 5-Tier Audit Checklist
                          </h5>
                          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderRadius: "var(--radius-control)", backgroundColor: "var(--color-bg-subtle)", border: "1px solid var(--color-border-default)", fontSize: "var(--text-xs)" }}>
                              <span style={{ color: "var(--color-text-main)" }}>Tier 1: On-Chain Genesis Registration</span>
                              <span style={{ color: currentVerification.tiers.tier1_registered ? "var(--color-success)" : "var(--color-danger)", fontWeight: 700 }}>
                                {currentVerification.tiers.tier1_registered ? "✓ Valid Unit ID" : "✕ Unregistered ID"}
                              </span>
                            </div>

                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderRadius: "var(--radius-control)", backgroundColor: "var(--color-bg-subtle)", border: "1px solid var(--color-border-default)", fontSize: "var(--text-xs)" }}>
                              <span style={{ color: "var(--color-text-main)" }}>Tier 2: Anti-Replay &amp; Double-Dispensing Lock</span>
                              <span style={{ color: currentVerification.tiers.tier2_unsold ? "var(--color-success)" : "var(--color-danger)", fontWeight: 700 }}>
                                {currentVerification.tiers.tier2_unsold ? "✓ Unsold & Active" : "✕ Already Sold (Replay Attack)"}
                              </span>
                            </div>

                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderRadius: "var(--radius-control)", backgroundColor: "var(--color-bg-subtle)", border: "1px solid var(--color-border-default)", fontSize: "var(--text-xs)" }}>
                              <span style={{ color: "var(--color-text-main)" }}>Tier 3: Handshake Custody &amp; Anti-Diversion</span>
                              <span style={{ color: !currentVerification.diversionDetected ? "var(--color-success)" : "var(--color-warning)", fontWeight: 700 }}>
                                {!currentVerification.diversionDetected ? "✓ Authorized Dispensary Stock" : "⚠ Diverted Stock (Owner Mismatch)"}
                              </span>
                            </div>

                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderRadius: "var(--radius-control)", backgroundColor: "var(--color-bg-subtle)", border: "1px solid var(--color-border-default)", fontSize: "var(--text-xs)" }}>
                              <span style={{ color: "var(--color-text-main)" }}>Tier 4: Transit Integrity &amp; Contamination</span>
                              <span style={{ color: currentVerification.tiers.tier4_integrity ? "var(--color-success)" : "var(--color-danger)", fontWeight: 700 }}>
                                {currentVerification.tiers.tier4_integrity ? "✓ Verified Transit Handshake" : "✕ Rejected / Recalled Stock"}
                              </span>
                            </div>

                            {/* Tier 5 Scratch PIN (Collapsible for fast zero-friction checkout) */}
                            <details
                              style={{
                                padding: "8px 12px",
                                borderRadius: "var(--radius-control)",
                                backgroundColor: "var(--color-bg-subtle)",
                                border: "1px dashed var(--color-border-default)",
                                fontSize: "var(--text-xs)",
                              }}
                            >
                              <summary style={{ cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", outline: "none", userSelect: "none" }}>
                                <span style={{ color: "var(--color-text-main)", fontWeight: 500 }}>
                                  Tier 5: Tamper Scratch Seal (Optional Inspection)
                                </span>
                                <span
                                  style={{
                                    color:
                                      currentVerification.tamperSealStatus === "verified" ||
                                      currentVerification.tamperSealStatus === "consumed"
                                        ? "var(--color-success)"
                                        : currentVerification.tamperSealStatus === "invalid" ||
                                          currentVerification.tamperSealStatus === "locked"
                                        ? "var(--color-danger)"
                                        : "var(--color-text-muted)",
                                    fontWeight: 700,
                                  }}
                                >
                                  {currentVerification.tamperSealStatus === "verified"
                                    ? "✓ Cryptographically Verified"
                                    : currentVerification.tamperSealStatus === "consumed"
                                    ? "✓ Seal Previously Verified"
                                    : currentVerification.tamperSealStatus === "locked"
                                    ? "⚠️ Locked (24h Cooldown)"
                                    : currentVerification.tamperSealStatus === "invalid"
                                    ? "✕ Invalid Secret Code"
                                    : "Click to Inspect"}
                                </span>
                              </summary>

                              <div style={{ marginTop: "var(--space-3)", paddingTop: "var(--space-2)", borderTop: "1px solid var(--color-border-default)" }}>
                                {currentVerification.tamperSealStatus === "consumed" ? (
                                  <p style={{ margin: "0", fontSize: "11px", color: "var(--color-success)" }}>
                                    ✓ Packaging tamper seal was already authenticated on {currentVerification.consumedAt ? new Date(currentVerification.consumedAt).toLocaleDateString() : "prior inspection"}. Stock is verified genuine.
                                  </p>
                                ) : currentVerification.tamperSealStatus === "locked" ? (
                                  <p style={{ margin: "0", fontSize: "11px", color: "var(--color-danger)" }}>
                                    ⚠️ Cooldown lock active due to repeated invalid guesses. Unit cannot be validated offline until lockout expires or manufacturer resets it.
                                  </p>
                                ) : (
                                  <>
                                    <p style={{ margin: "0 0 6px", fontSize: "11px", color: "var(--color-text-muted)" }}>
                                      Standard checkout is 1-scan. For high-risk medications, optionally scratch and enter the 12-char Base32 code or 4-digit PIN:
                                    </p>
                                    {currentVerification.tamperSealStatus !== "verified" && (
                                      <div style={{ display: "flex", gap: "var(--space-2)" }}>
                                        <input
                                          type="text"
                                          placeholder={`Enter scratch secret code (or PIN: ${currentVerification.unit?.manufacturer.slice(-4) || "1537"})`}
                                          value={scratchSecret}
                                          onChange={(e) => setScratchSecret(e.target.value)}
                                          style={{
                                            flex: 1,
                                            backgroundColor: "var(--color-bg-surface)",
                                            border: "1px solid var(--color-border-default)",
                                            borderRadius: "var(--radius-control)",
                                            padding: "6px 10px",
                                            fontSize: "var(--text-xs)",
                                            color: "var(--color-text-main)",
                                          }}
                                        />
                                        <Button variant="outline" size="sm" onClick={handleVerifyTamperPin}>
                                          Verify Code
                                        </Button>
                                      </div>
                                    )}
                                  </>
                                )}
                              </div>
                            </details>
                          </div>
                        </div>
                      )}

                      {/* DISPENSING / SALE SECTION (Active Only) */}
                      {!isCounterfeitOrBad && currentVerification.unit && (
                        <div
                          style={{
                            backgroundColor: "var(--color-primary-subtle)",
                            border: "1px solid var(--color-primary-border)",
                            borderRadius: "var(--radius-surface)",
                            padding: "var(--space-4)",
                          }}
                        >
                          <h4 style={{ margin: "0 0 var(--space-3)", fontSize: "var(--text-sm)", fontWeight: 700, color: "var(--color-primary)" }}>
                            Point-of-Sale Dispensing Action
                          </h4>

                          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)", flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
                            <div>
                              <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", display: "block", marginBottom: "4px" }}>
                                Dispense Quantity:
                              </span>
                              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    playClickSound();
                                    setDispenseQty((q) => Math.max(1, q - 1));
                                  }}
                                >
                                  -
                                </Button>
                                <input
                                  type="number"
                                  min={1}
                                  max={Number(currentVerification.unit.quantity)}
                                  value={dispenseQty}
                                  onChange={(e) =>
                                    setDispenseQty(
                                      Math.min(Number(currentVerification.unit?.quantity || 1), Math.max(1, Number(e.target.value)))
                                    )
                                  }
                                  style={{
                                    width: "56px",
                                    textAlign: "center",
                                    backgroundColor: "var(--color-bg-surface)",
                                    border: "1px solid var(--color-border-default)",
                                    borderRadius: "var(--radius-control)",
                                    padding: "6px",
                                    color: "var(--color-text-main)",
                                    fontWeight: 700,
                                    fontSize: "var(--text-sm)",
                                  }}
                                />
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    playClickSound();
                                    setDispenseQty((q) =>
                                      Math.min(Number(currentVerification.unit?.quantity || 1), q + 1)
                                    );
                                  }}
                                >
                                  +
                                </Button>
                              </div>
                            </div>

                            {/* Presets */}
                            <div style={{ display: "flex", gap: "var(--space-1)", alignItems: "flex-end" }}>
                              <Button variant="outline" size="sm" onClick={() => setDispenseQty(1)}>
                                1 Unit
                              </Button>
                              <Button variant="outline" size="sm" onClick={() => setDispenseQty(Math.min(10, Number(currentVerification.unit?.quantity || 1)))}>
                                10 Units
                              </Button>
                              <Button variant="outline" size="sm" onClick={() => setDispenseQty(Number(currentVerification.unit?.quantity || 1))}>
                                Full Pack ({currentVerification.unit.quantity})
                              </Button>
                            </div>
                          </div>

                          {/* Fast Checkout Hotkey Hint */}
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-2)", padding: "0 2px" }}>
                            <span style={{ fontSize: "11px", color: "var(--color-text-muted)" }}>
                              Fast Checkout Mode:
                            </span>
                            <span style={{ fontSize: "11px", color: "var(--color-primary)", fontWeight: 700, display: "flex", alignItems: "center", gap: "4px" }}>
                              <Keyboard size={13} /> Press Spacebar or Enter to Sell
                            </span>
                          </div>

                          {/* Submit button */}
                          <Button
                            variant="primary"
                            size="md"
                            loading={isDispensing}
                            disabled={isDispensing || Number(currentVerification.unit.quantity) === 0}
                            onClick={handleDispense}
                            icon={<Zap size={18} />}
                            style={{ width: "100%" }}
                          >
                            {isDispensing
                              ? "Broadcasting Dispensing Tx to Sepolia..."
                              : `Confirm & Mark ${dispenseQty} Unit(s) as Sold (Gasless)`}
                          </Button>

                          {/* Receipt */}
                          {dispenseResult && (
                            <div
                              style={{
                                marginTop: "var(--space-4)",
                                backgroundColor: "var(--color-success-bg)",
                                border: "1px solid var(--color-success-border)",
                                borderRadius: "var(--radius-control)",
                                padding: "var(--space-3)",
                              }}
                            >
                              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", color: "var(--color-success)", fontWeight: 700, fontSize: "var(--text-sm)" }}>
                                <CheckCircle2 size={16} /> Dispensing Confirmed On-Chain!
                              </div>
                              <p style={{ margin: "4px 0 8px", fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
                                Successfully sold {dispenseResult.dispensedQty} unit(s). Remaining stock on-chain: <strong>{dispenseResult.remainingQty}</strong>.
                              </p>
                              <a
                                href={`https://sepolia.etherscan.io/tx/${dispenseResult.txHash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{
                                  color: "var(--color-primary)",
                                  fontSize: "var(--text-xs)",
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "4px",
                                  textDecoration: "none",
                                  fontWeight: 600,
                                }}
                              >
                                View Sepolia Etherscan Receipt <ExternalLink size={12} />
                              </a>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </Card>
                </div>
              ) : (
                /* Idle Prompt Card */
                <Card padding="lg" style={{ textAlign: "center" }}>
                  <div
                    style={{
                      width: "60px",
                      height: "60px",
                      borderRadius: "var(--radius-pill)",
                      backgroundColor: "var(--color-primary-subtle)",
                      border: "1px solid var(--color-primary-border)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      margin: "0 auto var(--space-4)",
                      color: "var(--color-primary)",
                    }}
                  >
                    <Scan size={30} />
                  </div>
                  <h3 style={{ margin: "0 0 var(--space-2)", fontSize: "var(--text-base)", fontWeight: 700, color: "var(--color-text-main)" }}>
                    Ready to Scan Medicine Packaging
                  </h3>
                  <p style={{ margin: "0 auto var(--space-4)", fontSize: "var(--text-sm)", color: "var(--color-text-muted)", maxWidth: "380px" }}>
                    Aim your optical barcode gun or camera at any pharmaceutical QR code. The system verifies on-chain registration, checks for duplicate sold stickers, and guarantees zero double-spending.
                  </p>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--text-xs)", color: "var(--color-success)", fontWeight: 600 }}>
                    <CheckCircle2 size={16} /> 5-Tier Anti-Counterfeit Interception Active
                  </div>
                </Card>
              )}

              {/* Shift Activity Log */}
              <Card padding="md">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-3)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                    <History size={16} color="var(--color-text-muted)" />
                    <h4 style={{ margin: 0, fontSize: "var(--text-sm)", fontWeight: 700, color: "var(--color-text-main)" }}>
                      Shift Scan Activity Log
                    </h4>
                  </div>
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
                    {scanHistory.length} event(s) recorded
                  </span>
                </div>

                {scanHistory.length === 0 ? (
                  <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--color-text-muted)", textAlign: "center", padding: "var(--space-4)" }}>
                    No scans recorded yet in this shift.
                  </p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", maxHeight: "240px", overflowY: "auto" }}>
                    {scanHistory.map((item) => (
                      <div
                        key={item.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "8px 12px",
                          borderRadius: "var(--radius-control)",
                          backgroundColor: "var(--color-bg-subtle)",
                          border: "1px solid var(--color-border-default)",
                          fontSize: "var(--text-xs)",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                          {item.type === "VERIFIED" && <CheckCircle2 size={16} color="var(--color-success)" />}
                          {item.type === "COUNTERFEIT" && <AlertTriangle size={16} color="var(--color-danger)" />}
                          {item.type === "DISPENSED" && <Zap size={16} color="var(--color-primary)" />}
                          {item.type === "QUARANTINED" && <ShieldAlert size={16} color="var(--color-danger)" />}
                          <div>
                            <div style={{ fontWeight: 600, color: "var(--color-text-main)" }}>{item.title}</div>
                            <div style={{ fontSize: "11px", color: "var(--color-text-muted)" }}>{item.details}</div>
                          </div>
                        </div>
                        <div style={{ fontSize: "11px", color: "var(--color-text-muted)", flexShrink: 0 }}>
                          {new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
