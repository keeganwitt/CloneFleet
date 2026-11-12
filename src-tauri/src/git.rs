use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(300);

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
    #[error("failed to run git: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("git {args} timed out after {seconds}s")]
    Timeout { args: String, seconds: u64 },
    #[error("git {args} failed: {message}")]
    Failed { args: String, message: String },
}

pub struct Git {
    repo: PathBuf,
    log: Vec<CommandRecord>,
}

impl Git {
    pub fn new(repo: impl Into<PathBuf>) -> Self {
        Self {
            repo: repo.into(),
            log: Vec::new(),
        }
    }

    pub fn into_log(self) -> Vec<CommandRecord> {
        self.log
    }

    pub async fn run(&mut self, args: &[&str]) -> Result<CommandRecord, GitError> {
        let mut command = Command::new("git");
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

        let output = tokio::time::timeout(COMMAND_TIMEOUT, command.output())
            .await
            .map_err(|_| GitError::Timeout {
                args: args.join(" "),
                seconds: COMMAND_TIMEOUT.as_secs(),
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
    async fn run_ok_returns_error_with_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let mut git = Git::new(dir.path());
        let err = git.run_ok(&["rev-parse", "--git-dir"]).await.unwrap_err();
        assert!(err.to_string().contains("not a git repository"), "{err}");
    }
}
