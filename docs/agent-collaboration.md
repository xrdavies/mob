# Agent collaboration on Desktop

Status: architecture draft COLLAB-1, 2026-11-02. Not implemented or released.

The shared [Mob vocabulary](https://github.com/xrdavies/mobd/blob/ddd731dfa64c0070345d423d9ff6add507d877cd/docs/agent-concepts.md) and
[mobd architecture](https://github.com/xrdavies/mobd/blob/ddd731dfa64c0070345d423d9ff6add507d877cd/docs/agent-collaboration.md)
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
