"use client";

import React from "react";
import Link from "next/link";
import {
  LayoutDashboard,
  PackagePlus,
  ShieldCheck,
  ArrowLeftRight,
  Package,
} from "lucide-react";

export interface NavItem {
  key: "overview" | "create" | "admin" | "transfers" | "inventory";
  label: string;
  href: string;
  icon: React.ComponentType<{ size?: number; "aria-hidden"?: boolean | "true" | "false" }>;
  badge?: number;
}

interface SidebarProps {
  activeMode: string;
  canCreateUnit: boolean;
  pendingTransfersCount?: number;
}

export function Sidebar({ activeMode, canCreateUnit }: SidebarProps) {
  const navItems: NavItem[] = [
    { key: "overview", label: "Overview", href: "/", icon: LayoutDashboard },
    ...(canCreateUnit
      ? [{ key: "create" as const, label: "Create Unit", href: "/create", icon: PackagePlus }]
      : []),
    { key: "admin", label: "Admin", href: "/admin", icon: ShieldCheck },
    { key: "transfers", label: "Transfers", href: "/transfers", icon: ArrowLeftRight },
    { key: "inventory", label: "Inventory", href: "/inventory", icon: Package },
  ];

  return (
    <aside
      className="desktop-sidebar"
      style={{
        width: "240px",
        flexShrink: 0,
        backgroundColor: "var(--color-bg-surface)",
        borderRight: "1px solid var(--color-border-default)",
        padding: "var(--space-6) var(--space-4)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
      }}
      aria-label="Main Navigation"
    >
      <nav style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
        {navItems.map((item) => {
          const isActive = activeMode === item.key;
          const Icon = item.icon;

          return (
            <Link
              key={item.key}
              href={item.href}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-3)",
                padding: "var(--space-3) var(--space-4)",
                minHeight: "44px",
                borderRadius: "var(--radius-control)",
                fontFamily: "var(--font-sans)",
                fontSize: "var(--text-sm)",
                fontWeight: isActive ? 600 : 500,
                color: isActive ? "var(--color-primary-fg)" : "var(--color-text-main)",
                backgroundColor: isActive ? "var(--color-primary)" : "transparent",
                transition: "var(--transition-all-safe)",
                textDecoration: "none",
              }}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon size={18} aria-hidden={true} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
