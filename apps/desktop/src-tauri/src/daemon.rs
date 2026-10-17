//! One daemon per project: started through `agency daemon start`, reached over its HTTP gateway.
//! The webview never sees the port or the token; events arrive on a per-project channel.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use futures_util::StreamExt;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tokio::sync::{Mutex, Notify};

#[derive(Clone)]
struct Conn {
    base: String,
    token: String,
}

struct Daemon {
    root: String,
    conn: Mutex<Option<Conn>>,
    channel: Mutex<Option<Channel<Value>>>,
    wake: Notify,
    /// A reloaded webview needs the `state` snapshot that only a new SSE connection sends.
    resubscribe: AtomicBool,
    pumping: AtomicBool,
}

enum Ended {
    Dropped { delivered: bool },
    Resubscribe,
    Restart,
}

impl Daemon {
    async fn emit(&self, value: Value) {
        if let Some(channel) = self.channel.lock().await.as_ref() {
            let _ = channel.send(value);
        }
    }

    async fn status(&self, state: &str, error: Option<String>) {
        self.emit(json!({ "kind": "status", "state": state, "error": error })).await;
    }
}

pub struct Daemons {
    agency: PathBuf,
    /// One config layer file per project: the environment the app chose for it.
    environments: PathBuf,
    http: reqwest::Client,
    map: Mutex<HashMap<String, Arc<Daemon>>>,
}

/// FNV-1a: a file name that stays the same for a root across builds, unlike the std hasher.
pub fn environment_file(dir: &std::path::Path, root: &str) -> PathBuf {
    let hash = root.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100_0000_01b3));
    dir.join(format!("{hash:016x}.json"))
}

/// The sidecar sits next to the app binary once installed; AGENCY_BIN points a dev build at another one.
pub fn agency_bin() -> PathBuf {
    if let Ok(path) = std::env::var("AGENCY_BIN") {
        return PathBuf::from(path);
    }
    let exe = std::env::current_exe().unwrap_or_default();
    let name = if cfg!(windows) { "agency.exe" } else { "agency" };
    exe.parent().map(|dir| dir.join(name)).unwrap_or_else(|| PathBuf::from(name))
}

pub fn command(program: &std::path::Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    cmd.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashes over the app
    cmd
}

fn last_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// The updater turns on reqwest's rustls without a default provider, so a plain client panics without one.
pub fn http_client() -> reqwest::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::new()
}

impl Daemons {
    pub fn new(environments: PathBuf) -> Self {
        Self { agency: agency_bin(), environments, http: http_client(), map: Mutex::new(HashMap::new()) }
    }

    /// Writes the project's environment layer; the daemon reads it when it next starts.
    pub fn set_environment(&self, root: &str, layer: &Value) -> Result<(), String> {
        std::fs::create_dir_all(&self.environments).map_err(|e| e.to_string())?;
        let text = serde_json::to_string_pretty(layer).map_err(|e| e.to_string())?;
        // A daemon that starts mid-write must read the old file or the new one, never half of one.
        let file = environment_file(&self.environments, root);
        let part = file.with_extension("json.part");
        std::fs::write(&part, text).map_err(|e| e.to_string())?;
        std::fs::rename(&part, &file).map_err(|e| e.to_string())
    }

    async fn ensure(&self, root: &str) -> Result<Conn, String> {
        let mut cmd = command(&self.agency);
        cmd.args(["daemon", "start", "--format", "json", "--workspace", root]);
        // The daemon leaves when this app does; a daemon that the CLI started stays.
        cmd.env("AGENCY_PARENT_PID", std::process::id().to_string());
        let layer = environment_file(&self.environments, root);
        if layer.exists() {
            cmd.env("AGENCY_CONFIG_OVERLAY", layer);
        }
        let output = cmd.output();
        let output = tokio::time::timeout(Duration::from_secs(60), output)
            .await
            .map_err(|_| "The daemon did not start within 60 seconds.".to_string())?
            .map_err(|e| format!("Could not run {}: {e}", self.agency.display()))?;
        if !output.status.success() {
            let reason = last_line(&output.stderr);
            return Err(if reason.is_empty() { last_line(&output.stdout) } else { reason });
        }
        let started: Value = serde_json::from_str(&last_line(&output.stdout)).map_err(|e| e.to_string())?;
        let port = started["httpPort"].as_u64().ok_or("The daemon has no HTTP gateway.")?;
        let file = started["instanceFile"].as_str().ok_or("The daemon gave no instance file.")?;
        let info: Value = serde_json::from_str(&std::fs::read_to_string(file).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        Ok(Conn {
            base: format!("http://127.0.0.1:{port}"),
            token: info["token"].as_str().unwrap_or_default().to_string(),
        })
    }

    async fn daemon(&self, root: &str) -> Arc<Daemon> {
        let mut map = self.map.lock().await;
        map.entry(root.to_string())
            .or_insert_with(|| {
                Arc::new(Daemon {
                    root: root.to_string(),
                    conn: Mutex::new(None),
                    channel: Mutex::new(None),
                    wake: Notify::new(),
                    resubscribe: AtomicBool::new(false),
                    pumping: AtomicBool::new(false),
                })
            })
            .clone()
    }

    /// Starts the root's daemon while the webview loads; its statuses wait for `connect`.
    pub async fn prestart(self: &Arc<Self>, root: String) {
        let daemon = self.daemon(&root).await;
        self.pump_once(daemon);
    }

    /// Attaches the webview's channel. A pump that ran without one sends its `up` and snapshot again.
    pub async fn connect(self: &Arc<Self>, root: String, channel: Channel<Value>) {
        let daemon = self.daemon(&root).await;
        daemon.channel.lock().await.replace(channel);
        if !self.pump_once(daemon.clone()) {
            daemon.resubscribe.store(true, Ordering::SeqCst);
            daemon.wake.notify_one();
        }
    }

    fn pump_once(self: &Arc<Self>, daemon: Arc<Daemon>) -> bool {
        if daemon.pumping.swap(true, Ordering::SeqCst) {
            return false;
        }
        let this = self.clone();
        tauri::async_runtime::spawn(async move { this.pump(daemon).await });
        true
    }

    pub async fn restart(&self, root: &str) {
        let daemon = self.daemon(root).await;
        daemon.conn.lock().await.take();
        daemon.wake.notify_one();
    }

    async fn pump(&self, daemon: Arc<Daemon>) {
        let mut backoff = Duration::from_millis(250);
        loop {
            daemon.status("connecting", None).await;
            let conn = match self.ensure(&daemon.root).await {
                Ok(conn) => conn,
                Err(error) => {
                    daemon.conn.lock().await.take();
                    daemon.status("down", Some(error)).await;
                    let _ = tokio::time::timeout(Duration::from_secs(5), daemon.wake.notified()).await;
                    continue;
                }
            };
            *daemon.conn.lock().await = Some(conn.clone());
            let mut last_id: Option<String> = None;
            loop {
                match self.stream(&daemon, &conn, &mut last_id).await {
                    Ended::Restart => break,
                    Ended::Resubscribe => continue,
                    Ended::Dropped { delivered } => {
                        if delivered {
                            backoff = Duration::from_millis(250);
                        }
                    }
                }
                if self.http.get(format!("{}/health", conn.base)).send().await.is_err() {
                    daemon.conn.lock().await.take();
                    break;
                }
                daemon.status("connecting", None).await;
                tokio::select! {
                    _ = tokio::time::sleep(backoff) => {}
                    _ = daemon.wake.notified() => {}
                }
                backoff = (backoff * 2).min(Duration::from_secs(5));
            }
        }
    }

    /// Reads one SSE connection until it drops, or until the webview or a restart needs a new one.
    async fn stream(&self, daemon: &Daemon, conn: &Conn, last_id: &mut Option<String>) -> Ended {
        daemon.resubscribe.store(false, Ordering::SeqCst);
        let mut request = self.http.get(format!("{}/events", conn.base)).bearer_auth(&conn.token);
        if let Some(id) = last_id.as_ref() {
            request = request.header("Last-Event-ID", id);
        }
        let response = match request.send().await {
            Ok(response) if response.status().is_success() => response,
            _ => return Ended::Dropped { delivered: false },
        };
        daemon.status("up", None).await;
        let mut body = response.bytes_stream();
        // Bytes, not text: a chunk can end inside a multi-byte character.
        let mut buffer: Vec<u8> = Vec::new();
        let mut delivered = false;
        loop {
            let chunk = tokio::select! {
                chunk = body.next() => chunk,
                _ = daemon.wake.notified() => {
                    if daemon.conn.lock().await.is_none() { return Ended::Restart; }
                    if daemon.resubscribe.load(Ordering::SeqCst) { return Ended::Resubscribe; }
                    continue;
                }
            };
            let Some(Ok(bytes)) = chunk else { return Ended::Dropped { delivered } };
            buffer.extend_from_slice(&bytes);
            while let Some(end) = buffer.windows(2).position(|pair| pair == b"\n\n") {
                let frame: Vec<u8> = buffer.drain(..end + 2).collect();
                if let Some(event) = parse_frame(&String::from_utf8_lossy(&frame), last_id) {
                    delivered = true;
                    daemon.emit(event).await;
                }
            }
        }
    }

    pub async fn rpc(&self, root: &str, method: &str, params: Value) -> Result<Value, Value> {
        let daemon = self.daemon(root).await;
        let conn = daemon.conn.lock().await.clone();
        let Some(conn) = conn else {
            return Err(json!({ "message": "The daemon is not running.", "code": "DAEMON_DOWN" }));
        };
        let response = self
            .http
            .post(format!("{}/rpc", conn.base))
            .bearer_auth(&conn.token)
            .json(&json!({ "id": 1, "method": method, "params": params }))
            .send()
            .await
            .map_err(|e| json!({ "message": format!("The daemon stopped answering: {e}"), "code": "DAEMON_DOWN" }))?;
        let body: Value = response.json().await.map_err(|e| json!({ "message": e.to_string() }))?;
        match body.get("error") {
            Some(error) if !error.is_null() => Err(error.clone()),
            _ => Ok(body.get("result").cloned().unwrap_or(Value::Null)),
        }
    }
}

fn parse_frame(frame: &str, last_id: &mut Option<String>) -> Option<Value> {
    let mut event = String::from("message");
    let mut data = String::new();
    let mut id = None;
    for line in frame.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
        } else if let Some(rest) = line.strip_prefix("event:") {
            event = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("id:") {
            id = Some(rest.trim().to_string());
        }
    }
    if data.is_empty() {
        return None;
    }
    if let Some(id) = id.clone() {
        *last_id = Some(id);
    }
    let data: Value = serde_json::from_str(&data).unwrap_or(Value::String(data));
    Some(json!({ "kind": "event", "id": id, "event": event, "data": data }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_an_http_client() {
        let _ = http_client();
    }

    #[test]
    fn parses_a_frame_and_keeps_its_id() {
        let mut last = None;
        let event = parse_frame("id: 7\nevent: turn.a\ndata: {\"type\":\"text_delta\",\"text\":\"hi\"}\n\n", &mut last);
        assert_eq!(last.as_deref(), Some("7"));
        let event = event.expect("a frame with data");
        assert_eq!(event["event"], "turn.a");
        assert_eq!(event["data"]["text"], "hi");
    }

    #[test]
    fn skips_comments_and_retry_hints() {
        let mut last = Some("3".to_string());
        assert!(parse_frame(": keepalive\n\n", &mut last).is_none());
        assert!(parse_frame("retry: 3000\n\n", &mut last).is_none());
        assert_eq!(last.as_deref(), Some("3"));
    }

    #[test]
    fn a_state_frame_has_no_id_and_leaves_the_last_one() {
        let mut last = Some("9".to_string());
        let event = parse_frame("event: state\ndata: {\"turns\":[]}\n\n", &mut last).expect("state");
        assert_eq!(event["event"], "state");
        assert!(event["id"].is_null());
        assert_eq!(last.as_deref(), Some("9"));
    }
}
