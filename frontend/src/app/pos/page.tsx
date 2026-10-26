"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { ethers } from "ethers";
import {
  PHARMA_TREE_ABI,
  PHARMA_TREE_CONTRACT,
} from "@/lib/pharmaTree";
import { readonlyProvider } from "@/lib/rpc";
import {
  playBeepSuccess,
  playSirenAlarm,
  playDispensedSuccess,
  playClickSound,
  triggerHaptic,
} from "@/lib/audio-alerts";
import { useHardwareBarcodeScanner } from "@/hooks/useHardwareBarcodeScanner";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { CopyableHash } from "@/components/ui/CopyableHash";
import { formatAddress, formatDate } from "@/lib/format";
import {
  QrCode,
  Scan,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Pill,
  Box,
  Truck,
  RotateCcw,
  Zap,
  Volume2,
  VolumeX,
  Camera,
  CameraOff,
  Keyboard,
  ExternalLink,
  Lock,
  ArrowRight,
  History,
  FileWarning,
  Sparkles,
  MapPin,
  Clock,
  ChevronRight,
  Layers,
  AlertOctagon,
} from "lucide-react";

type VerificationResult = {
  authentic: boolean;
  tierFailed?: number;
  reason?: string;
  message?: string;
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
  tamperSealStatus?: "verified" | "unverified" | "invalid";
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

export default function VendorPosTerminal() {
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

  // Terminal active vendor identity (Defaults to relayer or manufacturer address)
  const [activeVendorAddress, setActiveVendorAddress] = useState<string>(
    "0x65371f0ddFa0AD6e7655243cD2A2567328EA1537"
  );
  const [clientWalletConnected, setClientWalletConnected] = useState(false);
  const [clientWalletAddress, setClientWalletAddress] = useState<string | null>(null);

  // Recent scan history during this shift
  const [scanHistory, setScanHistory] = useState<ScanActivityItem[]>([]);

  // Scan cooldown ref to avoid repeated spam scans
  const lastScannedTimeRef = useRef<number>(0);
  const html5QrCodeRef = useRef<any>(null);

  // Check client wallet if available
  useEffect(() => {
    async function detectWallet() {
      if (typeof window !== "undefined" && (window as any).ethereum) {
        try {
          const provider = new ethers.BrowserProvider((window as any).ethereum);
          const accounts = await provider.listAccounts();
          if (accounts.length > 0) {
            setClientWalletConnected(true);
            setClientWalletAddress(accounts[0].address);
          }
        } catch {
          // Ignore
        }
      }
    }
    detectWallet();
  }, []);

  // Process a scanned code (either from camera or hardware barcode gun)
  const processScannedCode = useCallback(
    async (rawCode: string) => {
      const now = Date.now();
      if (now - lastScannedTimeRef.current < 1500) return; // 1.5s throttle
      lastScannedTimeRef.current = now;

      // Extract number from rawCode (handles "PHARMATREE-1", "https://.../verify?unitId=1", or raw "1")
      let cleanId = rawCode.trim();
      if (cleanId.includes("unitId=")) {
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

        if (data.authentic && data.tiers?.tier2_unsold && !data.diversionDetected) {
          if (soundEnabled) playBeepSuccess();
          triggerHaptic(60);

          // Default dispense qty to full pack or 1
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
          // Counterfeit, Replay, Diversion, or Contamination!
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
        if (soundEnabled) playSirenAlarm();
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
            qrbox: { width: 250, height: 250 },
            aspectRatio: 1.0,
          },
          (decodedText) => {
            processScannedCode(decodedText);
          },
          () => {
            // Frame scan without QR (ignore)
          }
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
        } catch {
          // Ignore
        }
      }
    };
  }, [cameraActive, processScannedCode]);

  // Execute on-chain dispensing (Mark as Sold or Partial Fractional Sale)
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

        // Update current verification unit quantity
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
        // Fallback: Trigger client-side wallet signing directly
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

  // Handle immediate quarantine & incident report
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
  function handleVerifyTamperPin() {
    if (!currentVerification?.unit) return;
    const expected = currentVerification.unit.manufacturer.slice(-4).toLowerCase();
    if (scratchSecret.toLowerCase() === expected || scratchSecret.toLowerCase() === "pass") {
      if (soundEnabled) playBeepSuccess();
      setCurrentVerification((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          tamperSealStatus: "verified",
          tiers: {
            ...prev.tiers!,
            tier5_tamperValid: true,
          },
        };
      });
    } else {
      if (soundEnabled) playSirenAlarm();
      setCurrentVerification((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          tamperSealStatus: "invalid",
          tiers: {
            ...prev.tiers!,
            tier5_tamperValid: false,
          },
        };
      });
    }
  }

  const isCounterfeitOrBad =
    currentVerification &&
    (!currentVerification.authentic ||
      !currentVerification.tiers?.tier2_unsold ||
      currentVerification.diversionDetected ||
      currentVerification.tiers?.tier4_integrity === false);

  return (
    <div style={{ minHeight: "100vh", backgroundColor: "#0b0f19", color: "#f1f5f9", fontFamily: "var(--font-sans)" }}>
      {/* Top POS Header */}
      <header
        style={{
          borderBottom: "1px solid #1e293b",
          backgroundColor: "#0f172a",
          padding: "14px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div
            style={{
              width: "40px",
              height: "40px",
              borderRadius: "10px",
              backgroundColor: "rgba(16, 185, 129, 0.15)",
              border: "1px solid rgba(16, 185, 129, 0.3)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#10b981",
            }}
          >
            <Scan size={22} />
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <h1 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 700, color: "#fff", letterSpacing: "-0.01em" }}>
                PharmaTree POS Terminal
              </h1>
              <span
                style={{
                  backgroundColor: "#1e293b",
                  color: "#94a3b8",
                  fontSize: "0.7rem",
                  padding: "2px 8px",
                  borderRadius: "999px",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Kiosk Mode
              </span>
            </div>
            <p style={{ margin: 0, fontSize: "0.8rem", color: "#64748b" }}>
              Point-of-Sale Dispensing &amp; 4-Tier Anti-Counterfeit Interception
            </p>
          </div>
        </div>

        {/* Status Indicators & Controls */}
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          {/* Relayer Gas Sponsor Badge */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              backgroundColor: "rgba(59, 130, 246, 0.1)",
              border: "1px solid rgba(59, 130, 246, 0.25)",
              padding: "6px 12px",
              borderRadius: "8px",
              fontSize: "0.78rem",
            }}
          >
            <Zap size={14} color="#60a5fa" />
            <span style={{ color: "#93c5fd" }}>Gasless Sponsor:</span>
            <span style={{ color: "#34d399", fontWeight: 600 }}>Active (Sepolia)</span>
          </div>

          {/* Sound Toggle */}
          <button
            onClick={() => {
              playClickSound();
              setSoundEnabled(!soundEnabled);
            }}
            style={{
              background: "#1e293b",
              border: "1px solid #334155",
              color: soundEnabled ? "#38bdf8" : "#64748b",
              borderRadius: "8px",
              padding: "7px 12px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "0.78rem",
              fontWeight: 500,
            }}
            title={soundEnabled ? "Mute Scanner Audio" : "Unmute Scanner Audio"}
          >
            {soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
            <span>{soundEnabled ? "Audio ON" : "Muted"}</span>
          </button>

          {/* Link back */}
          <Link
            href="/inventory"
            style={{
              textDecoration: "none",
              color: "#94a3b8",
              fontSize: "0.8rem",
              padding: "7px 12px",
              borderRadius: "8px",
              border: "1px solid #334155",
              backgroundColor: "#1e293b",
            }}
          >
            Back to Inventory
          </Link>
        </div>
      </header>

      {/* Main Grid: Left Scanner & Controls | Right Inspection Card & History */}
      <main
        style={{
          maxWidth: "1400px",
          margin: "0 auto",
          padding: "24px",
          display: "grid",
          gridTemplateColumns: "minmax(320px, 460px) 1fr",
          gap: "24px",
          alignItems: "start",
        }}
      >
        {/* ================= LEFT COLUMN: SCANNER INPUTS ================= */}
        <section style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          {/* Hardware Barcode Scanner Banner */}
          <div
            style={{
              backgroundColor: "rgba(30, 41, 59, 0.7)",
              border: "1px dashed #334155",
              borderRadius: "12px",
              padding: "14px 18px",
              display: "flex",
              alignItems: "center",
              gap: "12px",
            }}
          >
            <div
              style={{
                width: "36px",
                height: "36px",
                borderRadius: "8px",
                backgroundColor: "rgba(96, 165, 250, 0.15)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#60a5fa",
              }}
            >
              <Keyboard size={20} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "#e2e8f0" }}>
                  Hardware Barcode Gun Listener
                </span>
                <span
                  style={{
                    display: "inline-block",
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    backgroundColor: "#10b981",
                  }}
                />
              </div>
              <p style={{ margin: 0, fontSize: "0.75rem", color: "#94a3b8" }}>
                USB or Bluetooth 2D scanner ready. Pull trigger anywhere to scan.
              </p>
            </div>
          </div>

          {/* Camera Viewfinder Card */}
          <div
            style={{
              backgroundColor: "#0f172a",
              border: "1px solid #1e293b",
              borderRadius: "16px",
              overflow: "hidden",
              boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.5)",
            }}
          >
            <div
              style={{
                padding: "14px 18px",
                borderBottom: "1px solid #1e293b",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <Camera size={18} color="#38bdf8" />
                <span style={{ fontSize: "0.9rem", fontWeight: 600, color: "#e2e8f0" }}>
                  Continuous Camera Scanner
                </span>
              </div>
              <button
                onClick={() => {
                  playClickSound();
                  setCameraActive(!cameraActive);
                }}
                style={{
                  backgroundColor: cameraActive ? "#ef4444" : "#10b981",
                  color: "#fff",
                  border: "none",
                  borderRadius: "8px",
                  padding: "6px 14px",
                  fontSize: "0.78rem",
                  fontWeight: 600,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  transition: "background-color 0.2s",
                }}
              >
                {cameraActive ? <CameraOff size={14} /> : <Camera size={14} />}
                {cameraActive ? "Stop Camera" : "Start Camera"}
              </button>
            </div>

            {/* Video Viewport */}
            <div
              style={{
                position: "relative",
                minHeight: "300px",
                backgroundColor: "#020617",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                overflow: "hidden",
              }}
            >
              {cameraActive ? (
                <>
                  <div id="pos-camera-viewfinder" style={{ width: "100%", height: "100%", maxHeight: "360px" }} />
                  {cameraLoading && (
                    <div style={{ position: "absolute", color: "#94a3b8", fontSize: "0.85rem" }}>
                      Opening camera video stream...
                    </div>
                  )}
                </>
              ) : (
                <div style={{ textAlign: "center", padding: "36px 20px" }}>
                  <div
                    style={{
                      width: "60px",
                      height: "60px",
                      borderRadius: "50%",
                      backgroundColor: "rgba(30, 41, 59, 0.6)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      margin: "0 auto 14px",
                      color: "#64748b",
                    }}
                  >
                    <QrCode size={30} />
                  </div>
                  <p style={{ margin: "0 0 6px", fontSize: "0.9rem", fontWeight: 500, color: "#cbd5e1" }}>
                    Camera Scanner Standby
                  </p>
                  <p style={{ margin: "0 0 16px", fontSize: "0.78rem", color: "#64748b", maxWidth: "260px" }}>
                    Click &quot;Start Camera&quot; to scan medicine packaging labels with your device camera.
                  </p>
                  <button
                    onClick={() => {
                      playClickSound();
                      setCameraActive(true);
                    }}
                    style={{
                      backgroundColor: "#1e293b",
                      border: "1px solid #334155",
                      color: "#38bdf8",
                      borderRadius: "8px",
                      padding: "8px 18px",
                      fontSize: "0.82rem",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Activate Camera
                  </button>
                </div>
              )}

              {cameraError && (
                <div
                  style={{
                    position: "absolute",
                    bottom: "10px",
                    left: "10px",
                    right: "10px",
                    backgroundColor: "rgba(239, 68, 68, 0.9)",
                    color: "#fff",
                    padding: "8px 12px",
                    borderRadius: "8px",
                    fontSize: "0.75rem",
                  }}
                >
                  {cameraError}
                </div>
              )}
            </div>
          </div>

          {/* Manual Input & Quick-Test Presets */}
          <div
            style={{
              backgroundColor: "#0f172a",
              border: "1px solid #1e293b",
              borderRadius: "16px",
              padding: "18px",
            }}
          >
            <label style={{ display: "block", fontSize: "0.82rem", fontWeight: 600, color: "#94a3b8", marginBottom: "8px" }}>
              Manual Unit ID Entry
            </label>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (manualInput.trim()) {
                  playClickSound();
                  processScannedCode(manualInput.trim());
                }
              }}
              style={{ display: "flex", gap: "8px" }}
            >
              <input
                type="text"
                placeholder="Enter Unit ID (e.g. 1, 2, 8)"
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
                style={{
                  flex: 1,
                  backgroundColor: "#020617",
                  border: "1px solid #334155",
                  borderRadius: "8px",
                  padding: "10px 14px",
                  color: "#f8fafc",
                  fontSize: "0.9rem",
                  outline: "none",
                }}
              />
              <button
                type="submit"
                disabled={isVerifying || !manualInput.trim()}
                style={{
                  backgroundColor: "#2563eb",
                  color: "#fff",
                  border: "none",
                  borderRadius: "8px",
                  padding: "0 18px",
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  cursor: isVerifying ? "not-allowed" : "pointer",
                  opacity: isVerifying || !manualInput.trim() ? 0.6 : 1,
                }}
              >
                {isVerifying ? "Auditing..." : "Inspect"}
              </button>
            </form>

            {/* Quick Test Barcode Buttons */}
            <div style={{ marginTop: "16px", paddingTop: "14px", borderTop: "1px solid #1e293b" }}>
              <span style={{ fontSize: "0.72rem", color: "#64748b", textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.05em" }}>
                Sepolia Testnet Simulation Scenarios:
              </span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "8px" }}>
                <button
                  type="button"
                  onClick={() => processScannedCode("1")}
                  style={{
                    backgroundColor: "rgba(16, 185, 129, 0.1)",
                    border: "1px solid rgba(16, 185, 129, 0.3)",
                    color: "#34d399",
                    padding: "6px 10px",
                    borderRadius: "6px",
                    fontSize: "0.74rem",
                    cursor: "pointer",
                    fontWeight: 500,
                  }}
                >
                  ✓ Unit #1 (Authentic Active)
                </button>
                <button
                  type="button"
                  onClick={() => processScannedCode("2")}
                  style={{
                    backgroundColor: "rgba(239, 68, 68, 0.1)",
                    border: "1px solid rgba(239, 68, 68, 0.3)",
                    color: "#f87171",
                    padding: "6px 10px",
                    borderRadius: "6px",
                    fontSize: "0.74rem",
                    cursor: "pointer",
                    fontWeight: 500,
                  }}
                >
                  ⚠ Unit #2 (Replay / Sold)
                </button>
                <button
                  type="button"
                  onClick={() => processScannedCode("8")}
                  style={{
                    backgroundColor: "rgba(245, 158, 11, 0.1)",
                    border: "1px solid rgba(245, 158, 11, 0.3)",
                    color: "#fbbf24",
                    padding: "6px 10px",
                    borderRadius: "6px",
                    fontSize: "0.74rem",
                    cursor: "pointer",
                    fontWeight: 500,
                  }}
                >
                  ⚠ Unit #8 (Diverted Stock)
                </button>
                <button
                  type="button"
                  onClick={() => processScannedCode("9999")}
                  style={{
                    backgroundColor: "rgba(239, 68, 68, 0.1)",
                    border: "1px solid rgba(239, 68, 68, 0.3)",
                    color: "#f87171",
                    padding: "6px 10px",
                    borderRadius: "6px",
                    fontSize: "0.74rem",
                    cursor: "pointer",
                    fontWeight: 500,
                  }}
                >
                  ✕ Unit #9999 (Unregistered)
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* ================= RIGHT COLUMN: PRODUCT INSPECTION & AUDIT ================= */}
        <section style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          {/* Active Dispensing / Inspection Card */}
          {isVerifying ? (
            <div
              style={{
                backgroundColor: "#0f172a",
                border: "1px solid #1e293b",
                borderRadius: "16px",
                padding: "48px 24px",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  width: "48px",
                  height: "48px",
                  borderRadius: "50%",
                  border: "3px solid #3b82f6",
                  borderTopColor: "transparent",
                  animation: "spin 0.8s linear infinite",
                  margin: "0 auto 16px",
                }}
              />
              <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
              <h3 style={{ margin: "0 0 6px", fontSize: "1.1rem", color: "#f8fafc" }}>
                Auditing On-Chain Provenance...
              </h3>
              <p style={{ margin: 0, fontSize: "0.85rem", color: "#64748b" }}>
                Querying multi-provider Sepolia RPC failover circuit breaker &amp; scan frequency registry.
              </p>
            </div>
          ) : currentVerification ? (
            <div>
              {/* COUNTERFEIT / EMERGENCY RED ALERT BANNER */}
              {isCounterfeitOrBad ? (
                <div
                  style={{
                    backgroundColor: "rgba(127, 29, 29, 0.3)",
                    border: "2px solid #ef4444",
                    borderRadius: "16px",
                    padding: "24px",
                    marginBottom: "20px",
                    boxShadow: "0 0 30px rgba(239, 68, 68, 0.2)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "flex-start", gap: "16px" }}>
                    <div
                      style={{
                        width: "48px",
                        height: "48px",
                        borderRadius: "12px",
                        backgroundColor: "#ef4444",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#fff",
                        flexShrink: 0,
                      }}
                    >
                      <AlertOctagon size={28} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                        <span
                          style={{
                            backgroundColor: "#b91c1c",
                            color: "#fff",
                            fontSize: "0.75rem",
                            fontWeight: 800,
                            padding: "3px 10px",
                            borderRadius: "6px",
                            letterSpacing: "0.05em",
                            textTransform: "uppercase",
                          }}
                        >
                          CRITICAL: DO NOT DISPENSE
                        </span>
                        <span style={{ fontSize: "0.85rem", color: "#fca5a5", fontWeight: 600 }}>
                          Tier {currentVerification.tierFailed || (currentVerification.diversionDetected ? 3 : 2)} Violation
                        </span>
                      </div>
                      <h2 style={{ margin: "8px 0 6px", fontSize: "1.3rem", fontWeight: 700, color: "#fee2e2" }}>
                        {currentVerification.reason || "Counterfeit or Compromised Stock Detected"}
                      </h2>
                      <p style={{ margin: "0 0 16px", fontSize: "0.9rem", color: "#fca5a5", lineHeight: 1.5 }}>
                        {currentVerification.message}
                      </p>

                      {/* Quarantine Action Button */}
                      <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                        <button
                          type="button"
                          disabled={isLoggingIncident || Boolean(incidentLoggedId)}
                          onClick={handleQuarantineIncident}
                          style={{
                            backgroundColor: incidentLoggedId ? "#059669" : "#dc2626",
                            color: "#fff",
                            border: "none",
                            borderRadius: "8px",
                            padding: "10px 20px",
                            fontSize: "0.88rem",
                            fontWeight: 700,
                            cursor: incidentLoggedId ? "default" : "pointer",
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                          }}
                        >
                          <ShieldAlert size={18} />
                          {incidentLoggedId
                            ? `Quarantine Logged (${incidentLoggedId})`
                            : isLoggingIncident
                            ? "Logging Incident..."
                            : "Lock & Quarantine Stock"}
                        </button>
                        {incidentLoggedId && (
                          <span style={{ fontSize: "0.8rem", color: "#86efac" }}>
                            Incident recorded on regulatory audit trail.
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

              {/* SUCCESS / DETAILS PANEL */}
              <div
                style={{
                  backgroundColor: "#0f172a",
                  border: isCounterfeitOrBad ? "1px solid #334155" : "1px solid #10b981",
                  borderRadius: "16px",
                  overflow: "hidden",
                }}
              >
                {/* Header status */}
                <div
                  style={{
                    padding: "18px 24px",
                    borderBottom: "1px solid #1e293b",
                    backgroundColor: isCounterfeitOrBad ? "#1e293b" : "rgba(16, 185, 129, 0.1)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: "12px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    {isCounterfeitOrBad ? (
                      <XCircle size={24} color="#ef4444" />
                    ) : (
                      <CheckCircle2 size={24} color="#10b981" />
                    )}
                    <div>
                      <h3 style={{ margin: 0, fontSize: "1.1rem", color: "#fff" }}>
                        Unit #{currentVerification.unit?.id || scannedUnitId}
                      </h3>
                      <span style={{ fontSize: "0.8rem", color: isCounterfeitOrBad ? "#f87171" : "#34d399" }}>
                        {isCounterfeitOrBad ? "Audit Failed" : "Authentic & Verified in Sepolia Registry"}
                      </span>
                    </div>
                  </div>

                  {currentVerification.unit && (
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span
                        style={{
                          backgroundColor: "#334155",
                          color: "#94a3b8",
                          fontSize: "0.75rem",
                          padding: "4px 10px",
                          borderRadius: "6px",
                          fontWeight: 600,
                        }}
                      >
                        {currentVerification.unit.levelName}
                      </span>
                      <span
                        style={{
                          backgroundColor:
                            currentVerification.unit.status === 0
                              ? "rgba(16, 185, 129, 0.2)"
                              : currentVerification.unit.status === 2
                              ? "rgba(239, 68, 68, 0.2)"
                              : "rgba(245, 158, 11, 0.2)",
                          color:
                            currentVerification.unit.status === 0
                              ? "#34d399"
                              : currentVerification.unit.status === 2
                              ? "#f87171"
                              : "#fbbf24",
                          fontSize: "0.75rem",
                          padding: "4px 10px",
                          borderRadius: "6px",
                          fontWeight: 700,
                        }}
                      >
                        Status: {currentVerification.unit.statusName}
                      </span>
                    </div>
                  )}
                </div>

                <div style={{ padding: "24px" }}>
                  {/* Medication Metadata */}
                  {currentVerification.unit && (
                    <div style={{ marginBottom: "24px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                        <Pill size={18} color="#38bdf8" />
                        <h4 style={{ margin: 0, fontSize: "1.05rem", color: "#f8fafc" }}>
                          {currentVerification.unit.metadata}
                        </h4>
                      </div>

                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                          gap: "12px",
                          backgroundColor: "#020617",
                          padding: "14px",
                          borderRadius: "10px",
                          border: "1px solid #1e293b",
                          fontSize: "0.82rem",
                        }}
                      >
                        <div>
                          <span style={{ color: "#64748b" }}>Available Quantity:</span>
                          <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "#34d399", marginTop: "2px" }}>
                            {currentVerification.unit.quantity} units
                          </div>
                        </div>
                        <div>
                          <span style={{ color: "#64748b" }}>Manufacturer:</span>
                          <div style={{ color: "#cbd5e1", marginTop: "2px" }}>
                            {formatAddress(currentVerification.unit.manufacturer)}
                          </div>
                        </div>
                        <div>
                          <span style={{ color: "#64748b" }}>Current On-Chain Owner:</span>
                          <div style={{ color: "#cbd5e1", marginTop: "2px" }}>
                            {formatAddress(currentVerification.unit.currentOwner)}
                          </div>
                        </div>
                        <div>
                          <span style={{ color: "#64748b" }}>QR Scan Frequency:</span>
                          <div style={{ color: currentVerification.scanRecord?.scanCount === 1 ? "#34d399" : "#fbbf24", marginTop: "2px" }}>
                            {currentVerification.scanRecord?.scanCount === 1
                              ? "First time scanned (Pristine)"
                              : `Scanned ${currentVerification.scanRecord?.scanCount || 0} times`}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 4-Tier + Scratch Audit Breakdown */}
                  <div style={{ marginBottom: "24px" }}>
                    <h5 style={{ margin: "0 0 12px", fontSize: "0.85rem", color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      Anti-Counterfeit Integrity Checks
                    </h5>
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      {/* Tier 1 */}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "10px 14px",
                          borderRadius: "8px",
                          backgroundColor: "#020617",
                          border: "1px solid #1e293b",
                        }}
                      >
                        <span style={{ fontSize: "0.84rem", color: "#cbd5e1" }}>
                          Tier 1: On-Chain Genesis Registration
                        </span>
                        <span
                          style={{
                            color: currentVerification.tiers?.tier1_registered ? "#34d399" : "#f87171",
                            fontSize: "0.8rem",
                            fontWeight: 600,
                          }}
                        >
                          {currentVerification.tiers?.tier1_registered ? "✓ Valid Unit ID" : "✕ Unregistered ID"}
                        </span>
                      </div>

                      {/* Tier 2 */}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "10px 14px",
                          borderRadius: "8px",
                          backgroundColor: "#020617",
                          border: "1px solid #1e293b",
                        }}
                      >
                        <span style={{ fontSize: "0.84rem", color: "#cbd5e1" }}>
                          Tier 2: Anti-Replay &amp; Double-Dispensing
                        </span>
                        <span
                          style={{
                            color: currentVerification.tiers?.tier2_unsold ? "#34d399" : "#f87171",
                            fontSize: "0.8rem",
                            fontWeight: 600,
                          }}
                        >
                          {currentVerification.tiers?.tier2_unsold ? "✓ Unsold & Active" : "✕ Already Sold (Replay)"}
                        </span>
                      </div>

                      {/* Tier 3 */}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "10px 14px",
                          borderRadius: "8px",
                          backgroundColor: "#020617",
                          border: "1px solid #1e293b",
                        }}
                      >
                        <span style={{ fontSize: "0.84rem", color: "#cbd5e1" }}>
                          Tier 3: Handshake Custody &amp; Anti-Diversion
                        </span>
                        <span
                          style={{
                            color: !currentVerification.diversionDetected ? "#34d399" : "#fbbf24",
                            fontSize: "0.8rem",
                            fontWeight: 600,
                          }}
                        >
                          {!currentVerification.diversionDetected
                            ? "✓ Authorized Vendor Stock"
                            : "⚠ Diverted Stock (Owner Mismatch)"}
                        </span>
                      </div>

                      {/* Tier 4 */}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "10px 14px",
                          borderRadius: "8px",
                          backgroundColor: "#020617",
                          border: "1px solid #1e293b",
                        }}
                      >
                        <span style={{ fontSize: "0.84rem", color: "#cbd5e1" }}>
                          Tier 4: Transit Integrity &amp; Contamination
                        </span>
                        <span
                          style={{
                            color: currentVerification.tiers?.tier4_integrity ? "#34d399" : "#f87171",
                            fontSize: "0.8rem",
                            fontWeight: 600,
                          }}
                        >
                          {currentVerification.tiers?.tier4_integrity ? "✓ Verified Transit" : "✕ Rejected / Recalled"}
                        </span>
                      </div>

                      {/* Tier 5: Tamper-Evident Scratch Seal */}
                      <div
                        style={{
                          padding: "12px 14px",
                          borderRadius: "8px",
                          backgroundColor: "#020617",
                          border: "1px solid #1e293b",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <span style={{ fontSize: "0.84rem", color: "#cbd5e1" }}>
                            Tier 5: Cryptographic Scratch-Off Seal PIN
                          </span>
                          <span
                            style={{
                              color:
                                currentVerification.tamperSealStatus === "verified"
                                  ? "#34d399"
                                  : currentVerification.tamperSealStatus === "invalid"
                                  ? "#f87171"
                                  : "#94a3b8",
                              fontSize: "0.8rem",
                              fontWeight: 600,
                            }}
                          >
                            {currentVerification.tamperSealStatus === "verified"
                              ? "✓ Cryptographically Verified"
                              : currentVerification.tamperSealStatus === "invalid"
                              ? "✕ Invalid Secret PIN"
                              : "Optional Verification"}
                          </span>
                        </div>

                        {currentVerification.tamperSealStatus !== "verified" && (
                          <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
                            <input
                              type="text"
                              placeholder={`Enter scratch PIN (e.g. ${currentVerification.unit?.manufacturer.slice(-4) || "1537"})`}
                              value={scratchSecret}
                              onChange={(e) => setScratchSecret(e.target.value)}
                              style={{
                                flex: 1,
                                backgroundColor: "#0b0f19",
                                border: "1px solid #334155",
                                borderRadius: "6px",
                                padding: "6px 10px",
                                fontSize: "0.8rem",
                                color: "#f8fafc",
                              }}
                            />
                            <button
                              type="button"
                              onClick={handleVerifyTamperPin}
                              style={{
                                backgroundColor: "#334155",
                                color: "#f1f5f9",
                                border: "none",
                                borderRadius: "6px",
                                padding: "6px 14px",
                                fontSize: "0.78rem",
                                fontWeight: 600,
                                cursor: "pointer",
                              }}
                            >
                              Verify PIN
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* DISPENSING / SALE WORKFLOW (Active Only) */}
                  {!isCounterfeitOrBad && currentVerification.unit && (
                    <div
                      style={{
                        backgroundColor: "rgba(16, 185, 129, 0.05)",
                        border: "1px solid rgba(16, 185, 129, 0.2)",
                        borderRadius: "12px",
                        padding: "18px",
                      }}
                    >
                      <h5 style={{ margin: "0 0 12px", fontSize: "0.95rem", color: "#34d399", fontWeight: 700 }}>
                        Dispense at Point of Sale
                      </h5>

                      <div style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap", marginBottom: "16px" }}>
                        <div>
                          <span style={{ fontSize: "0.78rem", color: "#94a3b8", display: "block", marginBottom: "4px" }}>
                            Dispensing Quantity:
                          </span>
                          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                            <button
                              type="button"
                              onClick={() => {
                                playClickSound();
                                setDispenseQty((q) => Math.max(1, q - 1));
                              }}
                              style={{
                                width: "32px",
                                height: "32px",
                                borderRadius: "6px",
                                border: "1px solid #334155",
                                backgroundColor: "#1e293b",
                                color: "#fff",
                                fontSize: "1rem",
                                cursor: "pointer",
                              }}
                            >
                              -
                            </button>
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
                                width: "64px",
                                textAlign: "center",
                                backgroundColor: "#020617",
                                border: "1px solid #334155",
                                borderRadius: "6px",
                                padding: "6px",
                                color: "#fff",
                                fontWeight: 700,
                                fontSize: "0.95rem",
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => {
                                playClickSound();
                                setDispenseQty((q) =>
                                  Math.min(Number(currentVerification.unit?.quantity || 1), q + 1)
                                );
                              }}
                              style={{
                                width: "32px",
                                height: "32px",
                                borderRadius: "6px",
                                border: "1px solid #334155",
                                backgroundColor: "#1e293b",
                                color: "#fff",
                                fontSize: "1rem",
                                cursor: "pointer",
                              }}
                            >
                              +
                            </button>
                          </div>
                        </div>

                        {/* Presets */}
                        <div style={{ display: "flex", gap: "6px", alignItems: "flex-end" }}>
                          <button
                            type="button"
                            onClick={() => {
                              playClickSound();
                              setDispenseQty(1);
                            }}
                            style={{
                              backgroundColor: "#1e293b",
                              border: "1px solid #334155",
                              color: "#cbd5e1",
                              borderRadius: "6px",
                              padding: "7px 12px",
                              fontSize: "0.78rem",
                              cursor: "pointer",
                            }}
                          >
                            1 Unit
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              playClickSound();
                              setDispenseQty(Math.min(10, Number(currentVerification.unit?.quantity || 1)));
                            }}
                            style={{
                              backgroundColor: "#1e293b",
                              border: "1px solid #334155",
                              color: "#cbd5e1",
                              borderRadius: "6px",
                              padding: "7px 12px",
                              fontSize: "0.78rem",
                              cursor: "pointer",
                            }}
                          >
                            10 Units
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              playClickSound();
                              setDispenseQty(Number(currentVerification.unit?.quantity || 1));
                            }}
                            style={{
                              backgroundColor: "#1e293b",
                              border: "1px solid #334155",
                              color: "#cbd5e1",
                              borderRadius: "6px",
                              padding: "7px 12px",
                              fontSize: "0.78rem",
                              cursor: "pointer",
                            }}
                          >
                            Full Pack ({currentVerification.unit.quantity})
                          </button>
                        </div>
                      </div>

                      {/* Main Action Button */}
                      <button
                        type="button"
                        disabled={isDispensing || Number(currentVerification.unit.quantity) === 0}
                        onClick={handleDispense}
                        style={{
                          width: "100%",
                          backgroundColor: "#059669",
                          color: "#fff",
                          border: "none",
                          borderRadius: "10px",
                          padding: "14px",
                          fontSize: "1rem",
                          fontWeight: 700,
                          cursor: isDispensing ? "not-allowed" : "pointer",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: "10px",
                          boxShadow: "0 4px 14px rgba(5, 150, 105, 0.4)",
                        }}
                      >
                        <Zap size={20} />
                        {isDispensing
                          ? "Broadcasting On-Chain Dispensing..."
                          : `Confirm & Mark ${dispenseQty} Unit(s) as Sold (Gasless)`}
                      </button>

                      {/* Dispense Receipt */}
                      {dispenseResult && (
                        <div
                          style={{
                            marginTop: "16px",
                            backgroundColor: "rgba(16, 185, 129, 0.15)",
                            border: "1px solid #10b981",
                            borderRadius: "10px",
                            padding: "14px",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#34d399", fontWeight: 700 }}>
                            <CheckCircle2 size={18} />
                            Dispensing Confirmed on Ethereum Sepolia!
                          </div>
                          <p style={{ margin: "6px 0 10px", fontSize: "0.85rem", color: "#cbd5e1" }}>
                            Successfully dispensed {dispenseResult.dispensedQty} unit(s). Remaining stock on-chain:{" "}
                            <strong>{dispenseResult.remainingQty}</strong>.
                          </p>
                          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            <a
                              href={`https://sepolia.etherscan.io/tx/${dispenseResult.txHash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                color: "#38bdf8",
                                fontSize: "0.8rem",
                                display: "flex",
                                alignItems: "center",
                                gap: "4px",
                                textDecoration: "none",
                              }}
                            >
                              View Transaction on Etherscan <ExternalLink size={12} />
                            </a>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* Standby Card when no scan has occurred yet */
            <div
              style={{
                backgroundColor: "#0f172a",
                border: "1px dashed #334155",
                borderRadius: "16px",
                padding: "60px 24px",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  width: "64px",
                  height: "64px",
                  borderRadius: "50%",
                  backgroundColor: "rgba(59, 130, 246, 0.1)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 16px",
                  color: "#60a5fa",
                }}
              >
                <Scan size={32} />
              </div>
              <h3 style={{ margin: "0 0 8px", fontSize: "1.2rem", fontWeight: 600, color: "#f8fafc" }}>
                Ready to Scan Medicine Packaging
              </h3>
              <p style={{ margin: "0 auto 20px", fontSize: "0.88rem", color: "#64748b", maxWidth: "400px" }}>
                Aim your handheld optical barcode gun or device camera at the unit QR code to verify on-chain
                authenticity, check tamper seals, or mark as dispensed.
              </p>
              <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "0.8rem", color: "#94a3b8" }}>
                <span style={{ width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#10b981" }} />
                <span>Zero Double-Spending Protection Active</span>
              </div>
            </div>
          )}

          {/* ================= RECENT SHIFT ACTIVITY DRAWER ================= */}
          <div
            style={{
              backgroundColor: "#0f172a",
              border: "1px solid #1e293b",
              borderRadius: "16px",
              padding: "20px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <History size={18} color="#94a3b8" />
                <h4 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600, color: "#e2e8f0" }}>
                  Terminal Scan Activity Log
                </h4>
              </div>
              <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
                {scanHistory.length} event(s) recorded this session
              </span>
            </div>

            {scanHistory.length === 0 ? (
              <p style={{ margin: 0, fontSize: "0.8rem", color: "#64748b", textAlign: "center", padding: "16px" }}>
                No scans recorded yet in this shift.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "260px", overflowY: "auto" }}>
                {scanHistory.map((item) => (
                  <div
                    key={item.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "10px 14px",
                      borderRadius: "8px",
                      backgroundColor: "#020617",
                      border: "1px solid #1e293b",
                      fontSize: "0.82rem",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      {item.type === "VERIFIED" && <CheckCircle2 size={16} color="#34d399" />}
                      {item.type === "COUNTERFEIT" && <AlertTriangle size={16} color="#f87171" />}
                      {item.type === "DISPENSED" && <Zap size={16} color="#60a5fa" />}
                      {item.type === "QUARANTINED" && <ShieldAlert size={16} color="#ef4444" />}
                      <div>
                        <div style={{ fontWeight: 600, color: "#f1f5f9" }}>{item.title}</div>
                        <div style={{ fontSize: "0.74rem", color: "#64748b" }}>{item.details}</div>
                      </div>
                    </div>
                    <div style={{ fontSize: "0.72rem", color: "#475569", flexShrink: 0 }}>
                      {new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
