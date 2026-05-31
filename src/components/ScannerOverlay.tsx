// Branded QR scan overlay. Uses the barcode-scanner plugin in windowed
// mode: the live camera renders BEHIND the webview, so we hide the app
// (the `scanning` class) and draw our own framing here — a cyan target,
// a label, and a Cancel button — matching the rest of the app instead of
// the OS's bare fullscreen scanner.

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { startWindowedScan, cancelScan } from "../lib/scan";

export function ScannerOverlay({
  onResult,
}: {
  onResult: (address: string | null) => void;
}) {
  useEffect(() => {
    let done = false;
    const html = document.documentElement;
    html.classList.add("scanning");
    startWindowedScan().then((addr) => {
      if (!done) onResult(addr);
    });
    return () => {
      done = true;
      html.classList.remove("scanning");
      void cancelScan();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        pointerEvents: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Transparent target window; the huge box-shadow dims everything
          around it so the camera reads through the clear square. */}
      <div
        style={{
          width: 250,
          height: 250,
          borderRadius: 28,
          border: "2px solid var(--accent)",
          boxShadow: "0 0 0 100vmax rgba(0,0,0,.55)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: "calc(50% + 152px)",
          textAlign: "center",
          color: "#fff",
          fontSize: 15,
          fontWeight: 600,
          letterSpacing: "-.01em",
          textShadow: "0 1px 4px rgba(0,0,0,.6)",
        }}
      >
        Point at the sender&apos;s QR
      </div>
      <button
        onClick={() => onResult(null)}
        className="tap"
        style={{
          position: "absolute",
          left: "50%",
          transform: "translateX(-50%)",
          bottom: "calc(40px + env(safe-area-inset-bottom))",
          pointerEvents: "auto",
          padding: "13px 30px",
          borderRadius: 999,
          background: "var(--accent)",
          color: "var(--accent-ink)",
          fontWeight: 600,
          fontSize: 15,
          border: 0,
          cursor: "pointer",
        }}
      >
        Cancel
      </button>
    </div>,
    document.body,
  );
}
