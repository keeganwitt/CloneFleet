use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct LaunchTarget {
    pub app: PathBuf,
    pub args: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OpenTarget {
    FileManager,
    Terminal,
    Editor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    MacOs,
    Windows,
    Linux,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub current_dir: PathBuf,
}

pub fn expand_args(template: &str, repo: &Path) -> Vec<OsString> {
    let path = repo.as_os_str().to_string_lossy();
    template
        .split_whitespace()
        .map(|token| OsString::from(token.replace("{path}", &path)))
        .collect()
}

fn is_app_bundle(app: &Path) -> bool {
    app.extension().is_some_and(|ext| ext == "app")
}

pub fn plan_launch(target: &LaunchTarget, repo: &Path, platform: Platform) -> Launch {
    let template = target.args.trim();
    if platform == Platform::MacOs && is_app_bundle(&target.app) {
        let mut args: Vec<OsString> = vec!["-a".into(), target.app.clone().into()];
        if template.is_empty() || template == "{path}" {
            args.push(repo.into());
        } else {
            args.push("--args".into());
            args.extend(expand_args(template, repo));
        }
        return Launch {
            program: "open".into(),
            args,
            current_dir: repo.to_path_buf(),
        };
    }
    Launch {
        program: target.app.clone(),
        args: expand_args(template, repo),
        current_dir: repo.to_path_buf(),
    }
}

fn find_on_path(name: &str, path_env: Option<&OsString>) -> Option<PathBuf> {
    path_env
        .into_iter()
        .flat_map(std::env::split_paths)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

pub fn default_terminal(
    repo: &Path,
    platform: Platform,
    path_env: Option<&OsString>,
    terminal_env: Option<OsString>,
) -> Launch {
    let launch = |program: PathBuf, args: Vec<OsString>| Launch {
        program,
        args,
        current_dir: repo.to_path_buf(),
    };
    match platform {
        Platform::MacOs => launch(
            "open".into(),
            vec!["-a".into(), "Terminal".into(), repo.into()],
        ),
        Platform::Windows => match find_on_path("wt.exe", path_env) {
            Some(wt) => launch(wt, vec!["-d".into(), repo.into()]),
            None => launch("cmd.exe".into(), vec!["/K".into()]),
        },
        Platform::Linux => {
            let program = terminal_env
                .filter(|t| !t.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| "x-terminal-emulator".into());
            launch(program, Vec::new())
        }
    }
}

pub fn spawn(launch: &Launch) -> std::io::Result<()> {
    Command::new(&launch.program)
        .args(&launch.args)
        .current_dir(&launch.current_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
}

pub fn is_web_url(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    #[test]
    fn expands_the_path_placeholder_as_a_single_argument() {
        let repo = Path::new("/src/my repo");
        assert_eq!(
            expand_args("--new-window {path}", repo),
            os(&["--new-window", "/src/my repo"])
        );
        assert_eq!(
            expand_args("--working-directory={path}", repo),
            os(&["--working-directory=/src/my repo"])
        );
        assert!(expand_args("   ", repo).is_empty());
    }

    #[test]
    fn opens_mac_app_bundles_with_open_dash_a() {
        let repo = Path::new("/src/repo");
        let ghostty = LaunchTarget {
            app: "/Applications/Ghostty.app".into(),
            args: String::new(),
        };
        let plan = plan_launch(&ghostty, repo, Platform::MacOs);
        assert_eq!(plan.program, PathBuf::from("open"));
        assert_eq!(
            plan.args,
            os(&["-a", "/Applications/Ghostty.app", "/src/repo"])
        );

        let with_args = LaunchTarget {
            args: "--working-directory={path}".into(),
            ..ghostty
        };
        assert_eq!(
            plan_launch(&with_args, repo, Platform::MacOs).args,
            os(&[
                "-a",
                "/Applications/Ghostty.app",
                "--args",
                "--working-directory=/src/repo"
            ])
        );
    }

    #[test]
    fn runs_executables_from_the_repository_directory() {
        let repo = Path::new("/src/repo");
        let code = LaunchTarget {
            app: "/usr/local/bin/code".into(),
            args: "{path}".into(),
        };
        for platform in [Platform::MacOs, Platform::Linux, Platform::Windows] {
            let plan = plan_launch(&code, repo, platform);
            assert_eq!(plan.program, PathBuf::from("/usr/local/bin/code"));
            assert_eq!(plan.args, os(&["/src/repo"]));
            assert_eq!(plan.current_dir, repo);
        }
        let terminal = LaunchTarget {
            app: "/usr/bin/kitty".into(),
            args: String::new(),
        };
        assert!(
            plan_launch(&terminal, repo, Platform::Linux)
                .args
                .is_empty()
        );
    }

    #[test]
    fn picks_a_default_terminal_per_platform() {
        let repo = Path::new("/src/repo");
        let mac = default_terminal(repo, Platform::MacOs, None, None);
        assert_eq!(mac.args, os(&["-a", "Terminal", "/src/repo"]));

        let dir = tempfile::tempdir().unwrap();
        let path_env = std::env::join_paths([dir.path()]).unwrap();
        assert_eq!(
            default_terminal(repo, Platform::Windows, Some(&path_env), None).program,
            PathBuf::from("cmd.exe")
        );
        std::fs::write(dir.path().join("wt.exe"), "").unwrap();
        let wt = default_terminal(repo, Platform::Windows, Some(&path_env), None);
        assert_eq!(wt.program, dir.path().join("wt.exe"));
        assert_eq!(wt.args, os(&["-d", "/src/repo"]));

        assert_eq!(
            default_terminal(repo, Platform::Linux, None, Some("alacritty".into())).program,
            PathBuf::from("alacritty")
        );
        let fallback = default_terminal(repo, Platform::Linux, None, None);
        assert_eq!(fallback.program, PathBuf::from("x-terminal-emulator"));
        assert_eq!(fallback.current_dir, repo);
    }

    #[test]
    fn only_opens_web_urls() {
        assert!(is_web_url("https://gitlab.example.com/group/repo"));
        assert!(!is_web_url("file:///etc/passwd"));
        assert!(!is_web_url("javascript:alert(1)"));
    }
}
