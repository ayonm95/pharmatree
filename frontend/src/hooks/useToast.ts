"use client";

import { useState, useCallback } from "react";

export type ToastTone = "success" | "error" | "info" | "warning";

export type ToastItem = {
  id: string;
  message: string;
  tone: ToastTone;
  txHash?: string;
};

export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const showToast = useCallback((message: string, tone: ToastTone = "success", txHash?: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const newToast: ToastItem = { id, message, tone, txHash };
    
    setToasts((prev) => [...prev, newToast]);

    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return {
    toasts,
    showToast,
    dismissToast,
    addToast: showToast,
    removeToast: dismissToast,
  };
}
