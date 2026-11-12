use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;

use crate::store::BranchSettings;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(300);
const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);
const NETWORK_COMMANDS: &[&str] = &["fetch", "pull", "push", "ls-remote", "clone"];

fn subcommand<'a>(args: &[&'a str]) -> Option<&'a str> {
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match *arg {
            "-c" | "-C" => {
                rest.next();
            }
            option if option.starts_with('-') => {}
            command => return Some(command),
        }
    }
    None
}

fn timeout_for(args: &[&str]) -> Duration {
    match subcommand(args) {
        Some(command) if NETWORK_COMMANDS.contains(&command) => NETWORK_TIMEOUT,
        Some("remote") if args.contains(&"set-head") => NETWORK_TIMEOUT,
        _ => COMMAND_TIMEOUT,
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandRecord {
    pub args: Vec<String>,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl CommandRecord {
    pub fn success(&self) -> bool {
        self.exit_code == Some(0)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("failed to run git ({0}); check its location in Settings")]
    Spawn(#[from] std::io::Error),
    #[error("git {args} timed out after {seconds}s")]
    Timeout { args: String, seconds: u64 },
    #[error("git {args} failed: {message}")]
    Failed { args: String, message: String },
}

pub struct Git {
    program: PathBuf,
    repo: PathBuf,
    settings: BranchSettings,
    log: Vec<CommandRecord>,
}

impl Git {
    #[cfg(test)]
    pub fn new(repo: impl Into<PathBuf>) -> Self {
        Self::with_settings(repo, BranchSettings::default())
    }

    pub fn with_settings(repo: impl Into<PathBuf>, settings: BranchSettings) -> Self {
        Self {
            program: PathBuf::from("git"),
            repo: repo.into(),
            settings,
            log: Vec::new(),
        }
    }

    pub fn with_program(mut self, program: impl Into<PathBuf>) -> Self {
        self.program = program.into();
        self
    }

    pub fn branch_settings(&self) -> &BranchSettings {
        &self.settings
    }

    pub fn into_log(self) -> Vec<CommandRecord> {
        self.log
    }

    pub async fn run(&mut self, args: &[&str]) -> Result<CommandRecord, GitError> {
        let mut command = Command::new(&self.program);
        command
            .arg("-C")
            .arg(&self.repo)
            .args(args)
            // With no terminal attached, a credential or passphrase prompt would hang forever.
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            // CREATE_NO_WINDOW: otherwise every git invocation flashes a console window.
            command.creation_flags(0x0800_0000);
        }

        let timeout = timeout_for(args);
        let output = tokio::time::timeout(timeout, command.output())
            .await
            .map_err(|_| GitError::Timeout {
                args: args.join(" "),
                seconds: timeout.as_secs(),
            })??;

        let record = CommandRecord {
            args: args.iter().map(|a| a.to_string()).collect(),
            exit_code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        };
        self.log.push(record.clone());
        Ok(record)
    }

    pub async fn run_ok(&mut self, args: &[&str]) -> Result<String, GitError> {
        let record = self.run(args).await?;
        if record.success() {
            Ok(record.stdout)
        } else {
            Err(GitError::Failed {
                args: args.join(" "),
                message: failure_message(&record),
            })
        }
    }

    pub async fn succeeds(&mut self, args: &[&str]) -> Result<bool, GitError> {
        Ok(self.run(args).await?.success())
    }
}

pub fn failure_message(record: &CommandRecord) -> String {
    let stderr = record.stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    let stdout = record.stdout.trim();
    if !stdout.is_empty() {
        return stdout.to_string();
    }
    match record.exit_code {
        Some(code) => format!("exited with status {code}"),
        None => "terminated by signal".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(code: Option<i32>, stdout: &str, stderr: &str) -> CommandRecord {
        CommandRecord {
            args: vec![],
            exit_code: code,
            stdout: stdout.into(),
            stderr: stderr.into(),
        }
    }

    #[test]
    fn network_commands_get_a_shorter_timeout() {
        assert_eq!(subcommand(&["-c", "x=y", "fetch", "origin"]), Some("fetch"));
        assert_eq!(subcommand(&["-C", "/dir", "status"]), Some("status"));
        assert_eq!(
            timeout_for(&["-c", "a=b", "fetch", "--prune"]),
            NETWORK_TIMEOUT
        );
        assert_eq!(
            timeout_for(&["remote", "set-head", "origin", "--auto"]),
            NETWORK_TIMEOUT
        );
        assert_eq!(timeout_for(&["status", "--porcelain=v2"]), COMMAND_TIMEOUT);
    }

    #[test]
    fn failure_message_prefers_stderr() {
        assert_eq!(failure_message(&record(Some(1), "out", " err \n")), "err");
    }

    #[test]
    fn failure_message_falls_back_to_stdout_then_status() {
        assert_eq!(failure_message(&record(Some(1), "out\n", "")), "out");
        assert_eq!(
            failure_message(&record(Some(128), "", "")),
            "exited with status 128"
        );
        assert_eq!(
            failure_message(&record(None, "", "")),
            "terminated by signal"
        );
    }

    #[tokio::test]
    async fn run_records_each_command() {
        let dir = tempfile::tempdir().unwrap();
        let mut git = Git::new(dir.path());
        let record = git.run(&["--version"]).await.unwrap();
        assert!(record.success());
        assert!(record.stdout.starts_with("git version"));
        assert!(!git.succeeds(&["rev-parse", "--git-dir"]).await.unwrap());
        assert_eq!(git.into_log().len(), 2);
    }

    #[tokio::test]
    async fn reports_a_missing_git_program_helpfully() {
        let dir = tempfile::tempdir().unwrap();
        let mut git = Git::new(dir.path()).with_program(dir.path().join("no-such-git"));
        let error = git.run(&["--version"]).await.unwrap_err();
        assert!(
            error.to_string().contains("check its location in Settings"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn run_ok_returns_error_with_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let mut git = Git::new(dir.path());
        let err = git.run_ok(&["rev-parse", "--git-dir"]).await.unwrap_err();
        assert!(err.to_string().contains("not a git repository"), "{err}");
    }
}
