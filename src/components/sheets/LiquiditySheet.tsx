// Liquidity (LP) — self-serve add / remove against the swap pool. Wired to the
// walletd LP proxy RPCs. Shares are an off-chain ledger (Exfer has no VM).
//
// Flow mirrors the swap sheet's shape: a build step, a staged progress step, and
// a result screen (added / refunded / removed) with a toast — so LP feels like
// the rest of the app, not a bolt-on.

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "../../lib/wallet";
import { useToast } from "../../lib/toast";
import { rpc, formatBalanceCompact, parseExferAmount } from "../../lib/rpc";
import { humanizeError } from "../../lib/errors";
import { useT } from "../../lib/i18n";
import { isHidden } from "../../lib/hidden";
import { usePrice, useBnbUsd } from "../../lib/market";
import { Sheet, Spinner, BnbMark } from "../ui";
import { biometricStatus, biometricUnlock } from "../../lib/biometric";
import tokenLogo from "../../assets/exfer-mark.png";
import { Icon } from "../../lib/icons";

const FEE_RATE = 1; // exfers/byte, matches SendSheet
// The BNB leg is swept from a per-request address that pays its own BSC gas, so
// it must clear a safe gas floor (a few × the typical 21000-gas cost). Below
// this the pool would auto-refund the deposit, so we block it up front instead.
const MIN_BNB_LEG = 0.00001;

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
type ResultKind = "added" | "refunded" | "removed" | "failed";

function sig(n: number, d = 6): string {
  if (!isFinite(n) || n === 0) return "0";
  return n.toLocaleString("en-US", { maximumSignificantDigits: d, useGrouping: false });
}
function usd(n: number): string {
  if (!isFinite(n)) return "0"; // a transient 0 reserve must never render "$NaN"
  return n >= 1 ? n.toFixed(2) : n.toLocaleString("en-US", { maximumSignificantDigits: 3, useGrouping: false });
}
function buzz(p: number | number[]) { try { navigator.vibrate?.(p); } catch { /* unsupported */ } }

function ExferMark({ size = 26 }: { size?: number }) {
  // The brand mark on a dark coin with a white ring, to match the BNB coin.
  return (
    <span style={{ width: size, height: size, borderRadius: 999, flex: "0 0 auto", display: "grid", placeItems: "center", background: "#0b0e13", border: "1.5px solid rgba(255,255,255,0.92)", overflow: "hidden" }}>
      <img src={tokenLogo} alt="" width={size - 7} height={size - 7} style={{ display: "block" }} />
    </span>
  );
}

/** One row of a token pair: logo · name · right-aligned amount. */
function TokenRow({ kind, amount }: { kind: "exfer" | "bnb"; amount: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "9px 0" }}>
      {kind === "exfer" ? <ExferMark /> : <BnbMark size={26} />}
      <span style={{ flex: 1, fontWeight: 600, fontSize: 14.5 }}>{kind === "exfer" ? "EXFER" : "BNB"}</span>
      <span style={{ fontWeight: 600, fontSize: 14.5, fontVariantNumeric: "tabular-nums" }}>{amount}</span>
    </div>
  );
}

/** Tinted result badge, same visual language as the swap result screen. */
function ResultBadge({ kind }: { kind: "success" | "refunded" | "failed" }) {
  const color = kind === "success" ? "#34d399" : kind === "refunded" ? "#fbbf24" : "#f87171";
  const path = kind === "success" ? "M5 13l4 4L19 7" : kind === "refunded" ? "M9 14l-4-4 4-4M5 10h8a6 6 0 0 1 0 12h-1" : "M6 6l12 12M18 6L6 18";
  return (
    <div style={{ width: 64, height: 64, borderRadius: 999, background: `color-mix(in srgb, ${color} 16%, transparent)`, display: "grid", placeItems: "center" }}>
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg>
    </div>
  );
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
  const exferAddr = funded[0]?.address ?? visible[0]?.address ?? "";
  const exferBal = funded[0]?.balance ?? 0;

  const [step, setStep] = useState<"overview" | "add" | "withdraw" | "progress" | "done">("overview");
  const [pool, setPool] = useState<PoolInfo | null>(null);
  const [pos, setPos] = useState<Position | null>(null);
  const [bscAddr, setBscAddr] = useState<string>("");
  const [bnbWei, setBnbWei] = useState<string>("0");
  const [unavailable, setUnavailable] = useState(false);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stage, setStage] = useState(0); // 0 send, 1 sweep, 2 credit
  const [result, setResult] = useState<{ kind: ResultKind; bnb?: string; exfer?: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const p = await rpc<PoolInfo>("lp_pool_info");
      if ((p as unknown as { error?: string })?.error || !p.genesis_done) { setUnavailable(true); return; }
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
    } catch { setUnavailable(true); }
  }, [exferAddr]);

  useEffect(() => { void load(); }, [load]);

  // Guard the EXFER reserve: if a transient node hiccup makes the pool report 0,
  // bnb/0 = Infinity poisons every downstream number into NaN. Treat it as
  // "unknown ratio" and fall back to the OTC spot price for USD figures.
  const exferReserve = pool ? Number(pool.reserves.exfer) : 0;
  const mid = pool && exferReserve > 0 ? Number(pool.reserves.bnb) / exferReserve : 0; // BNB per EXFER
  const bnbHuman = Number(BigInt(bnbWei || "0")) / 1e18;
  const amtNum = Number(amount);
  const bnbNeeded = mid > 0 && isFinite(amtNum) ? amtNum * mid : 0;
  const exferUsd = mid > 0 && bnbUsd ? mid * bnbUsd : price?.usd ?? 0;
  const addUsd = isFinite(amtNum) ? amtNum * exferUsd * 2 : 0;
  const minExfer = mid > 0 ? MIN_BNB_LEG / mid : 0; // min EXFER so the BNB leg clears gas
  const amountValid = isFinite(amtNum) && amtNum > 0;
  const enoughExfer = amountValid && parseExferAmount(amount || "0") <= exferBal;
  const enoughBnb = bnbNeeded <= bnbHuman;
  const belowMin = amountValid && minExfer > 0 && amtNum < minExfer;
  const canAdd = amountValid && enoughExfer && enoughBnb && !belowMin;

  async function confirmAdd() {
    if (!pool || !canAdd) return;
    const bio = await biometricStatus();
    if (bio.available && !(await biometricUnlock(t("lp.addTitle")))) {
      toast.error(t("swap.notConfirmedTitle"), ""); return;
    }
    setBusy(true); setErr(null); setStage(0); setStep("progress");
    try {
      const intent = await rpc<{ id: string; deposit_exfer_address: string; deposit_bsc_address: string }>(
        "lp_deposit_start", { exfer_address: exferAddr, bsc_address: bscAddr });
      setStage(0);
      await rpc("transfer", { from: exferAddr, outputs: [{ to: intent.deposit_exfer_address, amount: parseExferAmount(amount) }], fee_rate: FEE_RATE });
      await rpc("bsc_send_bnb", { to: intent.deposit_bsc_address, amount: sig(bnbNeeded, 8) });
      setStage(1);
      const status = await pollDeposit(intent.id);
      await load(); await refresh();
      if (status === "completed") {
        const pp = await rpc<Position>("lp_position", { address: exferAddr.toLowerCase() }).catch(() => null);
        buzz([0, 30, 40, 30]);
        setResult({ kind: "added", exfer: pp?.value_exfer, bnb: pp?.value_bnb });
        toast.success(t("lp.addedTitle"), t("lp.addedBody"));
      } else {
        buzz(60);
        setResult({ kind: "refunded" });
        toast.info(t("lp.refundedTitle"), t("lp.refundedBody"));
      }
      setStep("done"); setAmount("");
    } catch (e) {
      buzz(60);
      setErr(humanizeError(e));
      setResult({ kind: "failed" });
      setStep("done");
    } finally { setBusy(false); }
  }

  function pollDeposit(id: string): Promise<"completed" | "expired"> {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = async () => {
        try {
          const s = await rpc<{ status: string }>("lp_deposit_status", { id });
          if (s.status === "completed") { setStage(2); return resolve("completed"); }
          if (s.status === "expired") return resolve("expired");
        } catch { /* transient */ }
        if (Date.now() - t0 > 5 * 60_000) return reject(new Error(t("lp.timedOut")));
        window.setTimeout(tick, 4000);
      };
      tick();
    });
  }

  async function confirmWithdraw() {
    if (!pos?.has_position) return;
    const bio = await biometricStatus();
    if (bio.available && !(await biometricUnlock(t("lp.removeTitle")))) {
      toast.error(t("swap.notConfirmedTitle"), ""); return;
    }
    const owed = { exfer: pos.value_exfer, bnb: pos.value_bnb };
    setBusy(true); setErr(null);
    try {
      await rpc("lp_withdraw_self", { exfer_address: exferAddr, shares: "all" });
      await load(); await refresh();
      buzz([0, 30, 40, 30]);
      setResult({ kind: "removed", exfer: owed.exfer, bnb: owed.bnb });
      toast.success(t("lp.removeQueuedTitle"), t("lp.removeQueuedBody"));
      setStep("done");
    } catch (e) {
      setErr(humanizeError(e));
      setStep("withdraw");
    } finally { setBusy(false); }
  }

  // ── unavailable ──
  if (unavailable) {
    return (
      <Sheet title={t("lp.title")} onClose={onClose} footer={<button className="btn btn-block" onClick={onClose}>{t("swap.done")}</button>}>
        <div style={{ padding: "28px 8px", textAlign: "center", color: "var(--text-dim)", lineHeight: 1.6 }}>{t("lp.unavailable")}</div>
      </Sheet>
    );
  }
  if (!pool) {
    return <Sheet title={t("lp.title")} onClose={onClose}><div style={{ padding: 40, display: "grid", placeItems: "center" }}><Spinner size={22} /></div></Sheet>;
  }

  // ── progress (staged) ──
  if (step === "progress") {
    const steps = [t("lp.stepSend"), t("lp.stepSweep"), t("lp.stepCredit")];
    return (
      <Sheet title={t("lp.addTitle")} onClose={onClose}>
        <div style={{ display: "flex", flexDirection: "column", gap: 18, padding: "10px 0 6px" }}>
          <div style={{ textAlign: "center", fontSize: 15, fontWeight: 700 }}>{t("lp.progressHeading")}</div>
          <div style={{ display: "flex", alignItems: "center", padding: "0 6px" }}>
            {steps.map((_, i) => {
              const done = i < stage, active = i === stage;
              const node = (
                <div key={`n${i}`} style={{ width: 30, height: 30, borderRadius: 999, flex: "0 0 auto", display: "grid", placeItems: "center", background: done ? "#34d399" : active ? "var(--accent)" : "var(--surface-2)", border: done || active ? "none" : "1px solid var(--border)", color: done || active ? "var(--accent-ink)" : "var(--text-faint)" }}>
                  {done ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg> : active ? <Spinner size={14} /> : <span style={{ width: 7, height: 7, borderRadius: 999, background: "var(--text-faint)", opacity: 0.5 }} />}
                </div>
              );
              if (i === steps.length - 1) return node;
              return [node, <div key={`c${i}`} style={{ flex: 1, height: 2, margin: "0 6px", background: i < stage ? "#34d399" : "var(--border)" }} />];
            })}
          </div>
          <div style={{ display: "flex" }}>
            {steps.map((label, i) => (
              <span key={i} style={{ flex: 1, fontSize: 11.5, textAlign: i === 0 ? "left" : i === steps.length - 1 ? "right" : "center", fontWeight: i === stage ? 700 : 500, color: i === stage ? "var(--accent)" : i < stage ? "var(--text)" : "var(--text-faint)" }}>{label}</span>
            ))}
          </div>
          <div style={{ color: "var(--text-faint)", fontSize: 12.5, textAlign: "center", lineHeight: 1.5 }}>{t("lp.progressHint")}</div>
        </div>
      </Sheet>
    );
  }

  // ── result (added / refunded / removed / failed) ──
  if (step === "done" && result) {
    const k = result.kind;
    const badge = k === "added" || k === "removed" ? "success" : k === "refunded" ? "refunded" : "failed";
    const heading = k === "added" ? t("lp.addedHeading") : k === "removed" ? t("lp.removedHeading") : k === "refunded" ? t("lp.refundedTitle") : t("lp.failedHeading");
    return (
      <Sheet title={t("lp.title")} onClose={onClose} footer={<button className="btn btn-block" onClick={() => { setResult(null); setStep("overview"); }}>{t("swap.done")}</button>}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "22px 0" }}>
          <ResultBadge kind={badge} />
          <div style={{ fontSize: 18, fontWeight: 700 }}>{heading}</div>
          {(k === "added" || k === "removed") && result.exfer && (
            <div style={{ fontSize: 14, color: "var(--text-dim)", fontWeight: 600 }}>
              {sig(Number(result.exfer))} EXFER + {sig(Number(result.bnb), 4)} BNB
            </div>
          )}
          <div style={{ color: "var(--text-faint)", fontSize: 13, textAlign: "center", lineHeight: 1.5, padding: "0 12px" }}>
            {k === "added" ? t("lp.addedDoneBody") : k === "removed" ? t("lp.removeQueuedBody") : k === "refunded" ? t("lp.refundedBody") : (err || t("lp.failedBody"))}
          </div>
        </div>
      </Sheet>
    );
  }

  // ── add ──
  if (step === "add") {
    return (
      <Sheet title={t("lp.addTitle")} onClose={onClose} onBack={() => { setStep("overview"); setErr(null); }}
        footer={<button className="btn btn-block" disabled={busy || !canAdd} onClick={confirmAdd}>{busy ? <Spinner /> : t("lp.addConfirm")}</button>}>
        <label className="eyebrow">{t("lp.addExferAmount")}</label>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input className="field" inputMode="decimal" autoFocus placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ flex: 1, fontSize: 22, fontWeight: 600 }} />
          <span style={{ color: "var(--text-faint)", fontWeight: 600 }}>EXFER</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "8px 2px 2px" }}>
          <span style={{ fontSize: 12.5, color: "var(--text-faint)" }}>{t("lp.balance")}: {formatBalanceCompact(exferBal)}</span>
          {minExfer > 0 && <span style={{ fontSize: 11.5, color: belowMin ? "#fbbf24" : "var(--text-faint)" }}>{t("lp.minHint", { n: sig(Math.ceil(minExfer), 2) })}</span>}
        </div>
        <div className="quote-card" style={{ marginTop: 10, padding: "4px 14px" }}>
          <TokenRow kind="exfer" amount={amountValid ? sig(amtNum) : "0"} />
          <div style={{ height: 1, background: "var(--border)" }} />
          <TokenRow kind="bnb" amount={amountValid ? sig(bnbNeeded, 4) : "0"} />
          <div style={{ height: 1, background: "var(--border)" }} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", fontSize: 13.5 }}>
            <span style={{ color: "var(--text-faint)" }}>{t("lp.total")}</span>
            <span style={{ fontWeight: 700 }}>≈ ${amountValid ? usd(addUsd) : "0"}</span>
          </div>
        </div>
        {belowMin && <div className="banner banner-warn" style={{ marginTop: 12, fontSize: 12.5, lineHeight: 1.5 }}>{t("lp.belowMin", { n: sig(Math.ceil(minExfer), 2) })}</div>}
        {err && <div style={{ color: "#f87171", fontSize: 13, marginTop: 10 }}>{err}</div>}
      </Sheet>
    );
  }

  // ── withdraw ──
  if (step === "withdraw" && pos?.has_position) {
    return (
      <Sheet title={t("lp.removeTitle")} onClose={onClose} onBack={() => setStep("overview")}
        footer={<button className="btn btn-block btn-danger" disabled={busy} onClick={confirmWithdraw}>{busy ? <Spinner /> : t("lp.removeConfirm")}</button>}>
        <div className="quote-card" style={{ padding: "12px 14px 4px" }}>
          <div className="quote-label">{t("lp.youReceiveBack")}</div>
          <div style={{ marginTop: 6 }}>
            <TokenRow kind="exfer" amount={sig(Number(pos.value_exfer))} />
            <div style={{ height: 1, background: "var(--border)" }} />
            <TokenRow kind="bnb" amount={sig(Number(pos.value_bnb), 4)} />
          </div>
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
        {pos?.has_position ? (
          <div className="quote-card" style={{ padding: "16px 14px 2px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="quote-label">{t("lp.yourPosition")}</span>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--accent)", background: "color-mix(in srgb, var(--accent) 14%, transparent)", padding: "2px 8px", borderRadius: 999 }}>
                {sig(pos.pool_share_pct, 3)}% {t("lp.ofPool")}
              </span>
            </div>
            <div className="quote-figure" style={{ fontSize: 30, marginTop: 4 }}><span className="quote-cur">$</span>{usd(posValueUsd)}</div>
            <div style={{ marginTop: 10 }}>
              <div style={{ height: 1, background: "var(--border)" }} />
              <TokenRow kind="exfer" amount={sig(Number(pos.value_exfer))} />
              <div style={{ height: 1, background: "var(--border)" }} />
              <TokenRow kind="bnb" amount={sig(Number(pos.value_bnb), 4)} />
            </div>
          </div>
        ) : (
          <div className="quote-card" style={{ textAlign: "center", padding: "26px 18px" }}>
            <div style={{ width: 46, height: 46, borderRadius: 14, margin: "0 auto 12px", display: "grid", placeItems: "center", background: "color-mix(in srgb, var(--accent) 16%, transparent)", color: "var(--accent)" }}>
              <Icon name="spark" size={22} />
            </div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{t("lp.emptyHeading")}</div>
            <div style={{ fontSize: 12.5, color: "var(--text-faint)", marginTop: 5, lineHeight: 1.5 }}>{t("lp.emptySub")}</div>
          </div>
        )}

        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn btn-block" style={{ flex: 1 }} onClick={() => { setErr(null); setAmount(""); setStep("add"); }}>{t("lp.add")}</button>
          {pos?.has_position && <button className="btn btn-secondary btn-block" style={{ flex: 1 }} onClick={() => { setErr(null); setStep("withdraw"); }}>{t("lp.remove")}</button>}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11.5, color: "var(--text-faint)", padding: "0 2px" }}>
          <span>{t("lp.feeChip")}</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{t("lp.poolChip", { exfer: sig(Number(pool.reserves.exfer), 5), bnb: sig(Number(pool.reserves.bnb), 3) })}</span>
        </div>
      </div>
    </Sheet>
  );
}
