// Global swap-completion watcher. Mounted once under WalletProvider (so it
// survives tab switches and an open/closed Swap sheet), it polls the swap
// journal and, when any swap reaches a terminal state, fires an in-app toast +
// a best-effort OS notification — so a finished swap is announced even if the
// user closed the sheet, switched tabs, or backgrounded the app.
//
// The first poll establishes a baseline (no toasts for swaps that were already
// terminal when the app opened); only transitions after that announce.

import { useEffect, useRef } from "react";
import { rpc } from "../lib/rpc";
import { useToast } from "../lib/toast";
import { useT } from "../lib/i18n";
import { useWallet } from "../lib/wallet";
import { osNotify } from "../lib/notify";

interface SwapLite {
  swap_id: string;
  direction: "exfer_to_bnb" | "bnb_to_exfer";
  status: string;
  amount_out: string;
}

const TERMINAL = new Set(["completed", "refunded", "failed"]);

/** Significant-digit format for a decimal string (tiny BNB amounts must not
 *  read as "0"). */
function fmtAmt(s: string): string {
  const n = Number(s);
  if (!isFinite(n) || n === 0) return s;
  return n.toLocaleString("en-US", { maximumSignificantDigits: 6, useGrouping: false });
}

export function SwapWatcher() {
  const toast = useToast();
  const { t } = useT();
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
      if (!baseline) return; // first poll: baseline only, no toasts

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
    };

    tick();
    const id = window.setInterval(tick, 6000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [toast, t, refresh]);

  return null;
}
