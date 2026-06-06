// Global swap-completion watcher. Mounted once under WalletProvider (so it
// survives tab switches and an open/closed Swap sheet), it polls the swap
// journal and, when any swap reaches a terminal state, fires an in-app toast +
// a best-effort OS notification — so a finished swap is announced even if the
// user closed the sheet, switched tabs, or backgrounded the app.
//
// Last-seen statuses are persisted to localStorage, so the FIRST poll after a
// cold start diffs against them and still announces a completion/refund that
// happened while the app was closed (the old in-memory baseline swallowed
// those). It also fires a one-time "didn't match — auto-refund in {eta}" nudge
// when a swap's quote expires unmatched (see src/lib/swapPhase.ts).

import { useEffect, useRef } from "react";
import { rpc } from "../lib/rpc";
import { useToast } from "../lib/toast";
import { useT } from "../lib/i18n";
import { useWallet } from "../lib/wallet";
import { osNotify } from "../lib/notify";
import { getBlockHeight } from "../lib/market";
import { GRACE_SEC, refundEta, formatEta } from "../lib/swapPhase";

interface SwapLite {
  swap_id: string;
  direction: "exfer_to_bnb" | "bnb_to_exfer";
  status: string;
  amount_out: string;
  expires_at?: number | null;
  exfer_timeout_height?: number | null;
  bsc_timeout_sec?: number | null;
}

const TERMINAL = new Set(["completed", "refunded", "failed"]);

// Persisted last-seen status per swap (terminals are pruned once announced),
// and the set of swaps already nudged about being unmatched.
const WATCH_KEY = "exfer-wallet-swapwatch-v1";
const NUDGE_KEY = "exfer-wallet-swapwatch-nudged-v1";

function readStatuses(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(WATCH_KEY) || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}
function writeStatuses(map: Record<string, string>): void {
  try { localStorage.setItem(WATCH_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}
function readNudged(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(NUDGE_KEY) || "[]");
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}
function writeNudged(ids: string[]): void {
  try { localStorage.setItem(NUDGE_KEY, JSON.stringify(ids)); } catch { /* ignore */ }
}

/** Significant-digit format for a decimal string (tiny BNB amounts must not
 *  read as "0"). */
function fmtAmt(s: string): string {
  const n = Number(s);
  if (!isFinite(n) || n === 0) return s;
  return n.toLocaleString("en-US", { maximumSignificantDigits: 6, useGrouping: false });
}

export function SwapWatcher() {
  const toast = useToast();
  const { t, lang } = useT();
  const { refresh } = useWallet();
  const prev = useRef<Map<string, string> | null>(null);

  useEffect(() => {
    let cancelled = false;

    const announce = (s: SwapLite) => {
      const outUnit = s.direction === "exfer_to_bnb" ? "BNB" : "EXFER";
      if (s.status === "completed") {
        const title = t("swap.completedTitle");
        const body = t("swap.completedReceived", { amt: `${fmtAmt(s.amount_out)} ${outUnit}` });
        toast.success(title, body);
        osNotify(title, body);
        refresh();
      } else if (s.status === "refunded") {
        const title = t("swap.refundedTitle");
        const body = t("swap.refundedBody");
        toast.info(title, body);
        osNotify(title, body);
        refresh();
      } else if (s.status === "failed") {
        const title = t("swap.failedTitle");
        const body = t("swap.failedToastBody");
        toast.error(title, body);
        osNotify(title, body);
      }
    };

    const tick = async () => {
      let list: SwapLite[];
      try {
        list = await rpc<SwapLite[]>("swap_list");
      } catch {
        return; // engine off / transient
      }
      if (cancelled) return;
      const now = new Map(list.map((s) => [s.swap_id, s.status]));
      const baseline = prev.current;
      prev.current = now;

      if (!baseline) {
        // First poll after startup: diff against the PERSISTED statuses so a
        // swap that completed/refunded while the app was closed still gets its
        // notification. Only those two — an offline "failed" stays quiet here
        // (the terminal screen / activity covers it; most are expired quotes).
        const persisted = readStatuses();
        for (const s of list) {
          const before = persisted[s.swap_id];
          if (before === undefined || before === s.status) continue;
          if (s.status === "completed" || s.status === "refunded") announce(s);
        }
      } else {
        for (const s of list) {
          const before = baseline.get(s.swap_id);
          if (before === undefined || before === s.status || !TERMINAL.has(s.status)) continue;
          // A quote the user previewed but never confirmed simply expires
          // (quoted → failed/expired on older daemons): no funds moved, so it is
          // NOT a swap failure and must not pop a scary "transaction failed" toast.
          // Only announce a failure for a swap that actually went in-flight.
          if (s.status === "failed" && before === "quoted") continue;
          announce(s);
        }
      }

      // Persist the non-terminal statuses. Terminals are pruned here — once
      // announced they must not re-announce on the next launch, and the map
      // must not grow without bound.
      const keep: Record<string, string> = {};
      for (const s of list) if (!TERMINAL.has(s.status)) keep[s.swap_id] = s.status;
      writeStatuses(keep);

      // One-time nudge per swap that has entered "unmatched": still
      // user_locked past the quote expiry + grace. Funds are safe; the point
      // is to set the expectation of the auto-refund window.
      const nowSec = Math.floor(Date.now() / 1000);
      const nudged = new Set(readNudged());
      const candidates = list.filter(
        (s) =>
          s.status === "user_locked" &&
          s.expires_at != null &&
          nowSec > s.expires_at + GRACE_SEC &&
          !nudged.has(s.swap_id),
      );
      if (candidates.length > 0) {
        // Sell timeouts are EXFER block heights; one tip fetch covers them all.
        const needHeight = candidates.some((c) => c.direction === "exfer_to_bnb");
        const height = needHeight ? await getBlockHeight() : null;
        if (cancelled) return;
        for (const s of candidates) {
          const etaSec = refundEta(s, nowSec, height);
          const eta =
            etaSec == null
              ? t("swap.etaFewHours")
              : formatEta(Math.max(60, etaSec), lang);
          const title = t("swap.nudgeTitle");
          const body = t("swap.nudgeBody", { eta });
          toast.info(title, body);
          osNotify(title, body);
          nudged.add(s.swap_id);
        }
      }
      // Drop nudge marks for swaps that are gone / terminal (they can't
      // re-enter unmatched), then persist the announced set.
      const liveIds = new Set(list.filter((s) => !TERMINAL.has(s.status)).map((s) => s.swap_id));
      writeNudged([...nudged].filter((id) => liveIds.has(id)));
    };

    tick();
    const id = window.setInterval(tick, 6000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [toast, t, lang, refresh]);

  return null;
}
