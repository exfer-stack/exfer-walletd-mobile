// Branded QR scan overlay. Uses the barcode-scanner plugin in windowed
// mode: the live camera renders BEHIND the webview, so we hide the app
// (the `scanning` class) and draw our own framing here — a cyan target,
// a label, and a Cancel button — matching the rest of the app instead of
// the OS's bare fullscreen scanner.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  startWindowedScan,
  cancelScan,
  decodeQrFromImageFile,
} from "../lib/scan";

export function ScannerOverlay({
  onResult,
}: {
  onResult: (address: string | null) => void;
}) {
  // The live camera and the photo-import path race; only the first to find
  // a QR should win.
  const doneRef = useRef(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  function finish(addr: string | null) {
    if (doneRef.current) return;
    doneRef.current = true;
    onResult(addr);
  }

  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("scanning");
    startWindowedScan().then((addr) => {
      // Only auto-finish on a real hit. A null means the camera scan
      // ended / isn't available (e.g. plain browser) — keep the overlay
      // open so the user can still import a photo instead.
      if (addr) finish(addr);
    });
    return () => {
      doneRef.current = true;
      html.classList.remove("scanning");
      void cancelScan();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setMsg(null);
    const addr = await decodeQrFromImageFile(file);
    if (addr) finish(addr);
    else setMsg("No QR code found in that photo — try another.");
  }

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
        Point at the sender&apos;s QR, or import a photo
      </div>
      {msg && (
        <div
          style={{
            position: "absolute",
            left: 24,
            right: 24,
            top: "calc(50% + 182px)",
            textAlign: "center",
            color: "#ffd5d5",
            fontSize: 13,
            fontWeight: 600,
            textShadow: "0 1px 4px rgba(0,0,0,.6)",
          }}
        >
          {msg}
        </div>
      )}
      {/* Hidden picker: on mobile webviews this opens the native photo
          gallery (or camera). Decoded with jsQR — see decodeQrFromImageFile. */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        onChange={onPickPhoto}
        style={{ display: "none" }}
      />
      <div
        style={{
          position: "absolute",
          left: "50%",
          transform: "translateX(-50%)",
          bottom: "calc(40px + env(safe-area-inset-bottom))",
          pointerEvents: "auto",
          display: "flex",
          gap: 12,
        }}
      >
        <button
          onClick={() => fileRef.current?.click()}
          className="tap"
          style={{
            padding: "13px 24px",
            borderRadius: 999,
            background: "rgba(255,255,255,.14)",
            color: "#fff",
            fontWeight: 600,
            fontSize: 15,
            border: "1px solid rgba(255,255,255,.25)",
            cursor: "pointer",
          }}
        >
          Photo
        </button>
        <button
          onClick={() => finish(null)}
          className="tap"
          style={{
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
      </div>
    </div>,
    document.body,
  );
}
