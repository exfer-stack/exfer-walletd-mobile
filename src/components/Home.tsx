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
} from "../lib/rpc";
import { usePrice, usdValue } from "../lib/market";
import { useT, type MsgKey } from "../lib/i18n";
import { shortAddress } from "../lib/labels";
import { isHidden } from "../lib/hidden";
import { addrName } from "../lib/format";
import type { WalletEntry } from "../lib/types";
import { AddrAvatar, ActionMenu, PendingDot, Modal, CopyButton, Spinner } from "./ui";
import { Qr } from "./Qr";
import { ImportPhraseModal, ImportKeyFileModal } from "./modals/ImportModals";
import { NewAddressModal } from "./modals/NewAddressModal";

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

interface InflightSwap {
  swap_id: string;
  direction: "exfer_to_bnb" | "bnb_to_exfer";
  status: string;
  amount_in: string;
  amount_out: string;
}

/** Format native BNB wei (18 dp) to a short human string. */
function fmtBnbWei(wei: string | undefined, frac = 5): string {
  if (!wei) return "0";
  try {
    const n = BigInt(wei);
    const base = 10n ** 18n;
    const f = (n % base).toString().padStart(18, "0").slice(0, frac).replace(/0+$/, "");
    return f ? `${n / base}.${f}` : `${n / base}`;
  } catch {
    return "0";
  }
}

/** Trim a human decimal string to ≤4 fractional digits (drops trailing zeros).
 *  Tiny values (e.g. ~1e-6 BNB) fall back to significant digits, never "0". */
function fmtAmt(s: string, dp = 4): string {
  if (!s) return s;
  const [w, f = ""] = s.split(".");
  const frac = f.slice(0, dp).replace(/0+$/, "");
  if (!frac && w === "0") {
    const n = Number(s);
    if (isFinite(n) && n !== 0) {
      return n.toLocaleString("en-US", { maximumSignificantDigits: 4, useGrouping: false });
    }
  }
  return frac ? `${w}.${frac}` : w;
}

/** Map a walletd swap status to its localized label. */
function swapStatusText(t: (k: MsgKey) => string, status: string): string {
  switch (status) {
    case "quoted": return t("swap.statusQuoted");
    case "user_locked": return t("swap.statusUserLocked");
    case "pool_locked": return t("swap.statusPoolLocked");
    case "claiming": return t("swap.statusClaiming");
    case "completed": return t("swap.statusCompleted");
    case "refunding": return t("swap.statusRefunding");
    case "refunded": return t("swap.statusRefunded");
    case "failed": return t("swap.statusFailed");
    default: return status;
  }
}

export function Home({
  onReceive,
  onSend,
  onSwap,
  onResumeSwap,
  onOpenAddress,
}: {
  onReceive: () => void;
  onSend: () => void;
  onSwap: () => void;
  onResumeSwap: (swapId: string) => void;
  onOpenAddress: (address: string) => void;
}) {
  const { balance, error, refresh } = useWallet();
  const price = usePrice();
  const { t } = useT();
  const toast = useToast();

  // Surface swaps that are still settling (or recently terminal) so money in
  // motion is never invisible after the app is reopened. Queries the walletd
  // swap journal; no-ops silently when the swap engine isn't configured.
  const [inflight, setInflight] = useState<InflightSwap[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const all = await rpc<InflightSwap[]>("swap_list");
        if (cancelled) return;
        // "quoted" is a draft — no funds have moved — so it is NOT in progress.
        // Only surface swaps where the user's leg is actually on-chain.
        const live = (all ?? []).filter(
          (s) => !["quoted", "completed", "refunded", "failed"].includes(s.status),
        );
        setInflight(live);
      } catch {
        if (!cancelled) setInflight([]); // engine off / not configured
      }
    };
    load();
    const id = window.setInterval(load, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // The user's BNB lives at an in-wallet BSC address. Surface it as a first-class
  // asset so funded BNB is never invisible (a newcomer who deposits BNB and then
  // can't see it assumes their money is gone). No-ops when swap isn't configured.
  const [bnb, setBnb] = useState<{ addr: string; wei: string } | null>(null);
  // Pool mid price (BNB per EXFER) — lets us derive an implied BNB/USD value
  // (EXFER/USD ÷ BNB-per-EXFER) so the BNB card can show ≈$ like every other row.
  const [bnbMid, setBnbMid] = useState<number | null>(null);
  const [depositOpen, setDepositOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [a, b] = await Promise.all([
          rpc<{ address: string }>("bsc_get_address"),
          rpc<{ bnb_wei: string }>("bsc_get_balances"),
        ]);
        if (!cancelled) setBnb({ addr: a.address, wei: b.bnb_wei });
        try {
          const p = await rpc<{ mid_price_bnb_per_exfer: number | null }>("swap_pool_info");
          if (!cancelled) setBnbMid(p?.mid_price_bnb_per_exfer ?? null);
        } catch { /* preview is best-effort */ }
      } catch {
        if (!cancelled) setBnb(null); // engine off / not configured
      }
    };
    load();
    const id = window.setInterval(load, 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

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
        setBnb((prev) => (prev ? { ...prev, wei: b.bnb_wei } : prev));
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
          style={{
            position: "absolute",
            top: -86,
            right: -96,
            width: 360,
            height: 360,
            opacity: 0.13,
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
            <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
              <span
                style={{
                  fontFamily: '"Geist Variable","Geist", sans-serif',
                  fontSize: 58,
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
          <PrimaryAction icon="send" label={t("home.send")} onClick={onSend} variant="secondary" />
          <PrimaryAction icon="refresh" label={t("home.swap")} onClick={onSwap} variant="primary" />
        </div>

        {/* BNB asset card — BNB lives at an in-wallet BSC address; show it as a
            real holding so deposited/received BNB is never invisible. Tap to
            see the deposit address. Only renders when swap is configured. */}
        {bnb && (
          <button
            onClick={() => setDepositOpen(true)}
            className="card"
            style={{
              width: "100%", display: "flex", alignItems: "center", gap: 12,
              padding: "13px 14px", marginBottom: 14, textAlign: "left",
            }}
          >
            <span
              style={{
                width: 36, height: 36, borderRadius: 11, flex: "0 0 auto",
                display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700,
                background: "color-mix(in srgb, #f3ba2f 18%, transparent)", color: "#f3ba2f",
              }}
            >
              BNB
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 14, fontWeight: 600 }}>BNB</span>
              <span style={{ display: "block", fontSize: 12, color: "var(--text-faint)" }}>
                {t("home.bnbChain")}
              </span>
            </span>
            <span style={{ textAlign: "right" }}>
              <span style={{ display: "block", fontSize: 15, fontWeight: 600 }}>
                <Masked dots="••••">{fmtBnbWei(bnb.wei)}</Masked>
              </span>
              {(() => {
                if (!price || !bnbMid || bnbMid <= 0) return null;
                const bnbHuman = Number(BigInt(bnb.wei)) / 1e18;
                const usd = (bnbHuman * price.usd) / bnbMid;
                if (!isFinite(usd)) return null;
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

        {inflight.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div className="eyebrow" style={{ marginBottom: 6 }}>{t("swap.inflightTitle")}</div>
            {inflight.map((s) => (
              <button
                key={s.swap_id}
                onClick={() => onResumeSwap(s.swap_id)}
                className="card"
                style={{
                  width: "100%",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "10px 12px",
                  marginBottom: 6,
                  gap: 10,
                  textAlign: "left",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Icon name="refresh" />
                  <span style={{ fontSize: 13 }}>
                    {fmtAmt(s.amount_in)} {s.direction === "exfer_to_bnb" ? "EXFER" : "BNB"} →{" "}
                    {fmtAmt(s.amount_out)} {s.direction === "exfer_to_bnb" ? "BNB" : "EXFER"}
                  </span>
                </span>
                <span style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
                  {swapStatusText(t, s.status)}
                </span>
              </button>
            ))}
          </div>
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
        <Modal title={t("home.depositBnb")} onClose={() => setDepositOpen(false)}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "4px 0" }}>
            <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
              {t("home.bnbBalanceLabel")}: <b>{fmtBnbWei(bnb.wei)} BNB</b>
            </div>
            <Qr value={bnb.addr} size={170} />
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
              <span className="mono">{shortAddress(bnb.addr)}</span>
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
          </div>
        </Modal>
      )}
    </div>
  );
}
