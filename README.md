# Mob Desktop

<img src="public/logo.svg" alt="Mob" width="112" />

**Mob** is mob programming with your AI agents: they work on your office computer (via [mobd](https://github.com/xrdavies/mobd)), you steer from here. The name comes from [mob programming](https://en.wikipedia.org/wiki/Mob_programming), where a team works on one computer together: one at the keyboard, the others steering. In Mob the team is you and your agents.

This repository contains only the desktop app: macOS (Apple Silicon), Windows 10/11 and Linux (x64). The office daemon is developed
and released independently in [xrdavies/mobd](https://github.com/xrdavies/mobd).
iOS, Android and the product website live in separate repositories.

Desktop **mob** client: dispatch tasks to the office agent, follow what it does step by step, and watch the office desktop — task API from office **`mobd`** (v3) + its live desktop stream.

Design: [docs/ui.md](docs/ui.md) · Live view: [docs/desktop-streaming.md](docs/desktop-streaming.md) · Stack decision: [ADR 0009](docs/adr/0009-app-frontend-react.md) · API: [docs/mobd-v3.md](https://github.com/xrdavies/mobd/blob/main/docs/mobd-v3.md)

Planned, not implemented: [USB redirection](docs/usb-redirection.md), sharing selected local hardware with mobd through open-source USB/IP backends. The draft includes platform limits and links to mobd's Apple entitlement application.

Logo: **Screen Buddy** — editable SVG sources, app icons and regeneration commands are in the [brand guide](docs/brand/README.md).

Distribution: signed DMGs and Tauri updates use the public R2 download domain,
independently of the private source repository. See the [release setup](docs/releases.md).
Once configured, run `make release-patch` (or `release-minor`, `release-major`, or `make release VERSION=vX.Y.Z`)
from a clean `main` matching `origin/main`: it bumps the version in `package.json`, Tauri and Cargo files, asks for confirmation, commits it, tags that commit and pushes both. `make version` shows the current version. CI builds a draft Release; test its DMG,
then publish the stable Release on GitHub to distribute it through R2.

## Stack

- **Tauri 2** shell (`src-tauri/`): overlay title bar, sidebar vibrancy
- **React 19 + TypeScript 7 + Vite 8**, **Tailwind CSS v4**, shadcn/ui-style components on **Radix** (`src/components/ui`), **lucide** icons
- **TanStack Query** (health, queue, archived sessions) and **Zustand** (machines, layout, preferences — persisted in localStorage)
- `react-markdown` + GFM, **shiki** (core + JS regex engine, curated languages) for code blocks
- The live view: WebRTC in the webview (`RTCPeerConnection`), with a WebSocket + WebCodecs fallback

```text
src/
  api/          mobd v3 types and fetch helpers
  lib/chat.ts   conversation lifecycle (framework-free, tested)
  lib/timeline.ts  messages + activities → timeline items (tested)
  lib/stream.ts live desktop: WebRTC session, transport race, input (tested)
  lib/wsVideo.ts  WebSocket fallback decoded with WebCodecs (tested)
  hooks/        React bindings: chat, health/queue, global /events stream
  store/        app (persisted), composer, log
  components/   sidebar, timeline, composer, preview, settings, ui primitives
```

## Prerequisites

1. Platform tools: on macOS [Xcode Command Line Tools](https://developer.apple.com/xcode/); on Windows the MSVC build tools and WebView2 (preinstalled on Windows 11); on Linux the [Tauri system libraries](https://v2.tauri.app/start/prerequisites/#linux) plus `libdbus-1-dev`, and for the live view `gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav`
2. [Rust](https://rustup.rs/) stable (`rustup default stable`)
3. Node.js 24+ (npm) — tests run TypeScript directly through Node's type stripping
4. Office side reachable on LAN/VPN: `mobd` (API v3) with the `stream` feature, which streams the live desktop itself ([desktop streaming](https://github.com/xrdavies/mobd/blob/main/docs/desktop-streaming.md)); Screen Sharing is not needed

## Configure

Nothing to configure at build time. Machines are added by pasting the pairing link from `mobd link`. Manage machines (name, pairing, live view quality) in **Settings → Machines**, where **Test connection** shows the office readiness checks.

## Install & run

```bash
npm ci
npm run dev          # browser prototype at http://localhost:1420
npm run tauri dev    # desktop App (recommended on Mac)
npm run tauri build -- --target aarch64-apple-darwin  # production bundle
```

Checks: `npm test` (conversation lifecycle, timeline, pairing, SSE, live stream and input, migrations), `npm run typecheck`, `npm run build`; `make check` runs the tests, typecheck and release tests.

## Using the App

- **Files**: upload local files and download from the machine’s shared directory, with pause/continue, persistent partial transfers and SHA-256 verification. Choose local files and save locations with the system picker. [Transfer details](docs/file-transfers.md).

- **Sidebar:** conversations of the selected machine, live via mobd's `/events` (running spinner, queue position, failed dot). Right-click or `⋯` to rename (or double-click), pin, archive, delete. Archived conversations are in the collapsible group.
- **Timeline:** your prompts, the agent's replies (markdown), and its steps — screenshots, clicks, typing, shell commands, plans — as expandable cards; three or more consecutive steps fold into a group. Each turn ends with duration, tokens and model; failed turns offer **Retry**. Queued turns show their place in the desktop queue.
- **Questions from the agent:** when the agent needs a decision (`ask_user`) or wants approval before a risky action (`request_approval`), a card appears in the timeline with the options, a text box, or **Approve / Deny** with an optional note. The conversation shows a **?** badge in the sidebar, the window title shows the count, and a toast appears (Settings → Appearance can enable system notifications). The turn keeps the desktop while it waits; unanswered questions time out on the office computer (`MOBD_QUESTION_TIMEOUT`, default 30 min) and unanswered approvals count as denied.
- **Agent:** a new chat can use any agent the office computer has (Codex, Claude Code, Pi); pick it in the composer. A conversation keeps its agent; start a new chat to switch. Model and effort are remembered per agent, and Claude turns show their cost.
- **While the agent works:** with Codex (app-server mode) you can type in the composer and press ↵ to add to what it is doing, e.g. "also check the spam folder"; your message appears in the timeline and the agent picks it up in the same turn. **Stop** interrupts the turn. Replies stream in as they are written.
- **Composer:** ↵ send, ⇧↵ newline. Attach images (button, paste or drag-and-drop), pick model and reasoning effort (the models offered come from the machine's agent settings). The send button becomes **Stop** while the agent works.
- **Live view (right):** the office desktop streamed by mobd (⏻), or, when not connected, a snapshot refreshed every 4 s. Clicks by the agent flash at their position. Double-click or ⤢ expands it to fill the window (the green button gives macOS full screen); the expanded toolbar has View/Control, quality (Auto/High/Low), signal bars with kB/s, and Collapse. Resizing the window refits the stream without reconnecting. Below: the desktop queue and the current turn's steps.
- **Title bar:** machine status chip opens the readiness checks (agents, actuation, Accessibility, Screen Recording, display).
- **Shortcuts** (Ctrl instead of ⌘ on Windows and Linux): ⌘K command palette · ⌘N new chat · ⌘B sidebar · ⌘⇧B live view · ⌘⇧C expand and take control · ⌘, settings · ⌘1–9 switch conversation.
- **View / Control:** the panel only watches. To drive the office computer yourself, expand the view and switch **View | Control**, or press ⌘⇧C; your mouse, keyboard and scroll then go to the office computer, and `Esc` goes there too — switch back to **View** to use `Esc` for collapsing. Collapsing always returns to View. ⌘W and ⌘Q stay with the app. From Windows and Linux, Ctrl acts as ⌘ on the Mac (Ctrl+C copies there) and the Windows/Super key sends Control.
- **Transport:** WebRTC on the LAN or a tailnet. Where UDP cannot pass (Tailscale Funnel, an HTTPS gateway), the app falls back to mobd's WebSocket after 5 s and remembers that per machine (1 s next time); the readout shows which one is in use.
- **Auth:** every machine is paired (`mobd link`); the device credential is kept in the Keychain (macOS), Credential Manager (Windows) or the Secret Service keyring (Linux). If the system store is unavailable (e.g. headless Linux without Secret Service), mob falls back to an encrypted file under the app config directory — see [docs/credential-storage.md](docs/credential-storage.md).
- **Linux paste:** WebKitGTK 2.54.0–2.54.1 can SIGSEGV on native Ctrl+V when the clipboard is empty or one-shot ([WebKit bug 324466](https://bugs.webkit.org/show_bug.cgi?id=324466)). Settings → Machines pairing uses an OS clipboard read (and a **Paste** button) instead of the webview paste path; see [docs/ui.md](docs/ui.md).

Features follow mobd's `/health`: queue, uploads, model/effort, steering, session management, snapshots and the live view appear only when mobd reports API v3 and lists the feature.

### CORS note

The UI uses browser `fetch` / `EventSource` against the machine's mobd address. `mobd` allows `http://localhost:1420`, `http://127.0.0.1:1420`, `tauri://localhost`, and `http://tauri.localhost` by default. For another home-client origin, set `corsOrigins` in the office machine's `~/.mobd/config.json` to an array of allowed origins (replaces the defaults). Use the origin shown in the error, without a trailing slash; `localhost:1420` here refers to the client UI, even when the office API is on another machine.

After updating the office daemon, restart the installed `mobd`. Developers can use
`make restart` from their separate `mobd` checkout:

```bash
# Office machine
mobd restart
curl -i -H 'Origin: http://localhost:1420' http://127.0.0.1:8080/health
```

The response should include `Access-Control-Allow-Origin: http://localhost:1420`. Then retry Health in the home app; no client rebuild is needed for this server fix.

### Live view troubleshooting

If the live view cannot start, it shows mobd's reason (screen locked or asleep, Screen Recording missing, "Update mobd" for builds without `stream`) and the panel keeps showing `/screen` snapshots; task dispatch still works. Settings → Log records the transport, first-picture time and errors.

## Repository layout and commands

```text
src/            React frontend, API client and tests
src-tauri/      Rust shell, bundle configuration (tauri.conf.json + per-OS tauri.<os>.conf.json) and icons
public/         Browser assets
.github/        Desktop signing, Tauri updater and R2 publication
docs/           UI design, credential storage, live desktop, branding, releases, ADRs, postponed plans
```

Run commands from this repository root: `make install`, `make dev`, `make desktop`,
`make test`, `make build`, `make bundle`, `make check`, `make version`, `make release-patch` (`-minor`, `-major`).
No Go toolchain or sibling checkout is required to build the desktop app; a running
office daemon is required to dispatch tasks. mob and mobd are versioned and released
independently; they agree through the API version and features in `/health`.

## License

[MIT](LICENSE)
