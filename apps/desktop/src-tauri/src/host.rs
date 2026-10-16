//! Work the daemon has no RPC for: the project list, git, the file list behind `@`, and opening other apps.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::daemon::{agency_bin, command};

#[derive(Clone, Serialize, Deserialize)]
pub struct Project {
    pub path: String,
    pub name: String,
}

pub fn projects_file(data_dir: &Path) -> PathBuf {
    data_dir.join("projects.json")
}

pub fn load_projects(data_dir: &Path) -> Vec<Project> {
    std::fs::read_to_string(projects_file(data_dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_projects(data_dir: &Path, projects: &[Project]) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let file = projects_file(data_dir);
    let temp = file.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_vec_pretty(projects).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &file).map_err(|e| e.to_string())
}

pub fn project_for(path: &str) -> Result<Project, String> {
    let dir = PathBuf::from(path);
    if !dir.is_dir() {
        return Err(format!("{path} is not a folder."));
    }
    let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.to_string());
    Ok(Project { path: dir.to_string_lossy().to_string(), name })
}

pub struct Run {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub async fn run(program: &str, root: &str, args: &[&str]) -> Result<Run, String> {
    let output = command(Path::new(program))
        .current_dir(root)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("Could not run {program}: {e}"))?;
    Ok(Run {
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

async fn git(root: &str, args: &[&str]) -> Result<String, String> {
    let out = run("git", root, args).await?;
    if out.code != 0 {
        return Err(if out.stderr.is_empty() { format!("git {} failed", args.join(" ")) } else { out.stderr });
    }
    Ok(out.stdout)
}

/// Branch, last commit and the changed files with their line counts.
pub async fn git_status(root: &str) -> Result<Value, String> {
    if git(root, &["rev-parse", "--is-inside-work-tree"]).await.is_err() {
        return Ok(json!({ "repo": false }));
    }
    let branch = git(root, &["branch", "--show-current"]).await.unwrap_or_default().trim().to_string();
    let last = git(root, &["log", "-1", "--format=%h%x00%s%x00%cr"]).await.unwrap_or_default();
    let mut last = last.trim().splitn(3, '\0');
    let (hash, subject, when) = (last.next().unwrap_or(""), last.next().unwrap_or(""), last.next().unwrap_or(""));
    let upstream = git(root, &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).await.ok();
    let (ahead, behind) = upstream
        .map(|counts| {
            let mut it = counts.split_whitespace().map(|n| n.parse::<u64>().unwrap_or(0));
            (it.next().unwrap_or(0), it.next().unwrap_or(0))
        })
        .unwrap_or((0, 0));

    let mut counts = std::collections::HashMap::new();
    for line in git(root, &["diff", "HEAD", "--numstat", "-z"]).await.unwrap_or_default().split('\0') {
        let mut parts = line.splitn(3, '\t');
        if let (Some(add), Some(del), Some(path)) = (parts.next(), parts.next(), parts.next()) {
            counts.insert(path.to_string(), (add.parse::<u64>().ok(), del.parse::<u64>().ok()));
        }
    }
    let mut files = Vec::new();
    for entry in git(root, &["status", "--porcelain=v1", "-z", "--untracked-files=all"]).await?.split('\0') {
        if entry.len() < 4 {
            continue;
        }
        let (code, path) = entry.split_at(3);
        let code = code.trim();
        let (add, del) = match counts.get(path) {
            Some(found) => *found,
            None if code == "??" => (std::fs::read_to_string(Path::new(root).join(path)).ok().map(|t| t.lines().count() as u64), Some(0)),
            None => (None, None),
        };
        files.push(json!({ "path": path.replace('\\', "/"), "status": code, "added": add, "deleted": del }));
    }
    let branches: Vec<String> =
        git(root, &["branch", "--format=%(refname:short)"]).await.unwrap_or_default().lines().map(str::to_string).collect();
    Ok(json!({
        "repo": true,
        "branch": branch,
        "branches": branches,
        "ahead": ahead,
        "behind": behind,
        "lastCommit": { "hash": hash, "subject": subject, "when": when },
        "files": files,
    }))
}

/// The unified diff against HEAD, plus the text of untracked files (git has no diff for them without touching the index).
pub async fn git_diff(root: &str) -> Result<Value, String> {
    let diff = git(root, &["diff", "HEAD", "--no-color", "--no-ext-diff", "-U3"]).await.unwrap_or_default();
    let mut untracked = Vec::new();
    for path in git(root, &["ls-files", "--others", "--exclude-standard", "-z"]).await?.split('\0') {
        if path.is_empty() {
            continue;
        }
        let full = Path::new(root).join(path);
        let text = std::fs::read(&full).ok().filter(|b| b.len() <= 512 * 1024 && !b.contains(&0));
        untracked.push(json!({ "path": path.replace('\\', "/"), "text": text.map(|b| String::from_utf8_lossy(&b).to_string()) }));
    }
    Ok(json!({ "diff": diff, "untracked": untracked }))
}

pub async fn git_commit(root: &str, message: &str, paths: &[String]) -> Result<String, String> {
    let mut add = vec!["add", "--"];
    add.extend(paths.iter().map(String::as_str));
    git(root, &add).await?;
    let mut commit = vec!["commit", "-m", message, "--"];
    commit.extend(paths.iter().map(String::as_str));
    git(root, &commit).await?;
    Ok(git(root, &["rev-parse", "--short", "HEAD"]).await?.trim().to_string())
}

pub async fn git_push(root: &str) -> Result<(), String> {
    let has_upstream = git(root, &["rev-parse", "--abbrev-ref", "@{upstream}"]).await.is_ok();
    if has_upstream {
        git(root, &["push"]).await.map(|_| ())
    } else {
        git(root, &["push", "-u", "origin", "HEAD"]).await.map(|_| ())
    }
}

pub async fn git_switch(root: &str, branch: &str) -> Result<(), String> {
    git(root, &["switch", branch]).await.map(|_| ())
}

pub async fn pr_create(root: &str) -> Result<String, String> {
    let out = run("gh", root, &["pr", "create", "--fill"]).await?;
    if out.code != 0 {
        return Err(if out.stderr.is_empty() { "gh pr create failed".to_string() } else { out.stderr });
    }
    Ok(out.stdout.lines().rev().find(|l| l.starts_with("http")).unwrap_or("").to_string())
}

/// Workspace files for `@`, gitignore rules applied; the UI ranks them with fuzzysort.
pub fn list_files(root: &str, limit: usize) -> Vec<String> {
    let base = Path::new(root);
    let mut files = Vec::new();
    for entry in ignore::WalkBuilder::new(base).hidden(false).filter_entry(|e| e.file_name() != ".git").build().flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if let Ok(rel) = entry.path().strip_prefix(base) {
            files.push(rel.to_string_lossy().replace('\\', "/"));
        }
        if files.len() >= limit {
            break;
        }
    }
    files
}

pub async fn open_in(root: &str, target: &str) -> Result<(), String> {
    let spawn = |program: &str, args: &[&str]| -> Result<(), String> {
        let mut cmd = std::process::Command::new(program);
        cmd.args(args).current_dir(root);
        cmd.spawn().map(|_| ()).map_err(|e| format!("Could not open {target}: {e}"))
    };
    match (target, cfg!(windows)) {
        ("files", true) => spawn("explorer.exe", &[root]),
        ("files", false) => spawn(if cfg!(target_os = "macos") { "open" } else { "xdg-open" }, &[root]),
        ("vscode", true) => spawn("cmd", &["/c", "code", root]),
        ("vscode", false) => spawn("code", &[root]),
        ("zed", _) => spawn("zed", &[root]),
        ("terminal", true) => spawn("wt.exe", &["-d", root]).or_else(|_| spawn("cmd", &["/c", "start", "cmd", "/k", "cd", "/d", root])),
        ("terminal", false) if cfg!(target_os = "macos") => spawn("open", &["-a", "Terminal", root]),
        ("terminal", false) => spawn("x-terminal-emulator", &["--working-directory", root]),
        _ => Err(format!("Unknown target {target}")),
    }
}

pub async fn trust(root: &str) -> Result<(), String> {
    let program = agency_bin();
    let out = run(&program.to_string_lossy(), root, &["trust", "--workspace", root]).await?;
    if out.code != 0 {
        return Err(out.stderr);
    }
    Ok(())
}
