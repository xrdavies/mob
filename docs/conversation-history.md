# Conversation history pagination and incremental sync

Status: draft

The desktop client should adopt the mobd history-page contract while keeping
revision sync as the source of truth for live changes. See the shared protocol
draft in [mobd](https://github.com/xrdavies/mobd/blob/main/docs/conversation-history.md).

## State and requests

`Chat` currently opens a session with `GET /sessions/{id}` and uses the cached
detail revision for `?since=` refreshes. Extend that state with:

- `syncRev`: the last revision completely merged;
- `historyBefore`: the cursor for the oldest loaded page;
- `historyHasMore` and one in-flight page request per session.

On first open, request the newest history page (`limit=50`) and build the
timeline from that page. Reopening a cached session continues to use
`?since=<syncRev>`. On an older-page request, call
`/sessions/{id}/history?before=<historyBefore>&limit=50` and merge tasks by ID.
The page response must not replace newer task data already received from a
revision sync.

If the server does not advertise history paging, retain the existing full
snapshot path. This keeps older mobd versions usable while clients roll out
the new request.

## Timeline behavior

The timeline should load older history when the scroll container reaches its
top. It must preserve the visible position when prepending a page: record the
first visible item and its offset, insert the page, then restore that item and
offset after layout. A page request is debounced by the in-flight guard and
shows a small top loading state; errors leave the cursor unchanged and expose
a retry action.

New output continues to follow the bottom only while the user is already near
the bottom. Loading older pages must never jump the user to the bottom or mark
new output as read. The existing `buildTimeline` ordering remains the single
place that combines messages and activities.

## Store and cache changes

Keep task, message, activity and question identity keyed by their existing IDs.
When a revision response returns an old task that is outside the visible page,
store its latest value without forcing that page into the viewport. When the
page is later loaded, merge by task ID and keep the newer revision.

The existing in-memory recent-session cache may retain loaded pages and the
two cursors. It remains disposable: after a process restart the client starts
from the newest page again. Do not add disk persistence for this draft.

## Verification

Add store tests for first-page loading, cursor paging, duplicate suppression,
old-task revision updates, and fallback to the full snapshot. Add a timeline
test that prepending a page preserves the first visible item and a reconnect
test that merges an SSE gap through `since`.
