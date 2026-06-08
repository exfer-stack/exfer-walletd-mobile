// Governance / community voting screen.
//
// Built to match the approved simplified mockups (voting-mockups/*.html):
//   • list with 进行中 / 即将开始 / 已结束 sections + a one-time, dismissible
//     3-step primer,
//   • a proposal-detail sheet: 1-line description + 查看完整说明 expander, a
//     per-address selector (+ address-picker sheet), options, live results
//     bars, the pre-vote hold warning, the vote button, the 已投票 state with a
//     valid pill, and the ineligible state with a 用主地址投票 recovery CTA.
//
// Data + signing go through src/lib/governance.ts (byte-identical to
// SIGNING_SPEC). Power for an address = its current wallet balance; the picker
// lists every address with its balance + eligibility (each ≥ min_power address
// can cast its own vote).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getProposals,
  getProposal,
  getMyVote,
  getResults,
  submitVote,
  mediaUrl,
  fetchMediaBytes,
  type Proposal,
  type ProposalStatus,
  type VoteResult,
  type Attachment,
} from "../lib/governance";
import { saveBytes } from "../lib/fsfile";
import type { WalletEntry } from "../lib/types";
import { useWallet } from "../lib/wallet";
import { useT, type MsgKey } from "../lib/i18n";
import { Icon } from "../lib/icons";
import { Sheet } from "./ui";
import { useToast } from "../lib/toast";
import { addrName, EXFER_UNIT } from "../lib/format";
import { shortAddress } from "../lib/labels";

// ── helpers ──────────────────────────────────────────────────────────────

/** Governance-facing EXFER figure (power is in exfers, 1 EXFER = 1e8 exfers).
 *
 *  ≥ 1 EXFER  → whole, thousands-grouped ("128,400") to match the mockups.
 *  0 < x < 1  → decimal with up to 8 places, trailing zeros trimmed ("0.2"),
 *               so sub-1-EXFER balances/powers don't collapse to a misleading
 *               "0". (The app-wide `format.exfer()` keeps its own behaviour —
 *               this is governance-local on purpose.)
 *  0          → "0". */
function exfer(exfers: number): string {
  const v = exfers / EXFER_UNIT;
  if (v === 0) return "0";
  if (v >= 1) return Math.floor(v).toLocaleString("en-US");
  // sub-1-EXFER: show meaningful precision, trim trailing zeros.
  return v.toFixed(8).replace(/\.?0+$/, "");
}

/** Human-readable byte size for an attachment ("48 KB", "1.2 MB"). */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/** True only inside a Tauri webview — picks the download path (proxy bytes →
 *  device save) vs. a plain-browser anchor download of the dev-proxy URL. */
function inTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

function useNow(periodMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), periodMs);
    return () => window.clearInterval(id);
  }, [periodMs]);
  return now;
}

/** Effective status from the window, so an "open" proposal whose close_time has
 *  passed reads as closed even before the server flips its status field. */
function effectiveStatus(p: Proposal, nowSec: number): ProposalStatus {
  if (p.status === "finalized") return "finalized";
  if (nowSec < p.window.open_time) return "upcoming";
  if (nowSec >= p.window.close_time) return p.status === "open" ? "closed" : p.status;
  return "open";
}

// ── list screen ────────────────────────────────────────────────────────────

export function Governance() {
  const { t } = useT();
  const nowMs = useNow();
  const nowSec = Math.floor(nowMs / 1000);

  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const list = await getProposals();
      setProposals(list);
    } catch (e) {
      setProposals([]);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => {
    const open: Proposal[] = [];
    const upcoming: Proposal[] = [];
    const ended: Proposal[] = [];
    for (const p of proposals ?? []) {
      const s = effectiveStatus(p, nowSec);
      if (s === "open") open.push(p);
      else if (s === "upcoming") upcoming.push(p);
      else ended.push(p);
    }
    return { open, upcoming, ended };
  }, [proposals, nowSec]);

  return (
    <div className="screen">
      <div className="screen-pad">
        <div className="h-row" style={{ padding: "12px 4px 4px" }}>
          <div className="title-xl">{t("gov.title")}</div>
        </div>
        <div
          className="faint"
          style={{ fontSize: 13, padding: "0 4px 6px", lineHeight: 1.5 }}
        >
          {t("gov.tagline")}
        </div>

        <div className="primer">
          <div className="step">
            <span className="ic">
              <Icon name="card" size={17} />
            </span>
            <span className="tx">{t("gov.primer1")}</span>
          </div>
          <div className="step">
            <span className="ic">
              <Icon name="shield" size={17} />
            </span>
            <span className="tx">{t("gov.primer2")}</span>
          </div>
          <div className="step">
            <span className="ic">
              <Icon name="info" size={17} />
            </span>
            <span className="tx">{t("gov.primer3")}</span>
          </div>
        </div>

        {proposals === null ? (
          <ListSkeleton />
        ) : error && proposals.length === 0 ? (
          <div className="card" style={{ padding: "26px 18px", textAlign: "center", marginTop: 14 }}>
            <div className="title-lg" style={{ fontSize: 17, marginBottom: 6 }}>
              {t("gov.loadErr")}
            </div>
            <div className="faint" style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>
              {t("gov.loadErrBody")}
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => void load()}>
              {t("gov.retry")}
            </button>
          </div>
        ) : proposals.length === 0 ? (
          <div className="card" style={{ padding: "30px 18px", textAlign: "center", marginTop: 14 }}>
            <div className="title-lg" style={{ fontSize: 17, marginBottom: 6 }}>
              {t("gov.empty")}
            </div>
            <div className="faint" style={{ fontSize: 13, lineHeight: 1.5 }}>
              {t("gov.emptyBody")}
            </div>
          </div>
        ) : (
          <>
            <Section
              labelKey="gov.secOpen"
              items={groups.open}
              nowSec={nowSec}
              onOpen={setOpenId}
            />
            <Section
              labelKey="gov.secUpcoming"
              items={groups.upcoming}
              nowSec={nowSec}
              onOpen={setOpenId}
            />
            <Section
              labelKey="gov.secEnded"
              items={groups.ended}
              nowSec={nowSec}
              onOpen={setOpenId}
            />
          </>
        )}
      </div>

      {openId && (
        <ProposalDetail
          id={openId}
          onClose={() => {
            setOpenId(null);
            void load(); // refresh list tallies after voting
          }}
        />
      )}
    </div>
  );
}

function Section({
  labelKey,
  items,
  nowSec,
  onOpen,
}: {
  labelKey: MsgKey;
  items: Proposal[];
  nowSec: number;
  onOpen: (id: string) => void;
}) {
  const { t } = useT();
  if (items.length === 0) return null;
  return (
    <>
      <div className="gov-section">
        <span className="eyebrow">{t(labelKey)}</span>
        <span className="count">{items.length}</span>
      </div>
      {items.map((p) => (
        <ProposalCard key={p.id} p={p} nowSec={nowSec} onOpen={onOpen} />
      ))}
    </>
  );
}

/** Render the remaining/until time as a localized "{d}d {h}h" style string. */
function relTime(t: (k: MsgKey, v?: Record<string, string | number>) => string, seconds: number): string {
  const s = Math.max(0, seconds);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return t("gov.timeDH", { d, h });
  if (h > 0) return t("gov.timeHM", { h, m });
  return t("gov.timeM", { m: Math.max(1, m) });
}

function statusPill(s: ProposalStatus, p: Proposal): { key: MsgKey; cls: string } {
  if (s === "open") return { key: "gov.statusOpen", cls: "pill-accent" };
  if (s === "upcoming") return { key: "gov.statusUpcoming", cls: "pill-warn" };
  // ended: derive pass/fail from results if available
  const r = p.results;
  if (r && r.by_option && Object.keys(r.by_option).length > 0) {
    const entries = Object.entries(r.by_option);
    const winner = entries.reduce((a, b) => (BigInt(b[1] || "0") > BigInt(a[1] || "0") ? b : a));
    // First option is treated as the "yes/approve" option by convention.
    const first = p.options[0]?.id;
    if (winner[0] === first) return { key: "gov.statusPassed", cls: "pill-success" };
    return { key: "gov.statusRejected", cls: "pill-danger" };
  }
  return { key: "gov.statusClosed", cls: "pill-muted" };
}

function ProposalCard({
  p,
  nowSec,
  onOpen,
}: {
  p: Proposal;
  nowSec: number;
  onOpen: (id: string) => void;
}) {
  const { t, lang } = useT();
  const s = effectiveStatus(p, nowSec);
  const pill = statusPill(s, p);
  const ended = s === "closed" || s === "finalized";
  // Only show a vote count when the list payload actually carried a tally —
  // open proposals often omit `results`, and "0 votes" on a live proposal that
  // has votes is misleading. (The detail view fetches the live /results tally.)
  const totalVotes = p.results?.total_voters ?? null;

  // ended → "{pct}% yes" derived from first option share
  let yesPct: number | null = null;
  if (ended && p.results && p.results.by_option) {
    const total = Object.values(p.results.by_option).reduce(
      (acc, v) => acc + Number(v || "0"),
      0,
    );
    const first = p.options[0]?.id;
    const firstPower = first ? Number(p.results.by_option[first] || "0") : 0;
    if (total > 0) yesPct = Math.round((firstPower / total) * 100);
  }

  return (
    <button
      className={"prop-card" + (ended ? " is-ended" : "")}
      onClick={() => onOpen(p.id)}
    >
      <div className="prop-head">
        <div className="prop-title">{p.title[lang]}</div>
        <span className={"pill " + pill.cls}>{t(pill.key)}</span>
      </div>
      <div className="prop-brief">{p.description[lang]}</div>
      <div className="prop-meta">
        <span className="prop-id">{p.id}</span>
        <span className="dot" />
        {s === "open" && (
          <>
            <span className={"clock" + (p.window.close_time - nowSec < 86_400 ? " urgent" : "")}>
              <Icon name="clock" size={13} />
              {t("gov.endsIn", { t: relTime(t, p.window.close_time - nowSec) })}
            </span>
            {totalVotes != null && (
              <>
                <span className="dot" />
                <span>{t("gov.votesN", { n: totalVotes.toLocaleString("en-US") })}</span>
              </>
            )}
          </>
        )}
        {s === "upcoming" && (
          <span className="clock">
            <Icon name="calendar" size={13} />
            {t("gov.startsIn", { t: relTime(t, p.window.open_time - nowSec) })}
          </span>
        )}
        {ended && (
          <>
            {yesPct != null && <span>{t("gov.yesPct", { pct: yesPct })}</span>}
            {yesPct != null && totalVotes != null && <span className="dot" />}
            {totalVotes != null && (
              <span>{t("gov.votesN", { n: totalVotes.toLocaleString("en-US") })}</span>
            )}
          </>
        )}
      </div>
    </button>
  );
}

function ListSkeleton() {
  return (
    <div style={{ marginTop: 16 }}>
      <div className="gov-section">
        <span className="eyebrow" style={{ opacity: 0.4 }}>···</span>
      </div>
      {[0, 1].map((i) => (
        <div
          key={i}
          className="card"
          style={{ height: 112, marginBottom: 11, opacity: 0.5 }}
        />
      ))}
    </div>
  );
}

// ── detail sheet ────────────────────────────────────────────────────────────

interface AddrInfo {
  entry: WalletEntry;
  power: number; // exfers
  eligible: boolean;
}

function ProposalDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, lang } = useT();
  const toast = useToast();
  const { balance } = useWallet();
  const nowMs = useNow(15_000);
  const nowSec = Math.floor(nowMs / 1000);

  const [p, setP] = useState<Proposal | null>(null);
  const [liveResults, setLiveResults] = useState<VoteResult | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [selectedOpt, setSelectedOpt] = useState<string | null>(null);
  const [selectedAddr, setSelectedAddr] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [myVote, setMyVote] = useState<string | null>(null);
  const [votedAddrs, setVotedAddrs] = useState<Record<string, string>>({}); // addr -> option_id
  const [voting, setVoting] = useState(false);
  const [changing, setChanging] = useState(false); // "改投" → show options again
  const resultsAtMs = useRef<number>(Date.now());

  const entries = useMemo(() => balance?.entries ?? [], [balance]);

  const addrInfos: AddrInfo[] = useMemo(() => {
    if (!p) return [];
    return entries
      .map((e) => ({ entry: e, power: e.balance, eligible: e.balance >= p.min_power }))
      .sort((a, b) => b.power - a.power);
  }, [entries, p]);

  const selected = useMemo(
    () => addrInfos.find((a) => a.entry.address === selectedAddr) ?? null,
    [addrInfos, selectedAddr],
  );
  const topEligible = useMemo(() => addrInfos.find((a) => a.eligible) ?? null, [addrInfos]);

  // load proposal (+ live provisional tally while open). The detail endpoint
  // only embeds `results` once a proposal is closed/finalized; the live
  // open-window tally lives at the dedicated `/results` endpoint, so fetch that
  // separately whenever the proposal is still open.
  const reload = useCallback(async () => {
    try {
      setLoadErr(null);
      const prop = await getProposal(id);
      setP(prop);
      resultsAtMs.current = Date.now();
      const open = effectiveStatus(prop, Math.floor(Date.now() / 1000)) === "open";
      if (open) {
        try {
          setLiveResults(await getResults(id));
        } catch {
          setLiveResults(null);
        }
      } else {
        setLiveResults(null);
      }
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // default selected address: first eligible, else highest balance
  useEffect(() => {
    if (selectedAddr || addrInfos.length === 0) return;
    setSelectedAddr((topEligible ?? addrInfos[0]).entry.address);
  }, [addrInfos, topEligible, selectedAddr]);

  // my-vote for the selected address
  useEffect(() => {
    if (!selectedAddr) return;
    let cancelled = false;
    void getMyVote(id, selectedAddr)
      .then((v) => {
        if (cancelled) return;
        setMyVote(v?.option_id ?? null);
        setSelectedOpt((prev) => prev ?? v?.option_id ?? null);
        setChanging(false);
        if (v?.option_id) {
          setVotedAddrs((m) => ({ ...m, [selectedAddr]: v.option_id }));
        }
      })
      .catch(() => {
        if (!cancelled) setMyVote(null);
      });
    return () => {
      cancelled = true;
    };
  }, [id, selectedAddr]);

  // per-address voted state for the picker: fan out my-vote across every
  // eligible address so the "已投" chip is accurate for all of them, not just
  // the one the user has opened this session.
  useEffect(() => {
    if (!p || addrInfos.length === 0) return;
    let cancelled = false;
    void Promise.all(
      addrInfos
        .filter((a) => a.eligible)
        .map((a) =>
          getMyVote(id, a.entry.address)
            .then((v) => [a.entry.address, v?.option_id ?? null] as const)
            .catch(() => [a.entry.address, null] as const),
        ),
    ).then((pairs) => {
      if (cancelled) return;
      setVotedAddrs((m) => {
        const next = { ...m };
        for (const [addr, opt] of pairs) {
          if (opt) next[addr] = opt;
          else delete next[addr];
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [id, p, addrInfos]);

  // poll live results while open
  const status = p ? effectiveStatus(p, nowSec) : "open";
  useEffect(() => {
    if (status !== "open") return;
    const iv = window.setInterval(() => void reload(), 20_000);
    return () => window.clearInterval(iv);
  }, [status, reload]);

  const doVote = useCallback(
    async (optionId: string) => {
      if (!p || !selectedAddr) return;
      setVoting(true);
      try {
        const res = await submitVote(p.id, optionId, selectedAddr);
        setMyVote(optionId);
        setVotedAddrs((m) => ({ ...m, [selectedAddr]: optionId }));
        setChanging(false);
        const label = p.options.find((o) => o.id === optionId)?.label[lang] ?? optionId;
        toast.success(
          t("gov.voteOk"),
          t("gov.voteOkBody", { opt: label, n: exfer(res.power) }),
        );
        await reload();
      } catch (e) {
        toast.error(t("gov.voteFail"), e instanceof Error ? e.message : String(e));
      } finally {
        setVoting(false);
      }
    },
    [p, selectedAddr, lang, reload, t, toast],
  );

  // ── render states ────────────────────────────────────────────────────────
  if (!p) {
    return (
      <Sheet title={t("gov.detailTitle")} onClose={onClose} height="70%">
        {loadErr ? (
          <div className="banner banner-danger" style={{ marginTop: 12 }}>{loadErr}</div>
        ) : (
          <div className="dim" style={{ padding: 40, textAlign: "center" }}>···</div>
        )}
      </Sheet>
    );
  }

  const pill = statusPill(status, p);
  const isOpen = status === "open";
  const eligible = selected?.eligible ?? false;
  // "Have I voted" is independent of *current* eligibility: a balance that
  // later dropped below min_power doesn't erase a vote the server still holds.
  const hasVoted = !!myVote;
  // The voted address is below threshold *now* — the vote is recorded but at
  // risk of being voided at a spot-check; surface that instead of the generic
  // "you can't vote" recovery block.
  const votedAtRisk = isOpen && hasVoted && !eligible;
  const showOptions = isOpen && eligible && (!hasVoted || changing);

  // Live provisional tally while open (dedicated /results endpoint); fall back
  // to whatever the detail embedded (closed/finalized proposals carry it there).
  const results = liveResults ?? p.results;
  const updatedLabel = (() => {
    const ago = Math.floor((Date.now() - resultsAtMs.current) / 1000);
    if (ago < 5) return t("gov.justNow");
    if (ago < 60) return t("gov.secAgo", { s: ago });
    return t("gov.minAgo", { m: Math.floor(ago / 60) });
  })();

  return (
    <>
      <Sheet
        title={t("gov.detailTitle")}
        onClose={onClose}
        height="92%"
      >
        {/* title block */}
        <div className="h-row" style={{ alignItems: "flex-start", marginBottom: 10 }}>
          <span className="prop-id">{p.id}</span>
          <span className={"pill " + pill.cls}>
            {isOpen
              ? t("gov.statusOpen") + " · " + t("gov.endsIn", { t: relTime(t, p.window.close_time - nowSec) })
              : t(pill.key)}
          </span>
        </div>
        <div className="title-lg" style={{ lineHeight: 1.3, marginBottom: 14 }}>
          {p.title[lang]}
        </div>

        {/* description: one-line brief + expander */}
        <div className="prop-desc card" style={{ padding: "15px 16px", marginBottom: 18 }}>
          <p style={ expanded ? undefined : {
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}>
            {p.description[lang]}
          </p>
          <button
            className={"expander" + (expanded ? " open" : "")}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? t("gov.hideFull") : t("gov.viewFull")}
            <Icon name="chevron-down" size={14} stroke={2.2} />
          </button>
        </div>

        {/* attachments: inline image thumbnails + a downloadable files list */}
        {p.attachments.length > 0 && (
          <Attachments attachments={p.attachments} />
        )}

        {/* address selector */}
        <div className="eyebrow" style={{ margin: "0 2px 9px" }}>{t("gov.votingWith")}</div>
        <button
          className={"addr-sel" + (eligible ? "" : " below")}
          style={{ marginBottom: 18 }}
          onClick={() => setPickerOpen(true)}
        >
          <span className="avatar">
            <Icon name="card" size={19} />
          </span>
          <span className="body">
            <span className="lbl">
              {selected ? addrName(selected.entry) : "—"}
              <span className="switch-tag">{t("gov.switch")}</span>
            </span>
            <span className="addr mono">
              {selected ? shortAddress(selected.entry.address) : ""}
            </span>
            <span className="bal">
              {selected ? (
                eligible ? (
                  <><b>{exfer(selected.power)}</b> EXFER</>
                ) : (
                  <>{exfer(selected.power)} EXFER · {t("gov.notEligible")}</>
                )
              ) : null}
            </span>
          </span>
          <span className="chev">
            <Icon name="chevron-down" size={18} stroke={2.2} />
          </span>
        </button>

        {/* ── voted but now below threshold: vote at risk ─────────────── */}
        {votedAtRisk && (
          <div className="prevote-warn warn-danger" style={{ marginBottom: 18 }}>
            <Icon name="alert" size={15} />
            <span>
              <b style={{ display: "block", marginBottom: 2 }}>{t("gov.voteAtRisk")}</b>
              {t("gov.voteAtRiskBody", {
                label: selected ? addrName(selected.entry) : "",
                n: exfer(p.min_power),
              })}
            </span>
          </div>
        )}

        {/* ── ineligible recovery (not yet voted from this address) ────── */}
        {isOpen && !eligible && !hasVoted && (
          <IneligibleBlock
            selected={selected}
            topEligible={topEligible}
            minPower={p.min_power}
            onUseEligible={(addr) => setSelectedAddr(addr)}
          />
        )}

        {/* ── voted banner ────────────────────────────────────────────── */}
        {hasVoted && !changing && (
          <div className="voted-banner" style={{ marginBottom: 18 }}>
            <span className="check">
              <Icon name="check" size={18} stroke={2.6} />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="t" style={{ display: "block" }}>
                {t("gov.voted", {
                  opt: p.options.find((o) => o.id === myVote)?.label[lang] ?? myVote!,
                })}
              </span>
              <span className="s" style={{ display: "block" }}>
                {t("gov.votedMeta", {
                  label: selected ? addrName(selected.entry) : "",
                  n: selected ? exfer(selected.power) : "0",
                })}
              </span>
            </span>
          </div>
        )}

        {/* ── options (open + eligible + not-yet-voted / changing) ─────── */}
        {showOptions && eligible && (
          <>
            <div className="eyebrow" style={{ margin: "0 2px 11px" }}>{t("gov.chooseOption")}</div>
            {p.options.map((o) => (
              <button
                key={o.id}
                className={"opt" + (selectedOpt === o.id ? " selected" : "")}
                onClick={() => setSelectedOpt(o.id)}
                disabled={voting}
              >
                <span className="radio"><span className="core" /></span>
                <span className="label">{o.label[lang]}</span>
              </button>
            ))}
          </>
        )}

        {/* ── live results ────────────────────────────────────────────── */}
        {results && (
          <>
            <div className="h-row" style={{ margin: "20px 2px 11px" }}>
              <span className="eyebrow">
                {isOpen ? t("gov.liveResults") : t("gov.finalResults")}
              </span>
              <span className="faint" style={{ fontSize: 12 }}>
                {t("gov.resultsMeta", {
                  n: results.total_voters.toLocaleString("en-US"),
                  t: isOpen ? updatedLabel : "",
                })}
              </span>
            </div>
            <ResultBars proposal={p} results={results} myVote={hasVoted ? myVote : null} />
          </>
        )}

        {/* ── pre-vote hold warning + vote button ─────────────────────── */}
        {showOptions && eligible && (
          <>
            <div className="prevote-warn" style={{ margin: "16px 0 16px" }}>
              <Icon name="alert" size={15} />
              <span>{t("gov.holdWarn")}</span>
            </div>
            <button
              className="btn btn-block"
              disabled={!selectedOpt || voting}
              onClick={() => selectedOpt && void doVote(selectedOpt)}
            >
              {voting ? (
                t("gov.voting")
              ) : !selectedOpt ? (
                t("gov.selectOption")
              ) : (
                <>
                  <Icon name="check" size={19} stroke={2.2} />
                  {t("gov.voteWith", {
                    opt: p.options.find((o) => o.id === selectedOpt)?.label[lang] ?? "",
                  })}
                </>
              )}
            </button>
          </>
        )}

        {/* ── voted: valid pill + change-vote (while open) ────────────── */}
        {hasVoted && !changing && (
          <>
            {eligible && (
              <div style={{ margin: "16px 0 14px" }}>
                <span className="valid-pill">
                  <Icon name="check" size={14} stroke={3} />
                  {t("gov.validHold")}
                </span>
              </div>
            )}
            {isOpen && eligible && (
              <>
                <button
                  className="btn btn-secondary btn-block"
                  onClick={() => {
                    setChanging(true);
                    setSelectedOpt(myVote);
                  }}
                >
                  {t("gov.changeVote")}
                </button>
                <div
                  className="faint"
                  style={{ fontSize: 11, textAlign: "center", marginTop: 14, lineHeight: 1.6 }}
                >
                  {t("gov.changeHint")}
                </div>
              </>
            )}
          </>
        )}
      </Sheet>

      {pickerOpen && (
        <AddressPicker
          addrInfos={addrInfos}
          selectedAddr={selectedAddr}
          votedAddrs={votedAddrs}
          minPower={p.min_power}
          onPick={(addr) => {
            setSelectedAddr(addr);
            setSelectedOpt(null);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}

function ResultBars({
  proposal,
  results,
  myVote,
}: {
  proposal: Proposal;
  results: VoteResult;
  myVote: string | null;
}) {
  const { t, lang } = useT();
  const total = proposal.options.reduce(
    (acc, o) => acc + Number(results.by_option[o.id] || "0"),
    0,
  );
  // winner = highest power (for the .win highlight)
  let winnerId: string | null = null;
  let winnerPower = -1;
  for (const o of proposal.options) {
    const pw = Number(results.by_option[o.id] || "0");
    if (pw > winnerPower) {
      winnerPower = pw;
      winnerId = o.id;
    }
  }

  return (
    <>
      {proposal.options.map((o, i) => {
        const power = Number(results.by_option[o.id] || "0");
        const pct = total > 0 ? Math.round((power / total) * 100) : 0;
        const isWin = o.id === winnerId && total > 0;
        const isAbstain = i === proposal.options.length - 1 && proposal.options.length >= 3;
        const cls = "res" + (isWin ? " win" : isAbstain && !isWin ? " muted" : "");
        return (
          <div key={o.id} className={cls} style={{ ["--pct" as string]: `${pct}%` }}>
            <div className="fill" />
            <div className="row">
              <span className="name">
                {o.label[lang]}
                {myVote === o.id && (
                  <span className="you">
                    <Icon name="check" size={9} stroke={3.2} />
                    {t("gov.yourVote")}
                  </span>
                )}
              </span>
              <span className="pct">{pct}%</span>
            </div>
            <div className="votes">
              {t("gov.powerN", { n: exfer(power) })}
            </div>
          </div>
        );
      })}
    </>
  );
}

// ── attachments ──────────────────────────────────────────────────────────────

/** The ONLY MIME types we ever render inline. Raster only — never SVG (it can
 *  carry script). The server's `attachment.kind === "image"` is authoritative,
 *  but this is a deliberate second, client-side gate: defense-in-depth so a
 *  buggy/compromised server that mislabels e.g. an SVG as `kind:"image"` can
 *  never get it inline-rendered in our origin. Anything not on this list is
 *  treated as a download-only file regardless of `kind`. */
const INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** True only for attachments we are willing to render inline: server says
 *  `kind:"image"` AND the recorded content-type is a known raster type. */
function isInlineImage(a: Attachment): boolean {
  if (a.kind !== "image" || !a.id) return false;
  return INLINE_IMAGE_TYPES.has(normalizeMime(a.content_type));
}

/** Lowercased MIME with any parameters (e.g. "; charset=…") stripped. */
function normalizeMime(contentType: string): string {
  return contentType.split(";")[0]!.trim().toLowerCase();
}

/** The MIME type to stamp on an inline-image object-URL Blob. We only ever
 *  reach here for an attachment that already passed {@link isInlineImage}, but
 *  the bytes are re-fetched separately, so we clamp the Blob's type to a known
 *  raster allowlist and never let the fetched header pick the type — an SVG (or
 *  anything scriptable) can never end up as the Blob's MIME for `<img src>`. */
function blobImageType(fetchedContentType: string): string {
  const mime = normalizeMime(fetchedContentType);
  return INLINE_IMAGE_TYPES.has(mime) ? mime : "image/png";
}

/** Proposal attachments. Images render inline as thumbnails that zoom to full;
 *  every non-image attachment is listed under "Files" with a download action.
 *  Kind is server-decided (`attachment.kind`); we never infer it from
 *  `content_type` (SVG is intentionally a download-only "file"). On top of the
 *  server `kind`, {@link isInlineImage} gates inline rendering to a raster
 *  allowlist — anything else falls through to the download-only files list. */
function Attachments({ attachments }: { attachments: Attachment[] }) {
  const { t } = useT();
  const toast = useToast();
  const [zoom, setZoom] = useState<Attachment | null>(null);

  // Drop attachments with no id (nothing to fetch/download), then split:
  // inline-safe raster images vs. everything else (download-only).
  const usable = attachments.filter((a) => a.id);
  const images = usable.filter(isInlineImage);
  const files = usable.filter((a) => !isInlineImage(a));

  // Nothing renderable (every attachment lacked an id) — show nothing rather
  // than an empty "Attachments" header.
  if (usable.length === 0) return null;

  return (
    <div style={{ marginBottom: 18 }}>
      <div className="eyebrow" style={{ margin: "0 2px 11px" }}>{t("gov.attachments")}</div>

      {images.length > 0 && (
        <div className="att-thumbs" style={{ marginBottom: files.length > 0 ? 14 : 0 }}>
          {images.map((a) => (
            <ImageThumb key={a.id} att={a} onOpen={() => setZoom(a)} />
          ))}
        </div>
      )}

      {files.length > 0 && (
        <>
          {images.length > 0 && (
            <div className="eyebrow" style={{ margin: "0 2px 9px" }}>{t("gov.files")}</div>
          )}
          {files.map((a) => (
            <FileRow key={a.id} att={a} toast={toast} />
          ))}
        </>
      )}

      {zoom && <ImageZoom att={zoom} onClose={() => setZoom(null)} />}
    </div>
  );
}

/** A thumbnail for an inline image. In a Tauri webview a bare `/media/...` path
 *  isn't loadable as an `<img src>`, so we pull the bytes through the pinned
 *  proxy and render an object-URL; in browser dev we use the dev-proxy URL
 *  directly (inert placeholder without a configured proxy target). */
function ImageThumb({ att, onOpen }: { att: Attachment; onOpen: () => void }) {
  const { t } = useT();
  const [src, setSrc] = useState<string | null>(inTauri() ? null : mediaUrl(att.id));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!inTauri()) return;
    let url: string | null = null;
    let cancelled = false;
    void fetchMediaBytes(att.id)
      .then(({ bytes, contentType }) => {
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: blobImageType(contentType) }));
        setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [att.id]);

  return (
    <button className="att-thumb" onClick={onOpen} aria-label={att.filename}>
      {src && !failed ? (
        <img src={src} alt={att.filename} onError={() => setFailed(true)} />
      ) : (
        <span className="att-ph">
          <Icon name="card" size={20} />
          <span>{failed ? t("gov.imgFail") : "···"}</span>
        </span>
      )}
    </button>
  );
}

/** A download-only file row (filename + size + a download action). On Tauri we
 *  fetch bytes through the pinned proxy and save them to the device (mirrors the
 *  vault-backup save path); in browser dev a plain anchor download is fine. */
function FileRow({
  att,
  toast,
}: {
  att: Attachment;
  toast: ReturnType<typeof useToast>;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);

  const onDownload = useCallback(async () => {
    if (busy) return;
    if (!inTauri()) {
      // Browser dev: ordinary link download of the dev-proxy URL.
      const a = document.createElement("a");
      a.href = mediaUrl(att.id);
      a.download = att.filename;
      a.click();
      return;
    }
    setBusy(true);
    try {
      const { bytes } = await fetchMediaBytes(att.id);
      const where = await saveBytes(att.filename, bytes);
      toast.success(t("gov.download"), t("gov.savedTo", { path: where }));
    } catch (e) {
      toast.error(t("gov.downloadFail"), e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [att.id, att.filename, busy, t, toast]);

  return (
    <button className="att-file" onClick={() => void onDownload()} disabled={busy}>
      <span className="att-ic">
        <Icon name="export" size={18} />
      </span>
      <span className="att-body">
        <span className="att-name">{att.filename}</span>
      </span>
      <span className="att-sub">
        {busy ? t("gov.downloading") : formatBytes(att.size)}
      </span>
      <span className="att-dl">
        <Icon name="download" size={18} stroke={2.2} />
      </span>
    </button>
  );
}

/** Full-screen zoom for an inline image. Reuses the same proxy/dev-URL choice
 *  as the thumbnail. */
function ImageZoom({ att, onClose }: { att: Attachment; onClose: () => void }) {
  const { t } = useT();
  const [src, setSrc] = useState<string | null>(inTauri() ? null : mediaUrl(att.id));

  // Keep the latest onClose in a ref so the fetch effect depends only on the
  // attachment id — `onClose` is recreated on every parent render (the detail
  // sheet re-renders on a 15–20s poll), and listing it as a dependency would
  // re-fetch the bytes and rebuild the object-URL on each of those renders.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!inTauri()) return;
    let url: string | null = null;
    let cancelled = false;
    void fetchMediaBytes(att.id)
      .then(({ bytes, contentType }) => {
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: blobImageType(contentType) }));
        setSrc(url);
      })
      .catch(() => {
        if (!cancelled) onCloseRef.current();
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [att.id]);

  return (
    <div className="att-zoom" onClick={onClose}>
      <button className="att-zoom-close" aria-label={t("gov.closeImage")} onClick={onClose}>
        <Icon name="close" size={20} />
      </button>
      {src && <img src={src} alt={att.filename} onClick={(e) => e.stopPropagation()} />}
    </div>
  );
}

function IneligibleBlock({
  selected,
  topEligible,
  minPower,
  onUseEligible,
}: {
  selected: AddrInfo | null;
  topEligible: AddrInfo | null;
  minPower: number;
  onUseEligible: (addr: string) => void;
}) {
  const { t } = useT();
  const have = selected?.power ?? 0;
  const need = Math.max(0, minPower - have);
  const pct = minPower > 0 ? Math.min(100, (have / minPower) * 100) : 0;

  return (
    <>
      {topEligible && (
        <button
          className="btn btn-block"
          style={{ marginBottom: 14 }}
          onClick={() => onUseEligible(topEligible.entry.address)}
        >
          <Icon name="card" size={18} />
          {t("gov.useEligible", {
            label: addrName(topEligible.entry),
            n: exfer(topEligible.power),
          })}
        </button>
      )}

      <div className="card" style={{ padding: "20px 18px 18px", marginBottom: 18 }}>
        <div className="lock-hero">
          <span className="ring">
            <Icon name="lock" size={28} stroke={1.9} />
          </span>
          <h2>{t("gov.belowTitle", { n: exfer(minPower) })}</h2>
          <p>
            {t("gov.belowBody", {
              label: selected ? addrName(selected.entry) : "",
              n: exfer(minPower),
            })}
          </p>
        </div>

        <div className="req" style={{ marginTop: 18 }}>
          <div className="head">
            <span className="now">
              {exfer(have)} <small>EXFER</small>
            </span>
            <span className="goal">{t("gov.threshold", { n: exfer(minPower) })}</span>
          </div>
          <div className="track">
            <div className="bar" style={{ width: `${pct}%` }} />
          </div>
          <div className="left">{t("gov.needMore", { n: exfer(need) })}</div>
        </div>
      </div>
    </>
  );
}

// ── address picker sheet ────────────────────────────────────────────────────

function AddressPicker({
  addrInfos,
  selectedAddr,
  votedAddrs,
  minPower,
  onPick,
  onClose,
}: {
  addrInfos: AddrInfo[];
  selectedAddr: string | null;
  votedAddrs: Record<string, string>;
  minPower: number;
  onPick: (addr: string) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  return (
    <Sheet
      title={t("gov.pickTitle")}
      subtitle={t("gov.pickCount", { n: addrInfos.length })}
      onClose={onClose}
      height="80%"
      footer={
        <div className="sheet-hint">
          <Icon name="info" size={14} />
          <span>{t("gov.pickHint", { n: exfer(minPower) })}</span>
        </div>
      }
    >
      {addrInfos.map((a) => {
        const isSel = a.entry.address === selectedAddr;
        const voted = votedAddrs[a.entry.address];
        return (
          <button
            key={a.entry.address}
            className={
              "addr-row" + (isSel ? " selected" : "") + (a.eligible ? "" : " ineligible")
            }
            disabled={!a.eligible}
            onClick={() => a.eligible && onPick(a.entry.address)}
          >
            <span className="avatar">
              <Icon name="card" size={19} />
            </span>
            <span className="body">
              <span className="lbl">
                {addrName(a.entry)}
                {voted && (
                  <span className="voted-chip">
                    <Icon name="check" size={9} stroke={3.2} />
                    {t("gov.votedChip")}
                  </span>
                )}
                {!a.eligible && (
                  <span className="note">{t("gov.belowChip", { n: exfer(minPower) })}</span>
                )}
              </span>
              <span className="addr mono">{shortAddress(a.entry.address)}</span>
              <span className="bal">
                {exfer(a.power)} <small>EXFER</small>
              </span>
            </span>
            <span className="tick">
              {isSel ? (
                <Icon name="check" size={14} stroke={3} />
              ) : !a.eligible ? (
                <Icon name="lock" size={13} stroke={2.2} />
              ) : null}
            </span>
          </button>
        );
      })}
    </Sheet>
  );
}
