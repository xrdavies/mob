# Conversation history: local copy and paging (desktop)

Status: planned on `feat/conversation-history`

Mob Desktop keeps a local copy of each conversation and loads older turns as you scroll. The
protocol is in [mobd](https://github.com/xrdavies/mobd/blob/main/docs/conversation-history.md):
`GET /sessions/{id}/history` for pages and bounded changes, `seq` for turn order, `sessionHistory`
in `/health`. Without that feature the app keeps today's full-snapshot request.

## Local copy

SQLite through `rusqlite` (bundled) in the Tauri backend, in `history.sqlite` under the app data
folder with mode 0700. No extra encryption: the folder is private to the user. Tables:

- `turns`: one row per turn (machine, conversation, task ID, `seq`, `rev`, size) holding the JSON
  of the turn with its messages, steps and questions;
- `conversations`: the session row (title, flags), `syncRev`, oldest `seq` held, whether older
  turns exist, last opened time and stored size;
- `meta`: the schema version.

Rows are keyed by the machine's `serverId` from pairing (the local machine ID when absent), so
every address of one office computer shares one copy. A corrupt file or a different schema
version is deleted and rebuilt from mobd, which stays the source of truth.

Writes go through one queue: when a turn finishes, and at most every 5 seconds while one runs,
never for each streamed event.

## Opening a conversation

1. Show the saved turns at once, if any.
2. Sync: with a saved copy, `since=<syncRev>`; without one, the newest page. A `reset` answer drops
   the saved turns and loads the newest page.
3. Scrolling past the oldest held turn loads the page before it, saves it, and shows it.

Merging is by task ID, keeping the higher `rev`. Only turns from the oldest held `seq` up are
shown; a changed turn older than that is stored but not added to the end of the timeline, so it
can never become the current turn.

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
syncing. Offline, saved conversations can be read; sending is disabled and images not cached show
a placeholder.

## Timeline

Loading older turns preserves the scroll position: record the first visible item and its offset,
prepend, then restore them after layout. It must not scroll to the bottom or set the "new output"
state, which stays tied to new turns and output only. One page request at a time; an error leaves
the cursor unchanged and offers Retry. Long timelines use `content-visibility: auto` on turn
items; full virtualization only if that proves too slow.

## Storage limit

At most 500 MB per device. Above it, the app removes the saved turns of the least recently opened
conversation, then the next, until it is under about 450 MB. A single conversation over the limit
keeps its newest turns and loses its oldest. The open conversation and any with a running turn are
never trimmed (the open one is trimmed when left). Conversations stay in the chat list; their
removed turns load again from mobd when opened or scrolled to.

Settings shows the space used and **Clear local copy**.

## Removal

- `session.deleted`, a `404`, or a conversation missing from the list after being offline:
  delete it locally.
- Removing a machine, or mobd revoking this device: delete that machine's copy.
- The privacy page must describe the local copy (today it says "a cache of recent
  conversations").

## Verification

Store tests: first page, older pages, duplicate suppression, an old turn changed after paging is
not appended, `reset`, full-snapshot fallback, eviction order, trimming an oversized conversation.
Backend tests: schema, corrupt file rebuilt, mode 0700. Timeline test: prepending keeps the first
visible item and does not set "new output". End to end against a local mobd: reopen after restart
shows the saved copy before the network answers.
