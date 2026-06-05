// Update checker — compares the running app version against the latest
// published GitHub release and points the user at the download.
//
// Same network rule as walletd/price: the webview never calls out directly.
// In a Tauri build the request goes through the Rust `check_latest_release`
// command; in browser dev it fetches the GitHub API directly (GitHub sends
// permissive CORS). GitHub's anonymous REST API is rate-limited to 60/hour
// per IP — fine for a per-device check; we also cache the result for an hour.

import { invoke } from "@tauri-apps/api/core";
import { copyText } from "./clipboard";
import { useEffect, useState } from "react";
import { devmock } from "./devmock";

/** Running app version, baked in from package.json at build time. */
export const APP_VERSION: string =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";

const RELEASES_API =
  "https://api.github.com/repos/exfer-stack/exfer-walletd-mobile/releases/latest";
const CACHE_KEY = "exfer-update-cache";
const CACHE_TTL = 60 * 60 * 1000; // 1h

export interface LatestRelease {
  /** Clean version, e.g. "0.5.0" (the tag with any leading "v" stripped). */
  version: string;
  /** Release page (always present). */
  releaseUrl: string;
  /** Direct .apk asset, when the release attaches one. */
  apkUrl?: string;
}

/** Compare dotted versions. >0 if a>b, <0 if a<b, 0 if equal. Non-numeric or
 *  missing parts are treated as 0 so "0.5" < "0.5.1". */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".");
  const pb = b.replace(/^v/, "").split(".");
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = parseInt(pa[i] ?? "0", 10) || 0;
    const y = parseInt(pb[i] ?? "0", 10) || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function parseRelease(raw: string): LatestRelease | null {
  try {
    const d = JSON.parse(raw) as {
      tag_name?: string;
      html_url?: string;
      assets?: { name?: string; browser_download_url?: string }[];
    };
    if (!d.tag_name) return null;
    const apk = (d.assets ?? []).find((a) => a.name?.toLowerCase().endsWith(".apk"));
    return {
      version: d.tag_name.replace(/^v/, ""),
      releaseUrl: d.html_url || "https://github.com/exfer-stack/exfer-walletd-mobile/releases/latest",
      apkUrl: apk?.browser_download_url,
    };
  } catch {
    return null;
  }
}

async function fetchLatest(): Promise<LatestRelease | null> {
  let raw: string;
  if (devmock.isActive()) {
    const r = await fetch(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!r.ok) throw new Error(`github ${r.status}`);
    raw = await r.text();
  } else {
    raw = await invoke<string>("check_latest_release");
  }
  return parseRelease(raw);
}

export type UpdateState =
  | { status: "checking" }
  | { status: "current" }
  | { status: "available"; release: LatestRelease }
  | { status: "error" };

/** Check GitHub for a newer release. Caches the parsed result for an hour
 *  (unless `force`) so launches don't burn the API budget. */
export async function checkForUpdate(force = false): Promise<UpdateState> {
  if (!force) {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (c && Date.now() - c.at < CACHE_TTL && c.release) {
        return compareVersions(c.release.version, APP_VERSION) > 0
          ? { status: "available", release: c.release }
          : { status: "current" };
      }
    } catch {
      /* ignore */
    }
  }
  try {
    const release = await fetchLatest();
    if (!release) return { status: "error" };
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), release }));
    } catch {
      /* ignore */
    }
    return compareVersions(release.version, APP_VERSION) > 0
      ? { status: "available", release }
      : { status: "current" };
  } catch {
    return { status: "error" };
  }
}

/** Open the download in the system browser (so the .apk downloads directly).
 *  The mobile WebView's `window.open` is a no-op, so on a real build we go
 *  through the Tauri opener plugin; browser dev falls back to window.open, and
 *  only if everything fails do we copy the link. Resolves true iff it had to
 *  copy (so the caller can show a "link copied" hint). */
export async function openDownload(release: LatestRelease): Promise<boolean> {
  const url = release.apkUrl || release.releaseUrl;
  // Real app: hand the URL to the OS browser.
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return false;
  } catch {
    /* not in Tauri (browser dev) or plugin unavailable — try the web path */
  }
  try {
    const w = window.open(url, "_blank", "noopener");
    if (w) return false;
  } catch {
    /* fall through to clipboard */
  }
  try {
    await copyText(url);
  } catch {
    /* ignore */
  }
  return true;
}

/** React hook: auto-checks once on mount. */
export function useUpdateCheck(): {
  state: UpdateState;
  recheck: () => void;
} {
  const [state, setState] = useState<UpdateState>({ status: "checking" });
  function run(force: boolean) {
    setState({ status: "checking" });
    void checkForUpdate(force).then(setState);
  }
  useEffect(() => {
    void checkForUpdate(false).then(setState);
  }, []);
  return { state, recheck: () => run(true) };
}
