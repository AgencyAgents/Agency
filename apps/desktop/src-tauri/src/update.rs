//! Updates from the GitHub release feed. AGENCY_UPDATE_URL points a test build at a local feed; plain http
//! needs `dangerousInsecureTransportProtocol` from a build-time `--config`, and the signature check still applies.
//! The npm copy updates from npm instead (AGENCY_NPM_REGISTRY points it at a test registry): the installer would
//! add a second copy beside it.

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{ipc::Channel, AppHandle};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

#[derive(Clone)]
enum Found {
    Release(Update),
    Npm(String),
}

#[derive(Default)]
pub struct Pending(Mutex<Option<Found>>);

/// The package folder when this app runs from `node_modules/@endeavorai/agency/app`.
fn npm_package() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    if !exe.components().any(|c| c.as_os_str() == "node_modules") {
        return None;
    }
    Some(exe.parent()?.parent()?.to_path_buf())
}

fn newer(latest: &str, current: &str) -> bool {
    let parts = |v: &str| v.split(['.', '-']).take(3).map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    parts(latest) > parts(current)
}

async fn npm_latest() -> Result<String, String> {
    let registry = std::env::var("AGENCY_NPM_REGISTRY").unwrap_or_else(|_| "https://registry.npmjs.org".into());
    let url = format!("{}/@endeavorai%2Fagency/latest", registry.trim_end_matches('/'));
    let body: Value = crate::daemon::http_client()
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    body["version"].as_str().map(str::to_string).ok_or_else(|| "npm gave no version".into())
}

pub async fn check(app: &AppHandle, pending: &Pending) -> Result<Option<Value>, String> {
    let current = app.package_info().version.to_string();
    if npm_package().is_some() {
        let latest = npm_latest().await?;
        let found = newer(&latest, &current).then_some(latest);
        let info = found.as_ref().map(|v| json!({ "version": v, "current": current, "notes": null }));
        *pending.0.lock().await = found.map(Found::Npm);
        return Ok(info);
    }
    let mut builder = app.updater_builder();
    if let Ok(url) = std::env::var("AGENCY_UPDATE_URL") {
        let url = url.parse().map_err(|e| format!("AGENCY_UPDATE_URL: {e}"))?;
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    let updater = builder.build().map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| e.to_string())?;
    let info = found.as_ref().map(|u| json!({ "version": u.version, "current": u.current_version, "notes": u.body }));
    *pending.0.lock().await = found.map(Found::Release);
    Ok(info)
}

/// Downloads with progress on the channel, then installs. On Windows the installer closes the app and starts the new one.
pub async fn install(app: &AppHandle, pending: &Pending, progress: Channel<Value>) -> Result<(), String> {
    // A clone, not a take: "Try again" after a failed download needs the same update.
    let update = match pending.0.lock().await.clone().ok_or("No update is ready.")? {
        Found::Release(update) => update,
        Found::Npm(version) => return npm_install(app, &version, &progress),
    };
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

/// Windows locks the files of a running app, so the `agency` command installs once this app has quit, then opens it.
fn npm_install(app: &AppHandle, version: &str, progress: &Channel<Value>) -> Result<(), String> {
    let package = npm_package().ok_or("This copy is not from npm.")?;
    let mut command = std::process::Command::new("node");
    command.arg(package.join("agency.js")).args(["--after", &std::process::id().to_string(), "--to", version]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn().map_err(|e| format!("Could not start node to update: {e}"))?;
    let _ = progress.send(json!({ "phase": "install" }));
    app.exit(0);
    Ok(())
}
