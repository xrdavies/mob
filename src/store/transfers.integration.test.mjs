import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFile, writeFile, mkdir, mkdtemp, rm, stat, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

test("desktop transfer store resumes uploads and downloads against mobd", { skip: !process.env.MOB_FILE_TEST_FIXTURE, timeout: 120000 }, async () => {
  const { url: base, token } = JSON.parse(await readFile(process.env.MOB_FILE_TEST_FIXTURE, "utf8"));
  const dir = await mkdtemp(join(tmpdir(), "mob-files-desktop-"));
  const values = new Map();
  globalThis.localStorage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
  const sha = bytes => createHash("sha256").update(bytes).digest("hex");
  const saved = await mkdtemp(join(tmpdir(), "mob-files-saved-"));
  globalThis.transferTestInvoke = async (command, { id, offset, length, data, dir: to, name, source } = {}) => {
    const path = id ? join(dir, id) : "";
    switch (command) {
      case "transfer_size": await appendFile(path, Buffer.alloc(0)); return (await stat(path)).size;
      case "transfer_read": { const b = (await readFile(path)).subarray(offset, offset + length); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
      case "transfer_append": assert.equal((await stat(path)).size, offset); await appendFile(path, Buffer.from(data)); return;
      case "transfer_digest": return sha(await readFile(path));
      case "transfer_discard": await rm(path, { force: true }); return;
      case "transfer_stage": { const b = await readFile(source); await writeFile(path, b); return { name: source.split("/").pop(), size: b.length, sha256: sha(b) }; }
      case "transfer_place": { const target = join(to, name); await writeFile(target, await readFile(path), { flag: "wx" }); await rm(path); return target; }
      case "local_walk": return globalThis.transferTestWalk;
      default: throw new Error(command);
    }
  };
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === "@tauri-apps/api/core") return { url: "data:text/javascript,export const invoke = (...args) => globalThis.transferTestInvoke(...args)", shortCircuit: true };
    if (specifier.startsWith("@/")) return { url: new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, shortCircuit: true };
    return next(specifier, context);
  } });
  try {
    const { configureAuth } = await import("../lib/auth.ts");
    configureAuth({ token: () => token });
    let store = await import("./transfers.ts");
    const content = Buffer.alloc(9 * 1024 * 1024 + 17);
    for (let i = 0; i < content.length; i++) content[i] = i % 251;
    const id = randomUUID();
    const name = `desktop 报告 ${id}.bin`;
    await writeFile(join(dir, id), content);
    store.useTransfers.setState({ tasks: [{ id, base, machineId: "fixture", kind: "upload", name, size: content.length, sha256: sha(content), bytes: 0, status: "paused" }] });
    async function waitState(id, state) {
      for (let n = 0; n < 1000; n++) {
        const task = store.useTransfers.getState().tasks.find(t => t.id === id);
        if (task?.status === state) return task;
        assert.notEqual(task?.status, "failed", task?.message);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail(`transfer did not become ${state}`);
    }
    let unsubscribe = store.useTransfers.subscribe(({ tasks }) => {
      const task = tasks.find(t => t.id === id);
      if (task?.bytes > 0 && task.status === "running") store.pauseTransfer(id);
    });
    store.startTransfer(id);
    const paused = await waitState(id, "paused");
    unsubscribe();
    assert(paused.bytes > 0 && paused.bytes < content.length);
    assert(paused.url);
    assert(!values.get("mob.fileTransfers.v2").includes(token));
    store = await import("./transfers.ts?upload-restart");
    store.startTransfer(id);
    const uploaded = await waitState(id, "done");
    const listing = await store.listFiles(base);
    assert(listing.files.some(f => f.name === uploaded.name && f.size === content.length));
    store.addDownload("fixture", base, uploaded.remotePath, listing.files.find(f => f.name === uploaded.name), saved);
    const download = store.useTransfers.getState().tasks.find(t => t.kind === "download");
    unsubscribe = store.useTransfers.subscribe(({ tasks }) => {
      const task = tasks.find(t => t.id === download.id);
      if (task?.bytes > 0 && task.status === "running") store.pauseTransfer(download.id);
    });
    const partial = await waitState(download.id, "paused");
    unsubscribe();
    assert(partial.bytes > 0 && partial.bytes < content.length);
    store = await import("./transfers.ts?download-restart");
    store.startTransfer(download.id);
    const finished = await waitState(download.id, "done");
    assert.equal(finished.localPath, join(saved, uploaded.name));
    assert.deepEqual(await readFile(finished.localPath), content);
    store.dismissTransfer(download.id);
    assert(!store.useTransfers.getState().tasks.some(t => t.id === download.id));

    // A folder upload keeps its tree, empty folders included; a nested file downloads by its path.
    const source = await mkdtemp(join(tmpdir(), "mob-files-folder-"));
    const top = `项目 ${id}`;
    await writeFile(join(source, "a.txt"), "alpha");
    await writeFile(join(source, "b.bin"), content.subarray(0, 5 * 1024 * 1024 + 3));
    globalThis.transferTestWalk = {
      folders: [top, `${top}/src`, `${top}/empty`],
      files: [{ path: join(source, "a.txt"), rel: `${top}/a.txt`, size: 5 }, { path: join(source, "b.bin"), rel: `${top}/src/b.bin`, size: 5 * 1024 * 1024 + 3 }],
    };
    if ((await store.listFiles(base)).folders) {
      await store.uploadLocal("fixture", base, { path: join(source, top), dir: true, size: 0 }, "");
      const group = store.useTransfers.getState().tasks.filter(t => t.groupName === top);
      assert.equal(group.length, 2);
      for (const t of group) assert((await waitState(t.id, "done")).remotePath.startsWith(`${top}/`));
      const inside = await store.listFiles(base, top);
      assert.deepEqual(inside.folders.map(f => f.name).sort(), ["empty", "src"]);
      assert.deepEqual(inside.files.map(f => f.name), ["a.txt"]);
      const nested = (await store.listFiles(base, `${top}/src`)).files[0];
      store.addDownload("fixture", base, `${top}/src/b.bin`, nested, saved);
      const got = await waitState(store.useTransfers.getState().tasks.find(t => t.kind === "download").id, "done");
      assert.deepEqual(await readFile(got.localPath), await readFile(join(source, "b.bin")));
    } else console.log("mobd without fileFolders: folder upload not tested");
    await rm(source, { recursive: true, force: true });
  } finally {
    hooks.deregister();
    await rm(dir, { recursive: true, force: true });
    await rm(saved, { recursive: true, force: true });
    delete globalThis.transferTestInvoke;
  }
});
