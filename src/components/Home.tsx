// Home — balance hero, Receive/Send, address list, New-address menu.

import { useMemo, useState } from "react";
import { Icon } from "../lib/icons";
import { useWallet } from "../lib/wallet";
import { useToast } from "../lib/toast";
import { useBalanceMask, Masked } from "../lib/balance";
import {
  MAX_ADDRESSES,
  splitBalanceCompact,
} from "../lib/rpc";
import { shortAddress } from "../lib/labels";
import { isHidden } from "../lib/hidden";
import { addrName } from "../lib/format";
import type { WalletEntry } from "../lib/types";
import { AddrAvatar, ActionMenu, PendingDot } from "./ui";
import { ImportPhraseModal, ImportKeyFileModal } from "./modals/ImportModals";
import { NewAddressModal } from "./modals/NewAddressModal";

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
  // `balance` is null until the first successful load. Show skeletons while
  // it's loading, but if that first load FAILED show an error+retry instead
  // of an infinite skeleton (and never a misleading "0 / No addresses").
  const firstLoad = balance === null && !error;
  const loadError = balance === null && !!error;
  const toast = useToast();
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
        "Address limit reached",
        `This wallet is capped at ${MAX_ADDRESSES} addresses.`,
      );
      return;
    }
    setCreateOpen(true);
  }

  return (
    <div className="screen">
      <div className="screen-pad">
        {loadError ? (
          <div style={{ padding: "64px 18px", textAlign: "center" }}>
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
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Can&apos;t reach the network</div>
            <div
              className="faint"
              style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.5, padding: "0 10px" }}
            >
              Couldn&apos;t load your balance. Check your connection and try again.
            </div>
            <button className="btn btn-sm" onClick={() => refresh()}>
              Retry
            </button>
          </div>
        ) : (
          <>
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
            Total balance
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
          {/* No "confirming" pill here: the hero already shows the projected
              total, so incoming funds read as arrived instantly. The
              still-confirming state lives only on the address row (a small
              dot) and in the address detail. */}
        </button>

        <div style={{ display: "flex", gap: 10, padding: "4px 0 24px" }}>
          <PrimaryAction icon="receive" label="Receive" onClick={onReceive} variant="secondary" />
          <PrimaryAction icon="send" label="Send" onClick={onSend} variant="primary" />
        </div>

        <div className="h-row" style={{ marginBottom: 11 }}>
          <div className="eyebrow">Addresses</div>
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
            <Icon name="plus" size={15} /> New address
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
              <div style={{ fontWeight: 600, marginBottom: 4 }}>No addresses yet</div>
              <div className="faint" style={{ fontSize: 13, marginBottom: 14 }}>
                Mint your first address to receive EXFER.
              </div>
              <button className="btn btn-sm" onClick={newAddress}>
                + Generate address
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
            {showHidden ? "Hide" : "Show"} {hiddenAddrs.length} hidden{" "}
            {hiddenAddrs.length === 1 ? "address" : "addresses"}
          </button>
        )}

        {atCap && (
          <div
            className="faint"
            style={{ fontSize: 12, textAlign: "center", marginTop: 14, lineHeight: 1.5 }}
          >
            You've reached the {MAX_ADDRESSES}-address limit. One address can take
            any number of deposits.
          </div>
        )}
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
    </div>
  );
}
