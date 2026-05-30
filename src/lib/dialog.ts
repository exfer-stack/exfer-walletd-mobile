// Thin wrappers around @tauri-apps/plugin-dialog that degrade gracefully in
// plain browser dev (the plugin only works inside a Tauri webview). Outside
// Tauri we return a synthetic path so the dev-mock flows still exercise.

import { devmock } from "./devmock";

interface OpenFilter {
  name: string;
  extensions: string[];
}

/** Pick an existing file. Returns its path, or null if cancelled. In browser
 *  dev mode returns a synthetic path so the mock import flows run. */
export async function pickFile(args: {
  filters?: OpenFilter[];
  title?: string;
}): Promise<string | null> {
  if (devmock.isActive()) {
    // No real filesystem in the browser; hand back a stand-in path the mock
    // backend accepts.
    return `/dev/mock/${(args.title ?? "file").replace(/\s+/g, "-").toLowerCase()}`;
  }
  const mod = await import("@tauri-apps/plugin-dialog");
  const selected = await mod.open({
    multiple: false,
    directory: false,
    filters: args.filters,
    title: args.title,
  });
  if (typeof selected === "string") return selected;
  return null;
}

/** Pick a destination path to save to. Returns the path, or null if
 *  cancelled. Browser dev mode returns a synthetic path. */
export async function pickSavePath(args: {
  defaultPath?: string;
  filters?: OpenFilter[];
  title?: string;
}): Promise<string | null> {
  if (devmock.isActive()) {
    return `/dev/mock/${args.defaultPath ?? "export.bin"}`;
  }
  const mod = await import("@tauri-apps/plugin-dialog");
  const dest = await mod.save({
    defaultPath: args.defaultPath,
    filters: args.filters,
    title: args.title,
  });
  return dest ?? null;
}
