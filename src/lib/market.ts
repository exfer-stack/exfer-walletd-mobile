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
    return parseKlines(raw);
  } catch {
    return null;
  }
}

/** Live EXFER price. `null` until the first successful fetch (and stays at the
 *  last good value if a later refresh fails). Refreshes every 3 minutes. */
export function usePrice(): MarketPrice | null {
  const [price, setPrice] = useState<MarketPrice | null>(null);
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
