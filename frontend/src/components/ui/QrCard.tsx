"use client";

import React, { useEffect, useState } from "react";
import { Download, Copy, Check, ExternalLink } from "lucide-react";
import { generateQrDataUrl } from "@/lib/qr";
import { Button } from "./Button";
import { Skeleton } from "./Skeleton";

export interface QrCardProps {
  unitId: string;
  displayId?: string;
  medicineName?: string;
  quantity?: string;
  metadata?: string;
  verifyUrl?: string;
}

export function QrCard({
  unitId,
  displayId,
  medicineName,
  quantity,
  metadata,
  verifyUrl,
}: QrCardProps) {
  const [qrUrl, setQrUrl] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);

  const effectiveUrl =
    verifyUrl ||
    (typeof window !== "undefined"
      ? `${window.location.origin}/verify?unitId=${unitId}`
      : `/verify?unitId=${unitId}`);

  useEffect(() => {
    let cancelled = false;
    async function loadQr() {
      try {
        setLoading(true);
        const url = await generateQrDataUrl(effectiveUrl);
        if (!cancelled) setQrUrl(url);
      } catch (err) {
        console.error("QR Generation failed", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadQr();
    return () => {
      cancelled = true;
    };
  }, [effectiveUrl]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(effectiveUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  const displayName = medicineName || metadata || "Medicine Unit";
  const idToDisplay = displayId || unitId;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        gap: "var(--space-4)",
      }}
    >
      <div
        style={{
          width: "220px",
          height: "220px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#ffffff",
          borderRadius: "var(--radius-control)",
          border: "1px solid var(--color-border-default)",
          boxShadow: "var(--shadow-sm)",
          padding: "var(--space-2)",
        }}
      >
        {loading ? (
          <Skeleton width="180px" height="180px" />
        ) : qrUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={qrUrl}
            alt={`Verification QR Code for Unit #${idToDisplay}`}
            width={180}
            height={180}
            style={{ display: "block" }}
          />
        ) : (
          <div style={{ color: "var(--color-text-muted)", fontSize: "var(--text-xs)" }}>
            Unable to load QR
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
        <strong style={{ fontSize: "var(--text-base)", color: "var(--color-text-main)" }}>
          {displayName}
        </strong>
        <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
          Unit #{idToDisplay} {quantity ? `· ${quantity} tablets in stock` : ""}
        </span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", width: "100%", justifyContent: "center" }}>
        {qrUrl && (
          <a
            href={qrUrl}
            download={`pharmatree-unit-${unitId}-qr.png`}
            style={{ textDecoration: "none" }}
          >
            <Button
              type="button"
              variant="secondary"
              size="sm"
              icon={<Download size={14} />}
            >
              Download PNG
            </Button>
          </a>
        )}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={handleCopy}
          icon={copied ? <Check size={14} /> : <Copy size={14} />}
        >
          {copied ? "Link Copied" : "Copy Link"}
        </Button>
        <a
          href={`/verify?unitId=${unitId}`}
          target="_blank"
          rel="noreferrer"
          style={{ textDecoration: "none" }}
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon={<ExternalLink size={14} />}
          >
            Open Verification Page
          </Button>
        </a>
      </div>
    </div>
  );
}
