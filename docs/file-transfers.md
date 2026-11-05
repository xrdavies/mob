# File transfers

The [shared mobd contract](https://github.com/xrdavies/mobd/blob/main/docs/file-transfers.md) defines the remote directory,
tus 1.0 uploads, authenticated Range downloads, completion/checksums and acceptance cases.

Desktop adds a Files screen for the selected machine. Native open/save dialogs choose local
files; private disk staging keeps memory bounded and allows transfers to survive restarts.
tus-js-client handles upload offsets and retries. Download to a private partial file, verify
SHA-256, then offer Save. Persist task identity separately from credentials; pause and cancel
are distinct. Older mobd versions show an update explanation.

No folder sync, remote delete or agent prompt changes in this release. Browser development
mode cannot provide the desktop app's native file access.

## Verification

Desktop JS/store checks: `npm test`; native disk checks: `cargo test --manifest-path src-tauri/Cargo.toml --lib`; build: `npm run build`. Set `MOB_FILE_TEST_FIXTURE` to the isolated mobd fixture JSON to include the real tus upload/download integration test.

See the [shared verification record](https://github.com/xrdavies/mobd/blob/main/docs/file-transfer-verification.md) for coverage and limits.
