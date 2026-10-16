//! Updates from the GitHub release feed. AGENCY_UPDATE_URL points a test build at a local feed; plain http
//! needs `dangerousInsecureTransportProtocol` from a build-time `--config`, and the signature check still applies.

use serde_json::{json, Value};
use tauri::{ipc::Channel, AppHandle};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

pub async fn check(app: &AppHandle, pending: &Pending) -> Result<Option<Value>, String> {
    let mut builder = app.updater_builder();
    if let Ok(url) = std::env::var("AGENCY_UPDATE_URL") {
        let url = url.parse().map_err(|e| format!("AGENCY_UPDATE_URL: {e}"))?;
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    let updater = builder.build().map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| e.to_string())?;
    let info = found.as_ref().map(|u| json!({ "version": u.version, "current": u.current_version, "notes": u.body }));
    *pending.0.lock().await = found;
    Ok(info)
}

/// Downloads with progress on the channel, then installs. On Windows the installer closes the app and starts the new one.
pub async fn install(app: &AppHandle, pending: &Pending, progress: Channel<Value>) -> Result<(), String> {
    // A clone, not a take: "Try again" after a failed download needs the same update.
    let update = pending.0.lock().await.clone().ok_or("No update is ready.")?;
    let mut received: u64 = 0;
    update
        .download_and_install(
            |chunk, total| {
                received += chunk as u64;
                let _ = progress.send(json!({ "phase": "download", "received": received, "total": total }));
            },
            || {
                let _ = progress.send(json!({ "phase": "install" }));
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}
