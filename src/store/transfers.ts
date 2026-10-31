import { invoke } from "@tauri-apps/api/core";
import { Upload } from "tus-js-client";
import { create } from "zustand";
import { authFetch, responseProblem, UnauthorizedError } from "@/lib/auth";
import { FILE_CHUNK, checkFileRange, tusURL } from "@/lib/filesProtocol";
import { baseName, emptyFolders, encodeRemote, joinRemote } from "@/lib/filesPaths";
import { TusHttp } from "@/lib/tusHttp";

export interface RemoteFile { name: string; size: number; modified: string }
export interface RemoteFolder { name: string; modified: string }
export interface FileListing { directory: string; path?: string; maxUploadSize: number; files: RemoteFile[]; folders?: RemoteFolder[] }
export interface Transfer {
  id: string; machineId: string; base: string; kind: "upload" | "download";
  /** The file's own name; remotePath says where it is in mobd's shared folder. */
  name: string; size: number; sha256: string; bytes: number;
  status: "queued" | "paused" | "running" | "failed" | "done";
  remotePath?: string;
  /** Upload: the local file, staged when the transfer starts. Download: the folder it goes to. */
  source?: string; localDir?: string; localPath?: string;
  /** A folder upload: its files share a group and show as one row. */
  group?: string; groupName?: string;
  url?: string; uploaded?: boolean; etag?: string; message?: string; finishedAt?: number;
}
export interface LocalPlaces { home: string; downloads: string }
export interface LocalEntry { name: string; size: number; dir: boolean }
const storageKey = "mob.fileTransfers.v2";
const parallel = 2;
function restored(): Transfer[] {
  try {
    const tasks = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as Transfer[];
    return tasks.filter(t => /^[a-f0-9-]{32,36}$/.test(t.id) && typeof t.base === "string" && typeof t.machineId === "string")
      .map(t => ({ ...t, status: t.status === "running" || t.status === "queued" ? "paused" : t.status }));
  } catch { return []; }
}
export const useTransfers = create<{ tasks: Transfer[] }>(() => ({ tasks: restored() }));
function save(tasks: Transfer[]) {
  localStorage.setItem(storageKey, JSON.stringify(tasks));
  useTransfers.setState({ tasks });
}
function update(id: string, patch: Partial<Transfer>) {
  save(useTransfers.getState().tasks.map(t => t.id === id ? { ...t, ...patch } : t));
}
const running = new Map<string, { controller: AbortController; done: Promise<void> }>();

export async function listFiles(base: string, path = ""): Promise<FileListing> {
  const res = await authFetch(base, `${base}/files${path ? `?path=${encodeURIComponent(path)}` : ""}`);
  if (!res.ok) throw await responseProblem(res);
  return res.json();
}

async function remote(base: string, path: string, method: string, body?: unknown) {
  const res = await authFetch(base, `${base}${path}`, {
    method, ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  });
  if (!res.ok) throw await responseProblem(res);
}
export const renameRemote = (base: string, path: string, newName: string) => remote(base, `/files/${encodeRemote(path)}/rename`, "POST", { newName });
export const deleteRemote = (base: string, path: string) => remote(base, `/files/${encodeRemote(path)}`, "DELETE");

export const localPlaces = () => invoke<LocalPlaces>("local_places");
export const listLocal = (path: string) => invoke<LocalEntry[]>("local_list", { path });
export const revealLocal = (path: string) => invoke("local_reveal", { path });

function add(tasks: Transfer[]) {
  save([...useTransfers.getState().tasks, ...tasks]);
  pump();
}

/** Uploads a local file or folder into remoteDir of mobd's shared folder; a folder keeps its tree. */
export async function uploadLocal(machineId: string, base: string, local: { path: string; dir: boolean; size: number }, remoteDir: string) {
  const task = (source: string, remotePath: string, size: number, group?: Pick<Transfer, "group" | "groupName">): Transfer =>
    ({ id: crypto.randomUUID(), machineId, base, kind: "upload", name: baseName(remotePath), remotePath, source, size, sha256: "", bytes: 0, status: "queued", ...group });
  const path = local.path;
  if (!local.dir) {
    add([task(path, joinRemote(remoteDir, baseName(path)), local.size)]);
    return;
  }
  const walked = await invoke<{ files: { path: string; rel: string; size: number }[]; folders: string[] }>("local_walk", { path });
  for (const folder of emptyFolders(walked.folders, walked.files.map(f => f.rel))) {
    await remote(base, "/file-folders", "POST", { path: joinRemote(remoteDir, folder) });
  }
  const group = { group: crypto.randomUUID(), groupName: baseName(path) };
  add(walked.files.map(f => task(f.path, joinRemote(remoteDir, f.rel), f.size, group)));
}

/** Downloads a remote file into a local folder; the file appears there once it is verified. */
export function addDownload(machineId: string, base: string, remotePath: string, file: RemoteFile, localDir: string) {
  add([{ id: crypto.randomUUID(), machineId, base, remotePath, localDir, name: file.name, size: file.size, sha256: "", kind: "download", bytes: 0, status: "queued" }]);
}

async function uploadFile(task: Transfer, signal: AbortSignal) {
  // Older mobd takes only a file name: a path is sent only for a file inside a folder.
  const path = task.remotePath ?? task.name;
  const metadata: Record<string, string> = { filename: task.name, sha256: "" };
  if (path.includes("/")) metadata.relativePath = path;
  let url = task.url && tusURL(task.base, task.url);
  if (!task.sha256) {
    update(task.id, { message: "Preparing…" });
    const staged = await invoke<{ size: number; sha256: string }>("transfer_stage", { id: task.id, source: task.source });
    task = { ...task, size: staged.size, sha256: staged.sha256 };
    update(task.id, { size: staged.size, sha256: staged.sha256, message: undefined });
  }
  if (!task.uploaded) {
    if (await invoke<number>("transfer_size", { id: task.id }) !== task.size ||
        await invoke<string>("transfer_digest", { id: task.id }) !== task.sha256) {
      throw new Error("Local upload copy is missing or changed. Cancel and select the file again.");
    }
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const upload = new Upload(new Blob(), {
        endpoint: `${task.base}/file-uploads/`, uploadUrl: url,
        uploadSize: task.size, chunkSize: FILE_CHUNK, storeFingerprintForResuming: false,
        metadata: { ...metadata, sha256: task.sha256 },
        httpStack: new TusHttp(task.base), retryDelays: [0, 1000, 3000],
        onShouldRetry: e => !(e.causingError instanceof UnauthorizedError) &&
          (!e.originalResponse || e.originalResponse.getStatus() >= 500 || e.originalResponse.getStatus() === 409),
        fileReader: { openFile: async () => ({
          size: task.size, close() {},
          slice: async (start: number, end: number) => ({
            value: new Blob([await invoke<ArrayBuffer>("transfer_read", { id: task.id, offset: start, length: Math.min(end, task.size) - start })]),
            done: end >= task.size,
          }),
        }) },
        onUploadUrlAvailable: () => {
          url = tusURL(task.base, upload.url!);
          update(task.id, { url });
        },
        onChunkComplete: (_chunk, bytes) => update(task.id, { bytes }),
        onSuccess: () => { signal.removeEventListener("abort", abort); resolve(); },
        onError: e => { signal.removeEventListener("abort", abort); reject(e); },
      });
      const abort = () => { void upload.abort().then(() => reject(new DOMException("Paused", "AbortError")), reject); };
      signal.addEventListener("abort", abort, { once: true });
      upload.start();
    });
    update(task.id, { uploaded: true, url, bytes: task.size });
  }
  signal.throwIfAborted();
  update(task.id, { message: "Verifying upload…" });
  const res = await authFetch(task.base, `${tusURL(task.base, url!)}/complete`, { method: "POST", signal });
  if (!res.ok) throw await responseProblem(res);
  const result = await res.json() as { name: string; sha256: string; size: number };
  if (result.sha256 !== task.sha256 || result.size !== task.size) throw new Error("Upload verification failed");
  update(task.id, { remotePath: result.name, name: baseName(result.name), status: "done", message: undefined, finishedAt: Date.now() });
  await invoke("transfer_discard", { id: task.id });
}

async function downloadFile(task: Transfer, signal: AbortSignal) {
  const url = `${task.base}/files/${encodeRemote(task.remotePath ?? task.name)}`;
  let offset = await invoke<number>("transfer_size", { id: task.id });
  const head = await authFetch(task.base, url, { method: "HEAD", signal });
  if (!head.ok) throw await responseProblem(head);
  const size = Number(head.headers.get("Content-Length"));
  const etag = head.headers.get("ETag") ?? "";
  const sha256 = head.headers.get("X-Content-SHA256") ?? "";
  if (!Number.isSafeInteger(size) || size < 0 || !etag || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid file information from mobd");
  if ((task.etag && task.etag !== etag) || offset > size || (offset > 0 && !task.etag)) throw new Error("Remote file changed. Cancel and download the new version.");
  update(task.id, { size, etag, sha256, bytes: offset });
  while (offset < size) {
    signal.throwIfAborted();
    const end = Math.min(offset + FILE_CHUNK, size) - 1;
    const res = await authFetch(task.base, url, { headers: { Range: `bytes=${offset}-${end}`, "If-Match": etag }, signal });
    if (!res.ok) throw await responseProblem(res);
    checkFileRange(res.status, res.headers.get("Content-Range"), res.headers.get("ETag"), etag, offset, end, size);
    if (Number(res.headers.get("Content-Length")) !== end - offset + 1) throw new Error("Invalid download size");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length !== end - offset + 1) throw new Error("Incomplete download chunk; retry to continue");
    signal.throwIfAborted();
    await invoke("transfer_append", { id: task.id, offset, data: Array.from(bytes) });
    offset += bytes.length;
    update(task.id, { bytes: offset });
  }
  update(task.id, { message: "Verifying download…" });
  if (await invoke<string>("transfer_digest", { id: task.id }) !== sha256) throw new Error("Download checksum mismatch. Cancel and download again.");
  signal.throwIfAborted();
  if (!task.localDir) throw new Error("No folder to save the download in");
  const localPath = await invoke<string>("transfer_place", { id: task.id, dir: task.localDir, name: task.name });
  update(task.id, { status: "done", localPath, message: undefined, finishedAt: Date.now() });
}

/** Queues a paused or failed transfer; at most `parallel` run at a time. */
export function startTransfer(id: string) {
  const task = useTransfers.getState().tasks.find(t => t.id === id);
  if (!task || running.has(id) || task.status === "done") return;
  update(id, { status: "queued", message: undefined });
  pump();
}

function pump() {
  for (const task of useTransfers.getState().tasks) {
    if (running.size >= parallel) return;
    if (task.status === "queued" && !running.has(task.id)) run(task);
  }
}

function run(task: Transfer) {
  const id = task.id, controller = new AbortController();
  update(id, { status: "running", message: undefined });
  const done = (async () => {
    try {
      if (task.kind === "upload") await uploadFile(task, controller.signal);
      else await downloadFile(task, controller.signal);
    } catch (e) {
      const done = useTransfers.getState().tasks.find(t => t.id === id)?.status === "done";
      update(id, { status: done ? "done" : controller.signal.aborted ? "paused" : "failed", message: controller.signal.aborted ? undefined : String(e instanceof Error ? e.message : e) });
    } finally { running.delete(id); pump(); }
  })();
  running.set(id, { controller, done });
}

export function pauseTransfer(id: string) {
  const work = running.get(id);
  if (work) work.controller.abort();
  else if (useTransfers.getState().tasks.find(t => t.id === id)?.status === "queued") update(id, { status: "paused" });
}

/** Removes a finished transfer from the list. */
export function dismissTransfer(id: string) {
  save(useTransfers.getState().tasks.filter(t => t.id !== id || t.status !== "done"));
}

export async function cancelTransfer(id: string) {
  const work = running.get(id);
  work?.controller.abort();
  await work?.done;
  const task = useTransfers.getState().tasks.find(t => t.id === id);
  if (!task) return;
  if (task.kind === "upload" && task.url && task.status !== "done") {
    const res = await authFetch(task.base, tusURL(task.base, task.url), { method: "DELETE", headers: { "Tus-Resumable": "1.0.0" } });
    if (!res.ok && res.status !== 404 && res.status !== 410) throw await responseProblem(res);
  }
  await invoke("transfer_discard", { id });
  save(useTransfers.getState().tasks.filter(t => t.id !== id));
}
