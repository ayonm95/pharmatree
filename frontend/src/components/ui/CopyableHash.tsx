"use client";

import React, { useState } from "react";
import { Copy, Check } from "lucide-react";
import { formatAddress } from "@/lib/format";

interface CopyableHashProps {
  value?: string;
  hash?: string;
  truncateLength?: number;
  label?: string;
  className?: string;
}

export function CopyableHash({
  value,
  hash,
  truncateLength = 4,
  label,
  className = "",
}: CopyableHashProps) {
  const targetValue = hash || value || "";
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!targetValue) return;
    try {
      await navigator.clipboard.writeText(targetValue);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  const displayText = formatAddress(targetValue, truncateLength);

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-1)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        color: "var(--color-text-muted)",
        backgroundColor: "var(--color-bg-muted)",
        border: "1px solid var(--color-border-default)",
        borderRadius: "var(--radius-control)",
        padding: "2px var(--space-2)",
        maxWidth: "100%",
      }}
      title={value}
      className={`copyable-hash ${className}`}
    >
      {label && <span style={{ fontWeight: 600, color: "var(--color-text-main)" }}>{label}:</span>}
      <span className="tabular-nums" style={{ userSelect: "all" }}>
        {displayText}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : `Copy ${value}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "2px",
          backgroundColor: "transparent",
          border: "none",
          cursor: "pointer",
          color: copied ? "var(--color-success-fg)" : "var(--color-text-subtle)",
          transition: "var(--transition-color)",
        }}
      >
        {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
      </button>
    </div>
  );
}
