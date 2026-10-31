# Remote desktop audio

Status: draft, 2026-11-01. Not implemented.

The [mobd audio draft](https://github.com/xrdavies/mobd/blob/main/docs/desktop-audio.md)
owns negotiation, Opus format, WebSocket framing, timestamps and acceptance
targets. This plan covers the Tauri desktop client on macOS, Windows and Linux.
See [current live desktop behavior](desktop-streaming.md).

## Current state and scope

`src/lib/stream.ts` offers receive-only video. `PreviewPanel.tsx` renders a muted
video element. WebSocket fallback in `wsVideo.ts` decodes H.264 with WebCodecs
or uses `fmp4.ts` and MSE. No path currently receives or plays remote audio.

| Area | Planned change |
| --- | --- |
| `src/lib/stream.ts` and stream response types | Optional audio request/result, receive-only audio, transport ownership, errors and cleanup |
| `src/lib/wsVideo.ts`, `src/lib/fmp4.ts` | Audio demultiplexing/acknowledgements and capture-time-aware video scheduling |
| Playback helper beside the current stream modules | Opus decoder, bounded PCM queue and output clock for WebSocket |
| `src/components/preview/PreviewPanel.tsx`, stream UI state | Sound, mute, volume and unavailable/error states |
| `src/lib/stream.test.mjs`, WebSocket/MP4 tests | Negotiation, race, timestamps, queues and cleanup fixtures |
| Packaging/licenses, only if needed | Bundled Opus decoder fallback for webviews without usable WebCodecs audio |

## Negotiation and sound controls

Check `streamAudio` in health before offering sound. A new view starts with
sound off and requests the existing video-only stream. The Sound action opts
into `audio:true`; reconnect once if necessary, release held inputs and retain
view geometry. Reuse the user's gesture to activate playback. Once audio is
negotiated, mute/volume operate locally and do not alter office speaker volume.
Mute is not a promise to stop remote capture or transmission.

Use mobd's `audio.status` and the selected transport's actual receiver state.
Missing capability/result or `unavailable` means video remains usable with an
explanation. `error` with `about:audio` stops sound and offers retry without
closing video. Keep separate states for sound off, connecting, muted and error;
a silent game is not an error. Give controls accessible labels and keyboard use.

## WebRTC

Offer an audio `recvonly` transceiver with Opus alongside video when requesting
sound. Do not call `getUserMedia`. Combine incoming tracks by kind in one media
stream instead of letting a later `ontrack` replace the existing video stream.
Use native WebRTC decoding and playback, respecting the user's mute/volume.
Catch a rejected `play()` and display an Enable sound action; do not mark it as
a network failure or discard working video.

Only the winning transport is audible. Keep candidate playback muted until the
existing winner selection completes, then destroy the losing receiver. The
thumbnail and expanded view must share the session's audio ownership, even if
they use different video surfaces. Do not wait for audible samples to select a
working video connection.

## WebSocket playback

Demultiplex video type `1` and audio type `2` using the shared protocol. Preserve
video acknowledgements and add `audioAck` after network consumption, including
when locally muted. Validate packet bounds/configuration before decoding; an
unknown type must not be sent to the H.264 decoder.

Prefer `AudioDecoder` only after `isConfigSupported` succeeds for the negotiated
Opus format. WebRTC Opus support does not establish WebCodecs support. Where the
webview lacks a working decoder, bundle a pinned libopus-based WASM decoder,
using the same packet/PCM contract and no remote script download. Do not ship
an untested fallback or implement an Opus decoder locally. Verify worker/CSP
and Web Audio support in the packaged WKWebView, WebView2 and WebKitGTK builds.

Feed decoded PCM into a bounded Web Audio/AudioWorklet playback queue, with
target 60 ms and hard limit 200 ms of pending audio as proposed by mobd. Resume
the AudioContext from the user's Sound action. Muting must discard or keep
consuming current samples, never accumulate a backlog for unmute. A discontinuity
flushes old samples and resets timing. Account for Opus initialization/priming
when mapping packet PTS to rendered samples; verify the same fixture as mobile.

Use rendered audio position as the active playback clock and schedule video
against host capture PTS. The current canvas path presents decoded frames
immediately; the MSE path compresses idle intervals to keep video flowing.
Neither behavior alone gives A/V sync. Preserve a capture-to-playback mapping,
hold a static picture while audio advances, and test a new picture after a long
idle interval. The exact MSE mapping/hold strategy is a prototype gate before
claiming fallback audio works on Linux; do not just play audio beside the old
compressed timeline.

Keep browser decoding/playback failure isolated from video. TURN is not required
by this feature and cannot replace support for the current WebSocket route.

## Lifecycle and verification

Closing the live view, switching machines/conversations or ending the stream
flushes queues, releases audio resources and prevents stale callbacks from
restarting playback. A reconnect within the same view can retain sound enabled
but must resume at live time. A newly opened view defaults to sound off. Add no
microphone input, disk recording, background player or persistent sound setting.

Unit tests cover response compatibility, track arrival order, transport races,
muting, audio frame validation, acknowledgement, discontinuity and bounded queues.
Use the existing JS test/build checks (`npm test`, `npm run typecheck`,
`npm run build`) when implementing; this draft itself changes no runtime code.

Packaged-app tests must cover WKWebView, WebView2 and WebKitGTK, including video
through MSE without WebCodecs, rejected autoplay, one audible owner, headphones,
forced UDP failure, idle screen with music, reconnect and a 30-minute flash/tone
fixture. Measure actual output delay and A/V skew against the mobd targets,
separately for wired/built-in and Bluetooth outputs. Browser development mode
and successful packet decoding do not prove the native app plays correctly.

## References

- [WebCodecs](https://www.w3.org/TR/webcodecs/) and [Opus registration](https://www.w3.org/TR/webcodecs-opus-codec-registration/): decoder APIs and raw packet description; codec support must be detected.
- [WebKit WebRTC playback policy](https://webkit.org/blog/7763/a-closer-look-into-webrtc/): handle user activation for sound; verify behavior in the packaged webview.
- [libopus](https://opus-codec.org/docs/): standard decoder fallback.
