# Agent collaboration on Desktop

Status: architecture COLLAB-1, 2026-11-02. Implemented on main; see the status section below.

The shared [Mob vocabulary](https://github.com/xrdavies/mobd/blob/main/docs/agent-concepts.md) and
[mobd architecture](https://github.com/xrdavies/mobd/blob/main/docs/agent-collaboration.md)
define the overall design. Desktop provides the interaction and displays the
collaboration saved by mobd.

## User flow

1. In agent A's chat, select agent B by its handle (`@api`) or by title in the
   `@` picker, and tell A what to
   collaborate on. Each existing conversation is an agent; Codex, Claude Code
   and Pi are the framework choices used to run it.
2. A sends a focused request. Show who contacted whom, what was requested and
   whether it is waiting, being handled, answered or needs user attention.
3. B may ask A for clarification. mobd delivers the exchange and resumes A
   after B's result so A can continue the user's task.
4. Let the user open B's conversation, inspect the exchange and stop or cancel
   the relevant work. Keep the current draft and reading position when navigating.

The handle names the agent; the title describes its work. Show the handle as
a badge next to the title, and lead with it in collaboration views. Archived
agents appear greyed out in the picker and cannot be selected; their row offers
Unarchive or moving the handle to this conversation (mobd's
[handles](https://github.com/xrdavies/mobd/blob/main/docs/agent-collaboration-design.md#handles)).
Mention selection identifies a specific session. Duplicate names need explicit
selection, and renaming an agent preserves that identity. Selecting a mention
alone does not send work to another agent.

## Desktop responsibilities

Extend the existing composer, conversation timeline and local history views.
Use keyboard-accessible mention suggestions and clear sender labels. Keep a
compact pending-collaboration view available even in a very long conversation;
load exchange details when the user opens them.

mobd owns message delivery, execution and continuation. Closing Desktop or
switching chats does not stop collaboration. On reconnect, Desktop refreshes
server state. The local cache supports reading and does not schedule agent work.

## Assessment and scope

The architecture fits the existing chat UI and server connection; it requires
no separate Desktop agent engine or messaging service. Desktop, iOS and Android
must present the same collaboration behavior, with interaction adapted to each
platform. First delivery covers existing agents on one mobd.

Validate the end-to-end A/B exchange, clear attribution, user control and
reconnection first. UI component details, API models and cache changes follow
after the shared implementation contract is defined.

## Status: Desktop

Built against mobd's `feat/agent-collab-core` API and tested in the browser preview with the office
mobd running that branch (Codex and Claude Code, 2026-11-05).

- **Handles:** the badge shows next to the title in the sidebar; the row menu opens a dialog that
  sets, changes or removes a handle, suggesting one from the title and checking the rules as you
  type. A handle another conversation holds is moved only after the dialog says whose it is.
- **@ picker:** typing `@` opens a list above the composer: "Agents" (with a handle) first, then
  other "Conversations", without the open one. Arrow keys, Enter or Tab pick; Escape closes it for
  that word. Picking a conversation without a handle offers to name it (Enter) or mention it by
  short ID (Tab). Archived agents are greyed out. Mentions are resolved on send; an archived one
  stops the send. Mentions are highlighted while you type and shown as chips in sent messages;
  a chip opens that conversation.
- **Pending requests:** a strip above the timeline lists requests to and from the conversation
  ("To @heron", "From …") with status and text. Clicking one opens its request, clarifications and
  result, with Cancel while it is unfinished. Ended requests can be dismissed.
- **Who says what:** only your messages are on the right. This conversation's agent is "Mob" on the
  left; another agent is on the left too, with its name, framework, a colour of its own and what it
  did ("asks", "replied"), without mobd's instructions to the recipient. Collaboration steps read
  "Asked @heron: …", "Replied: …".
- **Live updates:** the global `collab` event updates the strip and an open request.

Verified with a real exchange: Codex asked a Claude Code conversation by `@handle` from the
composer, the strip went from waiting to handling to answered, and the result reached the asker.
Cancel from the dialog marked a request being handled as cancelled at once; the recipient's turn
keeps running (cancel does not stop it) and its `complete_request` fails afterwards.

Not verified: a clarification shown in the dialog, moving a handle that another conversation
holds, and the packaged app's WebView (tests used Chrome).
