# mob — UI design

**Product:** the home Mac **mob** App: dispatch tasks to the office agent, watch what it does, and monitor the office desktop.
**Stack:** Tauri 2 + React 19 + Tailwind v4 + shadcn/ui ([ADR 0009](adr/0009-app-frontend-react.md)); the live desktop is mobd's stream (WebRTC, WebSocket + WebCodecs fallback).
**Backend:** [mobd v3](https://github.com/xrdavies/mobd/blob/main/docs/mobd-v3.md). Features below name the API they depend on.
**Status:** implemented. Gaps are listed under "Not yet implemented".

The [agent collaboration draft](agent-collaboration.md) separately specifies
agent/framework terminology, reference selection and request UI; these proposed
additions are not implemented behavior described below.

---

## Design principles

1. **The agent's work is the content.** The center column is a timeline of what the agent *did* (screenshots, clicks, typing, commands, plans), with its replies in between. Debug logs never appear in the timeline.
2. **Calm, native, dense.** It should feel like a macOS app: inset traffic lights, a translucent sidebar, system font, 13–14 px UI text, restrained color. Accent color is used only for primary actions and running state.
3. **The desktop is always visible.** The live view is never more than one glance (thumbnail) or one double-click (fullscreen) away.
4. **State is explicit.** Every session row, task and machine shows whether it is queued, running, done, failed or offline, in the same visual language everywhere.
5. **Keyboard first.** ⌘K palette, ⌘N new chat, ↵ send, Esc to close or collapse, ⌘1–9 to switch sessions.

## Hard rules

- Three-column shell: sessions · timeline · preview. Connection settings live only in Settings.
- Human input is opt-in per use: the panel is always **view only**; only the expanded view has a **View | Control** switch, which starts on View and resets to View when the view collapses. Switching sends input over the open session's data channels (or the WebSocket); it does not reconnect.
- Auth is pairing only: paste the link from `mobd link`; the credential stays in the system keyring (Keychain / Credential Manager / Secret Service), with an automatic encrypted-file fallback when that store is unavailable ([credential-storage.md](credential-storage.md)). No accounts or sign-in.
- On Linux with WebKitGTK 2.54.0–2.54.1, native Ctrl+V can crash the process when the clipboard is empty or one-shot ([WebKit bug 324466](https://bugs.webkit.org/show_bug.cgi?id=324466)). The pairing field intercepts paste and reads via the OS clipboard API, and also offers a **Paste** button.
- Machines are first-class; each has its own `mobd` URL (added by pairing) and its own live view quality.

---

## Layout

```text
┌─●●●──────────────────────────────────────────────────────────────────────────────────┐
│      ⌕ Search  ⌘K           Office-A ● ready · queue 1          ◐  ⚙                 │  title bar (overlay)
├──────────────┬──────────────────────────────────────────┬────────────────────────────┤
│ ▾ Office-A ● │  Open Safari and find flights to Tokyo   │  LIVE ● viewOnly    ⤢  ⏻   │
│   ★ Weekly…  │  ───────────────────────────────────────  │ ┌────────────────────────┐ │
│   ◉ Flights  │  You · 2m                                │ │                        │ │
│     Expense… │  ┌──────────────────────────────────┐    │ │   office desktop       │ │
│     Report…  │  │ Open Safari and find flights …    │    │ │   (live thumbnail)     │ │
│ ▸ Office-B ○ │  └──────────────────────────────────┘    │ │        ⊕ last click    │ │
│              │  ▸ ✓ Opened Safari            open_app   │ └────────────────────────┘ │
│              │  ▸ ✓ Screenshot  [▢ thumb]    0.8s       │  1920×1080 · 24 fps        │
│              │  ▸ ✓ Click (412, 230)                    │                            │
│              │  ▸ ◌ Typing "Tokyo"…                     │  QUEUE                     │
│              │                                          │  ▸ Expense report  #1      │
│              │  mob · Codex                             │                            │
│              │  I found three options. The cheapest …   │  STEPS (this turn)         │
│              │  | Airline | Price |                     │  ✓ open_app                │
│              │                                          │  ✓ screenshot              │
│              │ ┌──────────────────────────────────────┐ │  ◌ type_text               │
│              │ │ Ask mob to do something…             │ │                            │
│ ＋ New chat   │ │ 📎  gpt-5.5 ▾  effort: high ▾   ⏎ ■ │ │                            │
│ ⚙ Settings   │ └──────────────────────────────────────┘ │                            │
└──────────────┴──────────────────────────────────────────┴────────────────────────────┘
```

| Region | Width | Contents |
| --- | --- | --- |
| Title bar | 44 px | Traffic lights (overlay), search / ⌘K, active machine status, theme toggle, settings |
| Sidebar | 248 px (collapsible ⌘B) | Machines → sessions tree, New chat, Settings |
| Timeline | flexible, content max 760 px centered | Session title, messages + activity cards, composer |
| Preview | 360 px (collapsible ⌘⇧B) | Live view, queue, steps of the current turn |

Planned: below 1100 px the preview collapses to a floating thumbnail at the bottom right of the timeline; below 800 px the sidebar becomes a drawer.

**Fullscreen preview:** double-click the live view (or ⤢) → the live view fills the window under a toolbar in the title bar row (machine, View/Control, signal bars, quality, Collapse) and a bottom-left overlay showing the current step ("Typing 'Tokyo'…"). Esc (in View) or double-click returns. The session is refitted with `resize`, not reconnected.

---

## Components

### Sidebar

- **Machine group:** name, status dot (green ready / amber degraded checks or needs pairing / grey offline), chevron. An unpaired machine shows "Needs pairing" and a link to Settings.
- **Session row:** title (one line, truncated), relative time ("2m"), state indicator: ◉ spinning ring while running, numbered badge while queued, red dot after failure. Pinned sessions show ★ and sort first.
  - Right click / `⋯`: Rename (inline edit), Pin/Unpin, Archive, Delete (confirm dialog). API: `PATCH`/`DELETE /sessions/{id}`.
  - "Archived" lives in a collapsible group at the bottom of each machine (`GET /sessions?archived=true`).
- Live updates come from `GET /events` (`session`, `session.deleted`, `task`). No polling.

### Timeline

Built by merging `messages` and `activities` from `GET /sessions/{id}`, sorted by time, then extended live from `/tasks/{id}/events`.

| Item | Design |
| --- | --- |
| **User message** | Right-aligned bubble, `bg-muted`, max 80% width, attachments as 64 px thumbnails above the text |
| **Assistant message** | No bubble. Avatar + "mob · Codex" label, markdown body (GFM tables, code blocks with shiki + copy button), hover actions: Copy, Retry turn |
| **Activity card** | Compact row: status icon (spinner / ✓ / ✕), icon per kind, title (`Click (412, 230)`), right-aligned meta (tool name, duration). Click to expand |
| ↳ `tool` | Expanded: arguments as a key/value list, text output in a mono block (collapsed after 12 lines), screenshot artifacts as a zoomable image (click → lightbox) |
| ↳ `command` | `$ command` in mono, output, exit code badge |
| ↳ `reasoning` | Muted italic "Thinking", collapsed by default, summary text when expanded |
| ↳ `plan` | Checklist with progress "2 / 5" |
| ↳ `file_change` | List of paths with added/modified/deleted badges |
| ↳ `notice` | Amber inline notice (Codex config warnings, etc.) |
| **Activity group** | Three or more consecutive activities fold into "▸ 7 steps · 42 s" with the latest step visible. Expanding shows all |
| **Turn footer** | After a finished turn: status pill (only when failed/cancelled), duration, tokens (`usage`), model. A failed turn shows the error message and a Retry button |
| **Queued turn** | Ghost card "Waiting for the desktop · #2 in queue", with a Cancel link |

Scrolling: stick to the bottom while the user is at the bottom. Otherwise show a "↓ New activity" pill.
Empty session: centered greeting + example prompt cards ("Open a website", "Check the screen", "Summarize mail", …).

### Composer

- Auto-growing textarea (1–10 rows), placeholder "Ask mob to do something on Office-A…".
- Toolbar: agent picker (new chats); 📎 attach images (picker, drag-and-drop, paste) → `POST /uploads`; **model** dropdown (`health.models`, plus "Default"); **effort** dropdown (`health.efforts`); send ⏎ / stop ■ (stop = `POST /tasks/{id}/cancel`).
- ↵ sends, ⇧↵ adds a newline, IME composition is respected. Send is disabled while the session has a non-terminal turn. The input is kept so the user can edit the next prompt.
- Agent (runner) is picked per new chat and remembered per machine; model and effort are remembered per machine and agent.

### Preview panel

- **Live view:** `<video>` (WebRTC) or `<canvas>` (WebSocket), aspect-fit, rounded 10 px, header with `LIVE ●` (green connected / grey idle / red error), `View only` badge, quality, connect/disconnect ⏻, expand ⤢. Shows kB/s; size, fps, transport and network in a tooltip.
- **Snapshot fallback:** when the live view is off, show `GET /screen` at the panel width in device pixels, refreshed every 4 s with `If-None-Match`, labelled "Snapshot · 12:04:31", or mobd's reason when unavailable.
- **Click marker:** when a `click` activity completes, an animated ring is drawn at its point coordinates over the live view, scaled from desktop points to canvas size.
- **Queue:** `GET /queue` + `queue` events. Each queued task shows its session title and position. Click to jump to it.
- **Steps:** a compact list of the current turn's activities, synced with the timeline. Click to scroll the timeline to that card.

### Title bar & ⌘K

- Machine status chip: `Office-A ● ready`. Click opens a popover listing `health.checks` with ✓/✕ and fix hints ("Grant Accessibility to Terminal in System Settings → Privacy").
- ⌘K command palette: new chat, connect/disconnect live view, toggle sidebar, show/hide desktop, light/dark theme, settings, open a session (search titles), switch machine.

### Settings (dialog, 720×560)

| Tab | Contents |
| --- | --- |
| Machines | Info callout when credentials use the encrypted-file fallback; list + form (name, pairing, live view quality); **Test connection** runs `/health` and shows the checks list |
| Appearance | Theme (system / light / dark), system notifications for agent questions |
| Log | Raw SSE/debug viewer (filter, pause, clear, copy). Monospace |
| About | App version, mobd `apiVersion`, links |

### First run / setup

With no machines: a centered card "Connect your office computer" asking for the pairing link printed by `mobd link`. Pairing creates the machine; the health popover then shows the checks. Failed checks are explained in [office-smoke-checklist.md](https://github.com/xrdavies/mobd/blob/main/docs/office-smoke-checklist.md) steps.

---

## Visual language

**Tokens** (CSS variables, light / dark):

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--background` | `#ffffff` | `#0b0c0f` | Window |
| `--sidebar` | `rgba(246,246,248,.8)` | `rgba(20,21,26,.72)` | Translucent sidebar (vibrancy) |
| `--panel` | `#f7f7f9` | `#121318` | Preview panel, cards |
| `--muted` | `#f1f1f4` | `#1a1c22` | User bubble, inputs |
| `--border` | `#e6e6ea` | `#24262e` | Hairlines (1 px) |
| `--foreground` | `#111216` | `#ececf1` | Text |
| `--muted-foreground` | `#6b6f7b` | `#8a8f9c` | Meta text |
| `--accent` | `#4f46e5` | `#8b85ff` | Primary action, running |
| `--success` / `--warning` / `--danger` | `#16a34a` / `#d97706` / `#dc2626` | `#22c55e` / `#f59e0b` / `#f87171` | Status |

- **Type:** system UI (`-apple-system`, SF Pro). 13 px UI, 14.5 px message body, line height 1.55. Mono: SF Mono / JetBrains Mono 12.5 px.
- **Radius:** 6 px controls, 10 px cards, 14 px composer and bubbles.
- **Spacing:** 4 px grid. Timeline items 12 px apart; activity rows 4 px apart within a group.
- **Motion:** 120–180 ms ease-out for expand/collapse and hover. Running status uses a spinning ring (no pulsing backgrounds). Respect `prefers-reduced-motion`.
- **Status language (everywhere):** queued = grey numbered badge, running = accent spinning ring, succeeded = no badge (silence is success), failed = red ✕, cancelled = grey ⊘.
- **Icons (lucide):** `MousePointerClick` click, `Keyboard` type/key, `Camera` screenshot, `AppWindow` open_app/list_windows, `TerminalSquare` command, `Brain` reasoning, `ListChecks` plan, `FileDiff` file changes, `Globe` web search, `TriangleAlert` notice.

---

## Code structure

```text
src/
  main.tsx, App.tsx        React root, providers, shortcuts, first-run and pairing screens
  api/                     mobd client: types (mirror mobd-v3.md), fetchers, feature checks
  store/                   Zustand: machines, selection, layout, preferences; migrations; updates
  lib/                     Framework-free, unit-tested: chat, timeline, stream, wsVideo, liveInput, pairing, sse
  hooks/                   React bindings: chat, health/queue, /events, question alerts
  components/ui/           shadcn primitives
  components/              TitleBar, CommandPalette, UpdateNotice, sidebar/, timeline/, composer/, preview/, settings/
```

## Not yet implemented

- Resizable columns (sidebar and preview have fixed widths) and the responsive drawer / floating-thumbnail layouts below 1100 px.
- Density and font-size settings.
- A machine `⋯` menu in the sidebar (Edit, Reconnect, Remove); machines are managed in Settings.

Update this doc when the IA changes.

## References

- [mobd API](https://github.com/xrdavies/mobd/blob/main/docs/mobd-v3.md) · [ADR 0009](adr/0009-app-frontend-react.md) · [desktop-streaming.md](https://github.com/xrdavies/mobd/blob/main/docs/desktop-streaming.md) · [Desktop README](../README.md)
