// Swap tab — the exchange home. Keeps EXFER↔BNB swapping, in-flight swaps, and
// liquidity in their own place so the wallet tab stays a clean EXFER wallet.
// (The BNB asset card stays on the wallet tab as a holding.)

import { useEffect, useState } from "react";
import { Icon } from "../lib/icons";
import { rpc } from "../lib/rpc";
import { usePrice, useBnbUsd } from "../lib/market";
import { useT, type MsgKey } from "../lib/i18n";
import { Spinner } from "./ui";

interface InflightSwap {
  swap_id: string;
  direction: "exfer_to_bnb" | "bnb_to_exfer";
  status: string;
  amount_in: string;
  amount_out: string;
}

function fmtAmt(s: string, dp = 4): string {
  if (!s) return s;
  const [w, f = ""] = s.split(".");
  const frac = f.slice(0, dp).replace(/0+$/, "");
  if (!frac && w === "0") {
    const n = Number(s);
    if (isFinite(n) && n !== 0) return n.toLocaleString("en-US", { maximumSignificantDigits: 4, useGrouping: false });
  }
  return frac ? `${w}.${frac}` : w;
}

function swapStatusText(t: (k: MsgKey) => string, status: string): string {
  switch (status) {
    case "quoted": return t("swap.statusQuoted");
    case "user_locked": return t("swap.statusUserLocked");
    case "pool_locked": return t("swap.statusPoolLocked");
    case "claiming": return t("swap.statusClaiming");
    case "completed": return t("swap.statusCompleted");
    case "refunding": return t("swap.statusRefunding");
    case "refunded": return t("swap.statusRefunded");
    case "failed": return t("swap.statusFailed");
    default: return status;
  }
}

export function SwapTab({
  onSwap,
  onResumeSwap,
  onLiquidity,
}: {
  onSwap: () => void;
  onResumeSwap: (swapId: string) => void;
  onLiquidity: () => void;
}) {
  const { t } = useT();
  const price = usePrice();
  const bnbUsd = useBnbUsd();
  const [mid, setMid] = useState<number | null>(null);
  const [inflight, setInflight] = useState<InflightSwap[]>([]);
  const [lpAvailable, setLpAvailable] = useState(false);

  // Pool mid (BNB per EXFER) for the live price line.
  useEffect(() => {
    let cancelled = false;
    rpc<{ mid_price_bnb_per_exfer: number | null }>("swap_pool_info")
      .then((p) => { if (!cancelled) setMid(p?.mid_price_bnb_per_exfer ?? null); })
      .catch(() => {});
    rpc<{ genesis_done?: boolean; error?: string }>("lp_pool_info")
      .then((lp) => { if (!cancelled) setLpAvailable(!lp?.error && !!lp?.genesis_done); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // In-flight swaps (money in motion) — poll so a resumed swap is never invisible.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const all = await rpc<InflightSwap[]>("swap_list");
        if (cancelled) return;
        setInflight((all ?? []).filter((s) => !["quoted", "completed", "refunded", "failed"].includes(s.status)));
      } catch {
        if (!cancelled) setInflight([]);
      }
    };
    load();
    const id = window.setInterval(load, 15_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  // Pool-driven EXFER price (mid × BNB/USD), falling back to the OTC quote.
  const exferUsd = mid != null && mid > 0 && bnbUsd ? mid * bnbUsd : price?.usd ?? null;
  const usdStr = exferUsd == null ? null : exferUsd >= 1 ? exferUsd.toFixed(2) : exferUsd.toLocaleString("en-US", { maximumSignificantDigits: 3, useGrouping: false });

  return (
    <div className="screen">
      <div className="screen-pad">
        <div className="title-xl" style={{ padding: "12px 4px 18px" }}>{t("swap.title")}</div>

        {/* Primary swap CTA — the whole card is tappable. */}
        <button
          onClick={onSwap}
          className="card"
          style={{ width: "100%", display: "flex", alignItems: "center", gap: 14, padding: "18px 16px", marginBottom: 16, textAlign: "left" }}
        >
          <span style={{ width: 44, height: 44, borderRadius: 14, flex: "0 0 auto", display: "grid", placeItems: "center", background: "var(--accent)", color: "var(--accent-ink)" }}>
            <Icon name="refresh" size={22} stroke={2.2} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 16, fontWeight: 700 }}>{t("swapTab.cta")}</span>
            <span style={{ display: "block", fontSize: 12.5, color: "var(--text-faint)", marginTop: 2 }}>
              {usdStr ? t("swapTab.priceLine", { usd: usdStr }) : t("swapTab.ctaSub")}
            </span>
          </span>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: "0 0 auto" }}>
            <path d="M9 6l6 6-6 6" />
          </svg>
        </button>

        {/* In-flight swaps. */}
        {inflight.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div className="eyebrow" style={{ marginBottom: 6 }}>{t("swap.inflightTitle")}</div>
            {inflight.map((s) => (
              <button
                key={s.swap_id}
                onClick={() => onResumeSwap(s.swap_id)}
                className="card"
                style={{ width: "100%", display: "flex", alignItems: "center", padding: "11px 13px", marginBottom: 6, gap: 11, textAlign: "left" }}
              >
                <span style={{ flex: "0 0 auto", display: "inline-flex", color: "var(--accent)" }}><Spinner size={18} /></span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>
                    {fmtAmt(s.amount_in)} {s.direction === "exfer_to_bnb" ? "EXFER" : "BNB"} →{" "}
                    {fmtAmt(s.amount_out)} {s.direction === "exfer_to_bnb" ? "BNB" : "EXFER"}
                  </span>
                  <span style={{ display: "block", fontSize: 11.5, color: "var(--accent)", marginTop: 2 }}>{swapStatusText(t, s.status)}</span>
                </span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: "0 0 auto" }}>
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
            ))}
          </div>
        )}

        {/* Liquidity entry — only when the pool supports self-serve LP. */}
        {lpAvailable && (
          <button
            onClick={onLiquidity}
            className="card"
            style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "13px 14px", textAlign: "left" }}
          >
            <span style={{ width: 36, height: 36, borderRadius: 11, flex: "0 0 auto", display: "grid", placeItems: "center", background: "color-mix(in srgb, var(--accent) 16%, transparent)", color: "var(--accent)" }}>
              <Icon name="spark" size={18} />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 14, fontWeight: 600 }}>{t("lp.title")}</span>
              <span style={{ display: "block", fontSize: 12, color: "var(--text-faint)" }}>{t("lp.entrySub")}</span>
            </span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: "0 0 auto" }}>
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
