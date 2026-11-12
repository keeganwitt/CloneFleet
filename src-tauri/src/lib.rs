mod actions;
mod app_settings;
mod branches;
mod changes;
mod cleanup;
mod diff;
mod discovery;
mod fork;
mod git;
mod health;
mod launch;
mod remote_health;
mod remotes;
mod status;
mod store;
#[cfg(test)]
mod test_support;
mod unpushed;
mod workspace;

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::{Manager, State};
use tokio::sync::Semaphore;

use actions::{Action, ActionResult, RepoSummary};
use app_settings::{AppSettings, GitInfo};
use branches::BranchReport;
use changes::FileChange;
use cleanup::CleanupResult;
use diff::{BranchDiff, FileDiff};
use git::Git;
use health::RepoHealth;
use remote_health::{RemoteCheck, RemoteInfo};
use store::{BranchSettings, Config};
use unpushed::UnpushedReport;
use workspace::WorkspaceView;

const MAX_CONCURRENT_REPOS: usize = 8;

struct AppState {
    config_path: PathBuf,
    config: Mutex<Config>,
    repos: Mutex<BTreeSet<PathBuf>>,
    detected_git: Option<PathBuf>,
    permits: Arc<Semaphore>,
    cancelled_runs: Mutex<HashSet<u64>>,
}

impl AppState {
    fn new(config_path: PathBuf) -> std::io::Result<Self> {
        let mut config = Config::load(&config_path)?;
        if !config.settings.reopen_last {
            config.close_all();
        }
        Ok(Self {
            config_path,
            config: Mutex::new(config),
            repos: Mutex::new(BTreeSet::new()),
            detected_git: app_settings::detect_git(std::env::var_os("PATH")),
            permits: Arc::new(Semaphore::new(MAX_CONCURRENT_REPOS)),
            cancelled_runs: Mutex::new(HashSet::new()),
        })
    }

    fn update(&self, change: impl FnOnce(&mut Config)) -> Result<Config, String> {
        let mut config = self.config.lock().unwrap();
        let mut updated = config.clone();
        change(&mut updated);
        updated.save(&self.config_path).map_err(|e| e.to_string())?;
        *config = updated;
        Ok(config.clone())
    }

    async fn rescan(&self, config: Config) -> Result<WorkspaceView, String> {
        let scanned = config.clone();
        let repos =
            tokio::task::spawn_blocking(move || workspace::scan(&scanned.roots, &scanned.excluded))
                .await
                .map_err(|e| e.to_string())?;
        let view = workspace::view(&config, &repos);
        *self.repos.lock().unwrap() = repos;
        Ok(view)
    }

    async fn change_workspace(
        &self,
        change: impl FnOnce(&mut Config),
    ) -> Result<WorkspaceView, String> {
        let config = self.update(change)?;
        self.rescan(config).await
    }

    fn git(&self, path: &Path) -> Result<Git, String> {
        self.ensure_known(path)?;
        let config = self.config.lock().unwrap();
        let settings = config
            .branch_settings
            .get(path)
            .cloned()
            .unwrap_or_default();
        let git = Git::with_settings(path, settings);
        Ok(match self.git_program(&config.settings) {
            Some(program) => git.with_program(program),
            None => git,
        })
    }

    fn git_program(&self, settings: &AppSettings) -> Option<PathBuf> {
        settings
            .git_path
            .clone()
            .or_else(|| self.detected_git.clone())
    }

    async fn settings_view(&self) -> SettingsView {
        let settings = self.config.lock().unwrap().settings.clone();
        SettingsView {
            active_git: app_settings::git_info(self.git_program(&settings).as_deref()).await,
            detected_git: self.detected_git.clone(),
            settings,
        }
    }

    fn is_cancelled(&self, run_id: Option<u64>) -> bool {
        run_id.is_some_and(|id| self.cancelled_runs.lock().unwrap().contains(&id))
    }

    fn ensure_known(&self, path: &Path) -> Result<(), String> {
        if self.repos.lock().unwrap().contains(path) {
            Ok(())
        } else {
            Err(format!("{} is not in the repository list", path.display()))
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsView {
    settings: AppSettings,
    detected_git: Option<PathBuf>,
    active_git: GitInfo,
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<SettingsView, String> {
    Ok(state.settings_view().await)
}

#[tauri::command]
async fn check_git(path: PathBuf) -> GitInfo {
    app_settings::git_info(Some(&path)).await
}

#[tauri::command]
async fn set_settings(
    settings: AppSettings,
    state: State<'_, AppState>,
) -> Result<SettingsView, String> {
    if let Some(path) = &settings.git_path {
        let info = app_settings::git_info(Some(path)).await;
        if let Some(error) = info.error {
            return Err(format!("{} is not a working git: {error}", path.display()));
        }
    }
    state.update(|config| {
        config.settings = settings;
        if !config.settings.remember_recent {
            config.clear_recent();
        }
    })?;
    Ok(state.settings_view().await)
}

#[tauri::command]
fn open_repo(
    path: PathBuf,
    target: launch::OpenTarget,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.ensure_known(&path)?;
    let settings = state.config.lock().unwrap().settings.clone();
    let platform = launch::Platform::current();
    let plan = match target {
        launch::OpenTarget::FileManager => {
            return tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string());
        }
        launch::OpenTarget::Terminal => match &settings.terminal {
            Some(terminal) => launch::plan_launch(terminal, &path, platform),
            None => launch::default_terminal(
                &path,
                platform,
                std::env::var_os("PATH").as_ref(),
                std::env::var_os("TERMINAL"),
            ),
        },
        launch::OpenTarget::Editor => match &settings.editor {
            Some(editor) => launch::plan_launch(editor, &path, platform),
            None => return Err("Choose an editor in Settings first".into()),
        },
    };
    launch::spawn(&plan).map_err(|e| format!("Could not start {}: {e}", plan.program.display()))
}

#[tauri::command]
fn open_web(url: String) -> Result<(), String> {
    if !launch::is_web_url(&url) {
        return Err(format!("Not a web address: {url}"));
    }
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_text_file(path: PathBuf, contents: String) -> Result<(), String> {
    tokio::fs::write(&path, contents)
        .await
        .map_err(|e| format!("Could not save {}: {e}", path.display()))
}

#[tauri::command]
async fn load_workspace(state: State<'_, AppState>) -> Result<WorkspaceView, String> {
    let config = state.config.lock().unwrap().clone();
    state.rescan(config).await
}

#[tauri::command]
async fn open_directories(
    paths: Vec<PathBuf>,
    state: State<'_, AppState>,
) -> Result<WorkspaceView, String> {
    state
        .change_workspace(|config| {
            config.include_again(&paths);
            config.open(paths);
        })
        .await
}

#[tauri::command]
async fn open_recent(
    roots: Vec<PathBuf>,
    state: State<'_, AppState>,
) -> Result<WorkspaceView, String> {
    state.change_workspace(|config| config.open(roots)).await
}

#[tauri::command]
async fn clear_recent(state: State<'_, AppState>) -> Result<WorkspaceView, String> {
    state.change_workspace(Config::clear_recent).await
}

#[tauri::command]
async fn add_directories(
    paths: Vec<PathBuf>,
    state: State<'_, AppState>,
) -> Result<WorkspaceView, String> {
    state
        .change_workspace(|config| {
            config.include_again(&paths);
            config.add(paths);
        })
        .await
}

#[tauri::command]
async fn remove_directory(
    path: PathBuf,
    state: State<'_, AppState>,
) -> Result<WorkspaceView, String> {
    state
        .change_workspace(|config| config.remove_root(&path))
        .await
}

#[tauri::command]
async fn rescan_workspace(state: State<'_, AppState>) -> Result<WorkspaceView, String> {
    state.change_workspace(|_| {}).await
}

#[tauri::command]
async fn remove_repos(
    paths: Vec<PathBuf>,
    state: State<'_, AppState>,
) -> Result<WorkspaceView, String> {
    state.change_workspace(|config| config.exclude(paths)).await
}

#[tauri::command]
async fn restore_excluded(state: State<'_, AppState>) -> Result<WorkspaceView, String> {
    state
        .change_workspace(|config| {
            let roots = config.roots.clone();
            config.include_again(&roots);
        })
        .await
}

#[tauri::command]
async fn repo_summary(path: PathBuf, state: State<'_, AppState>) -> Result<RepoSummary, String> {
    let mut git = state.git(&path)?;
    let _permit = state.permits.acquire().await.map_err(|e| e.to_string())?;
    actions::summarize(&mut git)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_action(
    path: PathBuf,
    action: Action,
    run_id: Option<u64>,
    state: State<'_, AppState>,
) -> Result<ActionResult, String> {
    let git = state.git(&path)?;
    let _permit = state.permits.acquire().await.map_err(|e| e.to_string())?;
    if state.is_cancelled(run_id) {
        return Ok(actions::cancelled());
    }
    Ok(actions::run_action(git, &action).await)
}

#[tauri::command]
fn cancel_run(run_id: u64, state: State<'_, AppState>) {
    state.cancelled_runs.lock().unwrap().insert(run_id);
}

#[tauri::command]
async fn list_changes(
    path: PathBuf,
    state: State<'_, AppState>,
) -> Result<Vec<FileChange>, String> {
    let mut git = state.git(&path)?;
    let _permit = state.permits.acquire().await.map_err(|e| e.to_string())?;
    changes::list_changes(&mut git)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn analyze_branches(
    path: PathBuf,
    fetch: bool,
    state: State<'_, AppState>,
) -> Result<BranchReport, String> {
    let mut git = state.git(&path)?;
    let _permit = state.permits.acquire().await.map_err(|e| e.to_string())?;
    branches::analyze(&mut git, fetch)
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
    let git = state.git(&path)?;
    let _permit = state.permits.acquire().await.map_err(|e| e.to_string())?;
    cleanup::delete_branches(git, &branches, allow_unmerged)
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
    let git = state.git(&path)?;
    let _permit = state.permits.acquire().await.map_err(|e| e.to_string())?;
    cleanup::remove_worktrees(git, &worktrees, delete_branches)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn analyze_unpushed(
    path: PathBuf,
    fetch: bool,
    state: State<'_, AppState>,
) -> Result<UnpushedReport, String> {
    let mut git = state.git(&path)?;
    let _permit = state.permits.acquire().await.map_err(|e| e.to_string())?;
    unpushed::analyze_unpushed(&mut git, fetch)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn drop_stashes(
    path: PathBuf,
    stashes: Vec<String>,
    state: State<'_, AppState>,
) -> Result<CleanupResult, String> {
    let git = state.git(&path)?;
    let _permit = state.permits.acquire().await.map_err(|e| e.to_string())?;
    unpushed::drop_stashes(git, &stashes)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_branch_names(
    path: PathBuf,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let mut git = state.git(&path)?;
    let _permit = state.permits.acquire().await.map_err(|e| e.to_string())?;
    branches::branch_names(&mut git)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_branch_settings(
    path: PathBuf,
    settings: BranchSettings,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.ensure_known(&path)?;
    state.update(|config| {
        if settings.is_empty() {
            config.branch_settings.remove(&path);
        } else {
            config.branch_settings.insert(path, settings);
        }
    })?;
    Ok(())
}

#[tauri::command]
async fn get_branch_settings(
    path: PathBuf,
    state: State<'_, AppState>,
) -> Result<BranchSettings, String> {
    state.ensure_known(&path)?;
    Ok(state
        .config
        .lock()
        .unwrap()
        .branch_settings
        .get(&path)
        .cloned()
        .unwrap_or_default())
}

#[tauri::command]
async fn list_remotes(
    path: PathBuf,
    state: State<'_, AppState>,
) -> Result<Vec<RemoteInfo>, String> {
    let mut git = state.git(&path)?;
    remote_health::list_remotes(&mut git)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn check_remotes(
    path: PathBuf,
    state: State<'_, AppState>,
) -> Result<Vec<RemoteCheck>, String> {
    let mut git = state.git(&path)?;
    let _permit = state.permits.acquire().await.map_err(|e| e.to_string())?;
    remote_health::check_remotes(&mut git)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn repo_health(
    path: PathBuf,
    stale_days: u32,
    state: State<'_, AppState>,
) -> Result<RepoHealth, String> {
    let mut git = state.git(&path)?;
    let _permit = state.permits.acquire().await.map_err(|e| e.to_string())?;
    health::repo_health(&mut git, stale_days)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn branch_diff(
    path: PathBuf,
    branch: String,
    base: Option<String>,
    state: State<'_, AppState>,
) -> Result<BranchDiff, String> {
    let mut git = state.git(&path)?;
    let _permit = state.permits.acquire().await.map_err(|e| e.to_string())?;
    diff::branch_diff(&mut git, &branch, base.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn working_file_diff(
    path: PathBuf,
    file: String,
    untracked: bool,
    state: State<'_, AppState>,
) -> Result<FileDiff, String> {
    let mut git = state.git(&path)?;
    let _permit = state.permits.acquire().await.map_err(|e| e.to_string())?;
    diff::working_file_diff(&mut git, &file, untracked)
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
            get_settings,
            set_settings,
            check_git,
            save_text_file,
            open_repo,
            open_web,
            load_workspace,
            open_directories,
            open_recent,
            clear_recent,
            add_directories,
            remove_directory,
            rescan_workspace,
            remove_repos,
            restore_excluded,
            repo_summary,
            run_action,
            cancel_run,
            list_changes,
            analyze_branches,
            delete_branches,
            remove_worktrees,
            analyze_unpushed,
            drop_stashes,
            list_branch_names,
            get_branch_settings,
            set_branch_settings,
            repo_health,
            list_remotes,
            check_remotes,
            branch_diff,
            working_file_diff
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[tokio::test]
    async fn workspace_changes_persist_and_guard_known_repos() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.json");
        let root = dir.path().join("src");
        fs::create_dir_all(root.join("one/.git")).unwrap();
        fs::create_dir_all(root.join("two/.git")).unwrap();
        let state = AppState::new(config_path.clone()).unwrap();

        let view = state
            .change_workspace(|c| c.open(vec![root.clone()]))
            .await
            .unwrap();
        assert_eq!(view.repos, vec![root.join("one"), root.join("two")]);
        assert!(state.ensure_known(&root.join("one")).is_ok());
        assert!(state.ensure_known(Path::new("/elsewhere")).is_err());

        let view = state
            .change_workspace(|c| c.exclude([root.join("one")]))
            .await
            .unwrap();
        assert_eq!(view.repos, vec![root.join("two")]);
        assert!(state.ensure_known(&root.join("one")).is_err());

        let reloaded = AppState::new(config_path).unwrap();
        let config = reloaded.config.lock().unwrap().clone();
        let view = reloaded.rescan(config).await.unwrap();
        assert_eq!(view.repos, vec![root.join("two")]);
        assert_eq!(view.excluded_count, 1);
    }

    #[test]
    fn starts_with_no_directories_open_when_reopening_is_disabled() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.json");
        let mut config = Config::default();
        config.open(vec!["/a".into()]);
        config.settings.reopen_last = false;
        config.save(&config_path).unwrap();

        let state = AppState::new(config_path).unwrap();
        let config = state.config.lock().unwrap();
        assert!(config.roots.is_empty());
        assert_eq!(config.recent, vec![vec![PathBuf::from("/a")]]);
    }

    #[test]
    fn tracks_cancelled_runs() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().join("config.json")).unwrap();
        assert!(!state.is_cancelled(Some(1)));
        state.cancelled_runs.lock().unwrap().insert(1);
        assert!(state.is_cancelled(Some(1)));
        assert!(!state.is_cancelled(Some(2)));
        assert!(!state.is_cancelled(None));
    }

    #[test]
    fn failed_save_leaves_in_memory_config_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("config.json.tmp")).unwrap();
        let state = AppState::new(dir.path().join("config.json")).unwrap();

        assert!(state.update(|c| c.add(vec!["/a".into()])).is_err());
        assert!(state.config.lock().unwrap().roots.is_empty());
    }
}
