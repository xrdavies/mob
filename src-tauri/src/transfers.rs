use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
use tauri::Manager;

const CHUNK: usize = 4 * 1024 * 1024;

fn valid_id(id: &str) -> bool {
    (32..=36).contains(&id.len()) && id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
}

fn path(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("Invalid transfer ID".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("transfers");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(dir.join(id))
}

fn digest(file: &Path) -> std::io::Result<String> {
    let mut file = File::open(file)?;
    let mut hash = Sha256::new();
    let mut buf = vec![0; 256 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[derive(Serialize)]
pub struct StagedFile {
    name: String,
    size: u64,
    sha256: String,
}

/// Copies a local file into private staging under the transfer ID and hashes the copy, so the
/// upload sends exactly what was checked even if the original changes meanwhile.
#[tauri::command]
pub async fn transfer_stage(
    app: tauri::AppHandle,
    id: String,
    source: String,
) -> Result<StagedFile, String> {
    let dest = path(&app, &id)?;
    let source = absolute(&source)?;
    tauri::async_runtime::spawn_blocking(move || {
        let before = fs::metadata(&source).map_err(|e| e.to_string())?;
        if !before.is_file() || before.len() > 20 * 1024 * 1024 * 1024 {
            return Err("Choose a regular file up to 20 GiB".into());
        }
        let result = (|| {
            fs::copy(&source, &dest).map_err(|e| e.to_string())?;
            let after = fs::metadata(&source).map_err(|e| e.to_string())?;
            if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
                return Err("File changed while preparing the upload; upload it again".into());
            }
            Ok(StagedFile {
                name: source
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into(),
                size: before.len(),
                sha256: digest(&dest).map_err(|e| e.to_string())?,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(&dest);
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn transfer_read(
    app: tauri::AppHandle,
    id: String,
    offset: u64,
    length: usize,
) -> Result<tauri::ipc::Response, String> {
    if length > CHUNK {
        return Err("Chunk too large".into());
    }
    let mut file = File::open(path(&app, &id)?).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut data = vec![0; length];
    file.read_exact(&mut data).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(data))
}

#[tauri::command]
pub async fn transfer_size(app: tauri::AppHandle, id: String) -> Result<u64, String> {
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path(&app, &id)?)
        .map_err(|e| e.to_string())?;
    file.metadata().map(|m| m.len()).map_err(|e| e.to_string())
}

fn append(path: &Path, offset: u64, data: &[u8]) -> Result<(), String> {
    if data.len() > CHUNK {
        return Err("Chunk too large".into());
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() != offset {
        return Err("Local download offset changed".into());
    }
    file.write_all(data)
        .and_then(|_| file.sync_data())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn transfer_append(
    app: tauri::AppHandle,
    id: String,
    offset: u64,
    data: Vec<u8>,
) -> Result<(), String> {
    append(&path(&app, &id)?, offset, &data)
}

#[tauri::command]
pub async fn transfer_digest(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let file = path(&app, &id)?;
    tauri::async_runtime::spawn_blocking(move || digest(&file).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn transfer_discard(app: tauri::AppHandle, id: String) -> Result<(), String> {
    match fs::remove_file(path(&app, &id)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Moves a verified download into dir, never replacing a file: an existing name gets " (1)", " (2)"…
/// Returns the path it was saved to.
fn place(source: &Path, dir: &Path, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err("Invalid file name".into());
    }
    let stem = Path::new(name)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let ext = Path::new(name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for n in 0..1000 {
        let target = if n == 0 {
            dir.join(name)
        } else {
            dir.join(format!("{stem} ({n}){ext}"))
        };
        // A hard link is atomic and refuses an existing name; across disks, copy into a new file.
        match fs::hard_link(source, &target) {
            Ok(()) => {
                let _ = fs::remove_file(source);
                return Ok(target);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => {}
        }
        let mut output = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        };
        let copied = File::open(source)
            .and_then(|mut input| std::io::copy(&mut input, &mut output))
            .and_then(|_| output.sync_all());
        if let Err(e) = copied {
            let _ = fs::remove_file(&target);
            return Err(e.to_string());
        }
        let _ = fs::remove_file(source);
        return Ok(target);
    }
    Err("Too many files with that name".into())
}

#[tauri::command]
pub async fn transfer_place(
    app: tauri::AppHandle,
    id: String,
    dir: String,
    name: String,
) -> Result<String, String> {
    let source = path(&app, &id)?;
    let dir = absolute(&dir)?;
    tauri::async_runtime::spawn_blocking(move || {
        place(&source, &dir, &name).map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn absolute(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("Expected an absolute path".into());
    }
    Ok(path)
}

#[derive(Serialize)]
pub struct LocalPlaces {
    home: String,
    downloads: String,
}

#[tauri::command]
pub fn local_places() -> Result<LocalPlaces, String> {
    let home = dirs::home_dir().ok_or("No home folder")?;
    let downloads = dirs::download_dir().unwrap_or_else(|| home.join("Downloads"));
    Ok(LocalPlaces {
        home: home.to_string_lossy().into(),
        downloads: downloads.to_string_lossy().into(),
    })
}

#[derive(Serialize)]
pub struct LocalEntry {
    name: String,
    size: u64,
    dir: bool,
}

/// One folder's visible entries (no dot names), following links like Finder does.
#[tauri::command]
pub async fn local_list(path: String) -> Result<Vec<LocalEntry>, String> {
    let dir = absolute(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut entries = Vec::new();
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let Ok(entry) = entry else { continue };
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            let Ok(meta) = fs::metadata(entry.path()) else {
                continue;
            };
            if meta.is_dir() || meta.is_file() {
                entries.push(LocalEntry {
                    name,
                    size: meta.len(),
                    dir: meta.is_dir(),
                });
            }
        }
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct WalkedFile {
    path: String,
    rel: String,
    size: u64,
}

#[derive(Serialize)]
pub struct Walk {
    files: Vec<WalkedFile>,
    folders: Vec<String>,
}

const WALK_LIMIT: usize = 10_000;

/// A folder upload: every file and folder under path, as paths relative to its parent (so they
/// start with the folder's own name). Dot names and links are skipped, as in the listing.
fn walk(root: &Path) -> Result<Walk, String> {
    let name = root
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid folder name")?;
    let mut out = Walk {
        files: Vec::new(),
        folders: vec![name.to_string()],
    };
    let mut stack = vec![(root.to_path_buf(), name.to_string())];
    while let Some((dir, rel)) = stack.pop() {
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let Ok(name) = entry.file_name().into_string() else {
                return Err(format!("{rel} has a file name that is not valid Unicode"));
            };
            if name.starts_with('.') {
                continue;
            }
            let meta = entry.metadata().map_err(|e| e.to_string())?;
            let child = format!("{rel}/{name}");
            if meta.is_dir() {
                out.folders.push(child.clone());
                stack.push((entry.path(), child));
            } else if meta.is_file() {
                out.files.push(WalkedFile {
                    path: entry.path().to_string_lossy().into(),
                    rel: child,
                    size: meta.len(),
                });
            }
            if out.files.len() + out.folders.len() > WALK_LIMIT {
                return Err("The folder has more than 10,000 items; upload part of it".into());
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn local_walk(path: String) -> Result<Walk, String> {
    let root = absolute(&path)?;
    tauri::async_runtime::spawn_blocking(move || walk(&root))
        .await
        .map_err(|e| e.to_string())?
}

/// Shows path in Finder (or the system file manager).
#[tauri::command]
pub fn local_reveal(path: String) -> Result<(), String> {
    let path = absolute(&path)?;
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result = std::process::Command::new("xdg-open")
        .arg(path.parent().unwrap_or(&path))
        .spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resumable_disk_writes_do_not_append_at_a_stale_offset() {
        let path =
            std::env::temp_dir().join(format!("mob-transfer-test-{}", rand::random::<u64>()));
        append(&path, 0, b"ab").unwrap();
        assert!(append(&path, 0, b"bad").is_err());
        append(&path, 2, b"c").unwrap();
        assert_eq!(
            digest(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        fs::remove_file(path).unwrap();
        assert!(!valid_id("../settings.json"));
    }

    #[test]
    fn placing_a_download_never_replaces_a_file() {
        let dir = std::env::temp_dir().join(format!("mob-place-test-{}", rand::random::<u64>()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.txt"), "old").unwrap();
        for content in ["new", "newer"] {
            let staged = dir.join(format!("staged-{content}"));
            fs::write(&staged, content).unwrap();
            place(&staged, &dir, "a.txt").unwrap();
            assert!(!staged.exists());
        }
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "old");
        assert_eq!(fs::read_to_string(dir.join("a (1).txt")).unwrap(), "new");
        assert_eq!(fs::read_to_string(dir.join("a (2).txt")).unwrap(), "newer");
        assert!(place(&dir.join("a.txt"), &dir, "../x").is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn walking_a_folder_keeps_its_name_and_skips_hidden_names() {
        let root = std::env::temp_dir().join(format!("mob-walk-test-{}", rand::random::<u64>()));
        let top = root.join("project");
        fs::create_dir_all(top.join("src/empty")).unwrap();
        fs::write(top.join("src/main.rs"), "x").unwrap();
        fs::write(top.join(".DS_Store"), "x").unwrap();
        fs::create_dir_all(top.join(".git")).unwrap();
        let walked = walk(&top).unwrap();
        let mut folders = walked.folders.clone();
        folders.sort();
        assert_eq!(folders, ["project", "project/src", "project/src/empty"]);
        assert_eq!(walked.files.len(), 1);
        assert_eq!(walked.files[0].rel, "project/src/main.rs");
        fs::remove_dir_all(root).unwrap();
    }
}
