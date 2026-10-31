//! The local copy of conversations (docs/conversation-history.md): one SQLite file in the app data
//! folder, private to the user (folder 0700, file 0600). mobd stays the source of truth, so a
//! corrupt file or another schema version is deleted and rebuilt.

use rusqlite::{params, Connection, ErrorCode, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

/// SQLite's user_version of the current schema.
const SCHEMA: i64 = 1;
const LIMIT: i64 = 500 * 1024 * 1024;
const TARGET: i64 = 450 * 1024 * 1024;

pub struct History {
    path: PathBuf,
    conn: Mutex<Option<Connection>>,
    /// The storage limit and the size eviction brings it back under.
    limit: i64,
    target: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTurn {
    seq: i64,
    data: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    session: String,
    sync_rev: i64,
    /// The oldest saved turn and the cursor naming it, for the page before it.
    oldest: Option<i64>,
    cursor: Option<String>,
    turns: Vec<SavedTurn>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    id: String,
    session: String,
    sync_rev: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    id: String,
    seq: i64,
    rev: i64,
    /// mobd's cursor naming this turn, when it was the oldest of a page.
    cursor: Option<String>,
    data: String,
}

impl History {
    pub fn new(path: PathBuf) -> Self {
        Self { path, conn: Mutex::new(None), limit: LIMIT, target: TARGET }
    }

    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        let mut guard = self.conn.lock().map_err(|_| "history lock poisoned".to_string())?;
        if guard.is_none() {
            *guard = Some(connect(&self.path)?);
        }
        match f(guard.as_mut().expect("connected")) {
            Ok(v) => Ok(v),
            Err(e) => {
                if corrupt(&e) {
                    *guard = None;
                    discard(&self.path);
                }
                Err(e.to_string())
            }
        }
    }

    /// The conversation's newest `limit` saved turns older than `before` (all when None),
    /// oldest first. Opening it (no `before`) makes it the most recently opened.
    pub fn load(&self, machine: &str, id: &str, before: Option<i64>, limit: i64) -> Result<Option<Saved>, String> {
        self.with(|c| {
            let row = c
                .query_row(
                    "SELECT session, sync_rev FROM conversations WHERE machine = ?1 AND id = ?2",
                    params![machine, id],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
                )
                .optional()?;
            let Some((session, sync_rev)) = row else { return Ok(None) };
            if before.is_none() {
                c.execute(
                    "UPDATE conversations SET opened_at = (SELECT COALESCE(MAX(opened_at), 0) + 1 FROM conversations)
                     WHERE machine = ?1 AND id = ?2",
                    params![machine, id],
                )?;
            }
            let (oldest, cursor) = c
                .query_row(
                    "SELECT seq, cursor FROM turns WHERE machine = ?1 AND conversation = ?2 ORDER BY seq LIMIT 1",
                    params![machine, id],
                    |r| Ok((Some(r.get::<_, i64>(0)?), r.get::<_, Option<String>>(1)?)),
                )
                .optional()?
                .unwrap_or((None, None));
            let mut stmt = c.prepare(
                "SELECT seq, data FROM turns WHERE machine = ?1 AND conversation = ?2 AND seq < ?3
                 ORDER BY seq DESC LIMIT ?4",
            )?;
            let mut turns = stmt
                .query_map(params![machine, id, before.unwrap_or(i64::MAX), limit], |r| {
                    Ok(SavedTurn { seq: r.get(0)?, data: r.get(1)? })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            turns.reverse();
            Ok(Some(Saved { session, sync_rev, oldest, cursor, turns }))
        })
    }

    /// The saved conversations' session rows, for the chat list while mobd is unreachable.
    pub fn list(&self, machine: &str) -> Result<Vec<String>, String> {
        self.with(|c| {
            let mut stmt = c.prepare("SELECT session FROM conversations WHERE machine = ?1")?;
            let rows = stmt.query_map(params![machine], |r| r.get(0))?.collect();
            rows
        })
    }

    /// Saves the conversation row and turns (`replace` drops its other turns first). A turn is
    /// only replaced by one with at least its `rev`. Then evicts down to the limit, never touching
    /// the conversations in `keep` on this machine.
    pub fn save(&self, machine: &str, conv: &Conversation, turns: &[Turn], replace: bool, keep: &[String]) -> Result<(), String> {
        self.with(|c| {
            let tx = c.transaction()?;
            tx.execute(
                "INSERT INTO conversations (machine, id, session, sync_rev, opened_at, size)
                 VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(opened_at), 0) + 1 FROM conversations), 0)
                 ON CONFLICT (machine, id) DO UPDATE SET session = excluded.session, sync_rev = excluded.sync_rev",
                params![machine, conv.id, conv.session, conv.sync_rev],
            )?;
            if replace {
                tx.execute("DELETE FROM turns WHERE machine = ?1 AND conversation = ?2", params![machine, conv.id])?;
            }
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO turns (machine, conversation, id, seq, rev, size, cursor, data)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                     ON CONFLICT (machine, conversation, id) DO UPDATE SET seq = excluded.seq, rev = excluded.rev,
                       size = excluded.size, cursor = COALESCE(excluded.cursor, turns.cursor), data = excluded.data
                     WHERE excluded.rev >= turns.rev",
                )?;
                for t in turns {
                    stmt.execute(params![machine, conv.id, t.id, t.seq, t.rev, t.data.len() as i64, t.cursor, t.data])?;
                }
            }
            resize(&tx, machine, &conv.id)?;
            tx.commit()?;
            self.evict(c, machine, keep)
        })
    }

    fn evict(&self, c: &mut Connection, machine: &str, keep: &[String]) -> rusqlite::Result<()> {
        let mut total = total(c)?;
        if total <= self.limit {
            return Ok(());
        }
        let candidates: Vec<(String, String, i64)> = {
            let mut stmt = c.prepare(
                "SELECT c.machine, c.id, SUM(t.size) FROM conversations c
                 JOIN turns t ON t.machine = c.machine AND t.conversation = c.id
                 GROUP BY c.machine, c.id ORDER BY c.opened_at",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            rows.filter(|r| !matches!(r, Ok((m, id, _)) if m == machine && keep.contains(id)))
                .collect::<rusqlite::Result<_>>()?
        };
        let tx = c.transaction()?;
        let count = candidates.len();
        for (i, (m, id, size)) in candidates.into_iter().enumerate() {
            if total <= self.target {
                break;
            }
            if i + 1 < count {
                tx.execute("DELETE FROM turns WHERE machine = ?1 AND conversation = ?2", params![m, id])?;
                total -= size;
            } else {
                // The last one keeps its newest turns. The oldest kept turn needs a cursor, or the
                // turns before it could never be fetched again.
                let rows: Vec<(String, i64, bool)> = {
                    let mut stmt =
                        tx.prepare("SELECT id, size, cursor IS NOT NULL FROM turns WHERE machine = ?1 AND conversation = ?2 ORDER BY seq")?;
                    let rows = stmt.query_map(params![m, id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
                    rows.collect::<rusqlite::Result<_>>()?
                };
                let mut drop = 0;
                while drop < rows.len() && (total > self.target || !rows[drop].2) {
                    total -= rows[drop].1;
                    drop += 1;
                }
                for (turn, _, _) in &rows[..drop] {
                    tx.execute("DELETE FROM turns WHERE machine = ?1 AND conversation = ?2 AND id = ?3", params![m, id, turn])?;
                }
            }
            // Without turns, the next open loads the newest page instead of changes since a revision.
            tx.execute(
                "UPDATE conversations SET sync_rev = 0 WHERE machine = ?1 AND id = ?2
                 AND NOT EXISTS (SELECT 1 FROM turns WHERE machine = ?1 AND conversation = ?2)",
                params![m, id],
            )?;
            resize(&tx, &m, &id)?;
        }
        tx.commit()
    }

    /// Deletes one conversation, or the machine's whole copy.
    pub fn remove(&self, machine: &str, id: Option<&str>) -> Result<(), String> {
        self.with(|c| {
            let tx = c.transaction()?;
            match id {
                Some(id) => {
                    tx.execute("DELETE FROM turns WHERE machine = ?1 AND conversation = ?2", params![machine, id])?;
                    tx.execute("DELETE FROM conversations WHERE machine = ?1 AND id = ?2", params![machine, id])?;
                }
                None => {
                    tx.execute("DELETE FROM turns WHERE machine = ?1", params![machine])?;
                    tx.execute("DELETE FROM conversations WHERE machine = ?1", params![machine])?;
                }
            }
            tx.commit()
        })
    }

    /// Deletes the machine's conversations that are not in `ids` (mobd's current list).
    pub fn prune(&self, machine: &str, ids: &[String]) -> Result<(), String> {
        let gone: Vec<String> = self.with(|c| {
            let mut stmt = c.prepare("SELECT id FROM conversations WHERE machine = ?1")?;
            let rows = stmt.query_map(params![machine], |r| r.get::<_, String>(0))?;
            rows.filter(|r| !matches!(r, Ok(id) if ids.contains(id))).collect()
        })?;
        for id in gone {
            self.remove(machine, Some(&id))?;
        }
        Ok(())
    }

    pub fn clear(&self) -> Result<(), String> {
        self.with(|c| {
            c.execute_batch("DELETE FROM turns; DELETE FROM conversations;")?;
            c.execute_batch("VACUUM")
        })
    }

    /// The bytes of saved conversations, as counted against the limit.
    pub fn size(&self) -> Result<i64, String> {
        self.with(|c| total(c))
    }
}

fn total(c: &Connection) -> rusqlite::Result<i64> {
    c.query_row("SELECT COALESCE(SUM(size), 0) FROM conversations", [], |r| r.get(0))
}

fn resize(c: &Connection, machine: &str, id: &str) -> rusqlite::Result<()> {
    c.execute(
        "UPDATE conversations SET size = length(session)
           + (SELECT COALESCE(SUM(size), 0) FROM turns WHERE machine = ?1 AND conversation = ?2)
         WHERE machine = ?1 AND id = ?2",
        params![machine, id],
    )?;
    Ok(())
}

fn corrupt(e: &rusqlite::Error) -> bool {
    matches!(e.sqlite_error_code(), Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase))
}

fn discard(path: &Path) {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut p = path.as_os_str().to_owned();
        p.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(p));
    }
}

/// Opens the copy, rebuilding it once when it is corrupt or from another schema version.
fn connect(path: &Path) -> Result<Connection, String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
        private(dir, 0o700);
    }
    match open(path) {
        Ok(c) => Ok(c),
        Err(_) => {
            discard(path);
            open(path).map_err(|e| format!("Could not open the local copy: {e}"))
        }
    }
}

fn open(path: &Path) -> rusqlite::Result<Connection> {
    let c = Connection::open(path)?;
    private(path, 0o600);
    let version: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version != 0 && version != SCHEMA {
        return Err(rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_NOTADB), Some("schema".into())));
    }
    let check: String = c.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if check != "ok" {
        return Err(rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CORRUPT), Some(check)));
    }
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS conversations (
           machine TEXT NOT NULL, id TEXT NOT NULL, session TEXT NOT NULL, sync_rev INTEGER NOT NULL,
           opened_at INTEGER NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (machine, id));
         CREATE TABLE IF NOT EXISTS turns (
           machine TEXT NOT NULL, conversation TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL,
           rev INTEGER NOT NULL, size INTEGER NOT NULL, cursor TEXT, data TEXT NOT NULL,
           PRIMARY KEY (machine, conversation, id));
         CREATE INDEX IF NOT EXISTS turns_seq ON turns (machine, conversation, seq);",
    )?;
    c.pragma_update(None, "user_version", SCHEMA)?;
    Ok(c)
}

#[cfg(unix)]
fn private(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn private(_: &Path, _: u32) {}

// Async commands run off the main thread; SQLite work is short and serialized by the mutex.

#[tauri::command]
pub async fn history_load(history: State<'_, History>, machine: String, id: String, before: Option<i64>, limit: i64) -> Result<Option<Saved>, String> {
    history.load(&machine, &id, before, limit)
}

#[tauri::command]
pub async fn history_list(history: State<'_, History>, machine: String) -> Result<Vec<String>, String> {
    history.list(&machine)
}

#[tauri::command]
pub async fn history_save(
    history: State<'_, History>,
    machine: String,
    conversation: Conversation,
    turns: Vec<Turn>,
    replace: bool,
    keep: Vec<String>,
) -> Result<(), String> {
    history.save(&machine, &conversation, &turns, replace, &keep)
}

#[tauri::command]
pub async fn history_remove(history: State<'_, History>, machine: String, id: Option<String>) -> Result<(), String> {
    history.remove(&machine, id.as_deref())
}

#[tauri::command]
pub async fn history_prune(history: State<'_, History>, machine: String, ids: Vec<String>) -> Result<(), String> {
    history.prune(&machine, &ids)
}

#[tauri::command]
pub async fn history_clear(history: State<'_, History>) -> Result<(), String> {
    history.clear()
}

#[tauri::command]
pub async fn history_size(history: State<'_, History>) -> Result<i64, String> {
    history.size()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mob-history-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("data").join("history.sqlite")
    }

    fn conv(id: &str, rev: i64) -> Conversation {
        Conversation { id: id.into(), session: format!("{{\"id\":\"{id}\"}}"), sync_rev: rev }
    }

    fn turn(id: &str, seq: i64, rev: i64, size: usize, cursor: Option<&str>) -> Turn {
        Turn { id: id.into(), seq, rev, cursor: cursor.map(Into::into), data: "x".repeat(size) }
    }

    fn seqs(h: &History, id: &str) -> Vec<i64> {
        h.load("m", id, Some(i64::MAX), 1000).unwrap().map(|s| s.turns.iter().map(|t| t.seq).collect()).unwrap_or_default()
    }

    #[test]
    fn saves_and_pages_turns_in_order() {
        let h = History::new(temp("pages"));
        let turns: Vec<_> = (1..=5).map(|i| turn(&format!("t{i}"), i, i, 10, (i == 2).then_some("c2"))).collect();
        h.save("m", &conv("s", 9), &turns[1..], true, &[]).unwrap();
        let s = h.load("m", "s", None, 2).unwrap().unwrap();
        assert_eq!((s.sync_rev, s.oldest, s.cursor.as_deref()), (9, Some(2), Some("c2")));
        assert_eq!(s.turns.iter().map(|t| t.seq).collect::<Vec<_>>(), vec![4, 5]);
        let older = h.load("m", "s", Some(4), 10).unwrap().unwrap();
        assert_eq!(older.turns.iter().map(|t| t.seq).collect::<Vec<_>>(), vec![2, 3]);
        assert!(h.load("m", "other", None, 2).unwrap().is_none());
        assert_eq!(h.list("m").unwrap(), vec!["{\"id\":\"s\"}".to_string()]);
    }

    #[test]
    fn keeps_the_newer_turn_and_its_cursor() {
        let h = History::new(temp("rev"));
        h.save("m", &conv("s", 1), &[turn("t1", 1, 5, 3, Some("c1"))], false, &[]).unwrap();
        h.save("m", &conv("s", 2), &[turn("t1", 1, 4, 9, None)], false, &[]).unwrap();
        assert_eq!(h.load("m", "s", None, 9).unwrap().unwrap().turns[0].data, "xxx");
        h.save("m", &conv("s", 3), &[turn("t1", 1, 6, 4, None)], false, &[]).unwrap();
        let s = h.load("m", "s", None, 9).unwrap().unwrap();
        assert_eq!((s.turns[0].data.as_str(), s.cursor.as_deref()), ("xxxx", Some("c1")));
        assert_eq!(h.size().unwrap(), 4 + "{\"id\":\"s\"}".len() as i64);
    }

    #[test]
    fn evicts_least_recently_opened_and_trims_the_last() {
        let mut h = History::new(temp("evict"));
        (h.limit, h.target) = (1000, 950);
        h.save("m", &conv("a", 1), &[turn("a1", 1, 1, 300, None)], false, &[]).unwrap();
        h.save("m", &conv("b", 1), &[turn("b1", 1, 1, 300, None)], false, &[]).unwrap();
        h.save("m", &conv("c", 1), &[turn("c1", 1, 1, 300, None)], false, &[]).unwrap();
        h.load("m", "a", None, 1).unwrap();
        // Over the limit: b was opened least recently; c is open, so it is kept.
        h.save("m", &conv("c", 2), &[turn("c2", 2, 2, 300, None)], false, &["c".into()]).unwrap();
        assert_eq!((seqs(&h, "a"), seqs(&h, "b"), seqs(&h, "c")), (vec![1], vec![], vec![1, 2]));
        assert_eq!(h.load("m", "b", None, 1).unwrap().unwrap().sync_rev, 0);
        assert_eq!(h.list("m").unwrap().len(), 3, "conversations stay listed");

        // One conversation alone over the limit keeps its newest turns, from one with a cursor.
        let mut h = History::new(temp("trim"));
        (h.limit, h.target) = (1000, 500);
        let turns: Vec<_> = (1..=6).map(|i| turn(&format!("t{i}"), i, 1, 200, [1, 3, 5].contains(&i).then_some("c"))).collect();
        h.save("m", &conv("s", 7), &turns, false, &[]).unwrap();
        assert_eq!(seqs(&h, "s"), vec![5, 6]);
        let s = h.load("m", "s", None, 9).unwrap().unwrap();
        assert_eq!((s.oldest, s.sync_rev), (Some(5), 7));
    }

    #[test]
    fn removes_prunes_and_clears() {
        let h = History::new(temp("remove"));
        for (m, id) in [("m", "a"), ("m", "b"), ("m", "c"), ("n", "a")] {
            h.save(m, &conv(id, 1), &[turn(&format!("{id}1"), 1, 1, 5, None)], false, &[]).unwrap();
        }
        h.remove("m", Some("a")).unwrap();
        h.prune("m", &["c".into()]).unwrap();
        assert_eq!(h.list("m").unwrap(), vec!["{\"id\":\"c\"}".to_string()]);
        h.remove("m", None).unwrap();
        assert!(h.list("m").unwrap().is_empty());
        assert_eq!(h.list("n").unwrap().len(), 1);
        h.clear().unwrap();
        assert_eq!(h.size().unwrap(), 0);
    }

    #[test]
    fn rebuilds_a_corrupt_or_foreign_file() {
        let path = temp("corrupt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"not a database at all, just text that is long enough").unwrap();
        let h = History::new(path.clone());
        h.save("m", &conv("s", 1), &[turn("t1", 1, 1, 5, None)], false, &[]).unwrap();
        assert_eq!(seqs(&h, "s"), vec![1]);
        drop(h);

        let c = Connection::open(&path).unwrap();
        c.pragma_update(None, "user_version", 99).unwrap();
        drop(c);
        let h = History::new(path);
        assert!(h.list("m").unwrap().is_empty(), "another schema version starts over");
    }

    #[cfg(unix)]
    #[test]
    fn the_copy_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp("mode");
        let h = History::new(path.clone());
        h.size().unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(path.parent().unwrap()), 0o700);
        assert_eq!(mode(&path), 0o600);
    }
}
