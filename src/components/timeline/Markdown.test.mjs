import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

// Load the actual TSX through the app's Vite config, then click its rendered DOM.
const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost:1420" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "HTMLInputElement"]) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { mockIPC, clearMocks } = await import("@tauri-apps/api/mocks");
const { Markdown } = await vite.ssrLoadModule("/src/components/timeline/Markdown.tsx");
let root, calls, clipboard;

const apple = "https://developer.apple.com/documentation/Xcode/running-your-app-on-simulated-or-physical-devices";
const log = "/Users/m4003/dev/github/xrdavies/build-results/mob-ios-build-check.log";

async function render(text, handler = () => undefined, desktop = true) {
  calls = [];
  clipboard = [];
  globalThis.isTauri = desktop;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => clipboard.push(text) } });
  mockIPC((command, args) => { calls.push({ command, args }); return handler(command, args); });
  root = createRoot(document.getElementById("root"));
  await act(async () => root.render(createElement(Markdown, { text })));
}
async function click(el) {
  assert.ok(el, "click target exists");
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () => el.dispatchEvent(event));
  return event;
}
const button = (label) => [...document.querySelectorAll("button")].find((el) => el.textContent === label);
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = undefined;
  clearMocks();
  delete globalThis.isTauri;
});
// Node isolates test files in separate processes. Keep window alive for React's deferred
// cleanup (including the existing code-copy timer) until that process exits.
after(async () => { await vite.close(); dom.window.close(); });

test("issue 2: clicking the Apple link dispatches the full URL to the system browser", async () => {
  await render(`[Apple 真机运行说明](${apple})`);
  assert.equal((await click(document.querySelector("a"))).defaultPrevented, true);
  assert.deepEqual(calls, [{ command: "plugin:opener|open_url", args: { url: apple, with: undefined } }]);
});

test("HTTP links and URL queries retain their destination", async () => {
  const url = "http://example.com:8080/log?name=a%20b&line=12#result";
  await render(`[Page](${url})`);
  await click(document.querySelector("a"));
  assert.deepEqual(calls, [{ command: "plugin:opener|open_url", args: { url, with: undefined } }]);
});

test("reply table links open on the client without contacting the remote machine", async (context) => {
  const network = context.mock.method(globalThis, "fetch", () => {
    throw Error("Remote machine is unavailable");
  });
  const projects = [
    ["Jolt Physics", "https://github.com/jrouwe/JoltPhysics"],
    ["Terrain3D", "https://github.com/TokisanGames/Terrain3D"],
    ["Material Maker", "https://github.com/RodZill4/material-maker"],
  ];
  await render(`| 项目 | 主要用途 |\n| --- | --- |\n${projects.map(([name, url]) => `| [${name}](${url}) | 游戏开发 |`).join("\n")}`);
  const links = [...document.querySelectorAll("td a")];
  assert.equal(links.length, projects.length);
  for (const link of links) {
    assert.equal((await click(link)).defaultPrevented, true);
  }
  assert.deepEqual(calls, projects.map(([, url]) => ({ command: "plugin:opener|open_url", args: { url, with: undefined } })));
  assert.equal(network.mock.callCount(), 0);
});

test("browser failure is visible and a successful retry clears it", async () => {
  let failed = true;
  await render(`[Apple](${apple})`, () => { if (failed) throw Error("No default browser"); });
  await click(document.querySelector("a"));
  assert.match(document.querySelector('[role="alert"]').textContent, /No default browser/);
  failed = false;
  await click(document.querySelector("a"));
  assert.equal(document.querySelector('[role="alert"]'), null);
});

// Observe the component's decision without allowing jsdom to navigate.
async function nativeNavigation(link) {
  let prevented;
  document.addEventListener("click", (e) => { prevented = e.defaultPrevented; e.preventDefault(); }, { once: true });
  await click(link);
  return prevented;
}

test("browser mode retains normal web navigation", async () => {
  await render(`[Apple](${apple})`, undefined, false);
  const link = document.querySelector("a");
  assert.equal(link.getAttribute("href"), apple);
  assert.equal(link.target, "_blank");
  assert.equal(await nativeNavigation(link), false);
  assert.deepEqual(calls, []);
});

test("file and other non-web links retain default Markdown behavior without native calls or dialogs", async () => {
  const hrefs = [log, `tauri://localhost${log}`, `file://${log}`, "C:/Users/me/log.txt", "docs/build.log", "#section", "mailto:person@example.com", "javascript:alert(1)", "https://user:password@example.com/page", "https://[bad"];
  for (const href of hrefs) {
    await render(`[Link](${href})`);
    assert.equal(await nativeNavigation(document.querySelector("a")), false, href);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.deepEqual(calls, [], href);
    await act(async () => root.unmount());
    root = undefined;
    clearMocks();
  }
});

test("default URL filtering is preserved and code copy still works", async () => {
  await render('[Bad](javascript:alert(1))\n\n```unknown\nsample\n```');
  assert.equal(document.querySelector("a").getAttribute("href"), "");
  await click(button("Copy"));
  assert.deepEqual(clipboard, ["sample"]);
  assert.deepEqual(calls, []);
});
