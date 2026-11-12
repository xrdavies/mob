//! This computer's mobd (mobd docs/mob-desktop-local-mobd.md): find it, install it with the same
//! checks as the official install.sh, run its service commands, and create the invitation Desktop
//! pairs with. There is one mobd per user, the one a terminal install gives: ~/.local/bin/mobd,
//! ~/.mobd and its background service. macOS and Linux; elsewhere every command says unsupported.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Download origin and Developer ID team, fixed when Desktop is built (release.yml sets both).
const DOWNLOAD_BASE: &str = match option_env!("DOWNLOAD_BASE_URL") {
    Some(base) => base,
    None => "https://dl.mymob.dev",
};
const APPLE_TEAM_ID: Option<&str> = option_env!("APPLE_TEAM_ID");

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    /// This system can run a local mobd set up by Desktop (macOS on Apple Silicon, Linux).
    pub supported: bool,
    /// The mobd binary Desktop would run, if one is installed.
    pub binary: Option<String>,
    /// The management socket answers.
    pub running: bool,
    /// The control socket's /health: listen, serverId, version, executable, loginStartup.
    pub health: Option<Value>,
    /// Login shell PATH, as passed to mobd's commands.
    pub path: String,
    /// ~/.mobd/config.json exists: mobd was set up before, by Desktop or in a terminal.
    pub configured: bool,
    /// The user's home directory, for the default working directory.
    pub home: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalLink {
    pub url: String,
    /// RFC 3339, as `mobd link` prints it.
    pub expires_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInvite {
    /// The pairing link, `<origin>/pair#v=1&serverId=…&invite=…`; never stored.
    pub url: String,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(err)?
}

#[tauri::command]
pub async fn local_status() -> Result<LocalStatus, String> {
    blocking(imp::status).await
}

/// One-use invitation for Desktop itself, at the loopback address of mobd's listen port.
#[tauri::command]
pub async fn local_invite() -> Result<LocalInvite, String> {
    blocking(imp::invite).await
}

/// `mobd link`: an invitation for a phone or another computer, at the address mobd picks (its
/// `mobd remote` address, else the LAN one), exactly as in a terminal.
#[tauri::command]
pub async fn local_link() -> Result<LocalLink, String> {
    blocking(imp::link).await
}

/// The `workdir` in ~/.mobd/config.json (empty when unset); setting it needs a restart.
#[tauri::command]
pub async fn local_workdir(set: Option<String>) -> Result<String, String> {
    blocking(move || imp::workdir(set.as_deref())).await
}

/// Opens the System Settings pane mobd names for a missing macOS permission.
#[tauri::command]
pub async fn local_open_settings(url: String) -> Result<(), String> {
    if !url.starts_with("x-apple.systempreferences:") {
        return Err("not a System Settings address".into());
    }
    blocking(move || {
        std::process::Command::new("/usr/bin/open").arg(&url).status().map_err(err)?;
        Ok(())
    })
    .await
}

/// The latest stable mobd version from the release manifest.
#[tauri::command]
pub async fn local_latest() -> Result<String, String> {
    blocking(|| imp::latest_version().map(|(v, _)| v)).await
}

/// Installs or upgrades mobd (refused while it runs), then returns the installed version.
#[tauri::command]
pub async fn local_install(app: tauri::AppHandle) -> Result<String, String> {
    blocking(move || imp::install(&|stage| progress(&app, stage))).await
}

/// First setup: `mobd init` where there is no config yet, with `workdir`, then `mobd start --login`.
#[tauri::command]
pub async fn local_setup(workdir: String) -> Result<String, String> {
    blocking(move || imp::setup(&workdir)).await
}

/// `mobd start|stop|restart` (start with `--login` when asked); returns mobd's output.
#[tauri::command]
pub async fn local_service(action: String, login: bool) -> Result<String, String> {
    blocking(move || imp::service(&action, login)).await
}

/// The last `lines` lines of ~/.mobd/mobd.log.
#[tauri::command]
pub async fn local_logs(lines: usize) -> Result<String, String> {
    blocking(move || imp::logs(lines)).await
}

/// GET or POST on the control socket for paths Desktop manages: /clients, /permissions.
#[tauri::command]
pub async fn local_control(method: String, path: String) -> Result<Value, String> {
    blocking(move || imp::control_allowed(&method, &path)).await
}

fn progress(app: &tauri::AppHandle, stage: &str) {
    use tauri::Emitter;
    let _ = app.emit("local-install", stage);
}

/// `X.Y.Z` with no leading zeros, as install.sh accepts.
fn stable_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) && (p.len() == 1 || !p.starts_with('0')))
}

/// The manifest's checksum for `platform` (release.json from mobd's release.mjs).
fn platform_sha256(release: &Value, version: &str, platform: &str) -> Result<String, String> {
    if release.get("version").and_then(Value::as_str) != Some(version) {
        return Err("Release version mismatch.".into());
    }
    let sha = release
        .pointer(&format!("/platforms/{platform}/sha256"))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("mobd {version} has no build for this system."))?;
    if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("Invalid release checksum.".into());
    }
    Ok(sha.to_string())
}

/// The address Desktop pairs over: loopback at mobd's port, unless mobd listens on one other
/// address only (then that one; loopback would not answer).
fn loopback_origin(listen: &str) -> Result<String, String> {
    let (host, port) = listen.rsplit_once(':').ok_or("mobd reported no listen port")?;
    if port.parse::<u16>().map_or(true, |p| p == 0) {
        return Err(format!("mobd reported an invalid listen address: {listen}"));
    }
    let host = host.trim_start_matches('[').trim_end_matches(']');
    Ok(match host {
        "" | "0.0.0.0" | "::" | "127.0.0.1" | "localhost" => format!("http://127.0.0.1:{port}"),
        "::1" => format!("http://[::1]:{port}"),
        h if h.contains(':') => format!("http://[{h}]:{port}"),
        h => format!("http://{h}:{port}"),
    })
}

/// The link and expiry from `mobd link`'s output (a QR code, the link, `Expires: … (one use)`).
fn parse_link(out: &str) -> Result<LocalLink, String> {
    let url = out
        .lines()
        .map(str::trim)
        .find(|l| (l.starts_with("http://") || l.starts_with("https://")) && l.contains("/pair#"))
        .ok_or("mobd link printed no pairing link")?;
    let expires_at = out
        .lines()
        .find_map(|l| l.trim().strip_prefix("Expires: "))
        .map(|rest| rest.split_whitespace().next().unwrap_or("").to_string())
        .unwrap_or_default();
    Ok(LocalLink { url: url.to_string(), expires_at })
}

/// Sets `workdir` in a JSON config, keeping every other field.
fn with_workdir(config: &str, workdir: &Path) -> Result<String, String> {
    let mut v: Value = serde_json::from_str(config).map_err(|e| format!("~/.mobd/config.json is not valid JSON: {e}"))?;
    let obj = v.as_object_mut().ok_or("~/.mobd/config.json is not a JSON object")?;
    obj.insert("workdir".into(), Value::String(workdir.to_string_lossy().into_owned()));
    Ok(serde_json::to_string_pretty(&v).map_err(err)? + "\n")
}

/// Parses an HTTP/1.1 response (Content-Length, chunked, or to the end of the connection).
fn parse_response(raw: &[u8]) -> Result<(u16, Vec<u8>), String> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("incomplete response from mobd")?;
    let head = std::str::from_utf8(&raw[..split]).map_err(err)?;
    let mut body = raw[split + 4..].to_vec();
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .ok_or("invalid response from mobd")?;
    if head.lines().any(|l| l.to_ascii_lowercase().replace(' ', "") == "transfer-encoding:chunked") {
        let mut out = Vec::new();
        let mut rest = body.as_slice();
        loop {
            let line_end = rest.windows(2).position(|w| w == b"\r\n").ok_or("truncated chunk")?;
            let size_hex = std::str::from_utf8(&rest[..line_end]).map_err(err)?;
            let size = usize::from_str_radix(size_hex.split(';').next().unwrap_or("").trim(), 16).map_err(err)?;
            rest = &rest[line_end + 2..];
            if size == 0 {
                break;
            }
            if rest.len() < size + 2 {
                return Err("truncated chunk".into());
            }
            out.extend_from_slice(&rest[..size]);
            rest = &rest[size + 2..];
        }
        body = out;
    }
    Ok((status, body))
}

#[cfg(unix)]
mod imp {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixStream;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    extern "C" {
        fn geteuid() -> u32;
    }

    fn home() -> Result<PathBuf, String> {
        dirs::home_dir().ok_or_else(|| "No home directory".to_string())
    }

    fn mobd_dir() -> Result<PathBuf, String> {
        Ok(home()?.join(".mobd"))
    }

    fn install_dir() -> Result<PathBuf, String> {
        Ok(home()?.join(".local").join("bin"))
    }

    /// (platform key in release.json, archive suffix), as install.sh picks them.
    fn platform() -> Option<(&'static str, &'static str)> {
        match (std::env::consts::OS, std::env::consts::ARCH) {
            ("macos", "aarch64") => Some(("darwin-aarch64", "darwin_arm64")),
            ("linux", "x86_64") => Some(("linux-x86_64", "linux_amd64")),
            ("linux", "aarch64") => Some(("linux-aarch64", "linux_arm64")),
            _ => None,
        }
    }

    /// Runs a program with a deadline; stdin is closed so nothing can wait for input.
    fn run(cmd: &mut Command, limit: Duration) -> Result<std::process::Output, String> {
        let mut child = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("{:?}: {e}", cmd.get_program()))?;
        let start = Instant::now();
        loop {
            if child.try_wait().map_err(err)?.is_some() {
                return child.wait_with_output().map_err(err);
            }
            if start.elapsed() > limit {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{:?} did not finish in {} s", cmd.get_program(), limit.as_secs()));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn checked(out: std::process::Output, what: &str) -> Result<String, String> {
        let text = String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr);
        if out.status.success() {
            Ok(text.trim().to_string())
        } else {
            Err(format!("{what} failed: {}", text.trim()))
        }
    }

    /// The login shell's PATH: a GUI app does not load the shell profile, so Homebrew, npm and
    /// ~/.local/bin are missing from its own. Interactive first (nvm and friends live in .zshrc),
    /// with markers around it because rc files may print; then plain login; then the usual dirs.
    pub fn login_path() -> String {
        // Starting a login shell can take a second or more; a minute keeps newly installed CLIs visible.
        static CACHE: std::sync::Mutex<Option<(Instant, String)>> = std::sync::Mutex::new(None);
        if let Some((at, path)) = CACHE.lock().unwrap().as_ref() {
            if at.elapsed() < Duration::from_secs(60) {
                return path.clone();
            }
        }
        let path = read_login_path();
        *CACHE.lock().unwrap() = Some((Instant::now(), path.clone()));
        path
    }

    fn read_login_path() -> String {
        let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).unwrap_or_else(|| "/bin/sh".into());
        for flags in ["-ilc", "-lc"] {
            let mut cmd = Command::new(&shell);
            cmd.args([flags, "printf '\\n__MOB_PATH__%s__MOB_PATH__\\n' \"$PATH\""]);
            if let Ok(out) = run(&mut cmd, Duration::from_secs(5)) {
                let text = String::from_utf8_lossy(&out.stdout);
                if let Some(path) = text.split("__MOB_PATH__").nth(1).filter(|p| !p.is_empty()) {
                    return with_local_bin(path);
                }
            }
        }
        let fallback = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into());
        with_local_bin(&format!("/opt/homebrew/bin:/usr/local/bin:{fallback}"))
    }

    /// The install directory goes first, as the installer asks users to put it on PATH.
    fn with_local_bin(path: &str) -> String {
        let dir = install_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
        if dir.is_empty() || path.split(':').any(|p| p == dir) {
            path.to_string()
        } else {
            format!("{dir}:{path}")
        }
    }

    fn socket() -> Result<PathBuf, String> {
        Ok(mobd_dir()?.join("run").join("control.sock"))
    }

    /// One request on the management socket (HTTP/1.1, connection closed after it).
    pub fn control(method: &str, path: &str, body: Option<&Value>) -> Result<(u16, Value), String> {
        let mut stream = UnixStream::connect(socket()?).map_err(|_| "mobd is not running".to_string())?;
        stream.set_read_timeout(Some(Duration::from_secs(10))).map_err(err)?;
        stream.set_write_timeout(Some(Duration::from_secs(5))).map_err(err)?;
        let body = body.map(|b| b.to_string()).unwrap_or_default();
        let req = format!(
            "{method} {path} HTTP/1.1\r\nHost: mobd\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(req.as_bytes()).map_err(err)?;
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).map_err(err)?;
        let (status, bytes) = parse_response(&raw)?;
        let value = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).map_err(err)? };
        Ok((status, value))
    }

    fn control_ok(method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
        let (status, value) = control(method, path, body)?;
        if (200..300).contains(&status) {
            Ok(value)
        } else {
            Err(value.get("error").and_then(Value::as_str).map(String::from).unwrap_or_else(|| format!("mobd answered {status}")))
        }
    }

    /// The control routes Desktop's settings use; anything else (reset, desktops) stays in the CLI.
    pub fn control_allowed(method: &str, path: &str) -> Result<Value, String> {
        let ok = match method {
            "GET" => path == "/clients" || path == "/permissions" || path == "/connections",
            "POST" => {
                (path.starts_with("/clients/") && path.ends_with("/revoke") && path.matches('/').count() == 3)
                    || (path.starts_with("/permissions/") && path.matches('/').count() == 2)
            }
            "DELETE" => path == "/invitations" || (path.starts_with("/clients/") && path.matches('/').count() == 2),
            _ => false,
        };
        if !ok {
            return Err(format!("{method} {path} is not available to Desktop"));
        }
        control_ok(method, path, None)
    }

    /// The installed binary: the running one, then the install directory, then PATH.
    fn find_binary(health: Option<&Value>, path: &str) -> Option<PathBuf> {
        if let Some(exe) = health.and_then(|h| h.get("executable")).and_then(Value::as_str).filter(|e| !e.is_empty()) {
            return Some(PathBuf::from(exe));
        }
        let candidates = install_dir().ok().map(|d| d.join("mobd")).into_iter().chain(path.split(':').map(|d| Path::new(d).join("mobd")));
        candidates.into_iter().find(|p| p.is_file())
    }

    pub fn status() -> Result<LocalStatus, String> {
        let path = login_path();
        let health = control("GET", "/health", None).ok().filter(|(s, _)| *s == 200).map(|(_, v)| v);
        Ok(LocalStatus {
            supported: platform().is_some(),
            binary: find_binary(health.as_ref(), &path).map(|p| p.to_string_lossy().into_owned()),
            running: health.is_some(),
            health,
            path,
            configured: mobd_dir()?.join("config.json").is_file(),
            home: home()?.to_string_lossy().into_owned(),
        })
    }

    pub fn invite() -> Result<LocalInvite, String> {
        let health = control_ok("GET", "/health", None)?;
        let listen = health.get("listen").and_then(Value::as_str).ok_or("mobd reported no listen address")?;
        invite_at(&loopback_origin(listen)?)
    }

    pub fn link() -> Result<LocalLink, String> {
        parse_link(&mobd(&["link"], None)?)
    }

    pub fn workdir(set: Option<&str>) -> Result<String, String> {
        let config = mobd_dir()?.join("config.json");
        let text = std::fs::read_to_string(&config).map_err(|e| format!("~/.mobd/config.json: {e}"))?;
        if let Some(dir) = set {
            let dir = PathBuf::from(dir);
            if !dir.is_absolute() {
                return Err("The working directory must be an absolute path.".into());
            }
            std::fs::create_dir_all(&dir).map_err(err)?;
            let updated = with_workdir(&text, &dir)?;
            // Same directory: write the new file next to it, then replace, so a crash leaves one whole.
            let staged = config.with_extension("json.mob-tmp");
            std::fs::write(&staged, updated).map_err(err)?;
            std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o600)).map_err(err)?;
            std::fs::rename(&staged, &config).map_err(err)?;
            return Ok(dir.to_string_lossy().into_owned());
        }
        let v: Value = serde_json::from_str(&text).map_err(err)?;
        Ok(v.get("workdir").and_then(Value::as_str).unwrap_or("").to_string())
    }

    fn invite_at(url: &str) -> Result<LocalInvite, String> {
        let body = serde_json::json!({ "url": url });
        let invite = control_ok("POST", "/invitations", Some(&body))?;
        let url = invite.get("url").and_then(Value::as_str).ok_or("mobd returned no invitation")?;
        Ok(LocalInvite { url: url.to_string() })
    }

    fn fetch(url: &str, to: &Path) -> Result<(), String> {
        let out = run(
            Command::new("curl").args(["--proto", "=https", "--tlsv1.2", "--retry", "3", "-fsSL", url, "-o"]).arg(to),
            Duration::from_secs(600),
        )?;
        checked(out, &format!("Download of {url}")).map(|_| ())
    }

    fn fetch_json(url: &str, dir: &Path, name: &str) -> Result<Value, String> {
        let path = dir.join(name);
        fetch(url, &path)?;
        serde_json::from_slice(&std::fs::read(&path).map_err(err)?).map_err(|e| format!("{name}: {e}"))
    }

    pub struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_dir() -> Result<TempDir, String> {
        let dir = std::env::temp_dir().join(format!("mob-mobd-install-{:016x}", rand::random::<u64>()));
        std::fs::create_dir(&dir).map_err(err)?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).map_err(err)?;
        Ok(TempDir(dir))
    }

    fn base() -> Result<&'static str, String> {
        let base = DOWNLOAD_BASE.trim_end_matches('/');
        if base.starts_with("https://") {
            Ok(base)
        } else {
            Err("This build has no HTTPS download address for mobd.".into())
        }
    }

    pub fn latest_version() -> Result<(String, TempDir), String> {
        let tmp = temp_dir()?;
        let latest = fetch_json(&format!("{}/mobd/latest.json", base()?), &tmp.0, "latest.json")?;
        let version = latest.get("version").and_then(Value::as_str).unwrap_or("").to_string();
        if !stable_version(&version) {
            return Err("Invalid stable version. Expected X.Y.Z.".into());
        }
        Ok((version, tmp))
    }

    /// Whether mobd runs as the service or in a terminal, as install.sh checks it.
    fn running() -> bool {
        if control("GET", "/health", None).is_ok() {
            return true;
        }
        let uid = unsafe { geteuid() }.to_string();
        let service = if cfg!(target_os = "macos") {
            Command::new("/bin/launchctl").args(["print", &format!("gui/{uid}/com.xrdavies.mobd")]).output()
        } else {
            Command::new("systemctl").args(["--user", "is-active", "--quiet", "mobd"]).output()
        };
        service.is_ok_and(|o| o.status.success())
            || Command::new("pgrep").args(["-u", &uid, "-x", "mobd"]).output().is_ok_and(|o| o.status.success())
    }

    /// The steps of mobd's .github/release/install.sh, in the same order and with the same checks.
    pub fn install(progress: &dyn Fn(&str)) -> Result<String, String> {
        if unsafe { geteuid() } == 0 {
            return Err("Run Mob as your normal user, not as root.".into());
        }
        let (platform, archive_arch) = platform().ok_or("mobd supports macOS on Apple Silicon and Linux on x86_64 or arm64.")?;
        if cfg!(target_os = "macos") {
            let v = checked(run(Command::new("/usr/bin/sw_vers").arg("-productVersion"), Duration::from_secs(5))?, "sw_vers")?;
            if v.split('.').next().and_then(|m| m.parse::<u32>().ok()).unwrap_or(0) < 13 {
                return Err("mobd requires macOS 13 or newer.".into());
            }
        }
        let team = if cfg!(target_os = "macos") {
            Some(APPLE_TEAM_ID.filter(|t| !t.is_empty()).ok_or("This build of Mob cannot verify mobd's signature. Install mobd with the official installer.")?)
        } else {
            None
        };
        if running() {
            return Err("mobd is running. Stop it before installing.".into());
        }
        progress("Checking the latest version");
        let (version, tmp) = latest_version()?;
        let prefix = format!("{}/mobd/v{version}", base()?);
        let release = fetch_json(&format!("{prefix}/release.json"), &tmp.0, "release.json")?;
        let expected = platform_sha256(&release, &version, platform)?;
        progress(&format!("Downloading mobd {version}"));
        let archive = tmp.0.join(format!("mobd_{version}_{archive_arch}.tar.gz"));
        fetch(&format!("{prefix}/mobd_{version}_{archive_arch}.tar.gz"), &archive)?;
        progress("Verifying");
        let mut hasher = Sha256::new();
        std::io::copy(&mut std::fs::File::open(&archive).map_err(err)?, &mut hasher).map_err(err)?;
        if format!("{:x}", hasher.finalize()) != expected {
            return Err("Checksum mismatch. Installation stopped.".into());
        }
        // Only regular files with these exact names may be extracted.
        let list = checked(run(Command::new("tar").arg("-tzf").arg(&archive), Duration::from_secs(60))?, "tar")?;
        let mut names: Vec<&str> = list.lines().collect();
        names.sort_unstable();
        if names != ["LICENSE", "README.md", "mobd"] {
            return Err("Unexpected archive contents.".into());
        }
        let verbose = checked(run(Command::new("tar").arg("-tvzf").arg(&archive), Duration::from_secs(60))?, "tar")?;
        if verbose.lines().any(|l| !l.starts_with('-')) {
            return Err("Archive contains links or special files.".into());
        }
        checked(run(Command::new("tar").arg("-xzf").arg(&archive).arg("-C").arg(&tmp.0).arg("mobd"), Duration::from_secs(60))?, "tar")?;
        let binary = tmp.0.join("mobd");
        if let Some(team) = team {
            let requirement = format!(
                "=anchor apple generic and identifier \"com.xrdavies.mobd\" and certificate leaf[subject.OU] = \"{team}\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
            );
            checked(
                run(Command::new("/usr/bin/codesign").args(["--verify", "--strict", "--verbose=2", "-R", &requirement]).arg(&binary), Duration::from_secs(60))?,
                "Signature check",
            )?;
        }
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).map_err(err)?;
        let reported = checked(run(Command::new(&binary).arg("--version"), Duration::from_secs(10))?, "mobd --version")?;
        if reported != format!("mobd {version}") {
            return Err("Binary version mismatch.".into());
        }
        progress("Installing");
        let dir = install_dir()?;
        std::fs::create_dir_all(&dir).map_err(err)?;
        let target = dir.join("mobd");
        if target.is_dir() {
            return Err(format!("Installation target is a directory: {}", target.display()));
        }
        let staged = dir.join(format!(".mobd-install.{:016x}", rand::random::<u64>()));
        let result = (|| {
            std::fs::copy(&binary, &staged).map_err(err)?;
            std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755)).map_err(err)?;
            if running() {
                return Err("mobd started during installation. Stop it before retrying.".to_string());
            }
            std::fs::rename(&staged, &target).map_err(err)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&staged);
        }
        result.map(|_| version)
    }

    fn mobd(args: &[&str], cwd: Option<&Path>) -> Result<String, String> {
        let path = login_path();
        // The running mobd's own binary first (it may not be on PATH), then the installed one.
        let health = control("GET", "/health", None).ok().filter(|(s, _)| *s == 200).map(|(_, v)| v);
        let bin = find_binary(health.as_ref(), &path).ok_or("mobd is not installed")?;
        let mut cmd = Command::new(bin);
        cmd.args(args).env("PATH", &path);
        if let Some(cwd) = cwd {
            cmd.current_dir(cwd);
        }
        // start waits up to 15 s for health; stop may wait for desktops to close.
        checked(run(&mut cmd, Duration::from_secs(120))?, &format!("mobd {}", args.join(" ")))
    }

    pub fn setup(workdir: &str) -> Result<String, String> {
        let workdir = PathBuf::from(workdir);
        if !workdir.is_absolute() {
            return Err("The working directory must be an absolute path.".into());
        }
        std::fs::create_dir_all(&workdir).map_err(err)?;
        let config = mobd_dir()?.join("config.json");
        if !config.exists() {
            mobd(&["init"], None)?;
            let text = std::fs::read_to_string(&config).map_err(err)?;
            let updated = with_workdir(&text, &workdir)?;
            std::fs::write(&config, updated).map_err(err)?;
        }
        // The service records this directory and PATH; the CLIs resolve to absolute paths.
        mobd(&["start", "--login"], Some(&workdir))
    }

    /// Where start and restart run. Without `workdir` in the config, mobd works in the directory
    /// it is started from; Desktop's own would be `/`. So: the configured one, else the one the
    /// service last used (service.json), else home.
    pub fn service_cwd() -> Result<PathBuf, String> {
        let dir = mobd_dir()?;
        for file in ["config.json", "service.json"] {
            let workdir = std::fs::read_to_string(dir.join(file))
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .and_then(|v| v.get("workdir").and_then(Value::as_str).map(PathBuf::from))
                .filter(|p| p.is_absolute() && p.is_dir());
            if let Some(w) = workdir {
                return Ok(w);
            }
        }
        home()
    }

    pub fn service(action: &str, login: bool) -> Result<String, String> {
        let cwd = service_cwd()?;
        match (action, login) {
            ("start", true) => mobd(&["start", "--login"], Some(&cwd)),
            ("restart", true) => mobd(&["restart", "--login"], Some(&cwd)),
            ("start", false) | ("restart", false) => mobd(&[action], Some(&cwd)),
            ("stop", _) => mobd(&["stop"], None),
            _ => Err(format!("unknown service action {action}")),
        }
    }

    pub fn logs(lines: usize) -> Result<String, String> {
        let text = std::fs::read_to_string(mobd_dir()?.join("mobd.log")).unwrap_or_default();
        let all: Vec<&str> = text.lines().collect();
        Ok(all[all.len().saturating_sub(lines.clamp(1, 5000))..].join("\n"))
    }
}

#[cfg(not(unix))]
mod imp {
    use super::*;

    const UNSUPPORTED: &str = "Setting up this computer is not supported on this system yet.";

    pub fn status() -> Result<LocalStatus, String> {
        Ok(LocalStatus::default())
    }
    pub fn invite() -> Result<LocalInvite, String> {
        Err(UNSUPPORTED.into())
    }
    pub fn link() -> Result<LocalLink, String> {
        Err(UNSUPPORTED.into())
    }
    pub fn workdir(_: Option<&str>) -> Result<String, String> {
        Err(UNSUPPORTED.into())
    }
    pub fn latest_version() -> Result<(String, ()), String> {
        Err(UNSUPPORTED.into())
    }
    pub fn install(_: &dyn Fn(&str)) -> Result<String, String> {
        Err(UNSUPPORTED.into())
    }
    pub fn setup(_: &str) -> Result<String, String> {
        Err(UNSUPPORTED.into())
    }
    pub fn service(_: &str, _: bool) -> Result<String, String> {
        Err(UNSUPPORTED.into())
    }
    pub fn logs(_: usize) -> Result<String, String> {
        Err(UNSUPPORTED.into())
    }
    pub fn control_allowed(_: &str, _: &str) -> Result<Value, String> {
        Err(UNSUPPORTED.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Trimmed from https://dl.mymob.dev/mobd/v0.5.1/release.json (written by mobd's release.mjs):
    // the format install.sh and Desktop both read.
    const RELEASE: &str = r#"{
  "version": "0.5.1",
  "notes": "…",
  "pub_date": "2026-11-10T10:56:32Z",
  "platforms": {
    "darwin-aarch64": {
      "url": "https://dl.mymob.dev/mobd/v0.5.1/mobd_0.5.1_darwin_arm64.tar.gz",
      "sha256": "451c34fa8b66c209113f8884933d8b996ad31bee98d1d5d91dae4cd2f22dc254"
    },
    "linux-x86_64": {
      "url": "https://dl.mymob.dev/mobd/v0.5.1/mobd_0.5.1_linux_amd64.tar.gz",
      "sha256": "ce863c99350af87866cb24cf0ecb0c6897815e852de749a513e897ed877a4f6d",
      "deb": {
        "url": "https://dl.mymob.dev/mobd/v0.5.1/mobd_0.5.1_amd64.deb",
        "sha256": "f28db4b9b1231d7409c80cfb6515f1a7e09ec21e40a9d2a38ea4f9e7373176d4"
      }
    },
    "windows-x86_64": {
      "url": "https://dl.mymob.dev/mobd/v0.5.1/mobd_0.5.1_windows_amd64.zip",
      "sha256": "ff7d33729f65135eb1a8862357dcd9828b984dd9cd67d16278cd3872a78bc513"
    }
  },
  "download": {
    "url": "https://dl.mymob.dev/mobd/v0.5.1/mobd_0.5.1_darwin_arm64.tar.gz",
    "sha256": "451c34fa8b66c209113f8884933d8b996ad31bee98d1d5d91dae4cd2f22dc254"
  }
}"#;

    #[test]
    fn reads_the_release_manifest_like_install_sh() {
        let release: Value = serde_json::from_str(RELEASE).unwrap();
        assert_eq!(
            platform_sha256(&release, "0.5.1", "darwin-aarch64").unwrap(),
            "451c34fa8b66c209113f8884933d8b996ad31bee98d1d5d91dae4cd2f22dc254"
        );
        assert_eq!(
            platform_sha256(&release, "0.5.1", "linux-x86_64").unwrap(),
            "ce863c99350af87866cb24cf0ecb0c6897815e852de749a513e897ed877a4f6d"
        );
        assert!(platform_sha256(&release, "0.5.1", "linux-aarch64").unwrap_err().contains("no build"));
        assert!(platform_sha256(&release, "0.5.2", "darwin-aarch64").unwrap_err().contains("mismatch"));
        let bad: Value = serde_json::from_str(&RELEASE.replace("451c34fa", "XYZ")).unwrap();
        assert!(platform_sha256(&bad, "0.5.1", "darwin-aarch64").is_err());
    }

    #[test]
    fn accepts_only_stable_versions() {
        for ok in ["0.5.1", "1.0.0", "10.20.30"] {
            assert!(stable_version(ok), "{ok}");
        }
        for bad in ["", "0.5", "0.5.1.2", "v0.5.1", "0.05.1", "0.5.1-rc1", "0.5.x", "../0.5.1"] {
            assert!(!stable_version(bad), "{bad}");
        }
    }

    #[test]
    fn pairs_over_loopback_unless_mobd_listens_elsewhere_only() {
        assert_eq!(loopback_origin(":8080").unwrap(), "http://127.0.0.1:8080");
        assert_eq!(loopback_origin("0.0.0.0:8080").unwrap(), "http://127.0.0.1:8080");
        assert_eq!(loopback_origin("[::]:9000").unwrap(), "http://127.0.0.1:9000");
        assert_eq!(loopback_origin("127.0.0.1:18080").unwrap(), "http://127.0.0.1:18080");
        assert_eq!(loopback_origin("[::1]:8080").unwrap(), "http://[::1]:8080");
        assert_eq!(loopback_origin("192.168.1.20:8080").unwrap(), "http://192.168.1.20:8080");
        assert!(loopback_origin("8080").is_err());
        assert!(loopback_origin(":0").is_err());
    }

    #[test]
    fn reads_the_link_from_mobd_link_output() {
        let out = "█▀▀▀▀▀█ ▄▀ █▀▀▀▀▀█\n█ ███ █ ▀▄ █ ███ █\nhttp://192.168.1.20:8080/pair#v=1&serverId=abc&invite=def\nExpires: 2026-11-12T10:15:00Z (one use)\n";
        assert_eq!(
            parse_link(&format!("Pairing address: http://192.168.1.20:8080 (LAN)\n{out}")).unwrap(),
            LocalLink {
                url: "http://192.168.1.20:8080/pair#v=1&serverId=abc&invite=def".into(),
                expires_at: "2026-11-12T10:15:00Z".into()
            }
        );
        assert!(parse_link("Pairing address: http://192.168.1.20:8080 (LAN)\n").is_err());
    }

    #[test]
    fn sets_workdir_and_keeps_other_fields() {
        let out = with_workdir("{\n  \"listen\": \"0.0.0.0:8080\"\n}\n", Path::new("/Users/me/Mob")).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["listen"], "0.0.0.0:8080");
        assert_eq!(v["workdir"], "/Users/me/Mob");
        assert!(with_workdir("[]", Path::new("/x")).is_err());
    }

    #[test]
    fn parses_plain_and_chunked_responses() {
        let plain = b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}";
        assert_eq!(parse_response(plain).unwrap(), (200, b"{\"ok\":true}".to_vec()));
        let chunked = b"HTTP/1.1 201 Created\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"a\"\r\n3\r\n:1}\r\n0\r\n\r\n";
        assert_eq!(parse_response(chunked).unwrap(), (201, b"{\"a\":1}".to_vec()));
        assert!(parse_response(b"HTTP/1.1 200 OK\r\n").is_err());
    }
}

#[cfg(all(test, unix))]
mod live {
    /// Against this user's real mobd: `cargo test --lib local::live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn reads_the_running_mobd() {
        let s = super::imp::status().unwrap();
        println!("service cwd={:?}", super::imp::service_cwd());
        println!("supported={} running={} binary={:?}", s.supported, s.running, s.binary);
        println!("health={}", s.health.map(|h| h.to_string()).unwrap_or_default());
        println!("path={}", s.path);
    }
}
