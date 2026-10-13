"use client";

import React, { useEffect, useRef } from "react";
import Link from "next/link";
import {
  X,
  LayoutDashboard,
  PackagePlus,
  ShieldCheck,
  ArrowLeftRight,
  Package,
} from "lucide-react";

interface MobileNavDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  activeMode: string;
  canCreateUnit: boolean;
}

export function MobileNavDrawer({
  isOpen,
  onClose,
  activeMode,
  canCreateUnit,
}: MobileNavDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      drawerRef.current?.focus();
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") onClose();
      };
      document.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";
      return () => {
        document.removeEventListener("keydown", handleKeyDown);
        document.body.style.overflow = "unset";
      };
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const navItems = [
    { key: "overview", label: "Overview", href: "/", icon: LayoutDashboard },
    ...(canCreateUnit
      ? [{ key: "create" as const, label: "Create Unit", href: "/create", icon: PackagePlus }]
      : []),
    { key: "admin", label: "Admin", href: "/admin", icon: ShieldCheck },
    { key: "transfers", label: "Transfers", href: "/transfers", icon: ArrowLeftRight },
    { key: "inventory", label: "Inventory", href: "/inventory", icon: Package },
  ];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(15, 23, 42, 0.45)",
        zIndex: "var(--z-drawer)",
        display: "flex",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation Menu"
        tabIndex={-1}
        style={{
          width: "280px",
          maxWidth: "80vw",
          height: "100%",
          backgroundColor: "var(--color-bg-surface)",
          borderRight: "1px solid var(--color-border-default)",
          padding: "var(--space-6) var(--space-4)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-4)",
          boxShadow: "var(--shadow-md)",
          outline: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontWeight: 700, fontSize: "var(--text-base)", color: "var(--color-text-main)" }}>
            Menu
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: "44px",
              height: "44px",
              borderRadius: "var(--radius-control)",
              border: "1px solid var(--color-border-default)",
              backgroundColor: "transparent",
              cursor: "pointer",
              color: "var(--color-text-muted)",
            }}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <nav style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          {navItems.map((item) => {
            const isActive = activeMode === item.key;
            const Icon = item.icon;

            return (
              <Link
                key={item.key}
                href={item.href}
                onClick={onClose}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-3)",
                  padding: "var(--space-3) var(--space-4)",
                  minHeight: "44px",
                  borderRadius: "var(--radius-control)",
                  fontSize: "var(--text-sm)",
                  fontWeight: isActive ? 600 : 500,
                  color: isActive ? "var(--color-primary-fg)" : "var(--color-text-main)",
                  backgroundColor: isActive ? "var(--color-primary)" : "transparent",
                  textDecoration: "none",
                  transition: "var(--transition-all-safe)",
                }}
                aria-current={isActive ? "page" : undefined}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
