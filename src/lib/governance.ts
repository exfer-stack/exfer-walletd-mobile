// Community voting / governance client.
//
// API-first: a vote is an Ed25519-signed canonical payload (see
// ../../../SIGNING_SPEC.md → `exfer-vote/v1`) POSTed to the `exfer-vote`
// community service. The wallet app and autonomous agents are equal clients of
// the same HTTP API + signing format.
//
// Networking follows the dual pattern in market.ts:
//   • dev / plain browser (devmock.isActive())  → direct `fetch` to the Vite
//     proxy path `/__vote/...` (devmock supplies mock data when the proxy is
//     not configured), so `npm run dev` works in-browser with no vote server.
//   • real Tauri build                          → `invoke("vote_api_get" |
//     "vote_api_post")`, the Rust proxy that handles HTTPS + CA pinning.
//
// Signing always goes through `rpc("sign_message", { address, message })` (the
// embedded walletd, Spend scope), which signs `"EXFER-MSG" || message` exactly
// as the spec requires. We never touch key material here.

import { invoke } from "@tauri-apps/api/core";
import { devmock } from "./devmock";
import { rpc } from "./rpc";

// ── types ──────────────────────────────────────────────────────────────────

/** Bilingual text. Both languages are always present (server-curated). */
export interface I18nText {
  en: string;
  zh: string;
}

/** A proposal lifecycle phase. Mirrors `exfer-vote`'s `status`. */
export type ProposalStatus = "upcoming" | "open" | "closed" | "finalized";

/** What kind of attachment this is — decided **server-side** from the
 *  validated `content_type`. `"image"` is reserved for the four inline raster
 *  types (`image/png`, `image/jpeg`, `image/webp`, `image/gif`); everything
 *  else — including `image/svg+xml`, which can carry script — is `"file"` and
 *  is served download-only with `nosniff`. Never infer this client-side. */
export type AttachmentKind = "image" | "file";

/** A file attached to a proposal. Bytes are self-hosted by exfer-vote and
 *  fetched from `GET /media/<id>`; this metadata is embedded inline on the
 *  proposal (and echoed by the admin upload endpoint). Mirrors the exfer-vote
 *  `Attachment` wire shape exactly. */
export interface Attachment {
  /** Server-generated id: 32 lowercase hex chars. The `GET /media/:id` key. */
  id: string;
  /** Sanitized basename (path/control/quote chars stripped, ≤200 chars). */
  filename: string;
  /** Validated, lowercased MIME (charset stripped); `application/octet-stream`
   *  when the upload carried none. */
  content_type: string;
  /** Byte length of the stored file. */
  size: number;
  /** `"image"` (inline-renderable raster) or `"file"` (download-only). */
  kind: AttachmentKind;
}

/** One selectable choice on a proposal. */
export interface Option {
  /** Stable option id, e.g. `"opt_a"` — what gets signed into the payload. */
  id: string;
  /** Display label (bilingual). */
  label: I18nText;
}

/** When voting is open. Unix epoch seconds (UTC). */
export interface VotingWindow {
  open_time: number;
  close_time: number;
}

/** The published tally for a closed/finalized proposal. Powers are strings
 *  (exfers) to avoid precision loss on large totals. */
export interface VoteResult {
  /** Height the result was finalized at (null until finalized). */
  finalized_at_height: number | null;
  /** Block heights of each post-close spot-check read. */
  spot_check_heights: number[];
  /** Distinct addresses counted in the (final) tally. */
  total_voters: number;
  /** Sum of `final_power` across all counted voters, in exfers. */
  total_power: string;
  /** Per-option power sum, in exfers, keyed by option id. */
  by_option: Record<string, string>;
  /** True once spot-checks have run and the tally is final; false while the
   *  shown numbers are a live provisional tally during the open window. */
  finalized: boolean;
}

/** A governance proposal. Mirrors the `exfer-vote` data model. */
export interface Proposal {
  id: string;
  title: I18nText;
  description: I18nText;
  options: Option[];
  window: VotingWindow;
  status: ProposalStatus;
  /** Eligibility threshold in exfers (1 EXFER = 1e8 exfers). Default 100,000
   *  EXFER = 10_000_000_000_000 exfers; per-proposal overridable. */
  min_power: number;
  /** Days after `close_time` during which random spot-checks may run. */
  spot_check_window_days: number;
  /** Published tally; null until the proposal has results to show. */
  results: VoteResult | null;
  /** Files attached to the proposal (empty `[]` when none). Each attachment's
   *  bytes live at `mediaUrl(attachment.id)`. */
  attachments: Attachment[];
}

/** The current voting power (balance, in exfers) of one address, plus whether
 *  it clears this proposal's `min_power`. Drives the per-address selector and
 *  the eligibility hint. */
export interface AddressPower {
  address: string;
  /** Current on-chain balance in exfers (the instantaneous snapshot power). */
  power: number;
  /** `power >= proposal.min_power`. */
  eligible: boolean;
}

/** This address's current recorded choice on a proposal, or null if it hasn't
 *  voted (latest-nonce-wins server-side). */
export interface MyVote {
  option_id: string;
}

/** Result of a successful `submitVote`. `power` is the vote-time balance
 *  snapshot the server credited, in exfers. */
export interface SubmitVoteResult {
  power: number;
}

// ── wire shapes (server JSON) ───────────────────────────────────────────────
// The server emits snake_case; we normalize to the types above so callers and
// the devmock agree on one shape.

interface WireProposal {
  id: string;
  title: I18nText;
  description: I18nText;
  options: Option[];
  voting_window: VotingWindow;
  status: ProposalStatus;
  min_power: number;
  spot_check?: { window_days?: number } | null;
  results?: WireResults | null;
  attachments?: WireAttachment[] | null;
}

interface WireAttachment {
  id?: string | null;
  filename?: string | null;
  content_type?: string | null;
  size?: number | null;
  kind?: string | null;
}

interface WireResults {
  finalized_at_height?: number | null;
  spot_check_heights?: number[] | null;
  total_voters?: number | null;
  total_power?: string | number | null;
  by_option?: Record<string, string | number> | null;
}

function normalizeResults(r: WireResults | null | undefined): VoteResult | null {
  if (!r) return null;
  const byOption: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.by_option ?? {})) byOption[k] = String(v ?? "0");
  return {
    finalized_at_height: r.finalized_at_height ?? null,
    spot_check_heights: Array.isArray(r.spot_check_heights) ? r.spot_check_heights : [],
    total_voters: Number(r.total_voters ?? 0),
    total_power: String(r.total_power ?? "0"),
    by_option: byOption,
    finalized: r.finalized_at_height != null,
  };
}

function normalizeAttachment(a: WireAttachment): Attachment {
  // `kind` is authoritative server-side; default to download-only `"file"` for
  // any unexpected/missing value rather than ever guessing `"image"`.
  const kind: AttachmentKind = a.kind === "image" ? "image" : "file";
  return {
    id: String(a.id ?? ""),
    filename: String(a.filename ?? ""),
    content_type: String(a.content_type ?? "application/octet-stream"),
    size: Number(a.size ?? 0),
    kind,
  };
}

function normalizeProposal(p: WireProposal): Proposal {
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    options: p.options ?? [],
    window: p.voting_window,
    status: p.status,
    min_power: p.min_power,
    spot_check_window_days: p.spot_check?.window_days ?? 7,
    results: normalizeResults(p.results),
    attachments: Array.isArray(p.attachments)
      ? p.attachments.map(normalizeAttachment)
      : [],
  };
}

// ── HTTP transport (dual: dev fetch vs. Tauri proxy command) ────────────────

// Dev/browser networking goes through devmock, which owns the Vite dev-proxy
// prefix `/__vote` (sibling of `/__walletd`, `/__price`, `/__bnbusd`) — point
// it at a real exfer-vote service via `VITE_VOTE_PROXY_TARGET` in `.env.local`,
// or leave unset for in-browser mock data. Callers here pass bare API paths
// (`/proposals`, `/votes`, …); the real Tauri build routes them through the
// `vote_api_get` / `vote_api_post` Rust commands (HTTPS + CA pinning).

async function voteGet<T>(path: string): Promise<T> {
  if (devmock.isActive()) return devmock.vote_api_get(path) as Promise<T>;
  return invoke<T>("vote_api_get", { path });
}

async function votePost<T>(path: string, body: unknown): Promise<T> {
  if (devmock.isActive()) return devmock.vote_api_post(path, body) as Promise<T>;
  return invoke<T>("vote_api_post", { path, body: JSON.stringify(body) });
}

/** The Vite dev-proxy prefix that fronts the exfer-vote service in a plain
 *  browser (sibling of `/__walletd`); kept in lockstep with `devmock`'s own
 *  `VOTE_BASE`. The proxy strips this prefix before forwarding, so the upstream
 *  service still sees a bare `/media/<id>`. */
const VOTE_PROXY_PREFIX = "/__vote";

/** Build the path/URL for an attachment's bytes — the public, no-auth
 *  `GET /media/:id` endpoint. Picks its base exactly like {@link voteGet} /
 *  {@link votePost} pick theirs, so the same call site works in both transports:
 *
 *   • dev / plain browser (`devmock.isActive()`) → the Vite dev-proxy path
 *     `/__vote/media/<id>`. This is directly usable as an `<img src>` / link
 *     `href`: the proxy strips `/__vote` and forwards to the configured
 *     `VITE_VOTE_PROXY_TARGET` (with no proxy target, the mock attachments are
 *     inert placeholders, so the dead URL is never actually loaded).
 *   • real Tauri build → the bare API path `/media/<id>`, the same shape the
 *     `vote_api_get` / `vote_api_post` commands consume. The Rust side joins it
 *     onto the build-time, CA-pinned `EXFER_VOTE_BASE`; the webview must route
 *     media bytes through that proxy rather than hitting the host directly, so
 *     the pinned trust anchor is preserved.
 *
 *  `id` is server-generated (32 lowercase hex) so it needs no escaping, but we
 *  encode defensively to keep the result well-formed for any value. */
export function mediaUrl(id: string): string {
  const safeId = encodeURIComponent(id);
  const base = devmock.isActive() ? VOTE_PROXY_PREFIX : "";
  return `${base}/media/${safeId}`;
}

/** An attachment's bytes, fetched through the SAME transport choice as the rest
 *  of the vote API so cert pinning is preserved on the real build:
 *
 *   • dev / plain browser (`devmock.isActive()`) → a plain `fetch` of
 *     {@link mediaUrl} (the `/__vote` dev-proxy path). With no
 *     `VITE_VOTE_PROXY_TARGET` the mock URLs are inert, so this throws and the
 *     caller falls back to an anchor download of {@link mediaUrl} — fine for dev.
 *   • real Tauri build → the `vote_media_get` Rust command, which pulls the
 *     bytes through the CA-pinned vote client (never host-direct) and hands back
 *     `{ content_type, body_hex }`.
 *
 *  Use this for: inline image rendering (build an object-URL the webview can
 *  load, since a Tauri webview can't `<img src="/media/...">` a bare API path)
 *  and Tauri file downloads (hand the bytes to the platform save helper). */
export async function fetchMediaBytes(
  id: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (devmock.isActive()) {
    const res = await fetch(mediaUrl(id));
    if (!res.ok) throw new Error(`media fetch failed: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      bytes: buf,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }
  const res = await invoke<{ content_type?: string; body_hex?: string }>(
    "vote_media_get",
    { path: `/media/${encodeURIComponent(id)}` },
  );
  const hex = res?.body_hex ?? "";
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return { bytes: out, contentType: res?.content_type ?? "application/octet-stream" };
}

// ── canonical vote payload (SIGNING_SPEC §2) ────────────────────────────────

/** Build the canonical JSON string that gets signed — keys sorted
 *  (`address`, `domain`, `nonce`, `option_id`, `proposal_id`), no whitespace,
 *  `nonce` a bare integer. MUST be byte-identical across every client; do NOT
 *  route through `JSON.stringify` over an unordered object. */
export function canonicalVotePayload(args: {
  address: string;
  optionId: string;
  proposalId: string;
  nonce: number;
}): string {
  const { address, optionId, proposalId, nonce } = args;
  if (!Number.isInteger(nonce) || nonce < 0) {
    throw new Error("nonce must be a non-negative integer");
  }
  return (
    `{"address":${JSON.stringify(address)},` +
    `"domain":${JSON.stringify("exfer-vote/v1")},` +
    `"nonce":${nonce},` + // bare integer — no quotes
    `"option_id":${JSON.stringify(optionId)},` +
    `"proposal_id":${JSON.stringify(proposalId)}}`
  );
}

/** A strictly-increasing nonce — unix-epoch seconds at vote time, the spec's
 *  recommended choice (latest nonce wins → re-votes always supersede).
 *
 *  The server applies *strictly-greater* latest-nonce-wins (SIGNING_SPEC §6.7),
 *  so two votes within the same wall-clock second would collide and the second
 *  would be dropped as a replay. We keep a module-level high-water mark and
 *  force the next nonce to be at least `last + 1`, guaranteeing a re-vote always
 *  supersedes regardless of sub-second timing (still a non-negative u64). */
let lastNonce = 0;
function nextNonce(): number {
  const n = Math.max(Math.floor(Date.now() / 1000), lastNonce + 1);
  lastNonce = n;
  return n;
}

// ── stale-while-revalidate cache ─────────────────────────────────────────────
//
// The governance screens hit a remote vote server on every entry, with
// no cache — so re-opening the tab or a proposal blanks to a skeleton and waits
// on a round-trip every time. These module-level caches let the UI paint the
// last-known data INSTANTLY (synchronous read) while the live fetch refreshes in
// the background. They're plain in-memory caches (cleared on app restart); the
// existing polling keeps them fresh.

let _proposalsCache: Proposal[] | null = null;
const _proposalCache = new Map<string, Proposal>();
const _resultsCache = new Map<string, VoteResult>();

/** Last-known proposals list, or null if none fetched yet this session. */
export function cachedProposals(): Proposal[] | null {
  return _proposalsCache;
}

/** Last-known detail for one proposal, or null if not cached. */
export function cachedProposal(id: string): Proposal | null {
  return _proposalCache.get(id) ?? null;
}

/** Last-known results for one proposal, or null if not cached. */
export function cachedResults(id: string): VoteResult | null {
  return _resultsCache.get(id) ?? null;
}

// ── public API ──────────────────────────────────────────────────────────────

/** All proposals (every status), newest/most-relevant first per the server. */
export async function getProposals(): Promise<Proposal[]> {
  const res = await voteGet<{ proposals?: WireProposal[] } | WireProposal[]>("/proposals");
  const list = Array.isArray(res) ? res : (res?.proposals ?? []);
  const proposals = list.map(normalizeProposal);
  _proposalsCache = proposals;
  // Seed per-proposal detail cache from the list so first detail open is instant.
  for (const p of proposals) _proposalCache.set(p.id, p);
  return proposals;
}

/** One proposal by id (includes results when closed/finalized). */
export async function getProposal(id: string): Promise<Proposal> {
  const res = await voteGet<WireProposal>(`/proposals/${encodeURIComponent(id)}`);
  const proposal = normalizeProposal(res);
  _proposalCache.set(proposal.id, proposal);
  if (proposal.results) _resultsCache.set(proposal.id, proposal.results);
  return proposal;
}

/** This address's current choice on a proposal, or null if it hasn't voted. */
export async function getMyVote(id: string, address: string): Promise<MyVote | null> {
  const res = await voteGet<{ option_id?: string | null } | null>(
    `/proposals/${encodeURIComponent(id)}/my-vote?address=${encodeURIComponent(address)}`,
  );
  if (!res || !res.option_id) return null;
  return { option_id: res.option_id };
}

/** Live/provisional tally during the window + final tally after finalize. */
export async function getResults(id: string): Promise<VoteResult> {
  const res = await voteGet<WireResults>(`/proposals/${encodeURIComponent(id)}/results`);
  const results = normalizeResults(res) ?? {
    finalized_at_height: null,
    spot_check_heights: [],
    total_voters: 0,
    total_power: "0",
    by_option: {},
    finalized: false,
  };
  _resultsCache.set(id, results);
  return results;
}

/** Cast (or change) a vote from `address`:
 *  1. build the canonical payload (SIGNING_SPEC §2) with a fresh nonce,
 *  2. `sign_message { address, message: payload }` via walletd (Spend scope) —
 *     returns `{ signature, pubkey, address }`,
 *  3. POST `{ payload, signature, pubkey }` to the vote server verbatim.
 *  Re-voting just submits a higher nonce; the server takes the latest. */
export async function submitVote(
  id: string,
  optionId: string,
  address: string,
): Promise<SubmitVoteResult> {
  const payload = canonicalVotePayload({
    address,
    optionId,
    proposalId: id,
    nonce: nextNonce(),
  });

  const signed = await rpc<{ signature: string; pubkey: string; address?: string }>(
    "sign_message",
    { address, message: payload },
  );
  if (!signed?.signature || !signed?.pubkey) {
    throw new Error("sign_message did not return a signature");
  }

  const res = await votePost<{ power?: number | string }>("/votes", {
    payload,
    signature: signed.signature,
    pubkey: signed.pubkey,
  });
  return { power: Number(res?.power ?? 0) };
}
