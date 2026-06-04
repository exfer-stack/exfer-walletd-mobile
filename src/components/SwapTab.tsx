// Swap tab — the exchange home: a real market screen. EXFER price + 24h change,
// a draggable candlestick chart, then the swap CTA, in-flight swaps, and the
// liquidity entry. The BNB asset card stays on the wallet tab as a holding.

import { useEffect, useState } from "react";
import { Icon } from "../lib/icons";
import { rpc } from "../lib/rpc";
import { usePrice, getKlines, type Candle } from "../lib/market";
import { useT, type MsgKey } from "../lib/i18n";
import { Spinner, BnbMark } from "./ui";
import { PriceChart } from "./PriceChart";
import tokenCoin from "../assets/exfer-token.png";
import { getLpOps, removeLpOp, onLpOpsChange, type LpOp } from "../lib/inflightLp";

const TERMINAL_SWAP = ["quoted", "completed", "refunded", "failed"];
const TERMINAL_DEP = ["completed", "expired", "refunded", "failed"];

interface InflightSwap {
  swap_id: string;
  direction: "exfer_to_bnb" | "bnb_to_exfer";
  status: string;
  amount_in: string;
  amount_out: string;
}

// Module cache so the chart + liquidity entry paint instantly on tab re-entry
// instead of popping in after their async fetches.
let candlesCache: Record<string, Candle[]> = {};
let lpAvailableCache = false;

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
  const map: Record<string, MsgKey> = {
    quoted: "swap.statusQuoted", user_locked: "swap.statusUserLocked", pool_locked: "swap.statusPoolLocked",
    claiming: "swap.statusClaiming", completed: "swap.statusCompleted", refunding: "swap.statusRefunding",
    refunded: "swap.statusRefunded", failed: "swap.statusFailed",
  };
  return map[status] ? t(map[status]) : status;
}

function ChangePill({ pct }: { pct: number }) {
  const up = pct > 0.05, down = pct < -0.05;
  const color = up ? "#34d399" : down ? "#f87171" : "var(--text-faint)";
  return (
    <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 12, fontWeight: 600, color, background: `color-mix(in srgb, ${color} 14%, transparent)`, padding: "2px 8px", borderRadius: 999 }}>
      {up ? "▲" : down ? "▼" : "•"} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

/** Overlapping EXFER + BNB coin pair with a small action badge — the modern
 *  "token pair" motif (like DEX wallets) for the swap / liquidity cards. The
 *  ring colour matches the card surface so the coins read as cleanly stacked. */
function CoinPair({ badge }: { badge: "swap" | "add" }) {
  const C = 30;
  const ring = "var(--surface)";
  return (
    <span style={{ position: "relative", width: C * 1.5, height: C, flex: "0 0 auto", display: "inline-block" }}>
      <span style={{ position: "absolute", right: 0, top: 0, borderRadius: 999, boxShadow: `0 0 0 2.5px ${ring}` }}><BnbMark size={C} /></span>
      <img src={tokenCoin} alt="" width={C} height={C} style={{ position: "absolute", left: 0, top: 0, borderRadius: 999, boxSizing: "border-box", boxShadow: `0 0 0 2.5px ${ring}`, border: "1px solid rgba(255,255,255,0.45)" }} />
      <span style={{ position: "absolute", right: -4, bottom: -4, width: 18, height: 18, borderRadius: 999, background: "var(--accent)", color: "var(--accent-ink)", display: "grid", placeItems: "center", boxShadow: `0 0 0 2.5px ${ring}` }}>
        <Icon name={badge === "swap" ? "refresh" : "plus"} size={11} stroke={2.6} />
      </span>
    </span>
  );
}

const INTERVALS: { key: string; label: string; tv: boolean }[] = [
  { key: "1h", label: "1H", tv: true },
  { key: "1d", label: "1D", tv: false },
];

export function SwapTab({
  onSwap,
  onResumeSwap,
  onLiquidity,
  theme,
}: {
  onSwap: () => void;
  onResumeSwap: (swapId: string) => void;
  onLiquidity: () => void;
  theme: "dark" | "light";
}) {
  const { t } = useT();
  const price = usePrice(); // pool-sourced EXFER/USD (cached → no flicker)
  const [interval, setInterval] = useState<string>("1d");
  const [candles, setCandles] = useState<Candle[]>(candlesCache["1d"] ?? []);
  const [loadingChart, setLoadingChart] = useState(false);
  const [inflight, setInflight] = useState<InflightSwap[]>([]);
  const [lpOps, setLpOps] = useState<LpOp[]>(getLpOps());
  const [lpAvailable, setLpAvailable] = useState(lpAvailableCache);

  useEffect(() => {
    let cancelled = false;
    rpc<{ genesis_done?: boolean; error?: string }>("lp_pool_info")
      .then((lp) => { const ok = !lp?.error && !!lp?.genesis_done; lpAvailableCache = ok; if (!cancelled) setLpAvailable(ok); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Candles for the chosen interval (cached per interval).
  useEffect(() => {
    let cancelled = false;
    if (!candlesCache[interval]) setLoadingChart(true);
    getKlines(interval, 120).then((c) => {
      if (cancelled) return;
      if (c.length) candlesCache[interval] = c;
      setCandles(c.length ? c : candlesCache[interval] ?? []);
      setLoadingChart(false);
    });
    return () => { cancelled = true; };
  }, [interval]);

  // In-progress: swaps + liquidity ops. Refreshes on a 15s timer AND on focus /
  // visibility / lp-store changes, so a finished item is dropped promptly (no
  // lingering spinner for an op that already completed while you were away).
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const all = await rpc<InflightSwap[]>("swap_list");
        if (!cancelled) setInflight((all ?? []).filter((s) => !TERMINAL_SWAP.includes(s.status)));
      } catch { if (!cancelled) setInflight([]); }
      // Drop any LP add whose deposit has gone terminal (the status read is a
      // cheap DB lookup via walletd, not a node-RPC hit).
      for (const op of getLpOps()) {
        if (op.kind !== "add") continue;
        try {
          const s = await rpc<{ status: string }>("lp_deposit_status", { id: op.id });
          if (s?.status && TERMINAL_DEP.includes(s.status)) removeLpOp(op.id);
        } catch { /* leave it; TTL is the backstop */ }
      }
      if (!cancelled) setLpOps(getLpOps());
    };
    void refresh();
    const id = window.setInterval(refresh, 15_000);
    const onWake = () => { if (document.visibilityState !== "hidden") void refresh(); };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    const unsub = onLpOpsChange(() => { if (!cancelled) setLpOps(getLpOps()); });
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
      unsub();
    };
  }, []);

  const exferUsd = price?.usd ?? null;
  const usdStr = exferUsd == null ? "—" : exferUsd >= 1 ? exferUsd.toFixed(2) : exferUsd.toLocaleString("en-US", { maximumSignificantDigits: 4, useGrouping: false });

  return (
    <div className="screen">
      <div className="screen-pad">
        <div className="title-xl" style={{ padding: "12px 4px 14px" }}>{t("swap.title")}</div>

        {/* Market card: price + 24h change + interval toggle + candlestick chart. */}
        <div className="card" style={{ padding: "14px 14px 10px", marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div className="eyebrow" style={{ marginBottom: 4 }}>EXFER · USD</div>
              <div style={{ fontFamily: '"Geist Variable","Geist",sans-serif', fontSize: 26, fontWeight: 600, letterSpacing: "-.02em", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
                <span style={{ fontSize: 18, fontWeight: 500, color: "var(--text-dim)", marginRight: 1 }}>$</span>{usdStr}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
              {price && <ChangePill pct={price.change24h} />}
              <div style={{ display: "flex", gap: 4 }}>
                {INTERVALS.map((iv) => (
                  <button
                    key={iv.key}
                    onClick={() => setInterval(iv.key)}
                    style={{
                      border: 0, cursor: "pointer", font: "inherit", fontSize: 11.5, fontWeight: 600,
                      padding: "3px 9px", borderRadius: 7,
                      background: interval === iv.key ? "var(--surface-2)" : "transparent",
                      color: interval === iv.key ? "var(--accent)" : "var(--text-faint)",
                    }}
                  >
                    {iv.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div style={{ marginTop: 8, minHeight: 200 }}>
            {candles.length > 0 ? (
              <PriceChart candles={candles} theme={theme} height={200} timeVisible={interval !== "1d"} />
            ) : (
              <div style={{ height: 200, display: "grid", placeItems: "center", color: "var(--text-faint)", fontSize: 13 }}>
                {loadingChart ? <Spinner size={20} /> : t("swapTab.noChart")}
              </div>
            )}
          </div>
        </div>

        {/* Primary swap CTA. */}
        <button onClick={onSwap} className="card" style={{ width: "100%", display: "flex", alignItems: "center", gap: 14, padding: "16px", marginBottom: 16, textAlign: "left" }}>
          <CoinPair badge="swap" />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 16, fontWeight: 700 }}>{t("swapTab.cta")}</span>
            <span style={{ display: "block", fontSize: 12.5, color: "var(--text-faint)", marginTop: 2 }}>{t("swapTab.ctaSub")}</span>
          </span>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: "0 0 auto" }}><path d="M9 6l6 6-6 6" /></svg>
        </button>

        {/* Liquidity entry — a feature, kept above the transient in-flight list. */}
        {lpAvailable && (
          <button onClick={onLiquidity} className="card" style={{ width: "100%", display: "flex", alignItems: "center", gap: 14, padding: "16px", marginBottom: 16, textAlign: "left" }}>
            <CoinPair badge="add" />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 16, fontWeight: 700 }}>{t("lp.title")}</span>
              <span style={{ display: "block", fontSize: 12.5, color: "var(--text-faint)", marginTop: 2 }}>{t("lp.entrySub")}</span>
            </span>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: "0 0 auto" }}><path d="M9 6l6 6-6 6" /></svg>
          </button>
        )}

        {/* In progress: swaps + liquidity adds/removes. */}
        {(inflight.length > 0 || lpOps.length > 0) && (
          <div style={{ marginBottom: 16 }}>
            <div className="eyebrow" style={{ marginBottom: 6 }}>{t("swapTab.inProgress")}</div>
            {inflight.map((s) => (
              <button key={s.swap_id} onClick={() => onResumeSwap(s.swap_id)} className="card" style={{ width: "100%", display: "flex", alignItems: "center", padding: "11px 13px", marginBottom: 6, gap: 11, textAlign: "left" }}>
                <span style={{ flex: "0 0 auto", display: "inline-flex", color: "var(--accent)" }}><Spinner size={18} /></span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>
                    {fmtAmt(s.amount_in)} {s.direction === "exfer_to_bnb" ? "EXFER" : "BNB"} → {fmtAmt(s.amount_out)} {s.direction === "exfer_to_bnb" ? "BNB" : "EXFER"}
                  </span>
                  <span style={{ display: "block", fontSize: 11.5, color: "var(--accent)", marginTop: 2 }}>{swapStatusText(t, s.status)}</span>
                </span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: "0 0 auto" }}><path d="M9 6l6 6-6 6" /></svg>
              </button>
            ))}
            {lpOps.map((op) => (
              <button key={op.id} onClick={onLiquidity} className="card" style={{ width: "100%", display: "flex", alignItems: "center", padding: "11px 13px", marginBottom: 6, gap: 11, textAlign: "left" }}>
                <span style={{ flex: "0 0 auto", display: "inline-flex", color: "var(--accent)" }}><Spinner size={18} /></span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>
                    {op.kind === "add" ? t("lp.addTitle") : t("lp.removeTitle")} · {fmtAmt(op.exfer)} EXFER + {op.bnb} BNB
                  </span>
                  <span style={{ display: "block", fontSize: 11.5, color: "var(--accent)", marginTop: 2 }}>{t("swapTab.lpProcessing")}</span>
                </span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: "0 0 auto" }}><path d="M9 6l6 6-6 6" /></svg>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
