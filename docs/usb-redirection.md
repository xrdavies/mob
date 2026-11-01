# Desktop USB redirection

Status: draft USB-1, 2026-11-01. Not implemented or released.

The [mobd USB design](https://github.com/xrdavies/mobd/blob/main/docs/usb-redirection.md)
is the canonical contract for direction, capability, states, security and release
gates. Mob Desktop exports a user-selected local device; mobd imports it. Use
USB/IP over an authenticated, encrypted reverse tunnel and open-source
implementations only. Desktop is the USB/IP server even though it initiates the
outgoing network connection. Do not define a competing USB wire protocol.

## First delivery

Target a Linux receiver, Linux/Windows exporters and a verified subset of macOS
exporters. Drives, serial boards, DFU devices and debug probes are initial test
targets, not an already supported list. Windows/macOS receivers follow only after
their backend validation. No mobile USB sharing, isochronous audio/camera support,
hub forwarding or automatic capture of every connected device in this version.

The browser development mode is not a device exporter. Implement inventory and
I/O in the native Tauri process or a narrowly privileged helper; a webview USB
API does not provide the required transparent OS-level mapping.

Ordinary download to a mounted local drive remains a [file transfer](file-transfers.md).
It does not give remote software a USB device or a raw disk. USB write/flash
operations do not inherit tus pause/continue behavior.

## Local UI and lifecycle

Add a machine-level **USB devices** view with local device name, identity,
availability/reason, destination, sharing state and Share/Stop actions. Do not
upload all local device identifiers just to populate the view. Explain exclusive
access before sharing and offer only devices the backend can actually claim.

Check proposed mobd capability `usbRedirection`, importer readiness and local
export readiness separately. Missing capability means unsupported; a newer
client must not break chat/files/video against an older mobd. Use canonical
session states `connecting`, `connected`, `disconnecting`, `disconnected`,
`failed`, with actionable reasons. An open socket alone is not device attachment.

Bind the share to the selected paired machine and physical device. Changing
chat, selected machine, preview or video transport does not release or retarget
it. Keep active shares visible with their actual destination. The native process
owns sharing while alive; closing a view does not stop it, but quitting must
attempt safe release and explain busy devices. Do not introduce an independent
always-on background service merely to keep shares after app exit.

Only the originating Desktop client may operate its sessions through the USB
API. Remote OS processes with permission can access the imported device, so this
is not chat-level isolation. Mobile clients do not take ownership of these shares.
Remote local administrators retain a recovery path for orphaned attachments.

On sleep, crash, physical removal, pairing revoke or broken transport, fail and
clean up the attachment. Retry creates a fresh attachment; do not replay USB
requests with unknown completion. Start with explicit reconnection after a
bootloader identity change; a future auto-reattach rule must identify the same
authorized hardware, not any matching vendor/product ID.

For storage, locally unmount before export. An orderly stop requires the remote
filesystem to flush/unmount before detach and local release. Report busy instead
of declaring a failed flush successful. Forced disconnect must state the data-loss
risk; unexpected disconnect cannot guarantee filesystem or firmware integrity.
Never let both hosts mount the same volume writable.

## Native integration

| Area | Future change |
| --- | --- |
| `src-tauri/src/lib.rs` and native modules | Device discovery, exporter readiness, narrowly scoped helper calls and outgoing tunnel lifecycle |
| `src/api/`, `src/store/` | Shared capability/readiness/session models, ownership independent of chat selection |
| Machine UI and shared components | Device selection, explicit sharing, destination/state, safe release, keyboard and screen-reader support |
| Existing secure credential access | Reuse paired credentials for native Authorization headers; no tokens in URLs/logs |
| OS packaging and release workflows | Pin/distribute the selected open-source helper/driver with its license and required signing |

Linux can use `usbip-host`; evaluate `usbipd-win` for Windows and `usbipd-mac`
or system USB APIs for macOS. The latter currently excludes system-owned mass
storage and other device classes; neither libusb nor an administrator prompt is
proof that a particular Mac-connected device can be shared. Probe real hardware
before offering it. Do not require users to disable SIP or driver signing.

Keep transport in the native service, independent of UI/webview suspension. Open
outgoing authenticated WSS channels to mobd and bridge only the selected device's
USB/IP traffic. Do not expose a local public USB/IP listener. Validate helper IPC
and device identifiers; do not expose arbitrary shell commands or a generic TCP
proxy through Tauri. Bound buffers and fail cleanly under sustained backlog;
dropping device packets to prioritize live video is not allowed.

The existing MIT license does not replace dependency licenses. `usbipd-win` is
GPL-3.0; assess its distribution requirements and retain notices/source obligations
before packaging. Prefer existing independent tools; do not copy GPL code into
MIT-only source or assume process separation removes every obligation.

## Apple entitlement boundary

The [mobd Apple application runbook](https://github.com/xrdavies/mobd/blob/main/docs/apple-usb-entitlement.md)
owns the request for `com.apple.developer.usb.host-controller-interface`, official
references, Feedback Assistant entry point, materials and submission template.
It is needed by the receiving macOS importer. Exporting a Mac's physical device
to Linux is a different permission problem; this grant does not unlock all local
device capture. Existing Developer ID signing/notarization grants neither
capability automatically. No application is submitted by this draft.

## Verification and shared-document updates

Follow mobd's acceptance matrix: drive checksum/read/write/unmount, serial
controls, flash/verify/debug, bootloader re-enumeration, network loss, sleep,
quit/crash, revocation and contention. Check that machine/chat/view changes do
not steal or interrupt a share and that malformed helper/tunnel input is rejected.
Test signed packages on clean supported systems, with ordinary security enabled.

Record exact exporter/importer versions, devices and latency results. A backend
claim or successful enumeration is not release evidence. Update this draft and
the iOS, Android and site companions whenever the canonical contract changes.
