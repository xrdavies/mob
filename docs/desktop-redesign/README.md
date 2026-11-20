# Mob Desktop redesign

Status: design settled 2026-11-20; not implemented yet. Mockup: [mockup.html](mockup.html) (open it in a browser;
the buttons along the top jump to each screen, everything in the window is clickable). Sample data only.

This document has three parts: [the feature](#part-1-feature) (what and why), [the decisions](#part-2-decisions)
(options considered, choice, reason) and [the design](#part-3-design) (how it looks and behaves).

## Part 1: Feature

### Problem

Mob Desktop grew one feature at a time. The result works but does not read as one product:

- Machines live in a switcher-like sidebar and a Settings page that mixes mobd's service, paired devices, the
  generic machine form and the agents in one long column.
- Questions and approvals that need the user are scattered across conversations.
- The side panel is built around the live desktop; for this computer it falls back to a queue and steps.
- Search and "ask an agent" are separate or missing; emoji, text buttons and explanatory hint lines make it feel
  less like a professional tool.
- The brand (Screen Buddy) barely appears.

### What the redesign does

**A chat-first, native-Mac window where every computer is always in view and anything that needs the user is one
click away.** Same features as today, reorganized; nothing is removed.

- Sidebar: the Mob brand, **Search or ask ⌘K**, **Needs you**, and every computer with its recent conversations.
- Conversation: the reply with its steps folded inline, approval cards, composer with attach and @mention.
- Right panel: the other computer's screen (asleep until clicked), the conversation's Activity, Details folded.
- Settings: app pages (General, Appearance, Notifications) and one page per computer with tabs.

### Who it is for

Developers first, without shutting out general computer-use work (booking, reports, apps): the same window serves
"fix the build" on this computer and "book a flight" on the office Mac.

### User stories

1. I see all my computers and what each is doing without switching.
2. When an agent asks me something on any computer, **Needs you** shows it with a count; I approve or deny there.
3. I press ⌘K and either find a conversation or start a task on any computer from the same field.
4. I unfold a reply to see each command, file edit, screenshot and agent request behind it.
5. On another computer's conversation, I click the dimmed screen to watch live, take control, then release.
6. I change an agent's model, permissions or program path in Settings → the computer → Agents.
7. I pair my phone from Settings → This computer → Devices & access.

### Scope

In scope: layout, navigation, the right panel, Settings structure and contents, iconography, copy rules,
light/dark themes, brand placement.

Not in scope: new mobd features (everything shown uses today's APIs, see [Part 3](#mobd-and-api)), the phone apps
(the language is meant to carry over later), the All-agents board (see D10).

### Platforms

macOS first (window chrome, Keychain, permissions as shown). Linux uses the same layout; the macOS-only parts
(permissions list, menu bar, Keychain wording) adapt. Windows Desktop shows other computers only until mobd runs
there (mobd [docs/mob-desktop-local-mobd.md](https://github.com/xrdavies/mobd/blob/main/docs/mob-desktop-local-mobd.md)).

## Part 2: Decisions

### D1. Chat-first ("Conversation") as the base

- **Options:** (A) chat-first, one conversation at a time; (B) a board of every agent on every computer, dense and
  keyboard-first; (C) each computer as a workspace with a hero composer or its live screen.
- **Choice:** A, taking B's Needs you inbox and ⌘K, and C's brand use.
- **Reason:** what developers expect from agent apps, easiest for non-developers, matches the phone apps, and
  reshapes today's code instead of replacing it.

### D2. Every computer listed in the sidebar, no switcher

- **Reason:** people with several computers need to see them all and their state; a switcher hides them behind a
  click. Each computer folds; offline ones stay listed, folded. Hovering a computer shows ＋ for a new chat there.

### D3. One ⌘K for search, asking an agent and commands

- **Options:** separate search field and a global "ask" bar; one field.
- **Choice:** one field at the top of the sidebar. Enter asks the selected agent on the selected computer; ⌘1–9
  picks the computer, Tab the agent; matching conversations and commands are listed below.

### D4. Needs you is first-class

- **Choice:** a sidebar entry with a count, opening a list of every waiting question and approval across
  computers, answered in place (also A / D). Counts also show per computer and per conversation.
- **Reason:** waiting agents are the most time-sensitive thing in the app and were only visible inside a chat.

### D5. Right panel is about what happened, not code

- **Options considered and dropped:** code changes/diff tab (not every conversation is about code, and people do
  not review diffs here); a Progress tab with plan and results (Activity covers it); an "In this conversation"
  section (participants moved to the title line); activity filters.
- **Choice:** Screen (other computers only) on top, Activity timeline, Details (computer, folder, model, time,
  usage, ID) folded at the bottom for advanced users.

### D6. The screen sleeps until touched

- **Choice:** the screen shows the last picture dimmed with "Asleep · click to wake". A click starts the live view;
  it sleeps again after 2 minutes without activity or when the conversation is left. **Take control** is a button
  on the live screen; control shows a purple border and a "You're in control · Release (Esc)" bar. Sound,
  own window and sleep are icon buttons on the screen.
- **Reason:** saves bandwidth, matches how a sleeping computer behaves, and avoids a tab or mode switch.
- No screen for this computer: the user is sitting at it.

### D7. Steps stay inline in replies

- **Choice:** keep today's folded "Worked for … · …" line; unfolding lists each step with icon, what it did,
  result and duration: command (exit status, failing output excerpt), file edit (+/−), agent request and answer,
  screen actions with screenshot thumbnails. Folded by default (Appearance option).
- Steps are per reply; Activity is the whole conversation.

### D8. This computer is always there

- **Choice:** Add a computer goes straight to pasting a `mobd link`; it never offers "This computer". This computer
  has no Remove; its Service tab has Stop and **Uninstall mobd** (keeps `~/.mobd`, the computer stays listed as
  "Not set up"). Other computers keep Remove, which also unpairs this app there.

### D9. Professional language: icons, no emoji, few hints

- **Choice:** one line-icon set (Lucide style) for everything; no emoji in the product. Icon buttons with tooltips
  for secondary actions (rename, choose folder, refresh, copy, open, restart, stop); text for primary and
  destructive actions. Status marks ◆ ✓ ✕ are typographic shapes.
- **Copy rule: show state, don't explain it.** A hint stays only if it shows state, prevents a mistake, or says
  how to fix something.

### D11. No new mobd fields for live status in the sidebar

- **Choice:** running conversations show "Working" in the sidebar; the current step appears in the open
  conversation (steps, Activity). Considered: a latest-step field on every session summary; dropped.
- **Reason:** today's Activity already covers it; the sidebar line is not worth a protocol change.

### D12. Maintenance from the app, not from agents

- **Choice:** config changes, restart and upgrade of any computer are done by the user in Settings, through mobd's
  remote maintenance. Agents get no tools for it (mobd remote-maintenance D2).

### D10. Later, not now

- An optional "All agents" board (Solution B) once people run many agents at once.
- Applying the language to the iPhone and Android apps.
- No Brand section in Appearance: the app icon follows the theme; Screen Buddy in empty screens is not a setting.

## Part 3: Design

### Window

| Area | Contents |
| --- | --- |
| Sidebar (272 px) | Window buttons, Screen Buddy + "Mob", hide sidebar, new chat · **Search or ask an agent… ⌘K** · **Needs you** (count) · **Computers** (＋ add): each with icon, name, status dot, needs-you count, its 3 recent conversations (agent avatar, title, status line), "Show N more" · Settings |
| Toolbar | Conversation title; agent, @handle, "with @others", computer · "Agent is using the screen" pill (this computer) · side panel toggle · ⋯ menu (Rename, Pin, Archive, Hide side panel, Stop the agent, Delete) |
| Conversation | User messages right; replies headed by agent and model, folded steps, text; approval cards (amber) with primary, secondary and Reply / Look at the screen |
| Composer | Agent, model · effort, attach (paperclip), mention (@), send |
| Right panel (328 px) | Screen (other computers), Activity (timeline with time and agent avatar), Details (folded) |

### Status vocabulary

Working (purple spinner) · Needs you (amber ◆) · Queued (dashed circle) · Done (green ✓) · Failed (red ✕). Shape
and color together. Words: Computer (not machine), This computer, Agent with @handle, Conversation, Needs you.

### Settings

| Page | Contents |
| --- | --- |
| General | About card (logo, version, check for updates) · Startup (open at login, menu bar) · Updates (automatic, channel) · Conversations (saved copies size + clear, credentials store) · Keyboard (shortcuts, editable) · Help (app log, What is Mob?, licenses) |
| Appearance | Theme (System / Light / Dark) · Layout (density, text size, conversations per computer, agent steps folded, side panel) |
| Notifications | Allow · Tell me when (needs you, finished, failed, agent uses this screen, new device pairs) · Per computer (Everything / Only when it needs me) · Delivery (sound, Dock badge, only in background) |
| This computer | **General** (name, agents' folder, summaries of the other tabs) · **Agents** · **Service** (mobd status, restart, stop, start at login, version, local and remote addresses, logs, program and data paths, Uninstall) · **Devices & access** (paired devices with Remove, Pair a phone or computer with QR and link, macOS permissions with Allow…) |
| Other computer | **General** (name, status, "shown there as", Remove) · **Agents** · **Connection** (addresses with the one in use, add address, Test connection with last results, screen quality and sound, shared folder) |
| Agents tab | List (avatar, model · effort · permission mode, Ready / Not signed in, on/off) · default for new chats · agents can ask each other. Agent page: model, effort, handle, permissions (ask before tools / run without asking), program path, which Claude settings it loads, check |

Settings is a sheet: app pages and computers in the left column, "Add a computer" at the end of the list.

### Visual language

- Brand colors from Screen Buddy: primary `#6559E8` (replaces today's indigo `#4f46e5`), `#8B85FF` on dark,
  mint `#B8ECCC` for the agent's cursor and presence, ink `#282347`.
- System font, 11/12/13/15/17 px; 4 px grid; radius 6 · 10 · 14; grouped rows in bordered lists for settings.
- Light and dark from the same tokens ([src/index.css](../../src/index.css) gets the new values).
- Screen Buddy: sidebar header, About card, welcome and empty or all-done states.

### Mapping from today's UI

| Today | Redesign |
| --- | --- |
| Sidebar machine groups | Computers section, always expanded state per computer, needs-you counts |
| Command palette | ⌘K field in the sidebar, adds "Ask an agent" |
| PreviewPanel (live view, queue, steps) / ActivityPanel | Right panel: Screen (sleeping), Activity, Details |
| Live view View/Control switch | Click to wake; Take control button; control bar with Release |
| Files button (other computers) | Unchanged in function; in the conversation menu / computer Connection tab |
| Settings → Machines (one long page) | Per-computer tabs; LocalSection split into Service and Devices & access |
| Appearance + notifications in one tab | Separate Appearance and Notifications pages |
| Question cards in the timeline | Unchanged, plus the Needs you list |

### mobd and API

Most of the redesign uses APIs mobd has today:

| Part | mobd source |
| --- | --- |
| Sidebar status lines, Needs you | `/events` session summaries (`status`, `waiting`), one stream per computer. Running conversations show "Working"; the current step is shown only in the open conversation (no new field, D11) |
| Steps in replies, Activity | Task activities (`command`, `exitCode`, `text`, `changes`, `images`, times) |
| Details | Task `model`, `effort`, `usage` (tokens, `costUsd`), times; `/health` `workdir` / `claudeWorkdir` |
| Agents tab (read) | `/health` `agents` (state, enabled, `bin`, `version`) and `GET /settings` |
| Agents tab (models, defaults, permissions) | `PUT /settings`, applies immediately |
| Agents tab (enable, program, settings source), working folder | mobd [remote maintenance](https://github.com/xrdavies/mobd/blob/main/docs/remote-maintenance.md): `PUT /config`, then **Restart to apply** |
| Service tab: restart, update | Remote maintenance operations (`POST /maintenance`, same code as `mobd upgrade`); Apply and Update are enabled only while no task runs |
| Service tab: stop, start at login, logs, uninstall (this computer) | Control socket and `mobd` commands |
| Devices & access | Control socket `/clients`, `/permissions`, `/invitations`; `DELETE /pair` |
| Screen | `GET /screen` (last picture), stream endpoints (live, control) |

Until mobd ships remote maintenance, the Agents tab's startup settings are editable for this computer only (Desktop
edits `config.json` and restarts) and read-only for other computers; Update uses Desktop's own installer for this
computer. App-side only: per-computer notification levels, conversation totals, screen sleep timing. Later: "From
anywhere" setup from Desktop (wraps `mobd remote setup`).

### Build order

1. Tokens, icon set, buttons (brand color, Lucide icons, icon-button style).
2. Sidebar: computers list, ⌘K field, Needs you list.
3. Conversation: inline steps, approval cards, composer, ⋯ menu, title line with participants.
4. Right panel: sleeping screen, Activity, Details.
5. Settings sheet: app pages, per-computer tabs, agent page.
6. Copy pass (D9), light and dark check, keyboard paths.

Each step ships on its own; the app stays usable between steps.

### Acceptance

1. Every paired computer is visible in the sidebar with its state; offline ones folded.
2. A question or approval on any computer appears in Needs you with a count and can be answered there.
3. ⌘K finds conversations and starts a task on a chosen computer and agent.
4. Unfolding a reply shows its steps (commands with exit status, edits, agent requests, screen actions).
5. Another computer's screen is asleep until clicked, sleeps again after 2 minutes idle; control has a visible state
   and Esc releases it. No screen for this computer.
6. Settings shows General, Appearance, Notifications and per-computer tabs as in the table above.
7. No emoji in the UI; secondary actions are icon buttons with tooltips.
8. Light and dark themes both pass a contrast check on text and status colors.
