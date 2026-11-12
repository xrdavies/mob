import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60],
];

/** Short relative time such as "2m", "3h", "now". */
export function shortAgo(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 45) return "now";
  for (const [unit, size] of units) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${unit === "month" ? "mo" : unit[0]}`;
  }
  return `${Math.max(1, Math.round(seconds / 60))}m`;
}

/** Human duration between two timestamps, e.g. "42s", "3m 05s". */
export function duration(from?: string, to?: string): string {
  if (!from || !to) return "";
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  if (!Number.isFinite(s)) return "";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function compactNumber(n: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function uid(): string {
  return crypto.randomUUID?.() ?? `m-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** The menu entry for "no choice": names the agent's default when mobd reports it. */
export function defaultLabel(what: string, value?: string): string {
  return value ? `Default (${value})` : `Default ${what}`;
}

/** `latest` is newer than `current` (X.Y.Z, as mobd's release manifest has it); false without `current`. */
export function newerVersion(latest: string, current?: string): boolean {
  if (!current) return false;
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}
