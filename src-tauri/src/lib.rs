mod actions;
mod branches;
mod changes;
mod cleanup;
mod discovery;
mod fork;
mod git;
mod remotes;
mod status;
mod store;
#[cfg(test)]
mod test_support;
mod unpushed;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::{Manager, State};
use tokio::sync::Semaphore;

use actions::{Action, ActionResult, RepoSummary};
use branches::BranchReport;
use changes::FileChange;
use cleanup::CleanupResult;
use git::Git;
use store::Config;
use unpushed::UnpushedReport;

const DISCOVERY_MAX_DEPTH: usize = 4;
const MAX_CONCURRENT_REPOS: usize = 8;

struct AppState {
    config_path: PathBuf,
    config: Mutex<Config>,
    permits: Arc<Semaphore>,
}

impl AppState {
    fn new(config_path: PathBuf) -> std::io::Result<Self> {
        let config = Config::load(&config_path)?;
        Ok(Self {
            config_path,
            config: Mutex::new(config),
            permits: Arc::new(Semaphore::new(MAX_CONCURRENT_REPOS)),
        })
    }

    fn repos(&self) -> Vec<PathBuf> {
        self.config.lock().unwrap().repos.iter().cloned().collect()
    }

    fn update(&self, change: impl FnOnce(&mut Config)) -> Result<Vec<PathBuf>, String> {
        let mut config = self.config.lock().unwrap();
        let mut updated = config.clone();
        change(&mut updated);
        updated.save(&self.config_path).map_err(|e| e.to_string())?;
        *config = updated;
        Ok(config.repos.iter().cloned().collect())
    }

    fn ensure_known(&self, path: &Path) -> Result<(), String> {
        if self.config.lock().unwrap().repos.contains(path) {
            Ok(())
        } else {
            Err(format!("{} is not in the repository list", path.display()))
        }
    }
}

#[tauri::command]
fn list_repos(state: State<'_, AppState>) -> Vec<PathBuf> {
    state.repos()
}

#[tauri::command]
async fn add_directory(path: PathBuf, state: State<'_, AppState>) -> Result<Vec<PathBuf>, String> {
    let found = tokio::task::spawn_blocking(move || {
        discovery::discover_repositories(&path, DISCOVERY_MAX_DEPTH)
    })
    .await
    .map_err(|e| e.to_string())?;
    state.update(|config| config.repos.extend(found))
}

#[tauri::command]
fn remove_repos(paths: Vec<PathBuf>, state: State<'_, AppState>) -> Result<Vec<PathBuf>, String> {
    state.update(|config| {
        for path in &paths {
            config.repos.remove(path);
        }
    })
}

#[tauri::command]
async fn repo_summary(path: PathBuf, state: State<'_, AppState>) -> Result<RepoSummary, String> {
    state.ensure_known(&path)?;
    let _permit = state.permits.acquire().await.map_err(|e| e.to_string())?;
    actions::summarize(&mut Git::new(path))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_action(
    path: PathBuf,
    action: Action,
    state: State<'_, AppState>,
) -> Result<ActionResult, String> {
    state.ensure_known(&path)?;
    let _permit = state.permits.acquire().await.map_err(|e| e.to_string())?;
    Ok(actions::run_action(Git::new(path), &action).await)
}

#[tauri::command]
async fn list_changes(
    path: PathBuf,
    state: State<'_, AppState>,
) -> Result<Vec<FileChange>, String> {
    state.ensure_known(&path)?;
    let _permit = state.permits.acquire().await.map_err(|e| e.to_string())?;
    changes::list_changes(&mut Git::new(path))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn analyze_branches(
    path: PathBuf,
    fetch: bool,
    state: State<'_, AppState>,
) -> Result<BranchReport, String> {
    state.ensure_known(&path)?;
    let _permit = state.permits.acquire().await.map_err(|e| e.to_string())?;
    branches::analyze(&mut Git::new(path), fetch)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_branches(
    path: PathBuf,
    branches: Vec<String>,
    allow_unmerged: bool,
    state: State<'_, AppState>,
) -> Result<CleanupResult, String> {
    state.ensure_known(&path)?;
    let _permit = state.permits.acquire().await.map_err(|e| e.to_string())?;
    cleanup::delete_branches(Git::new(path), &branches, allow_unmerged)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn remove_worktrees(
    path: PathBuf,
    worktrees: Vec<PathBuf>,
    delete_branches: bool,
    state: State<'_, AppState>,
) -> Result<CleanupResult, String> {
    state.ensure_known(&path)?;
    let _permit = state.permits.acquire().await.map_err(|e| e.to_string())?;
    cleanup::remove_worktrees(Git::new(path), &worktrees, delete_branches)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn analyze_unpushed(
    path: PathBuf,
    fetch: bool,
    state: State<'_, AppState>,
) -> Result<UnpushedReport, String> {
    state.ensure_known(&path)?;
    let _permit = state.permits.acquire().await.map_err(|e| e.to_string())?;
    unpushed::analyze_unpushed(&mut Git::new(path), fetch)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn drop_stashes(
    path: PathBuf,
    stashes: Vec<String>,
    state: State<'_, AppState>,
) -> Result<CleanupResult, String> {
    state.ensure_known(&path)?;
    let _permit = state.permits.acquire().await.map_err(|e| e.to_string())?;
    unpushed::drop_stashes(Git::new(path), &stashes)
        .await
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config_path = app.path().app_config_dir()?.join("config.json");
            app.manage(AppState::new(config_path)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_repos,
            add_directory,
            remove_repos,
            repo_summary,
            run_action,
            list_changes,
            analyze_branches,
            delete_branches,
            remove_worktrees,
            analyze_unpushed,
            drop_stashes
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_persists_and_ensure_known_guards_paths() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.json");
        let state = AppState::new(config_path.clone()).unwrap();

        let repos = state.update(|c| {
            c.repos.insert("/b".into());
            c.repos.insert("/a".into());
        });
        assert_eq!(
            repos.unwrap(),
            vec![PathBuf::from("/a"), PathBuf::from("/b")]
        );
        assert!(state.ensure_known(Path::new("/a")).is_ok());
        assert!(state.ensure_known(Path::new("/elsewhere")).is_err());

        let reloaded = AppState::new(config_path).unwrap();
        assert_eq!(reloaded.repos(), state.repos());
    }

    #[test]
    fn failed_save_leaves_in_memory_config_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("config.json.tmp")).unwrap();
        let state = AppState::new(dir.path().join("config.json")).unwrap();

        assert!(
            state
                .update(|c| {
                    c.repos.insert("/a".into());
                })
                .is_err()
        );
        assert!(state.repos().is_empty());
    }
}
