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
import { Sheet, Spinner, BnbMark, StagedStepper } from "../ui";
import { biometricStatus, biometricUnlock } from "../../lib/biometric";
import tokenCoin from "../../assets/exfer-token.png";
import { Icon } from "../../lib/icons";
import { AddrPicker } from "../AddrPicker";
import { shortAddress } from "../../lib/labels";
import { addLpOp, removeLpOp } from "../../lib/inflightLp";
import { useBscWallet } from "../../lib/bscWallet";
import { CreateBnbWalletSheet } from "./CreateBnbWalletSheet";

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
  // The full token coin (exfer-token.png is a centered mark on a black disc),
  // with a thin white ring so it reads as a coin on the dark sheet — like BNB.
  return (
    <img
      src={tokenCoin}
      alt=""
      width={size}
      height={size}
      style={{ borderRadius: 999, display: "block", flex: "0 0 auto", boxSizing: "border-box", border: "1px solid rgba(255,255,255,0.55)" }}
    />
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

// Cache pool + position across opens, so re-entering the sheet paints the real
// numbers instantly instead of flashing the empty state for a couple seconds.
let poolCache: PoolInfo | null = null;
const posCache: Record<string, Position> = {};

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

export function LiquiditySheet({ onClose, resumeAddId }: { onClose: () => void; resumeAddId?: string }) {
  const { balance, refresh, suspendPolling } = useWallet();
  const toast = useToast();
  const { t } = useT();
  const price = usePrice();
  const bnbUsd = useBnbUsd();
  // The BNB leg of an add is funded from the wallet's BSC key. Seedless wallets
  // start with none — `created == false` — so we gate the Add flow on it
  // existing and route to CreateBnbWalletSheet via a clear CTA before the user
  // fills anything, instead of rendering a blank BNB-from row / dead Max.
  const bsc = useBscWallet();
  const [setupOpen, setSetupOpen] = useState(false);

  useEffect(() => suspendPolling(), [suspendPolling]);

  const visible = (balance?.entries ?? []).filter((a) => !isHidden(a.address));
  const funded = visible.filter((a) => a.balance > 0);
  const defaultAddr = funded[0]?.address ?? visible[0]?.address ?? "";
  // The EXFER address that funds the deposit AND owns the position. User-visible
  // and selectable (a wallet can hold many) — was silently forced to funded[0].
  const [fromAddr, setFromAddr] = useState<string>("");
  const exferAddr = fromAddr || defaultAddr;
  const exferBal = visible.find((a) => a.address === exferAddr)?.balance ?? 0;

  const cachedPos = exferAddr ? posCache[exferAddr.toLowerCase()] ?? null : null;
  const [step, setStep] = useState<"overview" | "add" | "withdraw" | "progress" | "done">("overview");
  const [pool, setPool] = useState<PoolInfo | null>(poolCache);
  const [pos, setPos] = useState<Position | null>(cachedPos);
  const [posLoaded, setPosLoaded] = useState<boolean>(cachedPos != null);
  // The BNB-leg source / payout address is the wallet's BSC key, owned by the
  // hook — never an empty string scraped from a racing RPC.
  const bscAddr = bsc.address ?? "";
  const [bnbWei, setBnbWei] = useState<string>("0");
  const [unavailable, setUnavailable] = useState(false);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stage, setStage] = useState(0); // 0 send, 1 sweep, 2 credit
  const [withdrawPct, setWithdrawPct] = useState(100); // partial-withdraw percentage
  const [result, setResult] = useState<{ kind: ResultKind; bnb?: string; exfer?: string } | null>(null);
  // Every address that holds a position, scanned across the WHOLE wallet
  // (including hidden) — not just the selected one. Without this, a position on
  // a non-default address reads as "no liquidity" and the user can't find it.
  const [positions, setPositions] = useState<{ address: string; pos: Position }[]>([]);
  const [posScanned, setPosScanned] = useState(false);
  const [feeOpen, setFeeOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const p = await rpc<PoolInfo>("lp_pool_info");
      if ((p as unknown as { error?: string })?.error || !p.genesis_done) { setUnavailable(true); return; }
      poolCache = p;
      setPool(p);
      // The BSC address comes from useBscWallet (the single source of truth);
      // here we only need the on-chain BNB balance for the Add leg's gas check.
      const b = await rpc<{ bnb_wei: string }>("bsc_get_balances").catch(() => ({ bnb_wei: "0" }));
      setBnbWei(b.bnb_wei);
      if (exferAddr) {
        const pp = await rpc<Position>("lp_position", { address: exferAddr.toLowerCase() }).catch(() => null);
        if (pp) { posCache[exferAddr.toLowerCase()] = pp; setPos(pp); }
        setPosLoaded(true);
      }
    } catch { setUnavailable(true); }
  }, [exferAddr]);

  useEffect(() => { void load(); }, [load]);

  // Scan the whole wallet for positions once the pool is up. Polling is suspended
  // while the sheet is open, so `entries` is stable and this runs once per open.
  useEffect(() => {
    if (!pool) return;
    let cancelled = false;
    (async () => {
      const all = balance?.entries ?? [];
      const found = await Promise.all(
        all.map(async (e) => {
          const p = await rpc<Position>("lp_position", { address: e.address.toLowerCase() }).catch(() => null);
          if (p?.has_position) posCache[e.address.toLowerCase()] = p;
          return p?.has_position ? { address: e.address, pos: p } : null;
        }),
      );
      if (!cancelled) { setPositions(found.filter((x): x is { address: string; pos: Position } => x != null)); setPosScanned(true); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool]);

  // Refresh the BNB balance when opening Add — a cold walletd can return 0 at
  // first load, which would wrongly read as "not enough BNB" and disable the button.
  useEffect(() => {
    if (step !== "add") return;
    rpc<{ bnb_wei: string }>("bsc_get_balances").then((b) => { if (b?.bnb_wei) setBnbWei(b.bnb_wei); }).catch(() => {});
  }, [step]);

  // Resume an in-progress add: tapping the "processing" row in the in-progress
  // list reopens the sheet straight onto THIS deposit's progress (was wrongly
  // dropping the user on the overview). Poll it to completion like confirmAdd.
  useEffect(() => {
    if (!resumeAddId) return;
    let cancelled = false;
    setStep("progress"); setStage(1);
    (async () => {
      try {
        const status = await pollDeposit(resumeAddId);
        if (cancelled) return;
        removeLpOp(resumeAddId);
        await load(); await refresh();
        if (status === "completed") {
          const pp = await rpc<Position>("lp_position", { address: exferAddr.toLowerCase() }).catch(() => null);
          buzz([0, 30, 40, 30]);
          setResult({ kind: "added", exfer: pp?.value_exfer, bnb: pp?.value_bnb });
        } else {
          buzz(60);
          setResult({ kind: "refunded" });
        }
        setStep("done");
      } catch (e) {
        if (cancelled) return;
        buzz(60);
        setErr(humanizeError(e));
        setResult({ kind: "failed" });
        setStep("done");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeAddId]);

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
  // The BNB leg is funded from the BSC key — block the whole Add until it
  // exists (seedless wallets have none). Without it there's no BNB to send and
  // no address to sweep from, so an "add" can't complete.
  const hasBscWallet = bsc.created && !!bscAddr;
  const canAdd = hasBscWallet && amountValid && enoughExfer && enoughBnb && !belowMin;

  async function confirmAdd() {
    if (!pool || !canAdd) return;
    // Validate the BNB leg before broadcasting the EXFER transfer — otherwise a
    // missing BSC key would leave the deposit half-funded (EXFER sent, no BNB).
    if (!hasBscWallet || !bscAddr) { setSetupOpen(true); return; }
    const bio = await biometricStatus();
    if (bio.available && !(await biometricUnlock(t("lp.addTitle")))) {
      toast.error(t("swap.notConfirmedTitle"), ""); return;
    }
    setBusy(true); setErr(null); setStage(0); setStep("progress");
    try {
      const intent = await rpc<{ id: string; deposit_exfer_address: string; deposit_bsc_address: string }>(
        "lp_deposit_start", { exfer_address: exferAddr, bsc_address: bscAddr });
      // Track it so the Swap tab's "in progress" list shows it — and so it's
      // still visible if the user closes this sheet ("safe to close" hint).
      addLpOp({ id: intent.id, kind: "add", exfer: amount, bnb: sig(bnbNeeded, 4), startedAt: Date.now() });
      setStage(0);
      await rpc("transfer", { from: exferAddr, outputs: [{ to: intent.deposit_exfer_address, amount: parseExferAmount(amount) }], fee_rate: FEE_RATE });
      await rpc("bsc_send_bnb", { to: intent.deposit_bsc_address, amount: sig(bnbNeeded, 8) });
      setStage(1);
      const status = await pollDeposit(intent.id);
      removeLpOp(intent.id);
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
    const pct = withdrawPct;
    const shares = pct >= 100 ? "all" : (BigInt(pos.shares) * BigInt(pct) / 100n).toString();
    const owed = { exfer: (Number(pos.value_exfer) * pct / 100).toString(), bnb: (Number(pos.value_bnb) * pct / 100).toString() };
    setBusy(true); setErr(null);
    try {
      const w = await rpc<{ withdrawal_id?: string }>("lp_withdraw_self", { exfer_address: exferAddr, shares });
      // Show it in the Swap tab's "in progress" list while the pool pays both
      // legs (a few seconds); it falls off by TTL since there's no status poll.
      addLpOp({ id: w?.withdrawal_id || `wd-${Date.now()}`, kind: "remove", exfer: owed.exfer, bnb: sig(Number(owed.bnb), 4), startedAt: Date.now() });
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

  // ── progress (staged) — same stepper + close-and-keep-working footer as swap ──
  if (step === "progress") {
    const steps = [t("lp.stepSend"), t("lp.stepSweep"), t("lp.stepCredit")];
    return (
      <Sheet
        title={t("lp.addTitle")}
        onClose={onClose}
        footer={<button className="btn btn-block" onClick={onClose}>{t("lp.closeKeepWorking")}</button>}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "8px 0 4px" }}>
          <div style={{ textAlign: "center", fontSize: 16, fontWeight: 700 }}>{t("lp.progressHeading")}</div>
          <StagedStepper labels={steps} doneCount={stage} />
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

  // ── add: no BNB wallet yet — route to setup BEFORE any fields are filled ──
  // The BNB leg comes from the BSC key; without one there's nothing to send, so
  // show a single clear "Set up your BNB wallet" CTA instead of a blank
  // BNB-from row, a misleading "top up your BNB" disabled state, or a silent 0.
  if (step === "add" && !bsc.loading && !hasBscWallet) {
    return (
      <Sheet title={t("lp.addTitle")} onClose={onClose} onBack={() => { setStep("overview"); setErr(null); }}>
        <div className="quote-card" style={{ textAlign: "center", padding: "26px 18px" }}>
          <div style={{ width: 46, height: 46, borderRadius: 14, margin: "0 auto 12px", display: "grid", placeItems: "center", background: "color-mix(in srgb, var(--accent) 16%, transparent)", color: "var(--accent)" }}>
            <BnbMark size={26} />
          </div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{t("bnb.notCreatedTitle")}</div>
          <div style={{ fontSize: 12.5, color: "var(--text-faint)", marginTop: 5, lineHeight: 1.5 }}>{t("bnb.lpNeedsWallet")}</div>
        </div>
        <button className="btn btn-block" style={{ marginTop: 16 }} onClick={() => setSetupOpen(true)}>{t("bnb.createCta")}</button>
        {setupOpen && (
          <CreateBnbWalletSheet
            onClose={() => setSetupOpen(false)}
            onCreated={() => { setSetupOpen(false); void bsc.refresh(); void load(); }}
          />
        )}
      </Sheet>
    );
  }

  // ── add ──
  if (step === "add") {
    const maxAdd = Math.min(exferBal / 1e8, mid > 0 ? bnbHuman / mid : Infinity);
    return (
      <Sheet title={t("lp.addTitle")} onClose={onClose} onBack={() => { setStep("overview"); setErr(null); }}
        footer={<button className="btn btn-block" disabled={busy || !canAdd} onClick={confirmAdd}>{busy ? <Spinner /> : t("lp.addConfirm")}</button>}>

        {/* EXFER source: user sees AND chooses which wallet funds the deposit. */}
        <label className="eyebrow">{t("lp.fromExfer")}</label>
        {funded.length > 0
          ? <AddrPicker items={funded} value={exferAddr} onChange={setFromAddr} />
          : <div className="banner banner-warn" style={{ marginBottom: 14, fontSize: 12.5 }}>{t("lp.noFunded")}</div>}

        <label className="eyebrow">{t("lp.addExferAmount")}</label>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input className="field" inputMode="decimal" autoFocus placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ flex: 1, fontSize: 22, fontWeight: 600 }} />
          <button type="button" onClick={() => isFinite(maxAdd) && maxAdd > 0 && setAmount(sig(maxAdd))}
            style={{ border: 0, background: "var(--surface-2)", color: "var(--accent)", fontWeight: 700, fontSize: 12.5, padding: "7px 11px", borderRadius: 8, cursor: "pointer" }}>{t("lp.max")}</button>
          <span style={{ color: "var(--text-faint)", fontWeight: 600 }}>EXFER</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "8px 2px 2px" }}>
          <span style={{ fontSize: 12.5, color: amountValid && !enoughExfer ? "#fbbf24" : "var(--text-faint)" }}>
            {amountValid && !enoughExfer ? t("lp.needExfer") : `${t("lp.balance")}: ${formatBalanceCompact(exferBal)}`}
          </span>
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
        <div style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "8px 2px 0", lineHeight: 1.5 }}>{t("lp.matchRatio")}</div>

        {/* BNB source: the single BSC wallet, so the user sees where BNB comes from. */}
        <div className="quote-card" style={{ marginTop: 12, padding: "11px 13px", display: "flex", alignItems: "center", gap: 11 }}>
          <BnbMark size={26} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 12, color: "var(--text-faint)" }}>{t("lp.bnbFrom")}</span>
            <span className="mono" style={{ display: "block", fontSize: 12.5 }}>{shortAddress(bscAddr)}</span>
          </span>
          <span className="mono" style={{ fontSize: 12.5, color: amountValid && !enoughBnb ? "#fbbf24" : "var(--text-dim)", textAlign: "right" }}>{sig(bnbHuman, 4)} BNB</span>
        </div>

        {amountValid && !enoughBnb && <div className="banner banner-warn" style={{ marginTop: 10, fontSize: 12.5, lineHeight: 1.5 }}>{t("lp.needBnb", { bnb: sig(bnbNeeded, 4) })}</div>}
        {belowMin && <div className="banner banner-warn" style={{ marginTop: 10, fontSize: 12.5, lineHeight: 1.5 }}>{t("lp.belowMin", { n: sig(Math.ceil(minExfer), 2) })}</div>}
        <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 10, lineHeight: 1.5 }}>{t("lp.gasNote")}</div>
        {err && <div style={{ color: "#f87171", fontSize: 13, marginTop: 10 }}>{err}</div>}
      </Sheet>
    );
  }

  // ── withdraw ──
  if (step === "withdraw" && pos?.has_position) {
    const outExfer = Number(pos.value_exfer) * withdrawPct / 100;
    const outBnb = Number(pos.value_bnb) * withdrawPct / 100;
    return (
      <Sheet title={t("lp.removeTitle")} onClose={onClose} onBack={() => setStep("overview")}
        footer={<button className="btn btn-block btn-danger" disabled={busy} onClick={confirmWithdraw}>{busy ? <Spinner /> : (withdrawPct >= 100 ? t("lp.removeConfirm") : t("lp.removeConfirmPct", { pct: String(withdrawPct) }))}</button>}>

        {/* Partial withdrawal — was all-or-nothing before. */}
        <label className="eyebrow">{t("lp.removeAmount")}</label>
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          {[25, 50, 75, 100].map((p) => (
            <button key={p} type="button" onClick={() => setWithdrawPct(p)}
              style={{ flex: 1, padding: "9px 0", borderRadius: 10, border: 0, cursor: "pointer", font: "inherit", fontSize: 13.5, fontWeight: 700, background: withdrawPct === p ? "var(--accent)" : "var(--surface-2)", color: withdrawPct === p ? "var(--accent-ink)" : "var(--text-dim)" }}>
              {p === 100 ? t("lp.all") : `${p}%`}
            </button>
          ))}
        </div>

        <div className="quote-card" style={{ padding: "12px 14px 4px" }}>
          <div className="quote-label">{t("lp.youReceiveBack")}</div>
          <div style={{ marginTop: 6 }}>
            <TokenRow kind="exfer" amount={sig(outExfer)} />
            <div style={{ height: 1, background: "var(--border)" }} />
            <TokenRow kind="bnb" amount={sig(outBnb, 4)} />
          </div>
        </div>

        {/* Where the money lands — the two destination addresses. */}
        <div className="quote-card" style={{ marginTop: 12, padding: "11px 13px" }}>
          <div style={{ fontSize: 12, color: "var(--text-faint)", marginBottom: 7 }}>{t("lp.payoutTo")}</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12.5 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><ExferMark size={18} />EXFER</span>
            <span className="mono" style={{ color: "var(--text-dim)" }}>{shortAddress(exferAddr)}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12.5, marginTop: 7 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><BnbMark size={18} />BNB</span>
            {/* The pool pays the BNB leg back to the wallet's own BSC address;
                show a placeholder rather than a blank mono if it isn't loaded. */}
            <span className="mono" style={{ color: "var(--text-dim)" }}>{bscAddr ? shortAddress(bscAddr) : "—"}</span>
          </div>
        </div>
        <div className="banner banner-info" style={{ marginTop: 12, fontSize: 12, lineHeight: 1.5 }}>{t("lp.removeNote")}</div>
        {err && <div style={{ color: "#f87171", fontSize: 13, marginTop: 10 }}>{err}</div>}
      </Sheet>
    );
  }

  // ── overview ──
  const posValueUsd = pos?.has_position ? Number(pos.value_exfer) * exferUsd * 2 : 0;
  // Positions on addresses OTHER than the one currently shown — surfaced so a
  // user whose position sits on a non-default address can still find it.
  const others = positions.filter((p) => p.address.toLowerCase() !== exferAddr.toLowerCase());
  return (
    <Sheet title={t("lp.title")} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {pos?.has_position ? (
          <div className="quote-card" style={{ padding: "16px 14px 2px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="quote-label">{t("lp.yourPosition")}</span>
            </div>
            <div className="quote-figure" style={{ fontSize: 30, marginTop: 4 }}><span className="quote-cur" style={{ fontWeight: 500 }}>≈ $</span>{usd(posValueUsd)}</div>
            <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 2 }}>{shortAddress(exferAddr)}</div>
            <div style={{ marginTop: 10 }}>
              <div style={{ height: 1, background: "var(--border)" }} />
              <TokenRow kind="exfer" amount={sig(Number(pos.value_exfer))} />
              <div style={{ height: 1, background: "var(--border)" }} />
              <TokenRow kind="bnb" amount={sig(Number(pos.value_bnb), 4)} />
            </div>
          </div>
        ) : !posScanned || !posLoaded ? (
          <div className="quote-card" style={{ height: 150, display: "grid", placeItems: "center" }}>
            <Spinner size={22} />
          </div>
        ) : positions.length > 0 ? (
          // This address has nothing, but the wallet does — point the user at it
          // instead of the scary "no liquidity" empty state.
          <div className="quote-card" style={{ textAlign: "center", padding: "20px 18px" }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{t("lp.posElsewhereHeading")}</div>
            <div style={{ fontSize: 12.5, color: "var(--text-faint)", marginTop: 5, lineHeight: 1.5 }}>{t("lp.posElsewhereSub")}</div>
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

        {others.length > 0 && (
          <div>
            <label className="eyebrow">{t("lp.otherPositions")}</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {others.map((p) => (
                <button
                  key={p.address}
                  type="button"
                  onClick={() => { setFromAddr(p.address); setPosLoaded(false); }}
                  className="quote-card"
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 13px", border: 0, cursor: "pointer", font: "inherit", textAlign: "left", width: "100%" }}
                >
                  <ExferMark size={22} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="mono" style={{ display: "block", fontSize: 12.5, color: "var(--text-dim)" }}>{shortAddress(p.address)}</span>
                    <span style={{ display: "block", fontSize: 11.5, color: "var(--text-faint)" }}>{sig(p.pos.pool_share_pct, 3)}% {t("lp.ofPool")}</span>
                  </span>
                  <span style={{ fontWeight: 700, fontSize: 13.5 }}>≈ ${usd(Number(p.pos.value_exfer) * exferUsd * 2)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn btn-block" style={{ flex: 1 }} onClick={() => { setErr(null); setAmount(""); setStep("add"); }}>{t("lp.add")}</button>
          {pos?.has_position && <button className="btn btn-secondary btn-block" style={{ flex: 1 }} onClick={() => { setErr(null); setWithdrawPct(100); setStep("withdraw"); }}>{t("lp.remove")}</button>}
        </div>

        <div style={{ padding: "0 2px" }}>
          <button
            type="button"
            onClick={() => setFeeOpen((o) => !o)}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit", fontSize: 11.5, color: "var(--text-faint)" }}
          >
            {t("lp.feeChip")}
            <span style={{ display: "inline-grid", placeItems: "center", width: 14, height: 14, borderRadius: 999, border: "1px solid var(--text-faint)", fontSize: 9.5, fontWeight: 700, lineHeight: 1 }}>?</span>
          </button>
          {feeOpen && (
            <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.5, marginTop: 6 }}>{t("lp.feeInfo")}</div>
          )}
        </div>
      </div>
    </Sheet>
  );
}
