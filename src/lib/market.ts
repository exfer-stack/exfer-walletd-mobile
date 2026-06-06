// EXFER spot price (USD) + 24h change, from THIS pool's own price history.
// The displayed price is the pool's exchange rate (mid BNB-per-EXFER × BNB/USD),
// sampled into candles server-side; today's candle close is the current price
// and the 24h change is vs the previous day. The OTC market (archeotc) is no
// longer a live source — it only seeds the pool's history (server-side), so
// every price the user sees is OUR rate, not a third-party quote.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { devmock } from "./devmock";
import { rpc } from "./rpc";

export interface MarketPrice {
  /** USD per 1 EXFER. */
  usd: number;
  /** 24h change in percent (close vs. previous daily close). */
  change24h: number;
}

const EXFER_UNIT = 100_000_000; // 1 EXFER = 1e8 exfers

// Bumped to drop any stale OTC-sourced value cached by an older build.
const CACHE_KEY = "exfer-price-cache-v2";

/** Last good price, so the line paints instantly on the next launch instead of
 *  blanking for the ~couple seconds the fetch takes (and survives a transient
 *  fetch failure). */
function readCachedPrice(): MarketPrice | null {
  try {
    const o = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (o && typeof o.usd === "number" && o.usd > 0) {
      return { usd: o.usd, change24h: typeof o.change24h === "number" ? o.change24h : 0 };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function getMarketPrice(): Promise<MarketPrice | null> {
  try {
    // Today's candle close = the pool's current EXFER/USD; 24h change vs the
    // previous day. Sourced from the pool (swap_price_klines), not OTC.
    const res = await rpc<{ items?: { c: number | string }[] }>("swap_price_klines", { interval: "1d", limit: 2 });
    const items = res?.items;
    if (!Array.isArray(items) || items.length === 0) return readCachedPrice();
    const usd = Number(items[items.length - 1].c);
    if (!isFinite(usd) || usd <= 0) return readCachedPrice();
    const prev = items.length >= 2 ? Number(items[items.length - 2].c) : usd;
    const change24h = isFinite(prev) && prev > 0 ? ((usd - prev) / prev) * 100 : 0;
    const p = { usd, change24h };
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(p)); } catch { /* ignore */ }
    return p;
  } catch {
    return readCachedPrice();
  }
}

/** Live EXFER price. `null` until the first successful fetch (and stays at the
 *  last good value if a later refresh fails). Refreshes every 15s so the
 *  displayed mid-price tracks other users' swaps reasonably promptly (it's a
 *  poll, not a push — the indicative number; the actual trade always re-quotes
 *  live, so a slightly-stale display never affects what you pay). */
export function usePrice(): MarketPrice | null {
  // Seed from the cached price so the line shows immediately on launch.
  const [price, setPrice] = useState<MarketPrice | null>(readCachedPrice);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      getMarketPrice().then((p) => {
        if (alive && p) setPrice(p);
      });
    void tick();
    const id = window.setInterval(tick, 15_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  return price;
}

// ── candlesticks (price history) ─────────────────────────────────────────
export interface Candle {
  time: number; // unix seconds (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
}

type RawCandle = { t: string; o: number | string; h: number | string; l: number | string; c: number | string };
function mapCandles(items: RawCandle[]): Candle[] {
  return items
    .map((it) => ({
      time: Math.floor(new Date(it.t).getTime() / 1000),
      open: Number(it.o), high: Number(it.h), low: Number(it.l), close: Number(it.c),
    }))
    .filter((c) => isFinite(c.time) && isFinite(c.open) && isFinite(c.close))
    .sort((a, b) => a.time - b.time);
}

/** 24h trading stats the pool appends to swap_price_klines. Older pools omit
 *  it — callers get `null` and hide the corresponding UI. */
export interface KlineStats {
  swaps24h: number;
  volExfer24h: number;
  volBnb24h: number;
}

type RawStats = { swaps_24h?: number | string; vol_exfer_24h?: number | string; vol_bnb_24h?: number | string };

function mapStats(s: RawStats | null | undefined): KlineStats | null {
  if (!s) return null;
  const swaps = Number(s.swaps_24h), volExfer = Number(s.vol_exfer_24h), volBnb = Number(s.vol_bnb_24h);
  if (!isFinite(swaps) || !isFinite(volExfer) || !isFinite(volBnb)) return null;
  return { swaps24h: swaps, volExfer24h: volExfer, volBnb24h: volBnb };
}

/** OHLC candles + the pool's 24h stats, from THIS pool's own price history
 *  (swap_price_klines: seeded once from OTC server-side, then grown from the
 *  pool's mid). Empty candles / null stats on failure. */
export async function getKlinesWithStats(
  interval = "1d",
  limit = 120,
): Promise<{ candles: Candle[]; stats: KlineStats | null }> {
  try {
    const res = await rpc<{ items?: RawCandle[]; stats?: RawStats | null }>("swap_price_klines", { interval, limit });
    return {
      candles: Array.isArray(res?.items) ? mapCandles(res.items) : [],
      stats: mapStats(res?.stats),
    };
  } catch { /* fall through to empty */ }
  return { candles: [], stats: null };
}

/** OHLC candles for the chart. Empty array on failure — the chart shows its
 *  empty state. Thin wrapper that drops the stats. */
export async function getKlines(interval = "1d", limit = 120): Promise<Candle[]> {
  return (await getKlinesWithStats(interval, limit)).candles;
}

// ── circulating supply ───────────────────────────────────────────────────
// The node exposes no supply RPC, so we reproduce the emission curve from the
// consensus constants: per block h the reward is
//   R(h) = 1 EXFER + 99 EXFER · 2^(-h / HALF_LIFE)
// (a perpetual 1-EXFER tail plus a ~2-year-half-life decaying bonus). Total
// minted through height H is the running sum, which has a closed form:
//   supply(H) = (H+1) + 99 · (1 - r^(H+1))/(1 - r),  r = 2^(-1/HALF_LIFE)
// accurate to far better than display precision.

const HALF_LIFE = 6_307_200; // blocks (~2 years at 10s) — matches the node

/** Total EXFER emitted through `height` (whole EXFER). */
export function circulatingSupplyExfer(height: number): number {
  if (!isFinite(height) || height < 0) return 0;
  const n = height + 1;
  const r = Math.pow(2, -1 / HALF_LIFE);
  const decaySum = (1 - Math.pow(r, n)) / (1 - r);
  return n + 99 * decaySum;
}

/** Current EXFER tip height via walletd (null on failure). */
export async function getBlockHeight(): Promise<number | null> {
  try {
    const r = await rpc<{ height?: number }>("get_block_height");
    return typeof r?.height === "number" ? r.height : null;
  } catch {
    return null;
  }
}

// ── BNB/USD spot ─────────────────────────────────────────────────────────
// The independent USD anchor for BNB, so the EXFER price can be derived from
// the live pool ratio (EXFER/USD = pool BNB-per-EXFER × BNB/USD) instead of a
// fixed OTC quote. Same network rule: Rust command in the app, Vite proxy in
// dev. Failure resolves to null and callers fall back to the OTC EXFER price.

const BNB_CACHE_KEY = "exfer-bnbusd-cache";

function readCachedBnbUsd(): number | null {
  try {
    const v = Number(JSON.parse(localStorage.getItem(BNB_CACHE_KEY) || "null"));
    return isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export async function getBnbUsd(): Promise<number | null> {
  try {
    let raw: string;
    if (devmock.isActive()) {
      const r = await fetch("/__bnbusd/api/v3/ticker/price?symbol=BNBUSDT");
      if (!r.ok) return null;
      raw = await r.text();
    } else {
      raw = await invoke<string>("get_bnb_price");
    }
    const price = Number((JSON.parse(raw) as { price?: string }).price);
    if (!isFinite(price) || price <= 0) return null;
    try {
      localStorage.setItem(BNB_CACHE_KEY, JSON.stringify(price));
    } catch {
      /* ignore */
    }
    return price;
  } catch {
    return null;
  }
}

/** Live BNB/USD spot. Seeded from cache, refreshes every 60s (BNB is the price
 *  anchor — EXFER/USD = pool mid × BNB/USD — so keep it as fresh as the chart). */
export function useBnbUsd(): number | null {
  const [v, setV] = useState<number | null>(readCachedBnbUsd);
  useEffect(() => {
    let alive = true;
    const tick = () => getBnbUsd().then((p) => { if (alive && p) setV(p); });
    void tick();
    const id = window.setInterval(tick, 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  return v;
}

/** Format an exfer-denominated amount as its USD value, compactly. */
export function usdValue(exfers: number, usd: number): string {
  const v = (exfers / EXFER_UNIT) * usd;
  if (v <= 0) return "$0";
  if (v < 0.0001) return "$<0.0001";
  if (v < 1) return "$" + v.toFixed(4);
  return (
    "$" +
    v.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}
