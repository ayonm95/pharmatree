"use client";

import React from "react";

export interface StockDonutChartProps {
  activeCount: number;
  pendingCount: number;
  soldCount: number;
  size?: number;
}

export function StockDonutChart({
  activeCount,
  pendingCount,
  soldCount,
  size = 68,
}: StockDonutChartProps) {
  const total = activeCount + pendingCount + soldCount;
  const activePct = total > 0 ? (activeCount / total) * 100 : 0;
  const pendingPct = total > 0 ? (pendingCount / total) * 100 : 0;

  return (
    <div
      style={{
        position: "relative",
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
      aria-label={`Stock breakdown: ${Math.round(activePct)}% active`}
    >
      <svg
        viewBox="0 0 36 36"
        style={{ width: "100%", height: "100%", transform: "rotate(-90deg)" }}
        aria-hidden="true"
      >
        {/* Base Layer: Sold Units (Light Slate) */}
        <path
          d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
          fill="none"
          stroke="var(--color-border-default)"
          strokeWidth="4"
        />
        {/* Layer 2: Pending Transfers (Warning) */}
        {pendingPct > 0 && (
          <path
            d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
            fill="none"
            stroke="var(--color-warning-fg)"
            strokeWidth="4"
            strokeDasharray={`${pendingPct + activePct}, 100`}
            strokeDashoffset={-activePct}
          />
        )}
        {/* Layer 1: Active Units (Primary Teal) */}
        {activePct > 0 && (
          <path
            d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
            fill="none"
            stroke="var(--color-primary)"
            strokeWidth="4"
            strokeDasharray={`${activePct}, 100`}
          />
        )}
      </svg>
      {/* Center Percentage Display */}
      <span
        className="tabular-nums"
        style={{
          position: "absolute",
          fontSize: "11px",
          fontWeight: 700,
          color: "var(--color-text-main)",
        }}
      >
        {total > 0 ? `${Math.round(activePct)}%` : "0%"}
      </span>
    </div>
  );
}
