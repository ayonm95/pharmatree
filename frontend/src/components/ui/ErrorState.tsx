"use client";

import React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "./Button";

export interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
}

export function ErrorState({
  title = "Failed to load data",
  message,
  onRetry,
  retrying = false,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--space-8) var(--space-6)",
        textAlign: "center",
        backgroundColor: "var(--color-danger-bg)",
        border: "1px solid var(--color-danger-border)",
        borderRadius: "var(--radius-surface)",
        color: "var(--color-danger-fg)",
        margin: "var(--space-4) 0",
      }}
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "40px",
          height: "40px",
          borderRadius: "var(--radius-full)",
          backgroundColor: "#fee2e2",
          color: "var(--color-danger-fg)",
          marginBottom: "var(--space-3)",
        }}
        aria-hidden="true"
      >
        <AlertTriangle size={20} />
      </div>
      <h4
        style={{
          margin: 0,
          fontSize: "var(--text-base)",
          fontWeight: 700,
        }}
      >
        {title}
      </h4>
      <p
        style={{
          margin: "var(--space-2) 0 var(--space-4) 0",
          fontSize: "var(--text-sm)",
          lineHeight: "var(--line-sm)",
          maxWidth: "460px",
          color: "inherit",
          opacity: 0.9,
        }}
      >
        {message}
      </p>
      {onRetry && (
        <Button
          variant="secondary"
          size="sm"
          icon={<RefreshCw size={14} />}
          loading={retrying}
          onClick={onRetry}
          style={{
            borderColor: "var(--color-danger-border)",
            color: "var(--color-danger-fg)",
          }}
        >
          Retry Connection
        </Button>
      )}
    </div>
  );
}
