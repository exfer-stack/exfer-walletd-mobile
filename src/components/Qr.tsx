import { useEffect, useState } from "react";
import QRCode from "qrcode";

/** Renders a QR code for `value` as a PNG data URL via the `qrcode` package. */
export function Qr({ value, size = 222 }: { value: string; size?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    // A 64-hex address encodes far more compactly in QR alphanumeric mode
    // (uppercase A–F) than byte mode (lowercase) — ~31% fewer bits, so a
    // lower version with bigger, easier-to-scan modules. Addresses are
    // case-insensitive and the scanner lowercases on the way back in
    // (parseScannedAddress), so this is display-neutral.
    const encoded = /^[0-9a-fA-F]{64}$/.test(value) ? value.toUpperCase() : value;
    QRCode.toDataURL(encoded, {
      // A small quiet zone so scanners can still locate the finder patterns
      // (margin:0 left none, which is why it wouldn't scan), but kept tight
      // (2, not the spec's 4) since the QR already sits inside a white card —
      // a big white border looks heavy.
      margin: 2,
      width: size,
      color: { dark: "#0a0a0b", light: "#ffffff" },
    })
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);
  if (!url) {
    // Placeholder sits inside a white QR card, so keep it a light neutral.
    return (
      <div
        style={{ width: size, height: size, background: "#f1f1f4", borderRadius: 8 }}
      />
    );
  }
  return (
    <img
      src={url}
      width={size}
      height={size}
      alt="QR code"
      className="qr-img"
      style={{ width: size, height: size, display: "block" }}
      draggable={false}
    />
  );
}
