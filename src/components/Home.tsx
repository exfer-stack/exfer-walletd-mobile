// Home — balance hero, Receive/Send, address list, New-address menu.

import { useMemo, useState } from "react";
import wordmark from "../assets/wordmark.png";
import { Icon } from "../lib/icons";
import { useWallet } from "../lib/wallet";
import { useToast } from "../lib/toast";
import { useBalanceMask, Masked } from "../lib/balance";
import {
  rpc,
  MAX_ADDRESSES,
  splitBalanceCompact,
  formatBalanceCompact,
} from "../lib/rpc";
import { shortAddress } from "../lib/labels";
import { isHidden } from "../lib/hidden";
import { addrName } from "../lib/format";
import type { WalletEntry } from "../lib/types";
import { AddrAvatar, ActionMenu, PendingDot, Spinner } from "./ui";
import { ImportPhraseModal, ImportKeyFileModal } from "./modals/ImportModals";

function PrimaryAction({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="tap"
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 11,
        padding: "16px 14px",
        borderRadius: 18,
        border: 0,
        cursor: "pointer",
        font: "inherit",
        fontWeight: 600,
        fontSize: 16,
        letterSpacing: "-.01em",
        color: "var(--accent-ink)",
        background:
          "linear-gradient(165deg, color-mix(in srgb, var(--accent) 92%, #fff 8%), var(--accent-strong))",
        boxShadow:
          "0 10px 26px -12px color-mix(in srgb, var(--accent) 75%, transparent), inset 0 1px 0 color-mix(in srgb, #fff 28%, transparent)",
      }}
    >
      <span
        style={{
          width: 28,
          height: 28,
          borderRadius: 9,
          display: "grid",
          placeItems: "center",
          background: "color-mix(in srgb, var(--accent-ink) 14%, transparent)",
        }}
      >
        <Icon name={icon} size={19} stroke={2.3} />
      </span>
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
  const { balance, refresh } = useWallet();
  const toast = useToast();
  const { hidden, toggle } = useBalanceMask();
  const [showHidden, setShowHidden] = useState(false);
  const [addMenu, setAddMenu] = useState(false);
  const [impPhrase, setImpPhrase] = useState(false);
  const [impKey, setImpKey] = useState(false);
  const [creating, setCreating] = useState(false);

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
  const pendingIn = useMemo(
    () => vis.reduce((s, a) => s + (a.pending_received ?? 0), 0),
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
    setAddMenu(true);
  }

  async function createAddress() {
    setAddMenu(false);
    setCreating(true);
    try {
      await rpc("generate_independent_address");
      await refresh();
      toast.success("Address created", "A new key is ready to receive.");
    } catch (e) {
      toast.error("Could not create address", String(e instanceof Error ? e.message : e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="screen">
      <div className="screen-pad">
        <div className="h-row" style={{ padding: "10px 0 12px" }}>
          <img
            src={wordmark}
            alt="EXFER"
            style={{ height: 56, width: "auto", filter: "var(--wordmark-filter, none)" }}
            draggable={false}
          />
          <button
            className="icon-btn"
            onClick={toggle}
            aria-label="Toggle balance visibility"
          >
            <Icon name={hidden ? "eye-off" : "eye"} size={19} />
          </button>
        </div>

        <button
          onClick={toggle}
          className="tap"
          style={{
            background: "none",
            border: 0,
            width: "100%",
            textAlign: "left",
            cursor: "pointer",
            padding: "14px 0 20px",
          }}
        >
          <div className="eyebrow" style={{ marginBottom: 14, letterSpacing: ".16em" }}>
            Total balance
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 9 }}>
            <span
              style={{
                fontFamily: '"Geist Variable","Geist", sans-serif',
                fontSize: 58,
                fontWeight: 600,
                letterSpacing: "-.045em",
                lineHeight: 1,
                fontFeatureSettings: '"tnum" 1',
              }}
            >
              <Masked dots="••••">
                <span>{whole}</span>
                {frac && (
                  <span
                    style={{ color: "var(--text-faint)", fontWeight: 500, fontSize: "0.6em" }}
                  >
                    .{frac}
                  </span>
                )}
              </Masked>
            </span>
            <span
              style={{
                fontSize: 15,
                fontWeight: 600,
                color: "var(--text-faint)",
                letterSpacing: ".06em",
              }}
            >
              EXFER
            </span>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              marginTop: 18,
              flexWrap: "wrap",
            }}
          >
            <span className="dim" style={{ fontSize: 14 }}>
              across{" "}
              <b style={{ color: "var(--text)", fontWeight: 600 }}>{vis.length}</b>{" "}
              {vis.length === 1 ? "address" : "addresses"}
            </span>
            {pendingIn > 0 && !hidden && (
              <span
                className="pill pill-success"
                style={{ padding: "3px 10px", fontSize: 12 }}
              >
                +{formatBalanceCompact(pendingIn).replace(" EXFER", "")} confirming
              </span>
            )}
          </div>
        </button>

        <div style={{ display: "flex", gap: 12, padding: "8px 0 26px" }}>
          <PrimaryAction icon="receive" label="Receive" onClick={onReceive} />
          <PrimaryAction icon="send" label="Send" onClick={onSend} />
        </div>

        <div className="h-row" style={{ marginBottom: 11 }}>
          <div className="eyebrow">Addresses</div>
          <button
            onClick={newAddress}
            disabled={atCap || creating}
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
            {creating ? <Spinner size={15} /> : <Icon name="plus" size={15} />} New address
          </button>
        </div>

        <div className="list">
          {list.length === 0 && (
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
          {list.map((a) => {
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
                    textAlign: "right",
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                  }}
                >
                  {(a.pending_received ?? 0) > 0 && (
                    <PendingDot title="incoming, confirming" />
                  )}
                  <span
                    className="mono"
                    style={{
                      fontSize: 14.5,
                      fontWeight: 500,
                      color: bal === 0 ? "var(--text-faint)" : "var(--text)",
                    }}
                  >
                    <Masked dots="•••">
                      {formatBalanceCompact(bal).replace(" EXFER", "")}
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
      </div>

      {addMenu && (
        <ActionMenu
          title="Add an address"
          onClose={() => setAddMenu(false)}
          items={[
            { icon: "plus", label: "Create new address", onClick: createAddress },
            {
              icon: "key",
              label: "Import recovery phrase",
              onClick: () => {
                setAddMenu(false);
                setImpPhrase(true);
              },
            },
            {
              icon: "download",
              label: "Import wallet.key file",
              onClick: () => {
                setAddMenu(false);
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
