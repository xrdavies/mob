# Remote desktop audio (desktop)

Status: implemented on `feat/remote-audio` (WebRTC). No sound over the WebSocket fallback, by decision.

You hear the office computer's sound in the live view. The protocol, stages and capture are in
[mobd's desktop audio doc](https://github.com/xrdavies/mobd/blob/main/docs/desktop-audio.md):
`streamAudio` in `/health`, `audio: true` on `POST /stream`, and `{"t":"audio","on":…}` on the
control channel.

## How it works

`src/lib/stream.ts`:

- When `/health` lists `streamAudio` and the webview has WebRTC, every live view adds a
  receive-only audio transceiver to its offer and sends `audio: true`. mobd sends nothing until
  sound is turned on.
- The answer's `audio` sets the sound state: `ready` → **off** (or **starting** after a reconnect
  with sound on); anything else → **unavailable** with mobd's reason. A mobd without the feature
  is never asked, so the state stays **none** and no button shows.
- Video and sound arrive in one `MediaStream` (mobd gives them one stream ID) and play in the
  existing `<video>`, so the browser keeps them in sync. The track handler keeps that stream
  instead of replacing it with each track.
- `setSound(on)` is called from the click: it unmutes the video in the user's gesture (the
  webview's autoplay rule) and sends `{"t":"audio","on":true}`. mobd's `{"t":"audio","state":…}`
  answers move the state to **on**, or to **unavailable**/**error** with the reason, muting the
  video. Off sends `on:false`, which stops mobd's capture, and mutes.
- If the WebSocket carries the session, sound is **unavailable** ("needs a direct connection")
  by decision (mobd's doc: sound that stutters is worse than none).

## Lifecycle

A new live view starts with sound off. Reconnects within the view (new size, quality,
conversation) keep the choice and turn sound on again once the picture is back. Power, closing
the panel or switching machine turns it off. After a reconnect there is no click, so the webview
may refuse audible playback: then the video stays muted, sound is turned off at mobd, and the
button says to click it again.

## UI

`SoundButton` in `PreviewPanel.tsx`, in the panel header and the expanded toolbar, next to
quality: a muted or speaker icon, a spinner while starting, green while on; disabled with the
reason as tooltip when unavailable. Volume is the system's.

## Verification

- `src/lib/streamSound.test.mjs`: the offer and request, off until clicked, on/off messages, a
  reconnect keeping sound and a new view starting off, errors keeping the picture, no sound
  offered to an older mobd, refused playback falling back to muted.
- By hand in WebKit (Playwright) against a mobd from the branch on this Mac: two-channel Opus
  received with real audio energy while system sounds played; off stopped the packets.
