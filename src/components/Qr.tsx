import { useEffect, useState } from "react";
import QRCode from "qrcode";

/** Renders a QR code for `value` as a PNG data URL via the `qrcode` package. */
export function Qr({ value, size = 222 }: { value: string; size?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, {
      // A quiet zone is mandatory: scanners locate the finder patterns by
      // the white border around them. margin:0 left no quiet zone, so the
      // code was hard/impossible to scan off a screen even when aligned.
      // 4 modules is the spec minimum.
      margin: 4,
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
