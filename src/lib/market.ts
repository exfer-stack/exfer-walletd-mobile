// EXFER spot price (USD) + 24h change, from the public OTC market
// (archeotc). Same network rule as walletd: the webview never calls out
// directly. In a real Tauri build the request goes through the Rust
// `get_market_price` command; in browser dev it goes through the Vite
// `/__price` proxy (archeotc sends no CORS headers, so a direct fetch is
// blocked). Any failure resolves to `null` and the UI simply hides the price.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { devmock } from "./devmock";

export interface MarketPrice {
  /** USD per 1 EXFER. */
  usd: number;
  /** 24h change in percent (close vs. previous daily close). */
  change24h: number;
}

const EXFER_UNIT = 100_000_000; // 1 EXFER = 1e8 exfers

/** Parse archeotc daily klines → latest close + 24h change. */
function parseKlines(raw: string): MarketPrice | null {
  try {
    const items = (JSON.parse(raw) as { items?: { c?: string }[] }).items;
    if (!Array.isArray(items) || items.length === 0) return null;
    const usd = Number(items[items.length - 1]?.c);
    if (!isFinite(usd) || usd <= 0) return null;
    const prev = items.length >= 2 ? Number(items[items.length - 2]?.c) : usd;
    const change24h = isFinite(prev) && prev > 0 ? ((usd - prev) / prev) * 100 : 0;
    return { usd, change24h };
  } catch {
    return null;
  }
}

const CACHE_KEY = "exfer-price-cache";

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
    let raw: string;
    if (devmock.isActive()) {
      const r = await fetch(
        "/__price/api/coins/klines?coinId=EXFER&interval=1d&limit=2",
      );
      if (!r.ok) return null;
      raw = await r.text();
    } else {
      raw = await invoke<string>("get_market_price");
    }
    const p = parseKlines(raw);
    if (p) {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(p));
      } catch {
        /* ignore */
      }
    }
    return p;
  } catch {
    return null;
  }
}

/** Live EXFER price. `null` until the first successful fetch (and stays at the
 *  last good value if a later refresh fails). Refreshes every 3 minutes. */
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
    const id = window.setInterval(tick, 180_000);
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

/** OHLC candles for the EXFER market, for the price chart. Same network rule as
 *  getMarketPrice (Rust command in the app, /__price proxy in dev). Empty array
 *  on any failure — the chart just shows its empty state. */
export async function getKlines(interval = "1d", limit = 120): Promise<Candle[]> {
  try {
    let raw: string;
    if (devmock.isActive()) {
      const r = await fetch(`/__price/api/coins/klines?coinId=EXFER&interval=${interval}&limit=${limit}`);
      if (!r.ok) return [];
      raw = await r.text();
    } else {
      raw = await invoke<string>("get_market_klines", { interval, limit });
    }
    const items = (JSON.parse(raw) as { items?: { t: string; o: string; h: string; l: string; c: string }[] }).items;
    if (!Array.isArray(items)) return [];
    return items
      .map((it) => ({
        time: Math.floor(new Date(it.t).getTime() / 1000),
        open: Number(it.o), high: Number(it.h), low: Number(it.l), close: Number(it.c),
      }))
      .filter((c) => isFinite(c.time) && isFinite(c.open) && isFinite(c.close))
      .sort((a, b) => a.time - b.time);
  } catch {
    return [];
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

/** Live BNB/USD spot. Seeded from cache, refreshes every 3 minutes. */
export function useBnbUsd(): number | null {
  const [v, setV] = useState<number | null>(readCachedBnbUsd);
  useEffect(() => {
    let alive = true;
    const tick = () => getBnbUsd().then((p) => { if (alive && p) setV(p); });
    void tick();
    const id = window.setInterval(tick, 180_000);
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
