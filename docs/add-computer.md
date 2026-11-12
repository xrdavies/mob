# Add a computer

Status: built 2026-11-12 on `feat/add-computer` (mob, mobd); waiting for review.

This document has three parts: [the feature](#part-1-feature), [the decisions](#part-2-decisions) and
[the design](#part-3-design).

## Part 1: Feature

### Problem

Adding a computer was a pane inside Settings → Machines that asked for everything at once: a display name
before the computer was known, the pairing link with a paragraph of `mobd link` flags, the device name and
warnings in between. "This computer" sat in the same pane as a separate card. It read like a config form, not
like adding a computer.

### What the feature does

**One "Add a computer" dialog, in short steps, wherever a computer is added or paired again.**

- **Choose:** "This computer" or "Another computer" (the first only while this computer is not added).
- **Another computer:** run `mobd link` there, paste the link. A link already on the clipboard is used at once.
- **Confirm:** what is about to be paired: name (editable), address, LAN or Remote, HTTPS or not.
- **Done:** "Open" or "Add another".

### User stories

1. I install Mob and the welcome screen has one button, **Add a computer**.
2. I run `mobd link` on the office Mac, copy the link, open the dialog, and it goes straight to the confirmation.
3. The new computer is named as it is called (macOS "Office Mac"), not "Office computer".
4. I pair a computer again, or add its Tailscale address, from the same dialog.
5. I set up this computer from the same dialog.

### Entry points

Sidebar **+**, the welcome screen, the command palette ("Add a computer"), Settings → Machines ("Add a
computer", and "Pair again…" / "Add address or pair again…" for a saved one), the sidebar's and title bar's
"Pair again" for a machine that needs pairing.

### Scope

In scope: the dialog, the welcome screen, moving pairing out of Settings, naming a new computer from mobd.

Not in scope: finding computers on the network (Bonjour), QR scanning on desktop, the phone apps' pairing screens,
connecting this computer automatically (discussed separately).

### Platforms

macOS, Linux and Windows Desktop alike. "This computer" appears only where Desktop can set up mobd (macOS on Apple
Silicon, Linux; see mobd [docs/mob-desktop-local-mobd.md](https://github.com/xrdavies/mobd/blob/main/docs/mob-desktop-local-mobd.md)).

## Part 2: Decisions

### D1. A dialog of its own, not a pane in Settings

- **Options:** (a) restyle the Settings pane; (b) a dialog opened from every entry point.
- **Choice:** (b).
- **Reason:** adding a computer is a task, not a setting. Settings → Machines keeps managing saved computers.

### D2. Ask in the order the user knows things

- **Choice:** link first, then confirm with the name filled in; the device name under "Shown there as …".
- **Reason:** the old form asked for a name before knowing the computer, and for the device name, which almost
  nobody changes, every time.

### D3. A valid link moves on by itself

- **Options:** (a) a Continue button; (b) pasting, dropping or Enter with a valid link opens the confirmation; the
  clipboard is checked once when the dialog opens.
- **Choice:** (b). Back from the confirmation does not check the clipboard again, or it would jump forward at once.

### D4. The computer's name comes with the redeem, not the preview

- **Options:** (a) `GET /pair` returns the name, so the confirmation shows it before pairing; (b) `POST /pair`'s
  201 returns `computerName`.
- **Choice:** (b). Until pairing, the name comes from the address (`office-mac` from
  `office-mac.tail….ts.net`); after, a new computer takes `computerName` unless the user typed a name.
- **Reason:** `GET /pair` needs no credential and answers anyone who can reach mobd while an invitation is open,
  possibly over a public Funnel address. Only a device holding the invite should learn the name.

### D5. Flags and the relay note leave the main view

- **Choice:** `--lan` / `--url` behind "Other addresses"; the "Mob relay — coming soon" note removed.
- **Reason:** most people pair with the default address; a note about something unavailable is noise.

## Part 3: Design

| Step | Shown | Next |
| --- | --- | --- |
| Choose | Two cards: This computer, Another computer | Local or Link |
| Local | Setup from `LocalSetup`: status line, working directory for a new install, one button, progress beside it | Done |
| Link | 1 · `mobd link` with Copy; 2 · link field with Paste; "No mobd there yet? Install it", "Other addresses" | Confirm (valid link) |
| Confirm | Card: name (click to rename), host · LAN/Remote · HTTPS or "not encrypted"; a note for a new address of a saved computer; a checkbox when the link is for another computer than the one being paired again; "Shown there as …" | Done |
| Done | "<name> is ready", Open, Add another | — |

- **State:** `addOpen` and `addFor` (a saved machine to pair again) in the app store; `openAdd(machineId?)` closes
  Settings and the palette and opens the dialog. Each opening starts at Choose (or Link when this computer is
  added, unsupported, or a machine is being paired again).
- **Clipboard:** read through Tauri (`clipboard_read_text`); a native paste in the field is prevented, as before
  (WebKitGTK 2.54 crash, [ui.md](ui.md)).
- **Pairing:** `pair()` returns `computerName` when mobd sends one (trimmed, at most 128 characters);
  `nameFromOrigin()` names it until then. `completePairing` is unchanged.
- **Settings → Machines:** the list, "Add a computer", and an empty state; a saved computer's page has
  "Pair again…" / "Add address or pair again…" (not for this computer, which reconnects from its own screen).
- **mobd:** `POST /pair` 201 adds `computerName` (macOS `scutil --get ComputerName`, else the host name without
  `.local`); older mobd omits it.

### Acceptance

1. Welcome screen: one "Add a computer" button; the dialog opens on Choose (or Link where this computer can't be set up).
2. A pairing link on the clipboard when the dialog opens goes straight to Confirm; Back stays on Link.
3. Pasting, dropping or Enter with a valid link goes to Confirm; an invalid one shows why under the field.
4. A new computer paired with mobd 0.5.2+ is named by its computer name unless renamed on Confirm; with older mobd, by its address.
5. Pair again and Add address work from Settings, the sidebar, the title bar and the "needs pairing" screen.
6. HTTP links show "not encrypted"; a link for a different computer needs the checkbox.
