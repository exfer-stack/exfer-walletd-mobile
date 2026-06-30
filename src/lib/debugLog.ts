// In-memory debug-log ring buffer for the frontend.
//
// There is no logging infrastructure in the app, so a user hitting a problem on
// their phone has no way to hand us anything diagnostic. This keeps the last
// `CAP` console lines in a bounded buffer that Settings → Diagnostics can copy
// or export. Importing this module (a side-effect import in main.tsx) patches
// console.* so EVERYTHING already written with console.log/info/warn/error is
// captured automatically — the originals still fire, so normal dev logging is
// unchanged. Structured one-off entries can also be pushed with `pushLog`.

export type LogLevel = "log" | "info" | "warn" | "error" | "debug";

interface Entry {
  ts: number;
  level: LogLevel;
  msg: string;
}

// Bounded ring buffer (oldest evicted first). 500 lines is plenty to capture a
// stuck swap's trail without holding meaningful memory.
const CAP = 500;
const ring: Entry[] = [];

function fmtArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
  if (a === undefined) return "undefined";
  if (a === null) return "null";
  try {
    return JSON.stringify(a);
  } catch {
    // Circular / non-serializable — fall back to the default string coercion.
    return String(a);
  }
}

/** Append one entry to the ring buffer (oldest dropped past CAP). Never calls
 *  console, so it's safe to use from the console patch below without recursing. */
export function pushLog(level: LogLevel, ...args: unknown[]): void {
  ring.push({ ts: Date.now(), level, msg: args.map(fmtArg).join(" ") });
  if (ring.length > CAP) ring.splice(0, ring.length - CAP);
}

/** The captured log as a single string, oldest-first / newest-last, one entry
 *  per line with an ISO timestamp and level tag. */
export function getDebugLog(): string {
  return ring
    .map((e) => `${new Date(e.ts).toISOString()} [${e.level}] ${e.msg}`)
    .join("\n");
}

// ── Patch console.* once, at import time ───────────────────────────────────
// Guard against double-patching (Vite HMR / React StrictMode re-imports) via a
// marker on the global console object.
const PATCHED = "__exferDebugLogPatched";
type PatchableConsole = Console & Record<string, unknown>;
const c = console as PatchableConsole;
if (!c[PATCHED]) {
  c[PATCHED] = true;
  (["log", "info", "warn", "error", "debug"] as const).forEach((level) => {
    const original = c[level] as ((...args: unknown[]) => void) | undefined;
    if (typeof original !== "function") return;
    c[level] = (...args: unknown[]) => {
      try {
        pushLog(level, ...args);
      } catch {
        /* never let logging capture break the real console call */
      }
      original.apply(console, args);
    };
  });
}
