// Branded QR scan overlay.
//
// Primary path: getUserMedia + jsQR. We pull the live camera into a <video>
// element inside the webview and decode every ~150ms with jsQR — the SAME
// decoder that reads gallery photos reliably. This sidesteps the native
// barcode-scanner plugin's weaker live path (fixed 720p analysis + flaky
// close-range autofocus) that couldn't read a QR off a screen.
//
// Fallback path: if the webview can't open the camera (some Android
// WebViews block getUserMedia), we drop back to the native plugin in
// windowed mode (camera renders BEHIND a transparent webview — the
// `scanning` class) so behaviour is never worse than before.
//
// Either way: a Photo button (decode a gallery image) and Cancel.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  startWindowedScan,
  cancelScan,
  decodeQrFromImageFile,
  parseScannedAddress,
} from "../lib/scan";

type Mode = "starting" | "live" | "native";

export function ScannerOverlay({
  onResult,
}: {
  onResult: (address: string | null) => void;
}) {
  // Every input path (live frames, native plugin, photo) races; only the
  // first to find a QR wins.
  const doneRef = useRef(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastScanRef = useRef(0);
  const [mode, setMode] = useState<Mode>("starting");
  const [msg, setMsg] = useState<string | null>(null);

  function teardown() {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    document.documentElement.classList.remove("scanning");
    void cancelScan();
  }

  function finish(addr: string | null) {
    if (doneRef.current) return;
    doneRef.current = true;
    teardown();
    onResult(addr);
  }

  useEffect(() => {
    let cancelled = false;

    async function startLive(): Promise<boolean> {
      if (!navigator.mediaDevices?.getUserMedia) return false;
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
      } catch {
        return false; // no permission / not supported → caller falls back
      }
      if (cancelled || doneRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return true;
      }
      streamRef.current = stream;
      setMode("live");

      const jsQR = (await import("jsqr")).default;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      // The <video> mounts when mode flips to "live"; wait a tick for the ref.
      await new Promise((r) => setTimeout(r, 0));
      const video = videoRef.current;
      if (!video || !ctx) return true;
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        /* autoplay is allowed (muted) — ignore transient errors */
      }

      const tick = () => {
        if (doneRef.current) return;
        const now = performance.now();
        // ~6-7 scans/sec is plenty and keeps the phone cool.
        if (now - lastScanRef.current >= 150 && video.videoWidth > 0) {
          lastScanRef.current = now;
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const r = jsQR(img.data, img.width, img.height, {
            inversionAttempts: "attemptBoth",
          });
          const addr = parseScannedAddress(r?.data);
          if (addr) {
            finish(addr);
            return;
          }
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      return true;
    }

    (async () => {
      const live = await startLive();
      if (cancelled || doneRef.current) return;
      if (!live) {
        // Fall back to the native plugin (camera behind a transparent webview).
        setMode("native");
        document.documentElement.classList.add("scanning");
        startWindowedScan().then((addr) => {
          if (addr) finish(addr);
        });
      }
    })();

    return () => {
      cancelled = true;
      doneRef.current = true;
      teardown();
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

  // Cancel always closes, even if a result race flipped the guard.
  function cancel() {
    doneRef.current = true;
    teardown();
    onResult(null);
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
      {/* Live camera preview (getUserMedia path). In the native-fallback
          path the webview is transparent and the OS camera shows behind, so
          no <video> is rendered. */}
      {mode === "live" && (
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          style={{
            position: "fixed",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            zIndex: -1,
            background: "#000",
          }}
        />
      )}

      {/* Target window; the huge box-shadow dims everything around it. */}
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
        {mode === "starting"
          ? "Starting camera…"
          : "Point at the QR, or import a photo"}
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
      {/* Hidden picker: opens the native photo gallery. Decoded with jsQR. */}
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
          onClick={() => {
            setMsg(null);
            fileRef.current?.click();
          }}
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
          onClick={cancel}
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
