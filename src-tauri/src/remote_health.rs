use serde::Serialize;

use crate::actions::{FailureReason, Outcome, SkipReason, classify_failure};
use crate::git::{Git, GitError, failure_message};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub fetch_url: String,
    pub push_url: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RemoteStatus {
    Ok,
    Redirected,
    NotFound,
    AuthenticationRequired,
    Unreachable,
    Error,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCheck {
    pub name: String,
    pub status: RemoteStatus,
    pub redirect_url: Option<String>,
    pub message: Option<String>,
}

pub fn parse_remote_verbose(output: &str) -> Vec<RemoteInfo> {
    let mut remotes: Vec<RemoteInfo> = Vec::new();
    for line in output.lines() {
        let mut fields = line.split_whitespace();
        let (Some(name), Some(url), Some(kind)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let existing = remotes.iter().position(|r| r.name == name);
        let index = existing.unwrap_or_else(|| {
            remotes.push(RemoteInfo {
                name: name.to_string(),
                fetch_url: String::new(),
                push_url: None,
            });
            remotes.len() - 1
        });
        let remote = &mut remotes[index];
        match kind {
            "(fetch)" => remote.fetch_url = url.to_string(),
            "(push)" => remote.push_url = Some(url.to_string()),
            _ => {}
        }
    }
    for remote in &mut remotes {
        if remote.push_url.as_deref() == Some(remote.fetch_url.as_str()) {
            remote.push_url = None;
        }
    }
    remotes
}

pub fn parse_redirect(stderr: &str) -> Option<String> {
    stderr.lines().find_map(|line| {
        let url = line.trim().strip_prefix("warning: redirecting to ")?.trim();
        Some(url.trim_end_matches('/').to_string())
    })
}

pub async fn list_remotes(git: &mut Git) -> Result<Vec<RemoteInfo>, GitError> {
    Ok(parse_remote_verbose(&git.run_ok(&["remote", "-v"]).await?))
}

pub async fn check_remotes(git: &mut Git) -> Result<Vec<RemoteCheck>, GitError> {
    let remotes = list_remotes(git).await?;
    let mut checks = Vec::with_capacity(remotes.len());
    for remote in remotes {
        let record = git
            .run(&["ls-remote", "--heads", "--quiet", &remote.name])
            .await;
        let check = match record {
            Err(error) => RemoteCheck {
                name: remote.name,
                status: RemoteStatus::Unreachable,
                redirect_url: None,
                message: Some(error.to_string()),
            },
            Ok(record) if record.success() => {
                let redirect_url = parse_redirect(&record.stderr);
                RemoteCheck {
                    name: remote.name,
                    status: if redirect_url.is_some() {
                        RemoteStatus::Redirected
                    } else {
                        RemoteStatus::Ok
                    },
                    redirect_url,
                    message: None,
                }
            }
            Ok(record) => {
                let message = failure_message(&record);
                let status = match classify_failure(&message) {
                    Some(FailureReason::RepositoryNotFound) => RemoteStatus::NotFound,
                    Some(
                        FailureReason::AuthenticationRequired | FailureReason::HostKeyUnverified,
                    ) => RemoteStatus::AuthenticationRequired,
                    Some(FailureReason::NetworkUnreachable | FailureReason::TimedOut) => {
                        RemoteStatus::Unreachable
                    }
                    None => RemoteStatus::Error,
                };
                RemoteCheck {
                    name: remote.name,
                    status,
                    redirect_url: None,
                    message: Some(message),
                }
            }
        };
        checks.push(check);
    }
    Ok(checks)
}

pub async fn set_remote_url(git: &mut Git, remote: &str, url: &str) -> Result<Outcome, GitError> {
    let url = url.trim();
    if remote.starts_with('-') || url.starts_with('-') || url.is_empty() {
        return Ok(Outcome::failed("Invalid remote name or URL"));
    }
    let remotes = list_remotes(git).await?;
    let Some(current) = remotes.iter().find(|r| r.name == remote) else {
        return Ok(Outcome::skipped(
            SkipReason::NotFound,
            format!("No remote named {remote}"),
        ));
    };
    if current.fetch_url == url {
        return Ok(Outcome::succeeded(format!("{remote} already uses {url}")));
    }
    let updated = git.run(&["remote", "set-url", remote, url]).await?;
    Ok(if updated.success() {
        Outcome::succeeded(format!("{remote}: {} → {url}", current.fetch_url))
    } else {
        Outcome::failed(failure_message(&updated))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::Fixture;

    #[test]
    fn parses_remote_verbose_output() {
        let output = "\
origin\tgit@github.com:me/fork.git (fetch)
origin\tgit@github.com:me/fork.git (push)
upstream\thttps://github.com/org/repo.git (fetch)
upstream\tno_push (push)
";
        assert_eq!(
            parse_remote_verbose(output),
            vec![
                RemoteInfo {
                    name: "origin".into(),
                    fetch_url: "git@github.com:me/fork.git".into(),
                    push_url: None,
                },
                RemoteInfo {
                    name: "upstream".into(),
                    fetch_url: "https://github.com/org/repo.git".into(),
                    push_url: Some("no_push".into()),
                },
            ]
        );
    }

    #[test]
    fn parses_http_redirect_warnings() {
        assert_eq!(
            parse_redirect("warning: redirecting to https://github.com/new-org/repo.git/\n"),
            Some("https://github.com/new-org/repo.git".into())
        );
        assert_eq!(parse_redirect("some other warning\n"), None);
    }

    #[tokio::test]
    async fn checks_remotes_and_reports_missing_ones() {
        let fixture = Fixture::new();
        let missing = fixture.root().join("gone.git");
        fixture.git(
            &fixture.work,
            &["remote", "add", "gone", missing.to_str().unwrap()],
        );

        let checks = check_remotes(&mut Git::new(&fixture.work)).await.unwrap();
        let statuses: Vec<(&str, RemoteStatus)> =
            checks.iter().map(|c| (c.name.as_str(), c.status)).collect();
        assert_eq!(
            statuses,
            vec![
                ("gone", RemoteStatus::NotFound),
                ("origin", RemoteStatus::Ok)
            ]
        );
    }

    #[tokio::test]
    async fn sets_a_remote_url_and_validates_input() {
        let fixture = Fixture::new();
        let mut git = Git::new(&fixture.work);
        let moved = fixture.root().join("moved.git");
        let moved = moved.to_str().unwrap();

        let outcome = set_remote_url(&mut git, "origin", moved).await.unwrap();
        assert!(matches!(outcome, Outcome::Succeeded { .. }), "{outcome:?}");
        assert_eq!(
            fixture.git(&fixture.work, &["remote", "get-url", "origin"]),
            moved
        );
        assert_eq!(
            set_remote_url(&mut git, "origin", moved).await.unwrap(),
            Outcome::succeeded(format!("origin already uses {moved}"))
        );
        assert_eq!(
            set_remote_url(&mut git, "nope", moved).await.unwrap(),
            Outcome::skipped(SkipReason::NotFound, "No remote named nope")
        );
        assert_eq!(
            set_remote_url(&mut git, "origin", "--upload-pack=x")
                .await
                .unwrap(),
            Outcome::failed("Invalid remote name or URL")
        );
    }
}
