# Agent Collaboration UI (Desktop)

Implementation status: **Complete**

## What was built

Desktop implements the full agent collaboration UI against mobd's API:

### Handles
- Badge showing `@handle` next to conversation titles in the sidebar
- Context/dropdown menu action "Set handle…" opens a dialog
- Dialog supports setting, changing, clearing, and moving handles between conversations
- Handle suggestions from conversation titles when setting for the first time
- Validation: lowercase letters, digits, hyphens; starts with a letter; 2-32 chars; no all-hex; reserved words blocked

### Mentions
- Typing `@` in the composer opens a dropdown picker
- Picker ranks: handle prefix matches, then title words, then short IDs (6+ chars, all-hex)
- Archived conversations shown greyed and unselectable, with "Unarchive" button
- Arrow keys navigate, Enter/Tab picks, Escape closes
- Picking inserts the mention token (`@handle` or `@shortid`)
- On send, archived mentions block submission with an error message
- Live `mentions` array sent with the turn

### Timeline
- Peer messages (origin.kind == "collab") render with "From @handle" labels instead of user bubbles
- Pending requests strip above the timeline showing unfinished requests
- Status labels: waiting, handling, needs clarification, answered, failed, etc.
- Ended requests needing user attention ("interrupted", "over_budget", "expired") stay visible until dismissed

### Chat store
- Probes mobd's `agentCollaboration` feature flag
- `setHandle(id, handle, take)` to set/clear/move handles
- `loadRequests()` fetches the open conversation's requests on open
- `applyRequest(r)` applies live "collab" events from mobd
- `cancelRequest(requestId)` cancels a pending request

## What was tested

- 8 unit tests for collab helpers (handle validation, suggestions, mention detection, resolution, peer message parsing)
- All existing tests pass (125 total)
- Full typecheck passes

## What wasn't verified

- UI rendering (no browser automation)
- Live mobd integration (would require running mobd with agentCollaboration enabled)
- Handle collision edge cases with concurrent updates
- Request detail dialog (marked TODO in PendingStrip)
- Cancel request UI flow
