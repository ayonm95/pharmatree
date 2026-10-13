"use client";

import React from "react";
import { CheckCircle2, AlertCircle, Info, X, ExternalLink } from "lucide-react";
import { ToastItem } from "@/hooks/useToast";

interface ToastProps {
  toasts: ToastItem[];
  onDismiss?: (id: string) => void;
  onClose?: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss, onClose }: ToastProps) {
  const dismiss = onDismiss || onClose || (() => {});
  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        right: "var(--space-6)",
        bottom: "var(--space-6)",
        zIndex: "var(--z-toast)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        maxWidth: "min(440px, calc(100vw - 32px))",
      }}
    >
      {toasts.map((toast) => {
        const isError = toast.tone === "error";
        const Icon = isError ? AlertCircle : toast.tone === "info" ? Info : CheckCircle2;

        const borderStyle = isError
          ? "var(--color-danger-border)"
          : toast.tone === "warning"
          ? "var(--color-warning-border)"
          : "var(--color-success-border)";

        const bgStyle = isError
          ? "var(--color-danger-bg)"
          : toast.tone === "warning"
          ? "var(--color-warning-bg)"
          : "var(--color-success-bg)";

        const fgStyle = isError
          ? "var(--color-danger-fg)"
          : toast.tone === "warning"
          ? "var(--color-warning-fg)"
          : "var(--color-success-fg)";

        return (
          <div
            key={toast.id}
            role={isError ? "alert" : "status"}
            aria-live={isError ? "assertive" : "polite"}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "var(--space-3)",
              padding: "var(--space-3) var(--space-4)",
              backgroundColor: bgStyle,
              border: `1px solid ${borderStyle}`,
              borderRadius: "var(--radius-surface)",
              boxShadow: "var(--shadow-md)",
              color: fgStyle,
              transition: "var(--transition-all-safe)",
            }}
          >
            <Icon size={18} style={{ flexShrink: 0, marginTop: "2px" }} aria-hidden="true" />
            <div style={{ flex: 1, fontSize: "var(--text-sm)", lineHeight: "var(--line-sm)" }}>
              <div style={{ fontWeight: 600 }}>{toast.message}</div>
              {toast.txHash && (
                <a
                  href={`https://sepolia.etherscan.io/tx/${toast.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    marginTop: "var(--space-1)",
                    fontSize: "var(--text-xs)",
                    color: "inherit",
                    textDecoration: "underline",
                  }}
                >
                  View on Sepolia Etherscan <ExternalLink size={12} aria-hidden="true" />
                </a>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss notification"
              style={{
                background: "transparent",
                border: "none",
                color: "inherit",
                cursor: "pointer",
                padding: "2px",
                display: "inline-flex",
                alignItems: "center",
                opacity: 0.7,
              }}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
