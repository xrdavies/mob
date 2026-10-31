// Paths for the Files commander: remote paths are "/"-separated inside mobd's shared folder ("" is
// the folder itself); local paths are absolute, with the system's separator.
import type { Transfer } from "@/store/transfers";

export const joinRemote = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
export const parentRemote = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
export const encodeRemote = (path: string) => path.split("/").map(encodeURIComponent).join("/");

const sep = (path: string) => (path.includes("\\") && !path.includes("/") ? "\\" : "/");
export const joinLocal = (dir: string, name: string) => (dir.endsWith(sep(dir)) ? dir + name : dir + sep(dir) + name);
export function parentLocal(path: string): string | undefined {
  const s = sep(path), trimmed = path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
  const i = trimmed.lastIndexOf(s);
  if (i < 0 || trimmed === s || /^[A-Za-z]:$/.test(trimmed)) return undefined;
  return i === 0 ? s : /^[A-Za-z]:$/.test(trimmed.slice(0, i)) ? trimmed.slice(0, i + 1) : trimmed.slice(0, i);
}
export const baseName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;

/** Breadcrumb for a local folder: "Home" for the home folder, then each folder below it. */
export function localCrumbs(home: string, path: string): { label: string; path: string }[] {
  const crumbs: { label: string; path: string }[] = [];
  for (let p: string | undefined = path; p !== undefined; p = parentLocal(p)) {
    if (p === home) { crumbs.push({ label: "Home", path: p }); break; }
    crumbs.push({ label: baseName(p) || p, path: p });
  }
  return crumbs.reverse();
}

/** Folders first, then names in a natural, case-insensitive order. */
export function sortEntries<T extends { name: string; dir: boolean }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

/** Folders of a folder upload that no file creates: they have to be made on their own. */
export function emptyFolders(folders: string[], files: string[]): string[] {
  return folders.filter(f => !files.some(file => file.startsWith(`${f}/`)));
}

export const formatSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KiB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MiB` : `${(n / 1024 ** 3).toFixed(2)} GiB`;

export interface TransferRow {
  key: string; ids: string[]; kind: Transfer["kind"]; name: string; count: number;
  bytes: number; size: number; status: Transfer["status"]; message?: string;
}

/** Active transfers for the strip: a folder upload is one row with its total progress. */
export function transferRows(tasks: Transfer[]): TransferRow[] {
  const rows = new Map<string, TransferRow>();
  const order: Transfer["status"][] = ["failed", "running", "queued", "paused", "done"];
  for (const t of tasks.filter(t => t.status !== "done")) {
    const key = t.group ?? t.id;
    const row = rows.get(key) ?? { key, ids: [], kind: t.kind, name: t.groupName ?? t.name, count: 0, bytes: 0, size: 0, status: "done" };
    row.ids.push(t.id); row.count++; row.bytes += t.bytes; row.size += t.size;
    if (order.indexOf(t.status) < order.indexOf(row.status)) row.status = t.status;
    row.message = row.message ?? t.message;
    rows.set(key, row);
  }
  return [...rows.values()];
}
