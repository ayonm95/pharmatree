"use client";

import { useEffect, useRef } from "react";

interface HardwareScannerOptions {
  onScan: (scannedText: string) => void;
  minChars?: number;
  maxIntervalMs?: number;
  enabled?: boolean;
}

/**
 * Hook to automatically listen for USB & Bluetooth hardware 2D barcode / QR scanners
 * using Keyboard Wedge protocol. Captures high-speed keystroke bursts and fires onScan.
 */
export function useHardwareBarcodeScanner({
  onScan,
  minChars = 1,
  maxIntervalMs = 60,
  enabled = true,
}: HardwareScannerOptions) {
  const bufferRef = useRef<string>("");
  const lastKeyTimeRef = useRef<number>(0);

  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(e: KeyboardEvent) {
      // Ignore modifier keys
      if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") {
        return;
      }

      const now = performance.now();
      const timeSinceLastKey = now - lastKeyTimeRef.current;
      lastKeyTimeRef.current = now;

      // If characters took too long, reset the buffer (human typing or stray key)
      if (timeSinceLastKey > maxIntervalMs && bufferRef.current.length > 0) {
        bufferRef.current = "";
      }

      // Enter indicates completion of barcode transmission
      if (e.key === "Enter") {
        const text = bufferRef.current.trim();
        if (text.length >= minChars) {
          e.preventDefault();
          onScan(text);
          bufferRef.current = "";
          return;
        }
        bufferRef.current = "";
        return;
      }

      // Handle GS1 Group Separator (ASCII 29 / 0x1D) from 2D optical barcode scanners
      if (e.key === "GroupSeparator" || e.keyCode === 29 || e.key === "\x1d") {
        bufferRef.current += "\x1d";
        return;
      }

      // Append printable single characters
      if (e.key.length === 1) {
        bufferRef.current += e.key;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onScan, minChars, maxIntervalMs, enabled]);
}
