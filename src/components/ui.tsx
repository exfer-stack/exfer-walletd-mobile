// Shared mobile UI primitives, ported from the prototype's components.jsx.

import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Icon } from "../lib/icons";
import { avatarData, AVATAR_GRID } from "../lib/format";
import { useToast } from "../lib/toast";

/* ── status bar ─────────────────────────────────────────────────── */
function clock(): string {
  const d = new Date();
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

export function StatusBar() {
  const [time, setTime] = useState<string>(() => clock());
  useEffect(() => {
    const id = window.setInterval(() => setTime(clock()), 15000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="statusbar">
      <span>{time}</span>
      <div className="sb-right">
        <svg width="18" height="13" viewBox="0 0 18 13" fill="currentColor">
          <rect x="0" y="9" width="3" height="4" rx="1" />
          <rect x="5" y="6" width="3" height="7" rx="1" />
          <rect x="10" y="3" width="3" height="10" rx="1" />
          <rect x="15" y="0" width="3" height="13" rx="1" />
        </svg>
        <svg
          width="17"
          height="13"
          viewBox="0 0 17 13"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        >
          <path d="M1.5 4.2A11 11 0 0 1 15.5 4.2" />
          <path d="M4 7A7 7 0 0 1 13 7" />
          <path d="M6.5 9.8A3 3 0 0 1 10.5 9.8" />
          <circle cx="8.5" cy="12" r="0.6" fill="currentColor" />
        </svg>
        <svg width="26" height="13" viewBox="0 0 26 13" fill="none">
          <rect
            x="0.5"
            y="0.5"
            width="21"
            height="12"
            rx="3.5"
            stroke="currentColor"
            opacity="0.4"
          />
          <rect x="2" y="2" width="16" height="9" rx="2" fill="currentColor" />
          <path
            d="M23.5 4.5v4a2 2 0 0 0 1.2-1.84v-.32A2 2 0 0 0 23.5 4.5Z"
            fill="currentColor"
            opacity="0.4"
          />
        </svg>
      </div>
    </div>
  );
}

/* ── app bar (in-screen header) ─────────────────────────────────── */
export function AppBar({
  title,
  subtitle,
  onBack,
  right,
  large,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onBack?: () => void;
  right?: ReactNode;
  large?: boolean;
}) {
  if (large) {
    return (
      <div style={{ padding: "12px 4px 14px" }}>
        <div className="h-row">
          <div className="title-xl">{title}</div>
          {right}
        </div>
        {subtitle && (
          <div className="dim" style={{ fontSize: 14, marginTop: 4 }}>
            {subtitle}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="h-row" style={{ padding: "6px 0 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        {onBack && (
          <button className="icon-btn" onClick={onBack} aria-label="Back">
            <Icon name="back" size={20} />
          </button>
        )}
        <div style={{ minWidth: 0 }}>
          <div className="title-lg" style={{ whiteSpace: "nowrap" }}>
            {title}
          </div>
          {subtitle && (
            <div className="faint" style={{ fontSize: 12.5 }}>
              {subtitle}
            </div>
          )}
        </div>
      </div>
      {right}
    </div>
  );
}

/* ── copy button ────────────────────────────────────────────────── */
export function CopyButton({
  text,
  label,
  className = "icon-btn",
  size = 18,
  toast = true,
}: {
  text: string;
  label?: string;
  className?: string;
  size?: number;
  toast?: boolean;
}) {
  const toasts = useToast();
  const [done, setDone] = useState(false);
  function copy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard?.writeText(text).catch(() => {});
    setDone(true);
    if (toast) toasts.success("Copied", label ?? "Copied to clipboard");
    window.setTimeout(() => setDone(false), 1300);
  }
  return (
    <button
      type="button"
      className={className}
      onClick={copy}
      aria-label="Copy"
      style={{ color: done ? "var(--accent)" : undefined }}
    >
      <Icon name={done ? "check" : "copy"} size={size} />
    </button>
  );
}

/* ── bottom sheet wrapper ───────────────────────────────────────── */
export function Sheet({
  title,
  subtitle,
  onClose,
  onBack,
  right,
  footer,
  children,
  height = "auto",
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  onClose?: () => void;
  onBack?: () => void;
  right?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  height?: string;
}) {
  // Play an exit animation before the parent unmounts us: flip `closing`,
  // then fire the real onClose once the ~230ms slide-down has run.
  const [closing, setClosing] = useState(false);
  const requestClose = useCallback(() => {
    if (!onClose) return;
    setClosing(true);
    window.setTimeout(onClose, 230);
  }, [onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);
  return (
    <>
      <div
        className={"scrim" + (closing ? " closing" : "")}
        onClick={requestClose}
      />
      <div
        className={"sheet" + (closing ? " closing" : "")}
        style={{ height }}
        role="dialog"
      >
        <div className="sheet-grip" />
        <div className="sheet-head">
          <div
            style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
          >
            {onBack && (
              <button className="icon-btn" onClick={onBack} aria-label="Back">
                <Icon name="back" size={20} />
              </button>
            )}
            <div style={{ minWidth: 0 }}>
              <div
                className="title-lg"
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {title}
              </div>
              {subtitle && (
                <div className="faint" style={{ fontSize: 12.5 }}>
                  {subtitle}
                </div>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {right}
            {onClose && (
              <button className="icon-btn" onClick={requestClose} aria-label="Close">
                <Icon name="close" size={19} />
              </button>
            )}
          </div>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </>
  );
}

/* ── centered modal dialog ──────────────────────────────────────── */
/** Track the visual viewport so a centered modal stays inside the area NOT
 *  covered by the on-screen keyboard. Without this the soft keyboard overlays
 *  the modal's lower half (e.g. the password field + Reveal button on the
 *  recovery-phrase sheet, or the revealed 24 words). Falls back to the full
 *  window when VisualViewport is unavailable (desktop). */
function useVisualViewport(): { top: number; height: number } {
  const [vv, setVv] = useState(() => ({
    top: 0,
    height: typeof window !== "undefined" ? window.innerHeight : 0,
  }));
  useEffect(() => {
    const v = window.visualViewport;
    if (!v) return;
    const apply = () => setVv({ top: v.offsetTop, height: v.height });
    apply();
    v.addEventListener("resize", apply);
    v.addEventListener("scroll", apply);
    return () => {
      v.removeEventListener("resize", apply);
      v.removeEventListener("scroll", apply);
    };
  }, []);
  return vv;
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  danger,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  danger?: boolean;
}) {
  const vv = useVisualViewport();
  return (
    <>
      <div className="scrim" onClick={onClose} style={{ zIndex: 70 }} />
      <div
        style={{
          // Pin to the VISIBLE viewport (above the keyboard), not the full
          // window — otherwise a centered modal centers behind the keyboard
          // and its lower half (input + actions) is unreachable.
          position: "fixed",
          left: 0,
          right: 0,
          top: vv.top,
          height: vv.height,
          zIndex: 71,
          display: "grid",
          placeItems: "center",
          // Clear the status bar + nav bar so a tall modal never tucks under
          // them; the card is capped to this padded area and scrolls inside.
          padding:
            "calc(20px + env(safe-area-inset-top)) 20px calc(20px + env(safe-area-inset-bottom))",
          pointerEvents: "none",
        }}
      >
        <div
          className="card fade-up"
          style={{
            width: "100%",
            maxWidth: 360,
            // Never exceed the padded area — tall content (e.g. the 24-word
            // recovery phrase) scrolls in the body instead of overflowing the
            // screen top/bottom and clipping the title.
            maxHeight: "100%",
            display: "flex",
            flexDirection: "column",
            pointerEvents: "auto",
            overflow: "hidden",
            background: "var(--elevated)",
          }}
        >
          <div style={{ padding: "18px 18px 0", flex: "0 0 auto" }}>
            <div className="h-row" style={{ marginBottom: 4 }}>
              <div
                className="title-lg"
                style={{ color: danger ? "#f87171" : undefined }}
              >
                {title}
              </div>
              <button className="icon-btn" onClick={onClose} aria-label="Close">
                <Icon name="close" size={18} />
              </button>
            </div>
          </div>
          <div style={{ padding: "8px 18px 18px", overflowY: "auto", flex: "1 1 auto" }}>
            {children}
          </div>
          {footer && (
            <div style={{ padding: "0 18px 18px", flex: "0 0 auto", display: "flex", gap: 10 }}>
              {footer}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* ── bottom action menu (⋯) ─────────────────────────────────────── */
export interface ActionMenuItem {
  icon?: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
}

export function ActionMenu({
  items,
  onClose,
  title,
}: {
  items: ActionMenuItem[];
  onClose: () => void;
  title?: string;
}) {
  return (
    <>
      <div className="scrim" onClick={onClose} style={{ zIndex: 70 }} />
      <div className="sheet fade-up" style={{ zIndex: 71, paddingBottom: 8 }}>
        <div className="sheet-grip" />
        {title && (
          <div
            className="faint"
            style={{ textAlign: "center", fontSize: 12.5, padding: "4px 0 8px" }}
          >
            {title}
          </div>
        )}
        <div style={{ padding: "4px 12px calc(16px + env(safe-area-inset-bottom))" }}>
          {items.map((it, i) => (
            <button
              key={i}
              className="tap"
              onClick={() => it.onClick()}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 13,
                padding: "15px 12px",
                background: "none",
                border: 0,
                borderRadius: 12,
                cursor: "pointer",
                font: "inherit",
                color: it.danger ? "#f87171" : "var(--text)",
                fontSize: 16,
                fontWeight: 500,
                textAlign: "left",
              }}
            >
              {it.icon && <Icon name={it.icon} size={21} />}
              {it.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/* ── small bits ─────────────────────────────────────────────────── */
export function PendingDot({ title }: { title?: string }) {
  // Cyan + breathing: "money arriving" is the one place a quiet screen
  // should light up with the brand accent, no words needed.
  return (
    <span
      title={title}
      className="pending-dot"
      style={{
        display: "inline-block",
        width: 6,
        height: 6,
        borderRadius: 999,
        background: "var(--accent)",
      }}
    />
  );
}

export function Field({
  label,
  help,
  children,
}: {
  label?: ReactNode;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      {label && <label className="field-label">{label}</label>}
      {children}
      {help && <div className="field-help">{help}</div>}
    </div>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <span
      className="spin"
      style={{
        display: "inline-block",
        width: size,
        height: size,
        border: "2px solid color-mix(in srgb,currentColor 30%,transparent)",
        borderTopColor: "currentColor",
        borderRadius: "50%",
      }}
    />
  );
}

export function SettingRow({
  icon,
  label,
  sub,
  right,
  onClick,
  danger,
}: {
  icon?: string;
  label: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
}) {
  return (
    <button
      className="list-row"
      onClick={onClick}
      style={{ cursor: onClick ? "pointer" : "default" }}
    >
      {icon && (
        <span
          style={{
            width: 38,
            height: 38,
            borderRadius: 11,
            display: "grid",
            placeItems: "center",
            background: "var(--surface-2)",
            color: danger ? "#f87171" : "var(--text-dim)",
            flex: "0 0 auto",
          }}
        >
          <Icon name={icon} size={20} />
        </span>
      )}
      <span style={{ minWidth: 0, flex: 1 }}>
        <span
          style={{
            display: "block",
            fontSize: 15.5,
            fontWeight: 500,
            color: danger ? "#f87171" : "var(--text)",
          }}
        >
          {label}
        </span>
        {sub && (
          <span
            className="faint"
            style={{
              display: "block",
              fontSize: 12.5,
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {sub}
          </span>
        )}
      </span>
      {right !== undefined
        ? right
        : onClick && <Icon name="chevron" size={18} stroke={2} />}
    </button>
  );
}

/* ── address avatar ─────────────────────────────────────────────── */
export function AddrAvatar({
  address,
  size = 40,
}: {
  address: string;
  size?: number;
}) {
  const { bg, fg, cells } = avatarData(address);
  const cell = 100 / AVATAR_GRID;
  const style: CSSProperties = {
    borderRadius: Math.round(size * 0.3),
    flex: "0 0 auto",
    display: "block",
    overflow: "hidden",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      style={style}
      aria-hidden="true"
    >
      <rect width="100" height="100" fill={bg} />
      {cells.map((c, i) => (
        <rect
          key={i}
          x={(c.x * cell).toFixed(2)}
          y={(c.y * cell).toFixed(2)}
          width={(cell + 0.5).toFixed(2)}
          height={(cell + 0.5).toFixed(2)}
          fill={fg}
        />
      ))}
    </svg>
  );
}

/* ── BNB coin mark ──────────────────────────────────────────────── */
/** The native Binance BNB coin mark — gold disc (#F3BA2F) with the official
 *  white diamond glyph. Official logo geometry (viewBox 126.61); the symbol is
 *  scaled to ~62% so it sits inside the disc with padding. */
export function BnbMark({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 126.61 126.61" style={{ flex: "0 0 auto", display: "block" }} aria-hidden="true">
      <circle cx="63.3" cy="63.3" r="63.3" fill="#F3BA2F" />
      <g fill="#fff" transform="translate(63.3 63.3) scale(0.62) translate(-63.3 -63.3)">
        <path d="M38.73 53.2 63.32 28.62 87.92 53.22 102.22 38.91 63.32 0 24.42 38.9z" />
        <path d="M0 63.31 14.3 49l14.31 14.31L14.3 77.61z" />
        <path d="M38.73 73.41 63.32 98l24.6-24.6 14.31 14.29-.01.01-38.9 38.91-38.91-38.88-.02-.02z" />
        <path d="M98 63.31 112.3 49l14.31 14.3-14.31 14.32z" />
        <path d="M77.83 63.3 63.32 48.78 52.59 59.51l-1.24 1.23-2.54 2.54-.02.02.02.03 14.51 14.5z" />
      </g>
    </svg>
  );
}

/* ── review-row (key/value line inside a card) ──────────────────── */
export function RvRow({
  label,
  value,
  mono,
  strong,
  last,
}: {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
  strong?: boolean;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "12px 15px",
        borderBottom: last ? "0" : "1px solid var(--border-soft)",
      }}
    >
      <span className="dim" style={{ fontSize: 13.5 }}>
        {label}
      </span>
      <span
        className={mono ? "mono" : ""}
        style={{
          fontSize: strong ? 15.5 : 14,
          fontWeight: strong ? 700 : 500,
          color: "var(--text)",
        }}
      >
        {value}
      </span>
    </div>
  );
}
