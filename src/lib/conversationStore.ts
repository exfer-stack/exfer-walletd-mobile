// Multi-session store for the agent chat (mobile). Mirrors the mcpRegistry.ts
// idiom: a single localStorage key holding the whole {activeId, conversations}
// shape, try/catch read/write with an in-memory fallback when storage is
// unavailable (private mode / quota). The store is the DURABILITY layer; the
// live AgentSession (kept mounted via App's display:none) is the liveness layer.
//
// A conversation carries BOTH:
//   - messages: ChatMessage[]  — the model-facing transcript used to SEED a
//     rebuilt AgentSession (so a lang/provider/MCP change preserves context).
//   - turns:    unknown[]      — the UI's render model (AgentTab owns the Turn
//     shape; stored opaque here to avoid a circular import).
// Both are snapshotted together on turn_done/error.

import type { ChatMessage } from "exfer-agent";

const STORAGE_KEY = "exfer.agent.conversations.v1";

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** UI render model (opaque Turn[] — AgentTab casts). */
  turns: unknown[];
  /** Model-facing transcript, used to seed a rebuilt session. */
  messages: ChatMessage[];
  /** True once trimHistory() dropped earlier messages from `messages`. */
  truncated?: boolean;
}

interface Store {
  activeId: string | null;
  conversations: Conversation[];
}

// In-memory mirror — the source of truth this session. Hydrated from storage
// once; every mutation writes through to both this and localStorage.
let mem: Store | null = null;

function read(): Store {
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Store>;
      if (parsed && Array.isArray(parsed.conversations)) {
        mem = { activeId: parsed.activeId ?? null, conversations: parsed.conversations };
        return mem;
      }
    }
  } catch {
    /* corrupt / unavailable — start fresh in-memory */
  }
  mem = { activeId: null, conversations: [] };
  return mem;
}

function write(s: Store): void {
  mem = s;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage full / unavailable — the in-memory mirror still serves this session */
  }
}

function newId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** All conversations, most-recently-updated first. */
export function list(): Conversation[] {
  return read().conversations.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getActive(): Conversation | null {
  const s = read();
  return s.conversations.find((c) => c.id === s.activeId) ?? null;
}

export function setActive(id: string): void {
  const s = read();
  if (s.conversations.some((c) => c.id === id)) write({ ...s, activeId: id });
}

/** Create a fresh conversation and make it active. Returns it. */
export function create(now = Date.now()): Conversation {
  const s = read();
  const conv: Conversation = { id: newId(), title: "", createdAt: now, updatedAt: now, turns: [], messages: [] };
  write({ activeId: conv.id, conversations: [...s.conversations, conv] });
  return conv;
}

/** Ensure there's an active conversation to bind to, WITHOUT persisting an empty
 *  shell: if the active one is empty we reuse it; otherwise (no active) we make a
 *  lazy ephemeral one in memory only — it gets persisted on the first snapshot. */
export function ensureActive(): Conversation {
  const s = read();
  const active = s.conversations.find((c) => c.id === s.activeId);
  if (active) return active;
  // Lazy ephemeral: live in memory, not flushed to storage until it has content.
  const conv: Conversation = { id: newId(), title: "", createdAt: Date.now(), updatedAt: Date.now(), turns: [], messages: [] };
  mem = { activeId: conv.id, conversations: [...s.conversations, conv] };
  return conv;
}

export function rename(id: string, title: string): void {
  const s = read();
  write({
    ...s,
    conversations: s.conversations.map((c) => (c.id === id ? { ...c, title: title.trim(), updatedAt: Date.now() } : c)),
  });
}

/** Delete a conversation. If it was active, switch to the next-most-recent (or
 *  null, letting the caller create a fresh one). Returns the new active id. */
export function remove(id: string): string | null {
  const s = read();
  const remaining = s.conversations.filter((c) => c.id !== id);
  let nextActive = s.activeId;
  if (s.activeId === id) {
    const sorted = remaining.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    nextActive = sorted[0]?.id ?? null;
  }
  write({ activeId: nextActive, conversations: remaining });
  return nextActive;
}

/** Snapshot a conversation's turns + messages. Auto-titles from the first user
 *  message if still untitled. Persists the (until-now ephemeral) shell. */
export function save(id: string, turns: unknown[], messages: ChatMessage[], truncated?: boolean): void {
  const s = read();
  const existing = s.conversations.find((c) => c.id === id);
  const now = Date.now();
  if (!existing) {
    const conv: Conversation = { id, title: autoTitle(messages), createdAt: now, updatedAt: now, turns, messages, truncated };
    write({ activeId: s.activeId ?? id, conversations: [...s.conversations, conv] });
    return;
  }
  write({
    ...s,
    conversations: s.conversations.map((c) =>
      c.id === id
        ? { ...c, turns, messages, truncated: truncated ?? c.truncated, updatedAt: now, title: c.title || autoTitle(messages) }
        : c,
    ),
  });
}

/** Derive a short title from the first user message. */
function autoTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = first && "content" in first ? first.content.trim() : "";
  if (!text) return "";
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine;
}

export interface TrimResult {
  messages: ChatMessage[];
  truncated: boolean;
}

/**
 * Cap a transcript at `maxMessages`, always keeping the first `keepHead` (the
 * SEED boundary — system framing lives in the prompt, but the first user turn
 * anchors context). The critical invariant: NEVER orphan a tool_use from its
 * tool result. A tool result message references a prior assistant toolCall by
 * id; if we cut between them the model sees a result with no call (or a call
 * with no result) and errors. So after slicing we drop any leading orphans:
 *   - a leading `tool` message whose call isn't in the kept window, and
 *   - we never start the tail in the middle of an assistant→tool pair.
 */
export function trimHistory(
  messages: ChatMessage[],
  opts: { maxMessages: number; keepHead: number } = { maxMessages: 40, keepHead: 2 },
): TrimResult {
  const { maxMessages, keepHead } = opts;
  if (messages.length <= maxMessages) return { messages, truncated: false };

  const head = messages.slice(0, keepHead);
  // How many tail messages fit after the head.
  let tailStart = messages.length - (maxMessages - head.length);
  if (tailStart <= keepHead) return { messages, truncated: false };

  // Collect the set of assistant toolCall ids that survive in the tail, then
  // walk the tail boundary forward past any orphaned `tool` result (its call is
  // before tailStart) so the kept window opens on a clean message.
  const idsInTail = new Set<string>();
  for (let i = tailStart; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "assistant" && m.toolCalls) for (const c of m.toolCalls) idsInTail.add(c.id);
  }
  while (tailStart < messages.length) {
    const m = messages[tailStart];
    if (m.role === "tool" && !idsInTail.has(m.toolCallId)) {
      tailStart++; // drop an orphaned result whose call we trimmed
      continue;
    }
    break;
  }

  const tail = messages.slice(tailStart);
  return { messages: [...head, ...tail], truncated: true };
}
