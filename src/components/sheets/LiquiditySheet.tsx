// Liquidity (LP) — self-serve add / remove against the swap pool. Wired to the
// walletd LP proxy RPCs (lp_pool_info / lp_position / lp_deposit_start /
// lp_deposit_status / lp_withdraw_self). The pool's shares are an off-chain
// ledger (Exfer has no VM), so this is a CUSTODIAL position — surfaced honestly.
//
// Add: open a deposit intent → app sends EXFER (transfer) + BNB (bsc_send_bnb)
// to the per-request deposit addresses → poll until the pool credits shares.
// Remove: lp_withdraw_self → the pool auto-pays both legs back to the wallet.

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "../../lib/wallet";
import { useToast } from "../../lib/toast";
import { rpc, formatBalanceCompact, parseExferAmount } from "../../lib/rpc";
import { humanizeError } from "../../lib/errors";
import { useT } from "../../lib/i18n";
import { isHidden } from "../../lib/hidden";
import { usePrice, useBnbUsd } from "../../lib/market";
import { Sheet, Spinner } from "../ui";
import { biometricStatus, biometricUnlock } from "../../lib/biometric";

const FEE_RATE = 1; // exfers/byte, matches SendSheet

interface PoolInfo {
  total_shares: string;
  reserves: { bnb: string; exfer: string };
  operator_share_pct: number;
  genesis_done: boolean;
}
interface Position {
  has_position: boolean;
  shares: string;
  pool_share_pct: number;
  value_bnb: string;
  value_exfer: string;
}

function sig(n: number, d = 6): string {
  if (!isFinite(n) || n === 0) return "0";
  return n.toLocaleString("en-US", { maximumSignificantDigits: d, useGrouping: false });
}
function usd(n: number): string {
  return n >= 1 ? n.toFixed(2) : n.toLocaleString("en-US", { maximumSignificantDigits: 3, useGrouping: false });
}

export function LiquiditySheet({ onClose }: { onClose: () => void }) {
  const { balance, refresh, suspendPolling } = useWallet();
  const toast = useToast();
  const { t } = useT();
  const price = usePrice();
  const bnbUsd = useBnbUsd();

  useEffect(() => suspendPolling(), [suspendPolling]);

  const visible = (balance?.entries ?? []).filter((a) => !isHidden(a.address));
  const funded = visible.filter((a) => a.balance > 0);
  // LP identity = a stable funded EXFER address (the position is keyed by it).
  const exferAddr = funded[0]?.address ?? visible[0]?.address ?? "";
  const exferBal = funded[0]?.balance ?? 0;

  const [step, setStep] = useState<"overview" | "add" | "withdraw" | "progress">("overview");
  const [pool, setPool] = useState<PoolInfo | null>(null);
  const [pos, setPos] = useState<Position | null>(null);
  const [bscAddr, setBscAddr] = useState<string>("");
  const [bnbWei, setBnbWei] = useState<string>("0");
  const [unavailable, setUnavailable] = useState(false);
  const [amount, setAmount] = useState(""); // EXFER amount to add
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [progressMsg, setProgressMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const p = await rpc<PoolInfo>("lp_pool_info");
      if ((p as unknown as { error?: string })?.error || !p.genesis_done) {
        setUnavailable(true);
        return;
      }
      setPool(p);
      const [a, b] = await Promise.all([
        rpc<{ address: string }>("bsc_get_address").catch(() => ({ address: "" })),
        rpc<{ bnb_wei: string }>("bsc_get_balances").catch(() => ({ bnb_wei: "0" })),
      ]);
      setBscAddr(a.address);
      setBnbWei(b.bnb_wei);
      if (exferAddr) {
        const pp = await rpc<Position>("lp_position", { address: exferAddr.toLowerCase() }).catch(() => null);
        if (pp) setPos(pp);
      }
    } catch {
      setUnavailable(true);
    }
  }, [exferAddr]);

  useEffect(() => { void load(); }, [load]);

  // BNB:EXFER ratio from reserves; matching BNB for a given EXFER amount.
  const mid = pool ? Number(pool.reserves.bnb) / Number(pool.reserves.exfer) : 0; // BNB per EXFER
  const bnbHuman = Number(BigInt(bnbWei || "0")) / 1e18;
  const amtNum = Number(amount);
  const bnbNeeded = mid > 0 && isFinite(amtNum) ? amtNum * mid : 0;
  const exferUsd = mid > 0 && bnbUsd ? mid * bnbUsd : price?.usd ?? 0;
  const addUsd = isFinite(amtNum) ? amtNum * exferUsd * 2 : 0; // both legs ≈ 2× the EXFER value
  const amountValid = isFinite(amtNum) && amtNum > 0;
  const enoughExfer = amountValid && parseExferAmount(amount || "0") <= exferBal;
  const enoughBnb = bnbNeeded <= bnbHuman;

  async function confirmAdd() {
    if (!pool || !amountValid) return;
    if (!enoughExfer) { setErr(t("lp.needExfer")); return; }
    if (!enoughBnb) { setErr(t("lp.needBnb", { bnb: sig(bnbNeeded, 4) })); return; }
    const bio = await biometricStatus();
    if (bio.available && !(await biometricUnlock(t("lp.addTitle")))) {
      toast.error(t("swap.notConfirmedTitle"), "");
      return;
    }
    setBusy(true); setErr(null);
    try {
      setStep("progress"); setProgressMsg(t("lp.opening"));
      const intent = await rpc<{ id: string; deposit_exfer_address: string; deposit_bsc_address: string }>(
        "lp_deposit_start", { exfer_address: exferAddr, bsc_address: bscAddr },
      );
      // Send both legs from the user's wallet to the per-request addresses.
      setProgressMsg(t("lp.sendingExfer"));
      await rpc("transfer", { from: exferAddr, outputs: [{ to: intent.deposit_exfer_address, amount: parseExferAmount(amount) }], fee_rate: FEE_RATE });
      setProgressMsg(t("lp.sendingBnb"));
      await rpc("bsc_send_bnb", { to: intent.deposit_bsc_address, amount: sig(bnbNeeded, 8) });
      // Poll until the pool credits shares.
      setProgressMsg(t("lp.crediting"));
      await pollDeposit(intent.id);
      toast.success(t("lp.addedTitle"), t("lp.addedBody"));
      await load(); await refresh();
      setStep("overview"); setAmount("");
    } catch (e) {
      setErr(humanizeError(e));
      setStep("add");
    } finally {
      setBusy(false);
    }
  }

  function pollDeposit(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = async () => {
        try {
          const s = await rpc<{ status: string }>("lp_deposit_status", { id });
          if (s.status === "completed") return resolve();
          if (s.status === "expired") return reject(new Error("deposit expired/refunded"));
        } catch { /* transient */ }
        if (Date.now() - t0 > 5 * 60_000) return reject(new Error("timed out — check back shortly"));
        window.setTimeout(tick, 4000);
      };
      tick();
    });
  }

  async function confirmWithdraw() {
    if (!pos?.has_position) return;
    const bio = await biometricStatus();
    if (bio.available && !(await biometricUnlock(t("lp.removeTitle")))) {
      toast.error(t("swap.notConfirmedTitle"), "");
      return;
    }
    setBusy(true); setErr(null);
    try {
      await rpc("lp_withdraw_self", { exfer_address: exferAddr, shares: "all" });
      toast.success(t("lp.removeQueuedTitle"), t("lp.removeQueuedBody"));
      await load(); await refresh();
      setStep("overview");
    } catch (e) {
      setErr(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  // ── unavailable (pool not LP-enabled) ──
  if (unavailable) {
    return (
      <Sheet title={t("lp.title")} onClose={onClose} footer={<button className="btn btn-block" onClick={onClose}>{t("swap.done")}</button>}>
        <div style={{ padding: "28px 8px", textAlign: "center", color: "var(--text-dim)", lineHeight: 1.6 }}>
          {t("lp.unavailable")}
        </div>
      </Sheet>
    );
  }

  if (!pool) {
    return (
      <Sheet title={t("lp.title")} onClose={onClose}>
        <div style={{ padding: 40, display: "grid", placeItems: "center" }}><Spinner size={22} /></div>
      </Sheet>
    );
  }

  // ── progress ──
  if (step === "progress") {
    return (
      <Sheet title={t("lp.addTitle")} onClose={onClose}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "32px 0" }}>
          <Spinner size={26} />
          <div style={{ fontSize: 14, color: "var(--text-dim)" }}>{progressMsg}</div>
          <div style={{ fontSize: 12, color: "var(--text-faint)", textAlign: "center", lineHeight: 1.5 }}>{t("lp.progressHint")}</div>
        </div>
      </Sheet>
    );
  }

  // ── add ──
  if (step === "add") {
    return (
      <Sheet title={t("lp.addTitle")} onClose={onClose} onBack={() => { setStep("overview"); setErr(null); }}
        footer={<button className="btn btn-block" disabled={busy || !amountValid} onClick={confirmAdd}>{busy ? <Spinner /> : t("lp.addConfirm")}</button>}>
        <label className="eyebrow">{t("lp.addExferAmount")}</label>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input className="field" inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ flex: 1, fontSize: 22, fontWeight: 600 }} />
          <span style={{ color: "var(--text-faint)", fontWeight: 600 }}>EXFER</span>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-faint)", margin: "8px 2px" }}>
          {t("lp.balance")}: {formatBalanceCompact(exferBal)}
        </div>
        <div className="quote-card" style={{ marginTop: 6 }}>
          <div className="quote-label">{t("lp.youProvide")}</div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginTop: 4 }}>
            <span>{amountValid ? sig(amtNum) : "0"} EXFER</span>
            <span className={enoughExfer ? "" : "banner-warn"} style={{ color: enoughExfer ? "var(--text)" : "#fbbf24" }}>{enoughExfer ? "✓" : t("lp.short")}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginTop: 6 }}>
            <span>+ {sig(bnbNeeded, 6)} BNB</span>
            <span style={{ color: enoughBnb ? "var(--text)" : "#fbbf24" }}>{enoughBnb ? "✓" : t("lp.short")}</span>
          </div>
          <div className="quote-sub" style={{ marginTop: 8 }}>≈ ${usd(addUsd)} · {t("lp.matchRatio")}</div>
        </div>
        <div className="banner banner-info" style={{ marginTop: 14, fontSize: 12, lineHeight: 1.5 }}>{t("lp.custodialNote")}</div>
        {err && <div style={{ color: "#f87171", fontSize: 13, marginTop: 10 }}>{err}</div>}
      </Sheet>
    );
  }

  // ── withdraw confirm ──
  if (step === "withdraw" && pos?.has_position) {
    return (
      <Sheet title={t("lp.removeTitle")} onClose={onClose} onBack={() => setStep("overview")}
        footer={<button className="btn btn-block btn-danger" disabled={busy} onClick={confirmWithdraw}>{busy ? <Spinner /> : t("lp.removeConfirm")}</button>}>
        <div className="quote-card">
          <div className="quote-label">{t("lp.youReceiveBack")}</div>
          <div className="quote-figure" style={{ fontSize: 22 }}>{sig(Number(pos.value_exfer))}<span className="quote-unit">EXFER</span></div>
          <div className="quote-sub">+ {sig(Number(pos.value_bnb), 6)} BNB</div>
        </div>
        <div className="banner banner-info" style={{ marginTop: 14, fontSize: 12, lineHeight: 1.5 }}>{t("lp.removeNote")}</div>
        {err && <div style={{ color: "#f87171", fontSize: 13, marginTop: 10 }}>{err}</div>}
      </Sheet>
    );
  }

  // ── overview ──
  const posValueUsd = pos?.has_position ? Number(pos.value_exfer) * exferUsd * 2 : 0;
  return (
    <Sheet title={t("lp.title")} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="quote-card">
          <div className="quote-label">{t("lp.yourPosition")}</div>
          {pos?.has_position ? (
            <>
              <div className="quote-figure" style={{ fontSize: 26 }}><span className="quote-cur">$</span>{usd(posValueUsd)}</div>
              <div className="quote-sub">{sig(Number(pos.value_exfer))} EXFER + {sig(Number(pos.value_bnb), 6)} BNB · {sig(pos.pool_share_pct, 3)}% {t("lp.ofPool")}</div>
            </>
          ) : (
            <div style={{ fontSize: 14, color: "var(--text-dim)", marginTop: 4 }}>{t("lp.noPosition")}</div>
          )}
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn btn-block" style={{ flex: 1 }} onClick={() => { setErr(null); setStep("add"); }}>{t("lp.add")}</button>
          {pos?.has_position && (
            <button className="btn btn-secondary btn-block" style={{ flex: 1 }} onClick={() => { setErr(null); setStep("withdraw"); }}>{t("lp.remove")}</button>
          )}
        </div>

        <div className="banner banner-info" style={{ fontSize: 12, lineHeight: 1.55 }}>
          {t("lp.earnNote")}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-faint)", lineHeight: 1.5 }}>
          {t("lp.poolReserves", { exfer: sig(Number(pool.reserves.exfer)), bnb: sig(Number(pool.reserves.bnb), 6) })}
        </div>
      </div>
    </Sheet>
  );
}
