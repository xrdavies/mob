# Agent collaboration on Desktop

Status: draft COLLAB-1, 2026-11-02. Not implemented or released.

The pinned [Mob vocabulary](https://github.com/xrdavies/mobd/blob/7db3f83c218bcf3ac7c9a3b75bbae5c3929f6c28/docs/agent-concepts.md) and
[mobd collaboration contract](https://github.com/xrdavies/mobd/blob/7db3f83c218bcf3ac7c9a3b75bbae5c3929f6c28/docs/agent-collaboration.md)
own identity, request states, delivery, permissions, scheduling and recovery.
This companion specifies Desktop behavior against that revision. Change the
contract revision and client companions together when shared semantics change.

## Product behavior

Each existing conversation is an agent. Codex, Claude Code and Pi are framework
choices; the new-chat picker should say **Agent framework**. Keep the current
chat list and open a collaborator through its existing conversation view.
Do not add a second agent list backed by separate IDs.

In A's chat, the user selects B with `@name` or a unique short ID and asks A
to collaborate. A decides which focused message to send. The client shows the
actual dispatched request and its replies, rather than treating mention
selection as a broadcast. Messages and execution live in mobd; closing Desktop
or selecting another chat does not stop them.

## Composer and lookup

Extend [Composer](../src/components/composer/Composer.tsx) and its
[draft store](../src/store/composer.ts) with selected reference chips:
`{serverId, sessionId, displayName}`. Search the proposed agent-directory
endpoint only on the current paired host. Show name, short ID, framework and
busy/archive state. Use bounded search results; stale searches cannot replace
the results for a newer query or another machine.

- Arrow keys move through candidates, Enter selects, Escape closes the picker.
  Selecting a candidate must not also submit the message. Preserve the existing
  Enter/Shift+Enter and IME composition behavior when no picker is active.
- Expose the picker and chips to keyboard and screen-reader users. Names with
  spaces, Chinese text or emoji do not depend on a shared string-offset parser.
- Duplicate names and ambiguous prefixes require selection. Do not dispatch to
  the first match, resolve a renamed target by text, or use a turn ID as its ID.
- References are structured draft state, scoped to the machine and conversation.
  Editing text does not silently retarget a chip. Removing a chip removes that
  reference; quoted text and pasted code have no dispatch effect.
- Submit `agentRefs` with both a new/follow-up user turn and supported user
  steering. If the server cannot preserve references on a path, retain the
  draft and explain the limitation; never silently reduce it to an unbound name.
- Clear only the accepted submitted draft version. Preserve text, references
  and attachments on rejection. After an uncertain user-turn submission,
  reconcile current history before offering retry; reconnect never resends it.

Use pairing `serverId`, not a route URL or local machine row ID, for links and
cache keys. Switching between paired addresses of the same server preserves
references; pairing to a different server invalidates them.

## Timeline and request view

Add attributable cards to the existing timeline: **To Interface agent**,
**From UI agent**, request summary, status and a link to the other conversation.
Source identity comes from mobd metadata. A framework user-input transport does
not mean the author was the human. A rename can update the destination label
while the original sending-name snapshot remains in details.

Keep a compact collaboration summary visible independently of loaded chat turns.
Pending work from a much older turn must not disappear when the chat shows only
its newest page. Open request details on demand; do not fetch both participants'
complete histories to draw one card.

| Server request state | Desktop label |
| --- | --- |
| `open` | Queued / Processing / Waiting for clarification / Waiting for collaborator, derived from assignment and question state |
| `answered` | Answered |
| `needs_attention` | Needs attention |
| `failed` | Failed |
| `cancelled` | Cancelled |
| `expired` | Expired |

Show **Result recorded; finishing** for a proposed result until its handling turn
ends normally. Answered means a final answer exists, not that the user's overall
task passed review. Receipt, processing and final answer remain distinct.
Informational notices/progress do not independently wake a model.

**Stop current turn**, **Cancel collaboration**, and **Pause automatic
continuation** are separate controls using the canonical scope. A cancellation
cannot kill the peer's unrelated task. Resumption is explicit after interruption,
Stop or archive; show partial/late results without reopening a terminal request.
Use the expected revision for resumption and refresh on conflict.

Opening a linked chat preserves the current draft and scroll state. Missing or
archived targets have an explanatory state; never redirect to a same-name agent.
Do not take human desktop control or change live-stream ownership when navigating.

## API, sync and local storage

Gate controls on `agentCollaboration` in `/health.features`; the current
`agents` readiness array lists frameworks and is not the agent directory.
Do not require matching app/mobd release numbers. An older server retains normal
chat, history, files and live view. Offline, show saved collaboration read-only
with its stale status and preserve drafts; sending/cancel/resume require a
connection. Never execute cached inbox entries on client startup.

Extend [API types](../src/api/types.ts) and [Chat](../src/lib/chat.ts) with the
proposed bounded directory, session collaboration and request detail routes.
Global SSE invalidates the affected collaboration view; fetch authoritative
changes after reconnect or a gap. Keep `collaborationRev` separate from history
`syncRev`. Complete a snapshot's pages before accepting its baseline; failed
reads retain the prior revision. Handle reset and tombstones explicitly.

Extend [history interfaces](../src/lib/history.ts),
[Tauri history storage](../src-tauri/src/history.rs) and the browser-memory
implementation with cached request summaries/detail pages and source metadata.
Upsert by stable ID and revision, not array position. If a card changes in an
old turn, update its saved version without moving it to the bottom or making
it current. Pending summaries survive ordinary old-turn eviction; request bodies
can be refetched within bounds. Clearing the local copy does not cancel mobd work.

No new system service or message queue belongs in the Tauri backend. Cache
migration/rebuild follows the existing disposable-copy policy and must never
resend requests. Purge per-server cached data on machine removal or pairing
revocation, following [history lifecycle](conversation-history.md).

## Implementation and acceptance

Implement after mobd's wire fixtures are fixed: models/API and cache first,
reference drafts next, then cards, pending summaries and navigation. Rename
framework labels where this flow touches them; keep compatibility JSON names.

Use focused unit/component tests and the existing Rust cache tests for:

- Same-name agents, ambiguous ID, rename/delete after selection and server change.
- Keyboard/IME input, selection without sending, failed submit, draft edits while
  submission is pending, and references on the supported user-steer path.
- One-slot A/B clarification and finalization, several requests to busy B,
  correct provenance and no duplicate card from SSE plus HTTP recovery.
- Stop versus cancel versus continuation pause; late replies and stale revisions.
- An old open request outside the loaded turn range, bounded detail pages,
  cache relaunch, reset/tombstones and stable scroll position.
- Closing Desktop during work and reopening, switching paired addresses,
  offline reading, older mobd and unknown future states displayed conservatively.

Native framework integration, process handoff and the shared resource limits
are verified in mobd's acceptance suite. This document is a plan, not a claim
that these checks or the feature have shipped.
