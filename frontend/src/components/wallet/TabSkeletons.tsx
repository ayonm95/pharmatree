"use client";

import React from "react";
import { Card } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";

export function OverviewSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }} className="fade-in">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
          gap: "var(--space-6)",
        }}
      >
        {/* Left Card: Production Batches Skeleton */}
        <Card padding="md" style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)", minHeight: "340px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
            <Skeleton width="36px" height="36px" borderRadius="var(--radius-control)" />
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)", flex: 1 }}>
              <Skeleton width="160px" height="18px" />
              <Skeleton width="220px" height="14px" />
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", marginTop: "var(--space-2)" }}>
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                style={{
                  padding: "var(--space-3) var(--space-4)",
                  border: "1px solid var(--color-border-default)",
                  borderRadius: "var(--radius-control)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                  <Skeleton width="32px" height="16px" />
                  <Skeleton width="120px" height="16px" />
                  <Skeleton width="80px" height="14px" />
                </div>
                <Skeleton width="70px" height="22px" borderRadius="var(--radius-pill)" />
              </div>
            ))}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              paddingTop: "var(--space-4)",
              borderTop: "1px solid var(--color-border-default)",
              marginTop: "auto",
            }}
          >
            <Skeleton width="140px" height="16px" />
            <Skeleton width="90px" height="32px" borderRadius="var(--radius-control)" />
          </div>
        </Card>

        {/* Right Card: Current Inventory Skeleton */}
        <Card padding="md" style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)", minHeight: "340px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
              <Skeleton width="36px" height="36px" borderRadius="var(--radius-control)" />
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                <Skeleton width="150px" height="18px" />
                <Skeleton width="200px" height="14px" />
              </div>
            </div>
            <Skeleton width="64px" height="28px" borderRadius="var(--radius-control)" />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
            <Skeleton width="100%" height="32px" borderRadius="var(--radius-control)" />
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 2fr 1fr 1fr",
                  gap: "var(--space-3)",
                  padding: "var(--space-2) var(--space-3)",
                }}
              >
                <Skeleton width="40px" height="14px" />
                <Skeleton width="100px" height="14px" />
                <Skeleton width="30px" height="14px" style={{ justifySelf: "end" }} />
                <Skeleton width="70px" height="14px" />
              </div>
            ))}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              paddingTop: "var(--space-4)",
              borderTop: "1px solid var(--color-border-default)",
              marginTop: "auto",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
              <Skeleton width="110px" height="14px" />
              <Skeleton width="70px" height="20px" />
              <Skeleton width="160px" height="14px" />
            </div>
            <Skeleton width="80px" height="80px" borderRadius="var(--radius-full)" />
          </div>
        </Card>
      </div>
    </div>
  );
}

export function InventorySkeleton() {
  return (
    <Card padding="md" className="fade-in">
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginBottom: "var(--space-5)" }}>
        <Skeleton width="40px" height="40px" borderRadius="var(--radius-control)" />
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
          <Skeleton width="200px" height="20px" />
          <Skeleton width="320px" height="14px" />
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            style={{
              padding: "var(--space-4)",
              border: "1px solid var(--color-border-default)",
              borderRadius: "var(--radius-surface)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)" }}>
              <Skeleton width="20px" height="20px" />
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                <Skeleton width="140px" height="16px" />
                <Skeleton width="90px" height="12px" />
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
              <Skeleton width="80px" height="24px" borderRadius="var(--radius-pill)" />
              <Skeleton width="32px" height="32px" borderRadius="var(--radius-control)" />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function TransfersSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }} className="fade-in">
      <Card padding="lg">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginBottom: "var(--space-5)" }}>
          <Skeleton width="40px" height="40px" borderRadius="var(--radius-control)" />
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
            <Skeleton width="220px" height="20px" />
            <Skeleton width="340px" height="14px" />
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "var(--space-4)" }}>
          <Skeleton width="100%" height="44px" borderRadius="var(--radius-control)" />
          <Skeleton width="100%" height="44px" borderRadius="var(--radius-control)" />
        </div>
      </Card>
    </div>
  );
}
