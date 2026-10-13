"use client";

import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  subtitle?: string;
  children: React.ReactNode;
  maxWidth?: string;
}

export function Modal({
  isOpen,
  onClose,
  title,
  description,
  subtitle,
  children,
  maxWidth = "520px",
}: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElement = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      previouslyFocusedElement.current = document.activeElement as HTMLElement;
      // Focus modal content
      modalRef.current?.focus();

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          onClose();
        }

        // Basic Focus Trap within modal
        if (event.key === "Tab" && modalRef.current) {
          const focusableElements = modalRef.current.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          );
          if (focusableElements.length === 0) return;

          const first = focusableElements[0];
          const last = focusableElements[focusableElements.length - 1];

          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      };

      document.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";

      return () => {
        document.removeEventListener("keydown", handleKeyDown);
        document.body.style.overflow = "unset";
        previouslyFocusedElement.current?.focus();
      };
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(15, 23, 42, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--space-4)",
        zIndex: "var(--z-modal)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        aria-describedby={description ? "modal-description" : undefined}
        tabIndex={-1}
        style={{
          backgroundColor: "var(--color-bg-surface)",
          border: "1px solid var(--color-border-default)",
          borderRadius: "var(--radius-surface)",
          boxShadow: "var(--shadow-md)",
          width: "100%",
          maxWidth,
          maxHeight: "calc(100vh - 48px)",
          display: "flex",
          flexDirection: "column",
          outline: "none",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "var(--space-4) var(--space-6)",
            borderBottom: "1px solid var(--color-border-default)",
          }}
        >
          <div>
            <h2
              id="modal-title"
              style={{
                margin: 0,
                fontSize: "var(--text-lg)",
                lineHeight: "var(--line-lg)",
                fontWeight: 700,
                color: "var(--color-text-main)",
              }}
            >
              {title}
            </h2>
            {(description || subtitle) && (
              <p
                id="modal-description"
                style={{
                  margin: "var(--space-1) 0 0 0",
                  fontSize: "var(--text-sm)",
                  color: "var(--color-text-muted)",
                }}
              >
                {description || subtitle}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: "36px",
              height: "36px",
              borderRadius: "var(--radius-control)",
              border: "1px solid var(--color-border-default)",
              backgroundColor: "transparent",
              color: "var(--color-text-muted)",
              cursor: "pointer",
              transition: "var(--transition-all-safe)",
            }}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div
          style={{
            padding: "var(--space-6)",
            overflowY: "auto",
            flex: 1,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
