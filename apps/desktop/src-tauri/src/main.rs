#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod daemon;
mod host;
mod update;
mod workflows;

use std::sync::Arc;

use serde_json::Value;
use tauri::{ipc::Channel, AppHandle, Emitter, Manager, State};

type Daemons = Arc<daemon::Daemons>;

/// AGENCY_HOME isolates the app with the CLI it runs: tests point both at one temp dir.
fn data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    match std::env::var_os("AGENCY_HOME") {
        Some(home) => Ok(std::path::PathBuf::from(home).join("desktop")),
        None => app.path().app_data_dir().map_err(|e| e.to_string()),
    }
}

/// The first folder among the arguments of a launch.
fn folder_arg(args: impl IntoIterator<Item = String>) -> Option<String> {
    args.into_iter().skip(1).find(|a| !a.starts_with('-') && std::path::Path::new(a).is_dir())
}

/// The folder this process was started with; taken once, so a webview reload does not reopen it.
struct LaunchPath(std::sync::Mutex<Option<String>>);

#[tauri::command]
fn launch_path(launch: State<'_, LaunchPath>) -> Option<String> {
    launch.0.lock().ok()?.take()
}

#[tauri::command]
fn projects_list(app: AppHandle) -> Result<Vec<host::Project>, String> {
    Ok(host::load_projects(&data_dir(&app)?))
}

#[tauri::command]
fn projects_add(app: AppHandle, path: String) -> Result<host::Project, String> {
    let dir = data_dir(&app)?;
    let project = host::project_for(&path)?;
    let mut projects = host::load_projects(&dir);
    if !projects.iter().any(|p| p.path == project.path) {
        projects.push(project.clone());
        host::save_projects(&dir, &projects)?;
    }
    Ok(project)
}

#[tauri::command]
fn projects_remove(app: AppHandle, path: String) -> Result<(), String> {
    let dir = data_dir(&app)?;
    let projects: Vec<_> = host::load_projects(&dir).into_iter().filter(|p| p.path != path).collect();
    host::save_projects(&dir, &projects)
}

#[tauri::command]
async fn daemon_connect(daemons: State<'_, Daemons>, root: String, on_event: Channel<Value>) -> Result<(), String> {
    daemons.inner().connect(root, on_event).await;
    Ok(())
}

#[tauri::command]
async fn daemon_restart(daemons: State<'_, Daemons>, root: String) -> Result<(), String> {
    daemons.restart(&root).await;
    Ok(())
}

#[tauri::command]
async fn rpc(daemons: State<'_, Daemons>, root: String, method: String, params: Value) -> Result<Value, Value> {
    daemons.rpc(&root, &method, params).await
}

#[tauri::command]
async fn git_status(root: String) -> Result<Value, String> {
    host::git_status(&root).await
}

#[tauri::command]
async fn git_diff(root: String) -> Result<Value, String> {
    host::git_diff(&root).await
}

#[tauri::command]
async fn git_commit(root: String, message: String, paths: Vec<String>) -> Result<String, String> {
    host::git_commit(&root, &message, &paths).await
}

#[tauri::command]
async fn git_push(root: String) -> Result<(), String> {
    host::git_push(&root).await
}

#[tauri::command]
async fn git_switch(root: String, branch: String) -> Result<(), String> {
    host::git_switch(&root, &branch).await
}

#[tauri::command]
async fn pr_create(root: String) -> Result<String, String> {
    host::pr_create(&root).await
}

#[tauri::command]
async fn files_list(root: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || host::list_files(&root, 50_000)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_in(root: String, target: String) -> Result<(), String> {
    host::open_in(&root, &target).await
}

#[tauri::command]
async fn trust(root: String) -> Result<(), String> {
    host::trust(&root).await
}

#[tauri::command]
async fn update_check(app: AppHandle, pending: State<'_, update::Pending>) -> Result<Option<Value>, String> {
    update::check(&app, &pending).await
}

#[tauri::command]
async fn update_install(app: AppHandle, pending: State<'_, update::Pending>, on_progress: Channel<Value>) -> Result<(), String> {
    update::install(&app, &pending, on_progress).await
}

#[tauri::command]
async fn workflows_list(root: String) -> Result<Vec<Value>, String> {
    Ok(workflows::list(&root))
}

#[tauri::command]
async fn workflow_save(root: String, workflow: Value) -> Result<(), String> {
    workflows::save(&root, &workflow)
}

#[tauri::command]
async fn workflow_delete(root: String, id: String) -> Result<(), String> {
    workflows::delete(&root, &id)
}

#[tauri::command]
async fn workflow_runs(app: AppHandle, root: String, id: String) -> Result<Vec<Value>, String> {
    workflows::runs(&data_dir(&app)?, &root, &id)
}

#[tauri::command]
async fn workflow_run_save(app: AppHandle, root: String, id: String, run: Value) -> Result<(), String> {
    workflows::save_run(&data_dir(&app)?, &root, &id, run)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            if let Some(path) = folder_arg(args) {
                let _ = app.emit("open-path", path);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Arc::new(daemon::Daemons::new()))
        .manage(update::Pending::default())
        .manage(LaunchPath(std::sync::Mutex::new(folder_arg(std::env::args()))))
        .invoke_handler(tauri::generate_handler![
            projects_list,
            projects_add,
            projects_remove,
            launch_path,
            daemon_connect,
            daemon_restart,
            rpc,
            git_status,
            git_diff,
            git_commit,
            git_push,
            git_switch,
            pr_create,
            files_list,
            open_in,
            trust,
            update_check,
            update_install,
            workflows_list,
            workflow_save,
            workflow_delete,
            workflow_runs,
            workflow_run_save,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Agency app");
}
