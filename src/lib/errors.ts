// Turn raw walletd / JSON-RPC / transport errors into calm, plain-language
// messages. Errors reach the UI in a few shapes:
//   - Rust shell:    "upstream JSON-RPC error (code -32020): <inner>"
//   - browser proxy: "<inner> (code -32603)"
//   - plain JS Error / thrown string (our own validation messages)
// where <inner> may itself nest "upstream node returned error code -32603:
// Rate limit exceeded: ...". We never want to show the user a raw code dump,
// so we match known cases by substring (robust to the wrapping) and fall back
// to a generic line — keeping the raw text only in the console for debugging.
// Messages are localized via tStatic (reads the persisted language).

import { tStatic, type MsgKey } from "./i18n";

/** Pull the most useful raw string out of whatever was thrown. */
function rawText(e: unknown): string {
  if (e == null) return "";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (typeof e === "object") {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(e);
}

// Ordered most-specific → most-general. First match wins. `key` is resolved
// through tStatic at call time so the message follows the chosen language.
const PATTERNS: { test: RegExp; key: MsgKey }[] = [
  // ---- swap-specific (most specific; must win over the generic ones) ----
  {
    test: /swap not configured|swap engine|set --swap-pool/i,
    key: "err.swapUnavailable",
  },
  {
    test: /quote expired|request a fresh quote/i,
    key: "err.quoteExpired",
  },
  {
    test: /pool liquidity|temporarily reserved|reserved by other|size cap|exceeds.*reserve/i,
    key: "err.poolLiquidity",
  },
  {
    test: /no BNB|BNB for gas|fund it before/i,
    key: "err.needBnb",
  },
  {
    test: /unsafe .*timeout|too-short.*timeout/i,
    key: "err.unsafeTimeout",
  },
  {
    test: /rate.?limit|too many requests|queries per minute|-32603/i,
    key: "err.busy",
  },
  {
    test: /insufficient|not enough|exceeds? (the )?balance|can'?t cover|too small to cover/i,
    key: "err.insufficient",
  },
  {
    test: /invalid address|bad address|malformed address|not a valid address|address.*invalid/i,
    key: "err.badAddr",
  },
  {
    test: /passphrase|password|decrypt|bad mac|wrong key|invalid mac|authentication failed|incorrect/i,
    key: "err.password",
  },
  {
    test: /method not found|-32601|not supported|unsupported|unknown method/i,
    key: "err.oldNode",
  },
  {
    test: /timeout|timed out|connection refused|connection reset|unreachable|dns|failed to connect|error sending request|cannot reach|network error|transport:/i,
    key: "err.network",
  },
  {
    // Storage/OS permission failures (e.g. a wipe or backup the ROM blocks).
    // Matches English and the localized strerror Chinese ROMs surface.
    test: /permission denied|operation not permitted|access is denied|os error 13|os error 1\b|权限|拒绝访问|不允许/i,
    key: "err.permission",
  },
  {
    test: /already (known|in mempool|exists)|duplicate|nonce/i,
    key: "err.duplicate",
  },
  {
    test: /fee.*(too low|below)|min(imum)? fee/i,
    key: "err.feeLow",
  },
  {
    test: /no file selected|cancelled|canceled/i,
    key: "err.cancelled",
  },
];

// Wrapper prefixes/suffixes the shell adds; stripped before deciding whether a
// fallback message is already human-readable or still a raw code dump.
function stripWrappers(s: string): string {
  return s
    .replace(/^upstream json-rpc error \(code -?\d+\):\s*/i, "")
    .replace(/^upstream node returned error code -?\d+:\s*/i, "")
    .replace(/\s*\(code -?\d+\)\s*$/i, "")
    .trim();
}

/** True when a string still looks like an internal/raw error, not something
 *  worth showing a user verbatim. */
function looksRaw(s: string): boolean {
  return /json-rpc|rpc error|code -?\d|panicked|thiserror|anyhow|0x[0-9a-f]{8}|stack backtrace/i.test(
    s,
  );
}

/**
 * Map any thrown value to a calm, user-facing message. Pair it with a
 * contextual title at the call site, e.g. `toast.error("Transfer failed",
 * humanizeError(e))`. The raw text is logged to the console for debugging.
 */
export function humanizeError(e: unknown): string {
  const raw = rawText(e).trim();
  if (raw) console.warn("[error]", raw);
  if (!raw) return tStatic("err.generic");

  for (const { test, key } of PATTERNS) {
    if (test.test(raw)) return tStatic(key);
  }

  // No known pattern. If the (de-wrapped) text reads like a plain message —
  // e.g. one of our own validation strings — show it; otherwise stay generic.
  const inner = stripWrappers(raw);
  if (inner && inner.length <= 140 && !looksRaw(inner)) {
    return inner.charAt(0).toUpperCase() + inner.slice(1);
  }
  return tStatic("err.generic");
}
