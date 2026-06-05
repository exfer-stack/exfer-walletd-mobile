// Home — balance hero, Receive/Send, address list, New-address menu.

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../lib/icons";
import tokenLogo from "../assets/exfer-mark.png";
import { useWallet } from "../lib/wallet";
import { useToast } from "../lib/toast";
import { useBalanceMask, Masked } from "../lib/balance";
import {
  MAX_ADDRESSES,
  rpc,
  splitBalanceCompact,
  revealEvmPrivateKey,
} from "../lib/rpc";
import { usePrice, usdValue, useBnbUsd } from "../lib/market";
import { useT } from "../lib/i18n";
import { shortAddress } from "../lib/labels";
import { isHidden } from "../lib/hidden";
import { addrName } from "../lib/format";
import type { WalletEntry } from "../lib/types";
import { AddrAvatar, ActionMenu, PendingDot, Modal, CopyButton, Spinner, BnbMark } from "./ui";
import { Qr } from "./Qr";
import { ImportPhraseModal, ImportKeyFileModal } from "./modals/ImportModals";
import { NewAddressModal } from "./modals/NewAddressModal";
import { CreateBnbWalletSheet } from "./sheets/CreateBnbWalletSheet";
import { useBscWallet, revealBscMnemonic } from "../lib/bscWallet";
import { biometricStatus, biometricUnlock } from "../lib/biometric";
import { humanizeError } from "../lib/errors";

/** 24h change pill — green ▲ for up, red ▼ for down, muted for flat. */
function ChangePill({ pct }: { pct: number }) {
  const up = pct > 0.05, down = pct < -0.05;
  const color = up ? "#34d399" : down ? "#f87171" : "var(--text-faint)";
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex", alignItems: "center", gap: 3,
        fontSize: 12, fontWeight: 600, color,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
        padding: "2px 8px", borderRadius: 999,
      }}
    >
      {up ? "▲" : down ? "▼" : "•"} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

function PrimaryAction({
  icon,
  label,
  onClick,
  variant,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  variant: "primary" | "secondary";
}) {
  const primary = variant === "primary";
  return (
    <button
      onClick={onClick}
      className="tap"
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: "14px 16px",
        borderRadius: 14,
        cursor: "pointer",
        font: "inherit",
        fontWeight: 600,
        fontSize: 15,
        letterSpacing: "-.01em",
        color: primary ? "var(--accent-ink)" : "var(--text)",
        background: primary ? "var(--accent)" : "var(--surface-2)",
        // Both keep a 1px border so the box models (and label baselines)
        // match exactly — the accent one is just transparent.
        border: primary ? "1px solid transparent" : "1px solid var(--border)",
      }}
    >
      <Icon name={icon} size={18} stroke={2} />
      {label}
    </button>
  );
}

/** Format native BNB wei (18 dp) to a short human string. Gas-sized balances are
 *  tiny (≈0.0000017 BNB), so a fixed 5-dp cut showed them as a flat "0". For a
 *  sub-1 balance we extend precision to keep ~4 significant digits, so a real
 *  (non-zero) balance never reads as 0. */
function fmtBnbWei(wei: string | undefined, maxFrac = 6): string {
  if (!wei) return "0";
  try {
    const n = BigInt(wei);
    const base = 10n ** 18n;
    const whole = n / base;
    const rem = (n % base).toString().padStart(18, "0");
    let frac = maxFrac;
    if (whole === 0n && n > 0n) {
      const firstSig = rem.search(/[1-9]/);
      if (firstSig >= 0) frac = Math.min(18, firstSig + 4); // ~4 significant figures
    }
    const f = rem.slice(0, frac).replace(/0+$/, "");
    return f ? `${whole}.${f}` : `${whole}`;
  } catch {
    return "0";
  }
}

// Wei → a plain BNB decimal string for an amount input. Floors (never rounds
// up) at `dp` places so the value can never exceed the on-chain balance.
function weiToBnbAmount(wei: bigint, dp = 8): string {
  if (wei <= 0n) return "0";
  const base = 10n ** 18n;
  const whole = wei / base;
  const frac = (wei % base).toString().padStart(18, "0").slice(0, dp).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// Module-level cache for the BNB asset (address + balance + mid price). Home
// unmounts on every tab switch, so without this the BNB card refetches from
// scratch each time and visibly pops in a beat late. Seeding initial state from
// the cache makes the card render immediately with the last-known values while
// the fresh poll runs in the background.
//
// The cache stores the address it belongs to so it can NEVER leak across a
// wallet switch / lock: after a switch the authoritative address (from
// useBscWallet) differs, and we drop any cache that doesn't match it instead of
// showing the previous wallet's BNB address + balance.
let bnbCache: { addr: string; wei: string; reserveWei?: string } | null = null;
let bnbMidCache: number | null = null;

export function Home({
  onReceive,
  onSend,
  onOpenAddress,
}: {
  onReceive: () => void;
  onSend: () => void;
  onOpenAddress: (address: string) => void;
}) {
  const { balance, error, refresh } = useWallet();
  const price = usePrice();
  const bnbUsd = useBnbUsd();
  const { t } = useT();
  const toast = useToast();

  // The wallet's BNB key as a first-class identity. Seedless wallets (every
  // in-app create + vault import) start with NO BNB key — `created` is false
  // until the user sets one up, which routes the BNB card to a "Set up" CTA
  // instead of a dead/blank control.
  const bsc = useBscWallet();
  const [createBnbOpen, setCreateBnbOpen] = useState(false);

  // Drop any cached BNB balance that belongs to a DIFFERENT address than the
  // wallet's current BNB key (a wallet switch / lock leaves a stale cache).
  if (bnbCache && bsc.address && bnbCache.addr !== bsc.address) {
    bnbCache = null;
    bnbMidCache = null;
  }

  // The user's BNB lives at an in-wallet BSC address. Surface it as a first-class
  // asset so funded BNB is never invisible (a newcomer who deposits BNB and then
  // can't see it assumes their money is gone). No-ops when swap isn't configured.
  const [bnb, setBnb] = useState<{ addr: string; wei: string; reserveWei?: string } | null>(bnbCache);
  // Pool mid price (BNB per EXFER) — lets us derive an implied BNB/USD value
  // (EXFER/USD ÷ BNB-per-EXFER) so the BNB card can show ≈$ like every other row.
  const [bnbMid, setBnbMid] = useState<number | null>(bnbMidCache);
  const [depositOpen, setDepositOpen] = useState(false);
  // BNB private-key export modal (password + biometric gated).
  const [exportKey, setExportKey] = useState(false);
  // BNB withdraw form (inside the BNB modal): toggle + fields.
  const [bnbWithdraw, setBnbWithdraw] = useState(false);
  const [wto, setWto] = useState("");
  const [wamt, setWamt] = useState("");
  // True while the amount field holds the auto-computed "send everything" value.
  // We then send "max" (walletd sweeps from the live balance) rather than the
  // shown estimate, and keep the displayed figure in sync as the balance polls.
  const [wamtMax, setWamtMax] = useState(false);
  const [wbusy, setWbusy] = useState(false);

  // Wei the wallet holds back for gas on a full sweep (live, from walletd), and
  // the resulting "send everything" amount = balance − reserve. Both are bigint
  // | null so the form can hide the fee preview until the figures are known.
  const reserveWei = useMemo(() => {
    try { return bnb?.reserveWei ? BigInt(bnb.reserveWei) : null; } catch { return null; }
  }, [bnb?.reserveWei]);
  const maxSendWei = useMemo(() => {
    if (!bnb || reserveWei == null) return null;
    try {
      const bal = BigInt(bnb.wei);
      return bal > reserveWei ? bal - reserveWei : 0n;
    } catch { return null; }
  }, [bnb?.wei, reserveWei]);

  // Keep the auto-filled "全部" amount fresh as the balance re-polls.
  useEffect(() => {
    if (wamtMax && maxSendWei != null) setWamt(weiToBnbAmount(maxSendWei));
  }, [wamtMax, maxSendWei]);

  const wAddrValid = /^0x[0-9a-fA-F]{40}$/.test(wto.trim());
  const wAmtNum = Number.parseFloat(wamt);
  const wAmtPositive = Number.isFinite(wAmtNum) && wAmtNum > 0;

  async function withdrawBnb() {
    const to = wto.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
      toast.error(t("home.wdBadAddr"), "");
      return;
    }
    const bio = await biometricStatus();
    if (bio.available) {
      const ok = await biometricUnlock(t("home.wdConfirm"));
      if (!ok) return;
    }
    setWbusy(true);
    try {
      // In "全部" mode send the literal "max" so walletd sweeps from the live
      // balance (the shown figure is an estimate); otherwise send the typed
      // amount verbatim — what the user sees is what's sent.
      const amount = wamtMax ? "max" : wamt.trim();
      const r = await rpc<{ txhash: string }>("bsc_send_bnb", { to, amount });
      toast.success(t("home.wdSent"), shortAddress(r.txhash));
      setBnbWithdraw(false);
      setWto("");
      setWamt("");
      setWamtMax(false);
    } catch (e) {
      toast.error(t("home.wdFailed"), humanizeError(e));
    } finally {
      setWbusy(false);
    }
  }
  const bscAddr = bsc.address;
  useEffect(() => {
    // No BNB key yet → nothing to poll; the card renders the "Set up" CTA. Drop
    // any leftover balance so a freshly-created/switched wallet starts clean.
    if (!bscAddr) {
      bnbCache = null;
      setBnb(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const b = await rpc<{ bnb_wei: string; gas_reserve_wei?: string }>("bsc_get_balances");
        bnbCache = { addr: bscAddr, wei: b.bnb_wei, reserveWei: b.gas_reserve_wei };
        if (!cancelled) setBnb(bnbCache);
        try {
          const p = await rpc<{ mid_price_bnb_per_exfer: number | null }>("swap_pool_info");
          bnbMidCache = p?.mid_price_bnb_per_exfer ?? null;
          if (!cancelled) setBnbMid(bnbMidCache);
        } catch { /* preview is best-effort */ }
      } catch {
        // Engine off / not configured. Keep any cached card rather than
        // blanking it on a transient failure; only the very first load (no
        // cache for THIS address) shows just the address with no balance.
        if (!cancelled && (!bnbCache || bnbCache.addr !== bscAddr)) {
          setBnb({ addr: bscAddr, wei: "0" });
        }
      }
    };
    load();
    const id = window.setInterval(load, 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [bscAddr]);

  // While the Deposit BNB modal is open, poll faster (~5s) and celebrate when
  // the BNB balance increases — so a fresh deposit is never silent. Cleans up
  // when the modal closes / unmounts.
  const lastBnbWeiRef = useRef<bigint | null>(null);
  useEffect(() => {
    if (!depositOpen) {
      lastBnbWeiRef.current = null;
      return;
    }
    try {
      lastBnbWeiRef.current = bnb ? BigInt(bnb.wei) : null;
    } catch {
      lastBnbWeiRef.current = null;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const b = await rpc<{ bnb_wei: string }>("bsc_get_balances");
        if (cancelled) return;
        setBnb((prev) => {
          const next = prev ? { ...prev, wei: b.bnb_wei } : prev;
          if (next) bnbCache = next;
          return next;
        });
        const now = BigInt(b.bnb_wei);
        const prev = lastBnbWeiRef.current;
        if (prev != null && now > prev) {
          toast.success(t("swap.bnbReceived"), t("swap.bnbReceivedBody", { delta: fmtBnbWei((now - prev).toString()) }));
        }
        lastBnbWeiRef.current = now;
      } catch {
        /* transient / engine off; keep polling */
      }
    };
    const id = window.setInterval(tick, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [depositOpen, bnb, toast, t]);

  // `balance` is null until the first successful load. Show skeletons while
  // it's loading, but if that first load FAILED show an error+retry instead
  // of an infinite skeleton (and never a misleading "0 / No addresses").
  const firstLoad = balance === null && !error;
  const loadError = balance === null && !!error;
  const { toggle } = useBalanceMask();
  const [showHidden, setShowHidden] = useState(false);
  // Create-address modal (the primary path: generate + name in one step).
  const [createOpen, setCreateOpen] = useState(false);
  // Import options menu — reached only via the modal's secondary link, so
  // import no longer sits next to "create" as an equal first choice.
  const [importMenu, setImportMenu] = useState(false);
  const [impPhrase, setImpPhrase] = useState(false);
  const [impKey, setImpKey] = useState(false);

  const entries: WalletEntry[] = balance?.entries ?? [];
  const hiddenAddrs = entries.filter((a) => isHidden(a.address));
  const vis = entries.filter((a) => !isHidden(a.address));
  const list = showHidden ? entries : vis;

  const projected = useMemo(
    () =>
      vis.reduce(
        (s, a) =>
          s + a.balance + (a.pending_received ?? 0) - (a.pending_spent ?? 0),
        0,
      ),
    [vis],
  );
  const { whole, frac } = splitBalanceCompact(projected);
  // Responsive headline size: a fixed 58px overflowed once the integer part grew
  // (e.g. 583,999.2917 pushed the faded decimals and the "EXFER" suffix off the
  // right edge). Scale down by the rendered length so the whole line always fits
  // (the decimals render at 0.72em, hence the weight). Small balances stay 58px.
  const balLen = whole.length + (frac ? (frac.length + 1) * 0.72 : 0);
  const balFont = Math.max(26, Math.min(58, Math.floor(265 / (0.58 * balLen))));
  const atCap = entries.length >= MAX_ADDRESSES;

  function newAddress() {
    if (atCap) {
      toast.error(
        t("home.capToastTitle"),
        t("home.capToastBody", { max: MAX_ADDRESSES }),
      );
      return;
    }
    setCreateOpen(true);
  }

  return (
    <div className="screen">
      <div
        className="screen-pad"
        style={
          loadError
            ? {
                position: "relative",
                overflow: "hidden",
                // Fill the screen area (the tab bar is a sibling of .screen)
                // and center the message vertically instead of pinning it to
                // the top third.
                minHeight: "100%",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                textAlign: "center",
              }
            : { position: "relative", overflow: "hidden" }
        }
      >
        {loadError ? (
          <div style={{ maxWidth: 300, padding: "0 18px" }}>
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 16,
                margin: "0 auto 14px",
                display: "grid",
                placeItems: "center",
                background: "var(--surface-2)",
                color: "var(--text-faint)",
              }}
            >
              <Icon name="node" size={26} />
            </div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("home.netErrTitle")}</div>
            <div
              className="faint"
              style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.5, padding: "0 10px" }}
            >
              {t("home.netErrBody")}
            </div>
            <button className="btn btn-sm" onClick={() => refresh()}>
              {t("home.retry")}
            </button>
          </div>
        ) : (
          <>
        {/* Brand token mark as a large, flat backdrop bleeding off the
            top-right corner — sits behind ALL content (opaque buttons/cards
            cover it; it only shows through the empty negative space). */}
        <img
          src={tokenLogo}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="brand-backdrop"
          style={{
            position: "absolute",
            top: -86,
            right: -96,
            width: 360,
            height: 360,
            pointerEvents: "none",
            userSelect: "none",
            zIndex: 0,
          }}
        />
        <div style={{ position: "relative", zIndex: 1 }}>
        <button
          onClick={toggle}
          className="tap"
          style={{
            background: "none",
            border: 0,
            width: "100%",
            textAlign: "left",
            cursor: "pointer",
            padding: "18px 0 20px",
          }}
        >
          <div className="eyebrow" style={{ marginBottom: 10, letterSpacing: ".12em" }}>
            {t("home.totalBalance")}
          </div>
          {firstLoad ? (
            <span
              className="skeleton"
              style={{ width: 168, height: 46, borderRadius: 12, verticalAlign: "middle" }}
            />
          ) : (
            <div style={{ display: "flex", alignItems: "baseline", gap: 7, whiteSpace: "nowrap", maxWidth: "100%" }}>
              <span
                style={{
                  fontFamily: '"Geist Variable","Geist", sans-serif',
                  fontSize: balFont,
                  fontWeight: 600,
                  // Proportional figures (no tnum) so the zeros don't spread,
                  // with lighter tracking — tabular + heavy tracking is what
                  // made "0.00002" read oddly spaced.
                  letterSpacing: "-.02em",
                  lineHeight: 1,
                }}
              >
                <Masked dots="••••">
                  <span>{whole}</span>
                  {frac && (
                    <span
                      style={{ color: "var(--text-faint)", fontWeight: 500, fontSize: "0.72em" }}
                    >
                      .{frac}
                    </span>
                  )}
                </Masked>
              </span>
              <span
                style={{
                  fontSize: 15,
                  fontWeight: 500,
                  color: "var(--text-faint)",
                  letterSpacing: ".06em",
                }}
              >
                EXFER
              </span>
            </div>
          )}
          {!firstLoad && price && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
              <span className="mono" style={{ fontSize: 14, color: "var(--text-dim)" }}>
                <Masked dots="••••">≈ {usdValue(projected, price.usd)}</Masked>
              </span>
              <ChangePill pct={price.change24h} />
            </div>
          )}
          {/* No "confirming" pill here: the hero already shows the projected
              total, so incoming funds read as arrived instantly. The
              still-confirming state lives only on the address row (a small
              dot) and in the address detail. */}
        </button>

        <div style={{ display: "flex", gap: 10, padding: "4px 0 24px" }}>
          <PrimaryAction icon="receive" label={t("home.receive")} onClick={onReceive} variant="secondary" />
          <PrimaryAction icon="send" label={t("home.send")} onClick={onSend} variant="primary" />
        </div>

        {/* BNB — three states:
            1. No key yet (seedless wallet, created=false): a "Set up your BNB
               wallet" CTA so the control is never dead/blank.
            2. Key exists (created=true): the BNB asset card with balance.
            3. While the key state is still loading: render nothing (no flash).
            Surfaced as a first-class asset so deposited/received BNB is never
            invisible. */}
        {!bsc.loading && !bsc.created && (
          <button
            onClick={() => setCreateBnbOpen(true)}
            className="card"
            style={{
              width: "100%", display: "flex", alignItems: "center", gap: 12,
              padding: "13px 14px", marginBottom: 14, textAlign: "left",
            }}
          >
            <BnbMark size={36} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 14, fontWeight: 600 }}>
                {t("bnb.notCreatedTitle")}
              </span>
              <span style={{ display: "block", fontSize: 12, color: "var(--text-faint)", lineHeight: 1.4, marginTop: 2 }}>
                {t("bnb.notCreatedBody")}
              </span>
            </span>
            <span
              style={{
                flex: "0 0 auto",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "6px 10px",
                borderRadius: 999,
                background: "color-mix(in srgb, var(--accent) 15%, transparent)",
                color: "var(--accent)",
                fontSize: 12.5,
                fontWeight: 600,
              }}
            >
              <Icon name="plus" size={14} />
            </span>
          </button>
        )}
        {bsc.created && bnb && (
          <button
            onClick={() => setDepositOpen(true)}
            className="card"
            style={{
              width: "100%", display: "flex", alignItems: "center", gap: 12,
              padding: "13px 14px", marginBottom: 14, textAlign: "left",
            }}
          >
            <BnbMark size={36} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 14, fontWeight: 600 }}>BNB</span>
              <span style={{ display: "block", fontSize: 12, color: "var(--text-faint)" }}>
                {t("home.bnbChain")}
              </span>
            </span>
            <span style={{ textAlign: "right" }}>
              <span style={{ display: "block", fontSize: 15, fontWeight: 600 }}>
                <Masked dots="••••">
                  {(() => {
                    const [w, f = ""] = fmtBnbWei(bnb.wei).split(".");
                    return (
                      <>
                        {w}
                        {f && <span style={{ color: "var(--text-faint)", fontWeight: 500 }}>.{f}</span>}
                      </>
                    );
                  })()}
                </Masked>
              </span>
              {(() => {
                const bnbHuman = Number(BigInt(bnb.wei)) / 1e18;
                // Prefer the real BNB/USD spot; fall back to the pool-implied
                // value (EXFER/USD ÷ pool ratio) only if the feed is down.
                const usd =
                  bnbUsd != null
                    ? bnbHuman * bnbUsd
                    : price && bnbMid && bnbMid > 0
                      ? (bnbHuman * price.usd) / bnbMid
                      : null;
                if (usd == null || !isFinite(usd)) return null;
                const s = usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2);
                return (
                  <span style={{ display: "block", fontSize: 12, color: "var(--text-faint)" }}>
                    <Masked dots="••">≈ ${s}</Masked>
                  </span>
                );
              })()}
            </span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: "0 0 auto" }}>
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        )}

        <div className="h-row" style={{ marginBottom: 11 }}>
          <div className="eyebrow">{t("home.addresses")}</div>
          <button
            onClick={newAddress}
            disabled={atCap}
            className="tap"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              padding: "7px 13px",
              borderRadius: 999,
              border: 0,
              cursor: "pointer",
              background: "var(--surface-2)",
              color: "var(--accent)",
              fontSize: 13.5,
              fontWeight: 600,
              opacity: atCap ? 0.4 : 1,
            }}
          >
            <Icon name="plus" size={15} /> {t("home.newAddress")}
          </button>
        </div>

        <div className="list">
          {firstLoad &&
            [0, 1].map((i) => (
              <div
                key={"sk" + i}
                className="list-row"
                style={{ cursor: "default" }}
              >
                <span
                  className="skeleton"
                  style={{ width: 40, height: 40, borderRadius: 12, flex: "0 0 auto" }}
                />
                <span style={{ flex: 1, display: "grid", gap: 7 }}>
                  <span className="skeleton" style={{ width: "42%", height: 13, borderRadius: 6 }} />
                  <span className="skeleton" style={{ width: "64%", height: 11, borderRadius: 6 }} />
                </span>
                <span className="skeleton" style={{ width: 56, height: 14, borderRadius: 6 }} />
              </div>
            ))}
          {!firstLoad && list.length === 0 && (
            <div style={{ padding: "30px 18px", textAlign: "center" }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("home.noAddrTitle")}</div>
              <div className="faint" style={{ fontSize: 13, marginBottom: 14 }}>
                {t("home.noAddrBody")}
              </div>
              <button className="btn btn-sm" onClick={newAddress}>
                + {t("home.genAddr")}
              </button>
            </div>
          )}
          {!firstLoad && list.map((a) => {
            // Projected: confirmed + incoming − outgoing (mirror the total
            // at the top). Without the −pending_spent term a row overstates
            // its balance while one of its own sends is still in the mempool.
            const bal =
              a.balance + (a.pending_received ?? 0) - (a.pending_spent ?? 0);
            const isHid = isHidden(a.address);
            return (
              <button
                key={a.address}
                className="list-row"
                onClick={() => onOpenAddress(a.address)}
                style={{ opacity: isHid ? 0.5 : 1 }}
              >
                <AddrAvatar address={a.address} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: 15.5,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {addrName(a)}
                    </span>
                  </span>
                  <span
                    className="mono faint"
                    style={{ fontSize: 12, display: "block", marginTop: 2 }}
                  >
                    {shortAddress(a.address, 6, 6)}
                  </span>
                </span>
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                  }}
                >
                  {/* fixed-width slot so the amount stays on a hard right rail
                      whether or not the row is confirming */}
                  <span style={{ width: 6, display: "inline-flex", justifyContent: "center" }}>
                    {(a.pending_received ?? 0) > 0 && (
                      <PendingDot title="incoming, confirming" />
                    )}
                  </span>
                  <span
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-end",
                      gap: 2,
                    }}
                  >
                    <span
                      className="mono"
                      style={{
                        fontSize: 14.5,
                        fontWeight: 500,
                        color: bal === 0 ? "var(--text-faint)" : "var(--text)",
                      }}
                    >
                      <Masked dots="•••">
                        {(() => {
                          const s = splitBalanceCompact(bal);
                          return (
                            <>
                              {s.whole}
                              {s.frac && (
                                <span style={{ color: "var(--text-faint)" }}>.{s.frac}</span>
                              )}
                            </>
                          );
                        })()}
                      </Masked>
                    </span>
                    {price && bal > 0 && (
                      <span className="mono faint" style={{ fontSize: 11 }}>
                        <Masked dots="•••">≈ {usdValue(bal, price.usd)}</Masked>
                      </span>
                    )}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {hiddenAddrs.length > 0 && (
          <button
            className="btn-ghost btn-sm"
            onClick={() => setShowHidden((v) => !v)}
            style={{ marginTop: 12, color: "var(--text-dim)" }}
          >
            {showHidden
              ? t("home.hideHidden", { n: hiddenAddrs.length })
              : t("home.showHidden", { n: hiddenAddrs.length })}
          </button>
        )}

        {atCap && (
          <div
            className="faint"
            style={{ fontSize: 12, textAlign: "center", marginTop: 14, lineHeight: 1.5 }}
          >
            {t("home.capNote", { max: MAX_ADDRESSES })}
          </div>
        )}
        </div>
          </>
        )}
      </div>

      {createOpen && (
        <NewAddressModal
          onClose={() => setCreateOpen(false)}
          onCreated={refresh}
          onImport={() => {
            setCreateOpen(false);
            setImportMenu(true);
          }}
        />
      )}
      {importMenu && (
        <ActionMenu
          title="Import an address"
          onClose={() => setImportMenu(false)}
          items={[
            {
              icon: "key",
              label: "Import recovery phrase",
              onClick: () => {
                setImportMenu(false);
                setImpPhrase(true);
              },
            },
            {
              icon: "download",
              label: "Import wallet.key file",
              onClick: () => {
                setImportMenu(false);
                setImpKey(true);
              },
            },
          ]}
        />
      )}
      {impPhrase && (
        <ImportPhraseModal
          onClose={() => setImpPhrase(false)}
          onImported={refresh}
        />
      )}
      {impKey && (
        <ImportKeyFileModal onClose={() => setImpKey(false)} onImported={refresh} />
      )}
      {depositOpen && bnb && (
        <Modal
          title={bnbWithdraw ? t("home.withdrawBnb") : t("home.depositBnb")}
          onClose={() => { setDepositOpen(false); setBnbWithdraw(false); }}
        >
          {bnbWithdraw ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "2px 0" }}>
              {/* Balance hero — the big figure a sender checks first. */}
              <div className="quote-card" style={{ margin: 0 }}>
                <div className="quote-label">{t("home.wdAvail")}</div>
                <div className="quote-figure">
                  {fmtBnbWei(bnb.wei)} <span className="quote-unit">BNB</span>
                </div>
              </div>

              {/* Destination address with an inline validity check. */}
              <div>
                <label className="field-label">{t("home.wdTo")}</label>
                <div style={{ position: "relative" }}>
                  <input
                    className="field mono"
                    placeholder="0x…"
                    value={wto}
                    onChange={(e) => setWto(e.target.value)}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    style={{ paddingRight: 42 }}
                  />
                  {wAddrValid && (
                    <span style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", color: "#34d399", display: "flex" }}>
                      <Icon name="check" size={18} stroke={2.4} />
                    </span>
                  )}
                </div>
                {wto.trim() !== "" && !wAddrValid && (
                  <div className="field-help" style={{ color: "#fca5a5" }}>{t("home.wdBadAddr")}</div>
                )}
              </div>

              {/* Amount — a large figure on an inset leg with a tappable 全部 pill. */}
              <div>
                <label className="field-label">{t("home.wdAmount")}</label>
                <div className="swap-leg" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input
                    className="swap-amount"
                    inputMode="decimal"
                    placeholder="0.0"
                    value={wamt}
                    onChange={(e) => { setWamt(e.target.value); setWamtMax(false); }}
                  />
                  <span style={{ color: "var(--text-faint)", fontWeight: 600, fontSize: 15 }}>BNB</span>
                  <button
                    type="button"
                    className={`pill ${wamtMax ? "pill-accent" : "pill-muted"}`}
                    disabled={maxSendWei == null}
                    onClick={() => {
                      if (maxSendWei == null) return;
                      setWamt(weiToBnbAmount(maxSendWei));
                      setWamtMax(true);
                    }}
                    style={{ border: 0, padding: "6px 13px", fontSize: 12.5, cursor: maxSendWei == null ? "not-allowed" : "pointer" }}
                  >
                    {t("snd.max")}
                  </button>
                </div>
              </div>

              {/* Fee preview — only once an amount and the live reserve are known. */}
              {wAmtPositive && reserveWei != null && (
                <div className="quote-card" style={{ margin: 0 }}>
                  <div className="quote-detail quote-detail-bare">
                    <div className="quote-row">
                      <span className="quote-row-k">{t("home.wdReceive")}</span>
                      <span className="quote-row-v">{wamtMax ? "≈ " : ""}{wamt} <small>BNB</small></span>
                    </div>
                    <div className="quote-row">
                      <span className="quote-row-k">{t("home.wdFeeReserve")}</span>
                      <span className="quote-row-v">≈ {fmtBnbWei(bnb.reserveWei)} <small>BNB</small></span>
                    </div>
                  </div>
                  <div className="field-help" style={{ marginTop: 10 }}>{t("home.wdFeeNote")}</div>
                </div>
              )}

              <div className="banner banner-info" style={{ fontSize: 12.5, lineHeight: 1.55 }}>
                {t("home.wdNote")}
              </div>
              <button className="btn btn-block" disabled={wbusy || !wAddrValid || !wAmtPositive} onClick={withdrawBnb}>
                {wbusy ? <Spinner /> : t("home.wdSend")}
              </button>
              <button className="btn-ghost btn-block" onClick={() => { setBnbWithdraw(false); setWamtMax(false); }}>
                {t("home.wdBackDeposit")}
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "4px 0" }}>
              <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
                {t("home.bnbBalanceLabel")}: <b>{fmtBnbWei(bnb.wei)} BNB</b>
              </div>
              {/* Plain-language "what is this address" so a non-technical user
                  isn't puzzled by a BNB address appearing in an EXFER wallet. */}
              <div style={{ fontSize: 12.5, color: "var(--text-faint)", lineHeight: 1.55, textAlign: "center", padding: "0 4px" }}>
                {t("home.bnbWhat")}
              </div>
              <Qr value={bnb.addr} size={170} />
              {/* Full address (wraps) in an inset chip — a deposit address must
                  be fully verifiable; the copy button sits centered against it. */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", background: "var(--surface-2)", borderRadius: 12, padding: "10px 12px" }}>
                <span className="mono" style={{ flex: 1, minWidth: 0, wordBreak: "break-all", lineHeight: 1.55, fontSize: 12.5 }}>
                  {bnb.addr}
                </span>
                <CopyButton text={bnb.addr} />
              </div>
              {(() => {
                let zero = false;
                try { zero = BigInt(bnb.wei) === 0n; } catch { zero = false; }
                return zero ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-faint)", fontSize: 12.5 }}>
                    <Spinner size={13} /> {t("swap.waitingBnb")}
                  </div>
                ) : null;
              })()}
              <div className="banner banner-info" style={{ fontSize: 12.5, lineHeight: 1.55 }}>
                {t("home.depositBnbBody")}
              </div>
              <button className="btn btn-secondary btn-block" onClick={() => setBnbWithdraw(true)}>
                {t("home.withdrawBnb")}
              </button>
              <button
                className="btn-ghost btn-block"
                style={{ color: "var(--text-dim)" }}
                onClick={() => { setDepositOpen(false); setBnbWithdraw(false); setExportKey(true); }}
              >
                {t("home.exportBnbKey")}
              </button>
            </div>
          )}
        </Modal>
      )}
      {exportKey && <ExportBnbKeyModal onClose={() => setExportKey(false)} />}
      {createBnbOpen && (
        <CreateBnbWalletSheet
          onClose={() => setCreateBnbOpen(false)}
          onCreated={() => {
            // Re-fetch the key state so the card flips to the funded view and
            // the balance poll starts for the new address.
            bsc.refresh();
          }}
        />
      )}
    </div>
  );
}

/* The BNB (BSC/EVM) private key — password + biometric gated — so the user can
 * import their BNB address into MetaMask-style wallets ("Import account →
 * Private key"). The key is derived at m/44'/60'/0'/0/0, the standard path, so
 * the same address appears in MetaMask. */
function ExportBnbKeyModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const { t } = useT();
  const [pw, setPw] = useState("");
  const [data, setData] = useState<{ address: string; key: string; mnemonic: string[] | null } | null>(null);
  const [busy, setBusy] = useState(false);

  async function reveal() {
    if (pw.length < 4) {
      toast.error(t("home.expEnterPw"), "");
      return;
    }
    const bio = await biometricStatus();
    if (bio.available) {
      const ok = await biometricUnlock(t("home.exportBnbKey"));
      if (!ok) return;
    }
    setBusy(true);
    try {
      const res = await revealEvmPrivateKey(pw);
      // Also fetch the recovery phrase so the user can view/back it up again —
      // not just the private key. Raw-key-imported BNB wallets have no phrase
      // (bsc_reveal_mnemonic errors); show only the key in that case.
      let mnemonic: string[] | null = null;
      try {
        mnemonic = (await revealBscMnemonic(pw)).mnemonic;
      } catch {
        mnemonic = null;
      }
      setData({ address: res.address, key: res.private_key_hex, mnemonic });
    } catch (e) {
      toast.error(t("home.expFail"), humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t("home.exportBnbKey")}
      danger
      onClose={onClose}
      footer={
        data ? (
          <button className="btn btn-block" onClick={onClose}>{t("sheet.done")}</button>
        ) : (
          <>
            <button className="btn btn-secondary btn-block" onClick={onClose}>{t("sheet.cancel")}</button>
            <button className="btn btn-danger btn-block" disabled={busy} onClick={reveal}>
              {busy ? <Spinner /> : t("home.expReveal")}
            </button>
          </>
        )
      }
    >
      {!data ? (
        <>
          <div className="banner banner-warn" style={{ marginBottom: 14 }}>{t("home.expWarn")}</div>
          <label className="eyebrow">{t("sheet.walletPassword")}</label>
          <input
            className="field"
            type="password"
            autoFocus
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && reveal()}
            style={{ marginTop: 8 }}
          />
        </>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="banner banner-danger">{t("home.expRevealed")}</div>
          <div>
            <label className="eyebrow">{t("home.bnbAddress")}</label>
            <div className="mono" style={{ fontSize: 12.5, wordBreak: "break-all", marginTop: 4, color: "var(--text-dim)" }}>
              {data.address}
            </div>
          </div>
          {data.mnemonic && (
            <div>
              <label className="eyebrow">{t("home.bnbRecoveryPhrase")}</label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, margin: "6px 0 8px" }}>
                {data.mnemonic.map((w, i) => (
                  <div key={i} className="mono" style={{ fontSize: 12.5, padding: "5px 9px", background: "var(--surface-2)", borderRadius: 8, display: "flex", gap: 7 }}>
                    <span style={{ color: "var(--text-faint)", minWidth: 16, textAlign: "right" }}>{i + 1}</span>{w}
                  </div>
                ))}
              </div>
              <CopyButton text={data.mnemonic.join(" ")} label="Copied" />
            </div>
          )}
          <div>
            <label className="eyebrow">{t("home.expPrivKey")}</label>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 4 }}>
              <code className="mono" style={{ flex: 1, minWidth: 0, fontSize: 12.5, wordBreak: "break-all", lineHeight: 1.5 }}>
                {data.key}
              </code>
              <CopyButton text={data.key} label="Copied" />
            </div>
          </div>
          <div className="banner banner-info" style={{ fontSize: 12.5, lineHeight: 1.55 }}>{t("home.expMetaMask")}</div>
        </div>
      )}
    </Modal>
  );
}
