"use client";

import React from "react";
import { CheckCircle2, Clock, Archive, XCircle, AlertTriangle } from "lucide-react";

export type StatusType = "active" | "in-stock" | "pending" | "sold" | "rejected" | "flagged" | "unknown";

interface StatusBadgeProps {
  status?: number | StatusType;
  label?: string;
  variant?: "success" | "warning" | "danger" | "info" | "neutral";
  size?: "sm" | "md";
  className?: string;
}

export function StatusBadge({
  status,
  label,
  variant,
  size = "md",
  className = "",
}: StatusBadgeProps) {
  let resolvedVariant: "success" | "warning" | "danger" | "info" = "info";
  let displayLabel = label || "Unknown";
  let IconComponent: React.ComponentType<{ size?: number; "aria-hidden"?: boolean | "true" | "false" }> = Clock;

  if (status === 0 || status === "active" || status === "in-stock") {
    resolvedVariant = "success";
    displayLabel = label || "Active / In Stock";
    IconComponent = CheckCircle2;
  } else if (status === 1 || status === "pending") {
    resolvedVariant = "warning";
    displayLabel = label || "Pending Transfer";
    IconComponent = Clock;
  } else if (status === 2 || status === "sold") {
    resolvedVariant = "info";
    displayLabel = label || "Sold";
    IconComponent = Archive;
  } else if (status === 3 || status === "rejected") {
    resolvedVariant = "danger";
    displayLabel = label || "Rejected";
    IconComponent = XCircle;
  } else if (status === "flagged") {
    resolvedVariant = "danger";
    displayLabel = label || "Flagged";
    IconComponent = AlertTriangle;
  }

  if (variant) {
    resolvedVariant = variant === "neutral" ? "info" : variant;
  }

  const stylesByVariant = {
    success: {
      backgroundColor: "var(--color-success-bg)",
      color: "var(--color-success-fg)",
      borderColor: "var(--color-success-border)",
    },
    warning: {
      backgroundColor: "var(--color-warning-bg)",
      color: "var(--color-warning-fg)",
      borderColor: "var(--color-warning-border)",
    },
    danger: {
      backgroundColor: "var(--color-danger-bg)",
      color: "var(--color-danger-fg)",
      borderColor: "var(--color-danger-border)",
    },
    info: {
      backgroundColor: "var(--color-info-bg)",
      color: "var(--color-info-fg)",
      borderColor: "var(--color-info-border)",
    },
  };

  const badgeStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-1)",
    padding: size === "sm" ? "2px var(--space-2)" : "var(--space-1) var(--space-3)",
    fontSize: size === "sm" ? "var(--text-xs)" : "var(--text-sm)",
    lineHeight: size === "sm" ? "var(--line-xs)" : "var(--line-sm)",
    fontWeight: 600,
    borderRadius: "var(--radius-control)",
    border: "1px solid",
    whiteSpace: "nowrap",
    ...stylesByVariant[resolvedVariant],
  };

  return (
    <span style={badgeStyle} className={`status-badge ${className}`}>
      <IconComponent size={size === "sm" ? 14 : 16} aria-hidden={true} />
      <span>{displayLabel}</span>
    </span>
  );
}
