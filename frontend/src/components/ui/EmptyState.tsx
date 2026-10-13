"use client";

import React from "react";
import { Button } from "./Button";

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  actionHref?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  onAction,
}: EmptyStateProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--space-12) var(--space-6)",
        textAlign: "center",
        backgroundColor: "var(--color-bg-surface)",
        border: "1px dashed var(--color-border-strong)",
        borderRadius: "var(--radius-surface)",
        margin: "var(--space-4) 0",
      }}
    >
      {icon && (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "48px",
            height: "48px",
            borderRadius: "var(--radius-full)",
            backgroundColor: "var(--color-primary-subtle)",
            color: "var(--color-primary)",
            marginBottom: "var(--space-4)",
          }}
          aria-hidden="true"
        >
          {icon}
        </div>
      )}
      <h3
        style={{
          margin: 0,
          fontSize: "var(--text-base)",
          lineHeight: "var(--line-base)",
          fontWeight: 700,
          color: "var(--color-text-main)",
        }}
      >
        {title}
      </h3>
      <p
        style={{
          margin: "var(--space-2) 0 var(--space-6) 0",
          fontSize: "var(--text-sm)",
          lineHeight: "var(--line-sm)",
          color: "var(--color-text-muted)",
          maxWidth: "420px",
        }}
      >
        {description}
      </p>
      {actionLabel && onAction && (
        <Button variant="primary" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
