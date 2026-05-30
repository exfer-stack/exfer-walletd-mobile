// Theme + accent presets. Accent vars are driven into CSS as inline style on
// the .phone root (--accent / --accent-strong / --accent-ink).

export type ThemeMode = "dark" | "light";
export type AccentKey = "cyan" | "green" | "violet" | "amber";

export interface AccentDef {
  a: string;
  s: string;
  ink: string;
}

export const ACCENTS: Record<AccentKey, AccentDef> = {
  cyan: { a: "#22d3ee", s: "#06b6d4", ink: "#04181d" },
  green: { a: "#34e0b0", s: "#10b981", ink: "#04201a" },
  violet: { a: "#a78bfa", s: "#7c5cff", ink: "#14082b" },
  amber: { a: "#fbbf24", s: "#f59e0b", ink: "#231603" },
};

export function isAccentKey(v: string): v is AccentKey {
  return v === "cyan" || v === "green" || v === "violet" || v === "amber";
}

export function isThemeMode(v: string): v is ThemeMode {
  return v === "dark" || v === "light";
}
