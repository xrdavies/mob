# Conversation history: local copy and paging (desktop)

Status: implemented on `feat/conversation-history`

The [agent collaboration draft](agent-collaboration.md) proposes separate request
summaries and revision sync alongside this turn cache. Those additions are not
implemented; an old pending request must remain visible outside the loaded turns.

Mob Desktop keeps a local copy of each conversation and loads older turns as you scroll. The
protocol is in [mobd](https://github.com/xrdavies/mobd/blob/main/docs/conversation-history.md):
`GET /sessions/{id}/history` for pages and bounded changes, `seq` for turn order, `sessionHistory`
in `/health`. Without that feature the app keeps today's full-snapshot request.

## Local copy

SQLite through `rusqlite` (bundled) in the Tauri backend (`src-tauri/src/history.rs`), in
`history.sqlite` under the app data folder: folder 0700, file 0600. No extra encryption: the
folder is private to the user. Tables:

- `turns`: one row per turn (machine, conversation, task ID, `seq`, `rev`, size) holding the JSON
  of the turn with its messages, steps and questions, and mobd's cursor when the turn was the
  oldest of a page;
- `conversations`: the session row (title, flags), `syncRev`, last opened order and stored size.

The schema version is SQLite's `user_version`. The oldest saved turn is the lowest `seq`; older
turns exist while it is above 1. The browser preview (`npm run dev`) keeps the copy in memory
(`MemoryHistory` in `src/lib/history.ts`).

Rows are keyed by the machine's `serverId` from pairing (the local machine ID when absent), so
every address of one office computer shares one copy. A corrupt file or a different schema
version is deleted and rebuilt from mobd, which stays the source of truth.

Writes go through one queue in `Chat`: pages and changes as they arrive, the current turn when it
finishes or the conversation is left, and at most every 5 seconds while one runs, never for each
streamed event. A turn is only replaced by a copy with at least its `rev`.

## Opening a conversation

1. Show the newest 20 saved turns at once, if any.
2. Sync: with a saved copy, `since=<syncRev>`; without one, the newest page. A `reset` answer drops
   the saved turns and loads the newest page. Stream recovery uses the same request.
3. Scrolling near the top loads the 20 turns before the oldest shown: from the local copy while it
   has them, then from mobd with the cursor of the oldest saved turn, saving them.

Merging is by task ID, keeping the higher `rev` (`mergeTurns`). Only turns from the oldest shown
`seq` up are shown; a changed turn older than that is saved (when inside the saved range) but not
added to the end of the timeline, so it can never become the current turn.

Without `sessionHistory`, `Chat` keeps the full-snapshot request and its in-memory cache of eight
conversations, and saves nothing.

## Sync status

| State | Shown |
|---|---|
| Opening a saved chat, returning to the app, reconnecting | Spinner and **Syncing…** next to the title |
| Up to date | Nothing |
| mobd unreachable | **Offline · showing saved copy** |
| Sync failed while online | **Couldn't sync · Retry** |
| Loading older turns | Spinner at the top of the timeline |
| Older turns not saved, offline | **Older messages aren't available offline** |

The status appears only after about 300 ms, so a fast sync shows nothing. Routine refreshes show
nothing unless they fail; a running turn keeps its live status. Reading and sending continue while
syncing. Offline (mobd unreachable when the machine is selected), the chat list comes from the
local copy and saved conversations can be read; sending is disabled and images show their
placeholder. When `/health` answers again, or on Retry, the app syncs. Focusing the window syncs
the open conversation.

## Timeline

Loading older turns preserves the scroll position: the first item's offset is recorded after each
render, and when older items are prepended the scroll moves by how far it shifted (the browser's
own scroll anchoring is off, so the two never add up). It does not scroll to the bottom or set the
"New activity" state, which only follows the current turn. One page request at a time; the
loading pill floats over the top so it does not move the content; an error leaves the cursor
unchanged and offers Retry. Paging bounds the DOM to what was scrolled through.
`content-visibility: auto` is not used: placeholder heights of items above the view would make the
content jump while scrolling up.

## Storage limit

At most 500 MB per device. Above it, the app removes the saved turns of the least recently opened
conversation, then the next, until it is under about 450 MB. A single conversation over the limit
keeps its newest turns and loses its oldest. The open conversation and any with a running turn are
never trimmed (the open one is trimmed when left). Conversations stay in the chat list; their
removed turns load again from mobd when opened or scrolled to.

Settings → Appearance → **Saved conversations** shows the space used and **Clear local copy**.

## Removal

- `session.deleted`, a `404`, or a conversation missing from the list after being offline:
  delete it locally.
- Removing a machine, or a `401` from mobd (this device revoked): delete that machine's copy.
- The privacy page must describe the local copy (today it says "a cache of recent
  conversations").

## Verification

- `src/lib/history.test.mjs`: merging, first and older pages without gaps or duplicates, a relaunch
  that shows the saved copy before mobd answers and then fetches only changes, an old changed turn
  not appended, `reset`, offline reading and recovery, removal after a `404`, the full-snapshot
  fallback.
- `src-tauri/src/history.rs` tests: paging saved turns, the `rev` rule and cursors, eviction order
  and trimming, removal and pruning, a corrupt or foreign file rebuilt, modes 0700/0600.
- Checked by hand in WebKit against a mobd from the `feat/conversation-history` branch with a
  45-turn conversation: three pages, the top item stays within a pixel when 20 turns are
  prepended, no "New activity", "Syncing…" on a slow sync.
