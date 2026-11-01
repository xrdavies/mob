// Files: a two-pane commander. Left, mobd's shared folder on the office computer (never above
// it); right, this computer from Downloads. Upload moves right to left, download left to right.
// See docs/file-commander-design.md.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ArrowUp, RefreshCw, X } from "lucide-react";
import type { Health } from "@/api/types";
import { supports } from "@/api/client";
import { isTauri } from "@/components/TitleBar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/menu";
import { baseName, formatSize, joinLocal, joinRemote, localCrumbs, parentLocal, parentRemote, sortEntries, transferRows } from "@/lib/filesPaths";
import { baseUrl, type Machine } from "@/store/app";
import {
  addDownload, cancelTransfer, deleteRemote, dismissTransfer, listFiles, listLocal, localPlaces, pauseTransfer, renameRemote,
  revealLocal, startTransfer, uploadLocal, useTransfers, type FileListing, type LocalEntry, type LocalPlaces,
} from "@/store/transfers";

interface Entry { name: string; dir: boolean; size?: number }
const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
const message = (e: unknown) => String(e instanceof Error ? e.message : e);

export function FilesDialog({ machine, health, open, onOpenChange }: { machine: Machine; health?: Health; open: boolean; onOpenChange: (open: boolean) => void }) {
  const base = baseUrl(machine);
  const enabled = supports(health, "fileTransfers");
  const folders = supports(health, "fileFolders");
  const allTasks = useTransfers(s => s.tasks);
  const tasks = useMemo(() => allTasks.filter(t => t.machineId === machine.id && t.base === base), [allTasks, machine.id, base]);
  const [error, setError] = useState("");
  const action = async (work: () => Promise<unknown>) => { setError(""); try { await work(); } catch (e) { setError(message(e)); } };

  // Office side
  const [remoteDir, setRemoteDir] = useState("");
  const [remote, setRemote] = useState<FileListing>();
  const [remoteSel, setRemoteSel] = useState<string>();
  const uploaded = tasks.filter(t => t.kind === "upload" && t.status === "done").length;
  const loadRemote = (dir = remoteDir) => action(async () => { setRemote(await listFiles(base, dir)); });
  useEffect(() => { setRemoteDir(""); setRemoteSel(undefined); }, [base]);
  useEffect(() => { if (open && enabled) void loadRemote(); }, [base, open, enabled, remoteDir, uploaded]); // eslint-disable-line react-hooks/exhaustive-deps
  const remoteEntries: Entry[] = sortEntries([
    ...(remote?.folders ?? []).map(f => ({ name: f.name, dir: true })),
    ...(remote?.files ?? []).map(f => ({ name: f.name, dir: false, size: f.size })),
  ]);
  const openRemote = (dir: string) => { setRemoteDir(dir); setRemoteSel(undefined); };

  // This computer
  const [places, setPlaces] = useState<LocalPlaces>();
  const [localDir, setLocalDir] = useState<string>();
  const [local, setLocal] = useState<LocalEntry[]>();
  const [localSel, setLocalSel] = useState<string>();
  const [localError, setLocalError] = useState("");
  useEffect(() => {
    if (open && isTauri && !places) void action(async () => { const p = await localPlaces(); setPlaces(p); setLocalDir(d => d ?? p.downloads); });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const downloaded = tasks.filter(t => t.kind === "download" && t.status === "done");
  // A folder macOS has not allowed (Downloads, Documents, Desktop) fails here: say so in the pane.
  const loadLocal = async (dir = localDir) => {
    if (!dir) return;
    try { setLocal(sortEntries(await listLocal(dir))); setLocalError(""); }
    catch (e) { setLocal([]); setLocalError(/not permitted|denied/i.test(message(e)) ? `${isMac ? "macOS" : "The system"} has not allowed Mob to open this folder. Allow it in System Settings → Privacy & Security → Files and Folders, then refresh.` : message(e)); }
  };
  useEffect(() => { if (open) void loadLocal(); }, [open, localDir, downloaded.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // A download that lands in the open folder is selected, so it is easy to spot.
  const latest = downloaded.reduce<typeof downloaded[number] | undefined>((a, t) => (!a || (t.finishedAt ?? 0) > (a.finishedAt ?? 0) ? t : a), undefined);
  useEffect(() => { if (latest?.localPath && latest.localDir === localDir) setLocalSel(baseName(latest.localPath)); }, [latest?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const openLocal = (dir: string) => { setLocalDir(dir); setLocal(undefined); setLocalSel(undefined); setLocalError(""); };

  // Transfers: the most recent finished one shows for a few seconds, then goes.
  const finished = tasks.filter(t => t.status === "done").sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  useEffect(() => {
    const timers = finished.map(t => setTimeout(() => dismissTransfer(t.id), Math.max(0, (t.finishedAt ?? 0) + 4000 - Date.now())));
    return () => timers.forEach(clearTimeout);
  }, [finished.map(t => t.id).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = transferRows(tasks);
  const recent = finished[0];

  // Actions
  const remoteEntry = remoteEntries.find(e => e.name === remoteSel);
  const localEntry = local?.find(e => e.name === localSel);
  const upload = (entry = localEntry) => entry && localDir && action(() =>
    uploadLocal(machine.id, base, { path: joinLocal(localDir, entry.name), dir: entry.dir, size: entry.size }, remoteDir));
  const download = (entry = remoteEntry) => {
    const file = remote?.files.find(f => f.name === entry?.name);
    if (file && localDir && !entry?.dir) addDownload(machine.id, base, joinRemote(remoteDir, file.name), file, localDir);
  };
  const canUpload = !!localEntry && (!localEntry.dir || folders) && (folders || remoteDir === "");
  const [renaming, setRenaming] = useState<Entry>();
  const [deleting, setDeleting] = useState<Entry>();

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex h-[min(640px,88vh)] w-[min(1040px,96vw)] flex-col gap-3 p-4">
      <DialogTitle>Files</DialogTitle>
      <DialogDescription className="sr-only">Move files between {machine.name} and this computer.</DialogDescription>
      {!enabled ? <p className="text-sm">Update mobd to a version with file transfers, then reconnect.</p>
        : !isTauri ? <p className="text-sm">Use the desktop app to move files.</p>
        : <>
          <div className="grid min-h-0 flex-1 grid-cols-[1fr_auto_1fr] gap-3">
            <Pane
              title={machine.name}
              crumbs={[{ label: remote ? baseName(remote.directory) : "Shared folder", target: "" }, ...remoteDir.split("/").filter(Boolean).map((label, i, all) => ({ label, target: all.slice(0, i + 1).join("/") }))]}
              onCrumb={openRemote} upDisabled={!remoteDir} onUp={() => openRemote(parentRemote(remoteDir))} onRefresh={() => void loadRemote()}
              entries={remote && remoteEntries} selected={remoteSel} onSelect={setRemoteSel}
              onOpen={e => folders && openRemote(joinRemote(remoteDir, e.name))}
              empty="No files yet. Upload one, or ask your agent to copy files here."
              menu={e => <>
                {e.dir ? <ContextMenuItem disabled={!folders} onSelect={() => openRemote(joinRemote(remoteDir, e.name))}>Open</ContextMenuItem>
                  : <ContextMenuItem onSelect={() => download(e)}>Download</ContextMenuItem>}
                <ContextMenuItem disabled={!folders} onSelect={() => setRenaming(e)}>Rename…</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem danger disabled={!folders} onSelect={() => setDeleting(e)}>Delete…</ContextMenuItem>
              </>}
            />
            {/* A fixed height: the strip below comes and goes, and must not move these under the cursor. */}
            <div className="flex flex-col items-center gap-2 pt-48">
              <Button variant="secondary" size="sm" disabled={!canUpload} onClick={() => void upload()} title="Upload the selected item to the office computer"><ArrowLeft /> Upload</Button>
              <Button variant="secondary" size="sm" disabled={!remoteEntry || remoteEntry.dir || !localDir} onClick={() => download()} title="Download the selected file to this folder">Download <ArrowRight /></Button>
            </div>
            <Pane
              title={isMac ? "This Mac" : "This computer"}
              crumbs={places && localDir ? localCrumbs(places.home, localDir).map(c => ({ label: c.label, target: c.path })) : []}
              onCrumb={openLocal} upDisabled={!localDir || parentLocal(localDir) === undefined} onUp={() => { const up = localDir && parentLocal(localDir); if (up) openLocal(up); }}
              onRefresh={() => void loadLocal()}
              entries={local} selected={localSel} onSelect={setLocalSel}
              onOpen={e => localDir && openLocal(joinLocal(localDir, e.name))}
              empty={localError ? <>{localError}{places && localDir !== places.home && <Button variant="link" size="sm" className="mt-1 block w-full" onClick={() => openLocal(places.home)}>Go to Home</Button>}</> : "This folder is empty."}
              menu={e => <>
                {e.dir && <ContextMenuItem onSelect={() => localDir && openLocal(joinLocal(localDir, e.name))}>Open</ContextMenuItem>}
                <ContextMenuItem disabled={(e.dir && !folders) || (!folders && remoteDir !== "")} onSelect={() => void upload(e as LocalEntry)}>Upload</ContextMenuItem>
                <ContextMenuItem onSelect={() => localDir && void action(() => revealLocal(joinLocal(localDir, e.name)))}>{isMac ? "Show in Finder" : "Show in folder"}</ContextMenuItem>
              </>}
            />
          </div>
          {!folders && <p className="text-xs text-muted-foreground">Update mobd to upload folders and to rename or delete files here.</p>}
          {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
          {(rows.length > 0 || recent) && <ul className="max-h-40 shrink-0 space-y-1 overflow-y-auto border-t pt-2">
            {rows.map(row => <li key={row.key} className="flex items-center gap-3 text-xs">
              <span className="w-4 text-muted-foreground">{row.kind === "upload" ? "↑" : "↓"}</span>
              <span className="min-w-0 flex-1 truncate" title={row.message}>{row.name}{row.count > 1 && <span className="text-muted-foreground"> · {row.count} files</span>}</span>
              {row.status === "running" || row.status === "queued"
                ? <progress aria-label={`Progress for ${row.name}`} className="h-1 w-32" value={row.bytes} max={Math.max(1, row.size)} />
                : <span className={row.status === "failed" ? "max-w-60 truncate text-danger" : "text-muted-foreground"} title={row.message}>{row.status === "failed" ? row.message ?? "Failed" : "Paused"}</span>}
              <span className="w-12 text-right tabular-nums text-muted-foreground">{row.size ? Math.floor(row.bytes / row.size * 100) : 0}%</span>
              {row.status === "running" || row.status === "queued"
                ? <Button variant="ghost" size="sm" onClick={() => row.ids.forEach(pauseTransfer)}>Pause</Button>
                : <Button variant="ghost" size="sm" onClick={() => row.ids.forEach(startTransfer)}>{row.status === "failed" ? "Retry" : "Continue"}</Button>}
              <Button variant="ghost" size="sm" onClick={() => void action(() => Promise.all(row.ids.map(cancelTransfer)))}>Cancel</Button>
            </li>)}
            {recent && <li className="flex items-center gap-3 text-xs">
              <span className="w-4 text-success">✓</span>
              <span className="min-w-0 flex-1 truncate">{recent.kind === "upload" ? "Uploaded" : "Downloaded"} {recent.groupName ?? recent.name}</span>
              <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={() => finished.forEach(t => dismissTransfer(t.id))}><X /></Button>
            </li>}
          </ul>}
        </>}
      {renaming && <RenameDialog entry={renaming} onClose={() => setRenaming(undefined)} onRename={async name => {
        await renameRemote(base, joinRemote(remoteDir, renaming.name), name);
        setRemoteSel(name);
        await loadRemote();
      }} />}
      {deleting && <Dialog open onOpenChange={o => !o && setDeleting(undefined)}>
        <DialogContent className="w-[min(420px,92vw)] p-5" showClose={false}>
          <DialogTitle>Delete {deleting.name}{deleting.dir ? " and everything in it" : ""}?</DialogTitle>
          <DialogDescription className="mt-2">It is removed from the office computer and cannot be restored.</DialogDescription>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleting(undefined)}>Cancel</Button>
            <Button variant="danger" onClick={() => { const e = deleting; setDeleting(undefined); void action(async () => { await deleteRemote(base, joinRemote(remoteDir, e.name)); setRemoteSel(undefined); await loadRemote(); }); }}>Delete</Button>
          </div>
        </DialogContent>
      </Dialog>}
    </DialogContent>
  </Dialog>;
}

function Pane({ title, crumbs, onCrumb, upDisabled, onUp, onRefresh, entries, selected, onSelect, onOpen, empty, menu }: {
  title: string; crumbs: { label: string; target: string }[]; onCrumb: (target: string) => void;
  upDisabled: boolean; onUp: () => void; onRefresh: () => void;
  entries?: Entry[]; selected?: string; onSelect: (name: string) => void; onOpen: (entry: Entry) => void;
  empty: ReactNode; menu: (entry: Entry) => ReactNode;
}) {
  return <section aria-label={title} className="flex min-h-0 min-w-0 flex-col rounded-lg border">
    <header className="border-b px-3 py-2">
      <div className="flex items-center gap-1">
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-medium">{title}</h3>
        <Button variant="ghost" size="icon-sm" aria-label="Up one folder" disabled={upDisabled} onClick={onUp}><ArrowUp /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Refresh" onClick={onRefresh}><RefreshCw /></Button>
      </div>
      <nav aria-label="Folder" className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
        {crumbs.map((c, i) => <span key={c.target} className="flex items-center gap-1">
          {i > 0 && <span aria-hidden>›</span>}
          <button type="button" className={i === crumbs.length - 1 ? "text-foreground" : "hover:text-foreground"} onClick={() => onCrumb(c.target)}>{c.label}</button>
        </span>)}
      </nav>
    </header>
    <ul role="listbox" aria-label={`${title} files`} className="min-h-0 flex-1 overflow-y-auto p-1">
      {entries?.map(e => <li key={e.name} role="option" aria-selected={e.name === selected}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button type="button"
              className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted/60 aria-[current=true]:bg-accent/15"
              aria-current={e.name === selected}
              onClick={() => onSelect(e.name)} onContextMenu={() => onSelect(e.name)}
              onDoubleClick={() => e.dir && onOpen(e)}
              onKeyDown={k => k.key === "Enter" && e.dir && onOpen(e)}>
              <span className="min-w-0 flex-1 truncate">{e.name}{e.dir && <span className="text-muted-foreground">/</span>}</span>
              {!e.dir && e.size !== undefined && <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{formatSize(e.size)}</span>}
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>{menu(e)}</ContextMenuContent>
        </ContextMenu>
      </li>)}
      {entries?.length === 0 && <li className="px-3 py-6 text-center text-xs text-muted-foreground">{empty}</li>}
      {!entries && <li className="px-3 py-6 text-center text-xs text-muted-foreground">Loading…</li>}
    </ul>
  </section>;
}

function RenameDialog({ entry, onClose, onRename }: { entry: Entry; onClose: () => void; onRename: (name: string) => Promise<void> }) {
  const [name, setName] = useState(entry.name);
  const [error, setError] = useState("");
  const submit = async () => {
    setError("");
    try { await onRename(name.trim()); onClose(); } catch (e) { setError(message(e)); }
  };
  return <Dialog open onOpenChange={o => !o && onClose()}>
    <DialogContent className="w-[min(420px,92vw)] p-5" showClose={false}>
      <DialogTitle>Rename {entry.dir ? "folder" : "file"}</DialogTitle>
      <DialogDescription className="sr-only">A new name in the same folder.</DialogDescription>
      <form className="mt-4" onSubmit={e => { e.preventDefault(); void submit(); }}>
        <Input autoFocus value={name} onChange={e => setName(e.target.value)} aria-label="New name"
          onFocus={e => { const dot = entry.dir ? -1 : e.target.value.lastIndexOf("."); e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length); }} />
        {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!name.trim() || name.trim() === entry.name}>Rename</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
