"use client";

import React from "react";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  padding?: "none" | "sm" | "md" | "lg";
  as?: React.ElementType;
}

export function Card({
  padding = "md",
  as: Component = "div",
  children,
  className = "",
  style,
  ...props
}: CardProps) {
  const paddingMap = {
    none: "0px",
    sm: "var(--space-3)",
    md: "var(--space-6)",
    lg: "var(--space-8)",
  };

  const cardStyle: React.CSSProperties = {
    backgroundColor: "var(--color-bg-surface)",
    border: "1px solid var(--color-border-default)",
    borderRadius: "var(--radius-surface)",
    boxShadow: "var(--shadow-sm)",
    padding: paddingMap[padding],
    transition: "var(--transition-border)",
    ...style,
  };

  return (
    <Component style={cardStyle} className={`ui-card ${className}`} {...props}>
      {children}
    </Component>
  );
}
