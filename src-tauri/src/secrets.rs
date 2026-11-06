//! Pairing credentials: system keyring first, encrypted file fallback when unavailable.
//!
//! Preferred backends: macOS Keychain, Windows Credential Manager, Linux Secret Service
//! (via the `keyring` crate). When that path fails with a platform / storage-access error
//! (typical on headless Linux without `org.freedesktop.secrets`), secrets are stored in an
//! AES-256-GCM encrypted file under the app config directory, mode 0600 on Unix.
//! See docs/credential-storage.md.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};

const SERVICE: &str = "com.xrdavies.mob";
const APP_DIR: &str = "mob";
const CRED_SUBDIR: &str = "credentials";
const MASTER_KEY_FILE: &str = "master.key";
const STORE_FILE: &str = "store.enc";
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const FORMAT_VERSION: u8 = 1;

static KEYRING_UNAVAILABLE: AtomicBool = AtomicBool::new(false);
static USED_FILE_FALLBACK: AtomicBool = AtomicBool::new(false);
static FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    /// `"keyring"` or `"file"`.
    pub backend: &'static str,
    /// Directory of the encrypted file store when the file backend has been used or selected.
    pub path: Option<String>,
}

pub fn storage_info() -> StorageInfo {
    let file_active =
        USED_FILE_FALLBACK.load(Ordering::Relaxed) || KEYRING_UNAVAILABLE.load(Ordering::Relaxed);
    StorageInfo {
        backend: if file_active { "file" } else { "keyring" },
        path: if file_active {
            credentials_dir().ok().map(|p| p.display().to_string())
        } else {
            None
        },
    }
}

pub fn get(account: &str) -> Result<Option<String>, String> {
    validate_account(account)?;
    if !KEYRING_UNAVAILABLE.load(Ordering::Relaxed) {
        match keyring_get(account) {
            Ok(Some(value)) => return Ok(Some(value)),
            Ok(None) => return file_get(account),
            Err(e) if is_keyring_unavailable(&e) => mark_keyring_unavailable(&e),
            Err(e) => return Err(e.to_string()),
        }
    }
    file_get(account)
}

/// Stores a secret. Returns the backend that held the write (`"keyring"` or `"file"`).
pub fn set(account: &str, value: &str) -> Result<&'static str, String> {
    validate_account(account)?;
    if !KEYRING_UNAVAILABLE.load(Ordering::Relaxed) {
        match keyring_set(account, value) {
            Ok(()) => {
                // Prefer a single source of truth when the system store works.
                let _ = file_delete_account(account);
                return Ok("keyring");
            }
            Err(e) if is_keyring_unavailable(&e) => mark_keyring_unavailable(&e),
            Err(e) => return Err(e.to_string()),
        }
    }
    file_set(account, value)?;
    USED_FILE_FALLBACK.store(true, Ordering::Relaxed);
    Ok("file")
}

pub fn delete(account: &str) -> Result<(), String> {
    validate_account(account)?;
    let mut keyring_err: Option<String> = None;
    if !KEYRING_UNAVAILABLE.load(Ordering::Relaxed) {
        match keyring_delete(account) {
            Ok(()) => {}
            Err(e) if is_keyring_unavailable(&e) => mark_keyring_unavailable(&e),
            Err(e) => keyring_err = Some(e.to_string()),
        }
    }
    file_delete_account(account)?;
    if let Some(e) = keyring_err {
        return Err(e);
    }
    Ok(())
}

fn validate_account(account: &str) -> Result<(), String> {
    if account.is_empty() || account.len() > 256 {
        return Err("invalid secret account".into());
    }
    Ok(())
}

fn is_keyring_unavailable(err: &keyring::Error) -> bool {
    matches!(
        err,
        keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_)
    )
}

fn mark_keyring_unavailable(err: &keyring::Error) {
    KEYRING_UNAVAILABLE.store(true, Ordering::Relaxed);
    let dir = credentials_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "(unavailable)".into());
    eprintln!(
        "mob: system keyring unavailable ({err}); falling back to encrypted file store at {dir}"
    );
}

fn keyring_entry(account: &str) -> Result<keyring::Entry, keyring::Error> {
    keyring::Entry::new(SERVICE, account)
}

fn keyring_get(account: &str) -> Result<Option<String>, keyring::Error> {
    match keyring_entry(account)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e),
    }
}

fn keyring_set(account: &str, value: &str) -> Result<(), keyring::Error> {
    keyring_entry(account)?.set_password(value)
}

fn keyring_delete(account: &str) -> Result<(), keyring::Error> {
    match keyring_entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e),
    }
}

fn credentials_dir() -> Result<PathBuf, String> {
    if let Ok(override_dir) = std::env::var("MOB_CREDENTIALS_DIR") {
        if !override_dir.is_empty() {
            return Ok(PathBuf::from(override_dir));
        }
    }
    let base = dirs::config_dir().ok_or_else(|| "no user config directory".to_string())?;
    Ok(base.join(APP_DIR).join(CRED_SUBDIR))
}

fn ensure_credentials_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("create credentials dir: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

fn master_key_path(dir: &Path) -> PathBuf {
    dir.join(MASTER_KEY_FILE)
}

fn store_path(dir: &Path) -> PathBuf {
    dir.join(STORE_FILE)
}

fn load_or_create_master_key(dir: &Path) -> Result<[u8; KEY_LEN], String> {
    let path = master_key_path(dir);
    if path.exists() {
        let mut buf = Vec::new();
        File::open(&path)
            .and_then(|mut f| f.read_to_end(&mut buf))
            .map_err(|e| format!("read master key: {e}"))?;
        if buf.len() != KEY_LEN {
            return Err("master key file has unexpected length".into());
        }
        let mut key = [0u8; KEY_LEN];
        key.copy_from_slice(&buf);
        return Ok(key);
    }
    let mut key = [0u8; KEY_LEN];
    rand::thread_rng().fill_bytes(&mut key);
    write_restricted(&path, &key)?;
    Ok(key)
}

fn write_restricted(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    file.write_all(bytes)
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    file.sync_all()
        .map_err(|e| format!("sync {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn cipher(key: &[u8; KEY_LEN]) -> Result<Aes256Gcm, String> {
    Aes256Gcm::new_from_slice(key).map_err(|e| format!("init cipher: {e}"))
}

fn encrypt_blob(key: &[u8; KEY_LEN], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = cipher(key)?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("encrypt: {e}"))?;
    let mut out = Vec::with_capacity(1 + NONCE_LEN + ciphertext.len());
    out.push(FORMAT_VERSION);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn decrypt_blob(key: &[u8; KEY_LEN], blob: &[u8]) -> Result<Vec<u8>, String> {
    if blob.len() < 1 + NONCE_LEN + 16 {
        return Err("credential store blob too short".into());
    }
    if blob[0] != FORMAT_VERSION {
        return Err(format!("unsupported credential store version {}", blob[0]));
    }
    let nonce = Nonce::from_slice(&blob[1..1 + NONCE_LEN]);
    let ciphertext = &blob[1 + NONCE_LEN..];
    cipher(key)?
        .decrypt(nonce, ciphertext)
        .map_err(|_| "failed to decrypt credential store (wrong key or corrupt file)".into())
}

fn load_map(
    dir: &Path,
    key: &[u8; KEY_LEN],
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let path = store_path(dir);
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let mut blob = Vec::new();
    File::open(&path)
        .and_then(|mut f| f.read_to_end(&mut blob))
        .map_err(|e| format!("read credential store: {e}"))?;
    if blob.is_empty() {
        return Ok(serde_json::Map::new());
    }
    let plain = decrypt_blob(key, &blob)?;
    let value: serde_json::Value =
        serde_json::from_slice(&plain).map_err(|e| format!("parse credential store: {e}"))?;
    match value {
        serde_json::Value::Object(map) => Ok(map),
        _ => Err("credential store root must be an object".into()),
    }
}

fn save_map(
    dir: &Path,
    key: &[u8; KEY_LEN],
    map: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let plain = serde_json::to_vec(map).map_err(|e| format!("serialize credential store: {e}"))?;
    let blob = encrypt_blob(key, &plain)?;
    write_restricted(&store_path(dir), &blob)
}

fn account_key(account: &str) -> String {
    let digest = Sha256::digest(account.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn file_get(account: &str) -> Result<Option<String>, String> {
    let _guard = FILE_LOCK
        .lock()
        .map_err(|_| "credential file lock poisoned".to_string())?;
    let dir = credentials_dir()?;
    if !dir.exists() {
        return Ok(None);
    }
    let key = load_or_create_master_key(&dir)?;
    let map = load_map(&dir, &key)?;
    Ok(map
        .get(&account_key(account))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string()))
}

fn file_set(account: &str, value: &str) -> Result<(), String> {
    let _guard = FILE_LOCK
        .lock()
        .map_err(|_| "credential file lock poisoned".to_string())?;
    let dir = credentials_dir()?;
    ensure_credentials_dir(&dir)?;
    let key = load_or_create_master_key(&dir)?;
    let mut map = load_map(&dir, &key)?;
    map.insert(
        account_key(account),
        serde_json::Value::String(value.to_string()),
    );
    save_map(&dir, &key, &map)?;
    USED_FILE_FALLBACK.store(true, Ordering::Relaxed);
    Ok(())
}

fn file_delete_account(account: &str) -> Result<(), String> {
    let _guard = FILE_LOCK
        .lock()
        .map_err(|_| "credential file lock poisoned".to_string())?;
    let dir = credentials_dir()?;
    if !dir.exists() {
        return Ok(());
    }
    let key = load_or_create_master_key(&dir)?;
    let mut map = load_map(&dir, &key)?;
    if map.remove(&account_key(account)).is_none() {
        return Ok(());
    }
    if map.is_empty() {
        let _ = fs::remove_file(store_path(&dir));
    } else {
        save_map(&dir, &key, &map)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    static ENV_LOCK: StdMutex<()> = StdMutex::new(());

    fn with_temp_dir(f: impl FnOnce(&Path)) {
        let _env = ENV_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!(
            "mob-cred-test-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        std::env::set_var("MOB_CREDENTIALS_DIR", &dir);
        // Force file path for these unit tests.
        KEYRING_UNAVAILABLE.store(true, Ordering::SeqCst);
        USED_FILE_FALLBACK.store(false, Ordering::SeqCst);
        f(&dir);
        std::env::remove_var("MOB_CREDENTIALS_DIR");
        KEYRING_UNAVAILABLE.store(false, Ordering::SeqCst);
        USED_FILE_FALLBACK.store(false, Ordering::SeqCst);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_roundtrip_and_delete() {
        with_temp_dir(|dir| {
            assert!(get("m1.token").unwrap().is_none());
            assert_eq!(set("m1.token", "secret-value").unwrap(), "file");
            assert_eq!(get("m1.token").unwrap().as_deref(), Some("secret-value"));
            assert!(master_key_path(dir).exists());
            assert!(store_path(dir).exists());
            // Ciphertext must not contain the plaintext token.
            let blob = fs::read(store_path(dir)).unwrap();
            assert!(!blob
                .windows(b"secret-value".len())
                .any(|w| w == b"secret-value"));
            delete("m1.token").unwrap();
            assert!(get("m1.token").unwrap().is_none());
        });
    }

    #[test]
    fn storage_info_reports_file_after_fallback_write() {
        with_temp_dir(|_| {
            set("a.token", "x").unwrap();
            let info = storage_info();
            assert_eq!(info.backend, "file");
            assert!(info.path.is_some());
        });
    }

    #[test]
    fn keyring_platform_failure_falls_back_on_this_host() {
        // On machines without Secret Service this exercises the real fallback path.
        // Where the system keyring works, the write succeeds on "keyring" and the test still passes.
        let _env = ENV_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!(
            "mob-cred-fallback-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        std::env::set_var("MOB_CREDENTIALS_DIR", &dir);
        KEYRING_UNAVAILABLE.store(false, Ordering::SeqCst);
        USED_FILE_FALLBACK.store(false, Ordering::SeqCst);

        let account = format!("fallback-test-{}.token", rand::random::<u32>());
        let backend =
            set(&account, "fallback-secret").expect("set should succeed via keyring or file");
        assert!(
            backend == "keyring" || backend == "file",
            "unexpected backend {backend}"
        );
        assert_eq!(get(&account).unwrap().as_deref(), Some("fallback-secret"));
        if backend == "file" {
            assert!(
                USED_FILE_FALLBACK.load(Ordering::SeqCst)
                    || KEYRING_UNAVAILABLE.load(Ordering::SeqCst)
            );
            assert!(store_path(&dir).exists() || master_key_path(&dir).exists());
        }
        delete(&account).unwrap();

        std::env::remove_var("MOB_CREDENTIALS_DIR");
        KEYRING_UNAVAILABLE.store(false, Ordering::SeqCst);
        USED_FILE_FALLBACK.store(false, Ordering::SeqCst);
        let _ = fs::remove_dir_all(&dir);
    }
}
