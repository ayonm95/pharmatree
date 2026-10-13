"use client";

import React from "react";

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  width?: string | number;
  height?: string | number;
  borderRadius?: string;
}

export function Skeleton({
  width = "100%",
  height = "20px",
  borderRadius = "var(--radius-control)",
  style,
  className = "",
  ...props
}: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      style={{
        width,
        height,
        borderRadius,
        backgroundColor: "var(--color-bg-muted)",
        border: "1px solid var(--color-border-default)",
        position: "relative",
        overflow: "hidden",
        ...style,
      }}
      className={`skeleton-pulse ${className}`}
      {...props}
    />
  );
}
