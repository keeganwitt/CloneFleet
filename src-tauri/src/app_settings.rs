use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::launch::LaunchTarget;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub git_path: Option<PathBuf>,
    pub theme: Theme,
    pub reopen_last: bool,
    pub remember_recent: bool,
    pub terminal: Option<LaunchTarget>,
    pub editor: Option<LaunchTarget>,
    pub web_hosts: Vec<WebHost>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct WebHost {
    pub host: String,
    pub web_url: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            git_path: None,
            theme: Theme::System,
            reopen_last: true,
            remember_recent: true,
            terminal: None,
            editor: None,
            web_hosts: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub path: Option<PathBuf>,
    pub version: Option<String>,
    pub error: Option<String>,
}

fn executable_name() -> &'static str {
    if cfg!(windows) { "git.exe" } else { "git" }
}

fn preferred_locations() -> Vec<PathBuf> {
    if cfg!(target_os = "macos") {
        // GUI apps on macOS get a minimal PATH without Homebrew, so check its prefixes first.
        vec!["/opt/homebrew/bin/git".into(), "/usr/local/bin/git".into()]
    } else {
        Vec::new()
    }
}

fn fallback_locations() -> Vec<PathBuf> {
    if cfg!(windows) {
        let program_files =
            std::env::var_os("ProgramFiles").unwrap_or_else(|| "C:\\Program Files".into());
        vec![PathBuf::from(program_files).join("Git\\cmd\\git.exe")]
    } else {
        vec!["/usr/bin/git".into(), "/usr/local/bin/git".into()]
    }
}

pub fn detect_git(path_env: Option<OsString>) -> Option<PathBuf> {
    let on_path = path_env
        .iter()
        .flat_map(std::env::split_paths)
        .map(|dir| dir.join(executable_name()));
    preferred_locations()
        .into_iter()
        .chain(on_path)
        .chain(fallback_locations())
        .find(|candidate| candidate.is_file())
}

pub async fn git_info(program: Option<&Path>) -> GitInfo {
    let Some(program) = program else {
        return GitInfo {
            path: None,
            version: None,
            error: Some("git was not found; set its location in Settings".into()),
        };
    };
    let output = Command::new(program)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .await;
    match output {
        Ok(output) if output.status.success() => GitInfo {
            path: Some(program.to_path_buf()),
            version: Some(String::from_utf8_lossy(&output.stdout).trim().to_string()),
            error: None,
        },
        Ok(output) => GitInfo {
            path: Some(program.to_path_buf()),
            version: None,
            error: Some(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        },
        Err(error) => GitInfo {
            path: Some(program.to_path_buf()),
            version: None,
            error: Some(format!("Could not run {}: {error}", program.display())),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn detects_git_on_the_search_path() {
        let dir = tempfile::tempdir().unwrap();
        let empty = dir.path().join("empty");
        let bin = dir.path().join("bin");
        fs::create_dir_all(&empty).unwrap();
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join(executable_name()), "").unwrap();
        let path_env = std::env::join_paths([&empty, &bin]).unwrap();

        let found = detect_git(Some(path_env)).unwrap();
        let preferred = preferred_locations().into_iter().find(|p| p.is_file());
        assert_eq!(found, preferred.unwrap_or(bin.join(executable_name())));
    }

    #[tokio::test]
    async fn reports_the_version_of_a_working_git() {
        let detected = detect_git(std::env::var_os("PATH"));
        let info = git_info(detected.as_deref()).await;
        assert!(info.version.unwrap().starts_with("git version"));
        assert_eq!(info.error, None);
    }

    #[tokio::test]
    async fn reports_errors_for_missing_or_broken_git() {
        let missing = git_info(None).await;
        assert!(missing.error.unwrap().contains("not found"));

        let dir = tempfile::tempdir().unwrap();
        let bogus = dir.path().join("not-git");
        let broken = git_info(Some(&bogus)).await;
        assert_eq!(broken.version, None);
        assert!(broken.error.unwrap().starts_with("Could not run"));
    }

    #[test]
    fn settings_default_to_detected_git_and_system_theme() {
        let settings: AppSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings, AppSettings::default());
        assert_eq!(settings.theme, Theme::System);
        assert!(settings.reopen_last);
        assert!(settings.remember_recent);
        let dark: AppSettings = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(dark.theme, Theme::Dark);
    }
}
