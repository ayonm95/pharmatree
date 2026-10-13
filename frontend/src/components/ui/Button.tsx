"use client";

import React from "react";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger" | "ghost" | "outline";
  size?: "sm" | "md" | "lg";
  icon?: React.ReactNode;
  loading?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  icon,
  loading = false,
  children,
  className = "",
  disabled,
  style,
  ...props
}: ButtonProps) {
  const baseStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--space-2)",
    borderRadius: "var(--radius-control)",
    fontFamily: "var(--font-sans)",
    fontWeight: 600,
    cursor: disabled || loading ? "not-allowed" : "pointer",
    opacity: disabled || loading ? 0.6 : 1,
    border: "1px solid transparent",
    minHeight: "44px",
    transition: "var(--transition-all-safe)",
    textDecoration: "none",
    userSelect: "none",
    ...style,
  };

  const sizeStyles: Record<string, React.CSSProperties> = {
    sm: {
      padding: "var(--space-1) var(--space-3)",
      fontSize: "var(--text-xs)",
      lineHeight: "var(--line-xs)",
    },
    md: {
      padding: "var(--space-2) var(--space-4)",
      fontSize: "var(--text-sm)",
      lineHeight: "var(--line-sm)",
    },
    lg: {
      padding: "var(--space-3) var(--space-6)",
      fontSize: "var(--text-base)",
      lineHeight: "var(--line-base)",
    },
  };

  const variantStyles: Record<string, React.CSSProperties> = {
    primary: {
      backgroundColor: "var(--color-primary)",
      color: "var(--color-primary-fg)",
      borderColor: "var(--color-primary)",
    },
    secondary: {
      backgroundColor: "var(--color-bg-surface)",
      color: "var(--color-text-main)",
      borderColor: "var(--color-border-strong)",
      boxShadow: "var(--shadow-sm)",
    },
    danger: {
      backgroundColor: "var(--color-danger-bg)",
      color: "var(--color-danger-fg)",
      borderColor: "var(--color-danger-border)",
    },
    ghost: {
      backgroundColor: "transparent",
      color: "var(--color-text-muted)",
      borderColor: "transparent",
    },
    outline: {
      backgroundColor: "transparent",
      color: "var(--color-text-main)",
      borderColor: "var(--color-border-default)",
    },
  };

  return (
    <button
      disabled={disabled || loading}
      style={{
        ...baseStyle,
        ...sizeStyles[size],
        ...variantStyles[variant],
      }}
      className={`btn-${variant} ${className}`}
      {...props}
    >
      {loading ? (
        <span
          style={{
            display: "inline-block",
            width: "16px",
            height: "16px",
            border: "2px solid currentColor",
            borderRightColor: "transparent",
            borderRadius: "var(--radius-full)",
            animation: "spin 0.75s linear infinite",
          }}
          aria-hidden="true"
        />
      ) : (
        icon && <span style={{ display: "inline-flex", flexShrink: 0 }} aria-hidden="true">{icon}</span>
      )}
      {children}
    </button>
  );
}
