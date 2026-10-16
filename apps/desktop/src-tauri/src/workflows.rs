//! Workflow files: definitions live in the project (`.agency/workflows`), run history in the app data dir.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;

const KEEP_RUNS: usize = 20;

/// Read-modify-write of a run file must not interleave with another save.
static RUNS_LOCK: Mutex<()> = Mutex::new(());

/// An id is a file name: lowercase letters, digits and dashes, 1 to 64 chars, no leading dash.
pub fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    (1..=64).contains(&b.len())
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn check_id(id: &str) -> Result<(), String> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(format!("\"{id}\" is not a valid workflow id."))
    }
}

fn definitions_dir(root: &str) -> PathBuf {
    Path::new(root).join(".agency").join("workflows")
}

/// FNV-1a: std's hasher may change between releases, and this name must stay put on disk.
fn root_hash(root: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in root.bytes() {
        h = (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

fn runs_file(data_dir: &Path, root: &str, id: &str) -> PathBuf {
    data_dir.join("workflow-runs").join(root_hash(root)).join(format!("{id}.json"))
}

fn write_atomic(file: &Path, value: &Value) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let temp = file.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&temp, file).map_err(|e| e.to_string())
}

pub fn list(root: &str) -> Vec<Value> {
    let Ok(dir) = std::fs::read_dir(definitions_dir(root)) else { return Vec::new() };
    let mut files: Vec<PathBuf> = dir
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    files
        .iter()
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .filter_map(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(Value::is_object)
        .collect()
}

pub fn save(root: &str, workflow: &Value) -> Result<(), String> {
    let id = workflow.get("id").and_then(Value::as_str).unwrap_or("");
    check_id(id)?;
    write_atomic(&definitions_dir(root).join(format!("{id}.json")), workflow)
}

pub fn delete(root: &str, id: &str) -> Result<(), String> {
    check_id(id)?;
    match std::fs::remove_file(definitions_dir(root).join(format!("{id}.json"))) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

pub fn runs(data_dir: &Path, root: &str, id: &str) -> Result<Vec<Value>, String> {
    check_id(id)?;
    Ok(std::fs::read_to_string(runs_file(data_dir, root, id))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default())
}

/// Replaces the run with the same `id` in place, else puts the run first; keeps the newest 20.
pub fn upsert_run(mut runs: Vec<Value>, run: Value) -> Vec<Value> {
    match runs.iter().position(|r| r.get("id").is_some() && r.get("id") == run.get("id")) {
        Some(i) => runs[i] = run,
        None => runs.insert(0, run),
    }
    runs.truncate(KEEP_RUNS);
    runs
}

pub fn save_run(data_dir: &Path, root: &str, id: &str, run: Value) -> Result<(), String> {
    if run.get("id").and_then(Value::as_str).is_none() {
        return Err("A run needs an id.".into());
    }
    let _guard = RUNS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let all = upsert_run(runs(data_dir, root, id)?, run);
    write_atomic(&runs_file(data_dir, root, id), &Value::Array(all))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ids() {
        for ok in ["a", "0", "fix-ci", "a-", "7e3af1c", &"a".repeat(64)] {
            assert!(valid_id(ok), "{ok}");
        }
        for bad in ["", "-a", "A", "a_b", "a b", "a/b", "..", "a.b", "é", &"a".repeat(65)] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn upsert_puts_new_first_and_replaces_in_place() {
        let runs = upsert_run(vec![], json!({ "id": "a", "status": "running" }));
        let runs = upsert_run(runs, json!({ "id": "b", "status": "running" }));
        assert_eq!(runs[0]["id"], "b");
        let runs = upsert_run(runs, json!({ "id": "a", "status": "passed" }));
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0]["id"], "b");
        assert_eq!(runs[1]["status"], "passed");
    }

    #[test]
    fn upsert_keeps_the_newest_twenty() {
        let mut runs = vec![];
        for n in 0..25 {
            runs = upsert_run(runs, json!({ "id": n.to_string() }));
        }
        assert_eq!(runs.len(), KEEP_RUNS);
        assert_eq!(runs[0]["id"], "24");
        assert_eq!(runs[19]["id"], "5");
    }

    #[test]
    fn files_round_trip() {
        let dir = std::env::temp_dir().join(format!("agency-wf-{}", std::process::id()));
        let root = dir.join("project");
        let root = root.to_str().unwrap();
        let data = dir.join("data");
        let wf = json!({ "id": "fix-ci", "name": "Fix CI", "trigger": "manual", "steps": [] });
        assert!(save(root, &json!({ "id": "../x" })).is_err());
        save(root, &wf).unwrap();
        std::fs::write(definitions_dir(root).join("broken.json"), "{").unwrap();
        assert_eq!(list(root), vec![wf]);
        delete(root, "fix-ci").unwrap();
        delete(root, "fix-ci").unwrap();
        assert!(list(root).is_empty());

        save_run(&data, root, "fix-ci", json!({ "id": "r1", "status": "running" })).unwrap();
        save_run(&data, root, "fix-ci", json!({ "id": "r1", "status": "passed" })).unwrap();
        let saved = runs(&data, root, "fix-ci").unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0]["status"], "passed");
        assert!(save_run(&data, root, "fix-ci", json!({})).is_err());
        assert!(runs(&data, root, "../x").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
