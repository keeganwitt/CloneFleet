use serde::{Deserialize, Serialize};

use crate::fork::{PushPlan, push, rebase_fork};
use crate::git::{CommandRecord, Git, GitError, failure_message};
use crate::remotes::{fetch_all, rename_branch, sync_default_branch};
use crate::status::{RepoStatus, default_branch, repo_status};

pub const STASH_MESSAGE: &str = "Stashed by CloneFleet";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    CheckoutDefault,
    Pull,
    Stash,
    Commit {
        message: String,
    },
    RebaseFork,
    Push {
        plan: PushPlan,
    },
    Fetch,
    SyncDefaultBranch,
    RenameBranch {
        remote: String,
        from: String,
        to: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
    UncommittedChanges,
    OperationInProgress,
    DetachedHead,
    NoUpstream,
    NoDefaultBranch,
    Protected,
    NotMerged,
    WorktreeDirty,
    WorktreeLocked,
    NotFound,
    NoUpstreamRemote,
    NotOnDefaultBranch,
    NoRemote,
    AlreadyExists,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Outcome {
    Succeeded { message: String },
    Skipped { reason: SkipReason, message: String },
    Failed { message: String },
}

impl Outcome {
    pub(crate) fn succeeded(message: impl Into<String>) -> Self {
        Self::Succeeded {
            message: message.into(),
        }
    }

    pub(crate) fn skipped(reason: SkipReason, message: impl Into<String>) -> Self {
        Self::Skipped {
            reason,
            message: message.into(),
        }
    }

    pub(crate) fn failed(message: impl Into<String>) -> Self {
        Self::Failed {
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub outcome: Outcome,
    pub follow_up: Option<Action>,
    pub commands: Vec<CommandRecord>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    #[serde(flatten)]
    pub status: RepoStatus,
    pub default_branch: Option<String>,
}

pub async fn summarize(git: &mut Git) -> Result<RepoSummary, GitError> {
    let status = repo_status(git).await?;
    let default_branch = default_branch(git).await?.map(|b| b.name);
    Ok(RepoSummary {
        status,
        default_branch,
    })
}

pub async fn run_action(mut git: Git, action: &Action) -> ActionResult {
    let alone = |outcome: Result<Outcome, GitError>| outcome.map(|o| (o, None));
    let (outcome, follow_up) = match action {
        Action::CheckoutDefault => alone(checkout_default(&mut git).await),
        Action::Pull => alone(pull(&mut git).await),
        Action::Stash => alone(stash(&mut git).await),
        Action::Commit { message } => alone(commit(&mut git, message).await),
        Action::RebaseFork => rebase_fork(&mut git)
            .await
            .map(|(outcome, plan)| (outcome, plan.map(|plan| Action::Push { plan }))),
        Action::Push { plan } => alone(push(&mut git, plan).await),
        Action::Fetch => alone(fetch_all(&mut git).await),
        Action::SyncDefaultBranch => sync_default_branch(&mut git).await,
        Action::RenameBranch { remote, from, to } => {
            alone(rename_branch(&mut git, remote, from, to).await)
        }
    }
    .unwrap_or_else(|e| (Outcome::failed(e.to_string()), None));
    ActionResult {
        outcome,
        follow_up,
        commands: git.into_log(),
    }
}

pub(crate) fn blocked_by_operation(status: &RepoStatus) -> Option<Outcome> {
    status.operation.map(|op| {
        Outcome::skipped(
            SkipReason::OperationInProgress,
            format!("Repository is in the middle of {}", op.describe()),
        )
    })
}

pub(crate) fn plural(count: u32, noun: &str) -> String {
    if count == 1 {
        format!("1 {noun}")
    } else {
        format!("{count} {noun}s")
    }
}

async fn checkout_default(git: &mut Git) -> Result<Outcome, GitError> {
    let status = repo_status(git).await?;
    if let Some(blocked) = blocked_by_operation(&status) {
        return Ok(blocked);
    }
    let Some(default) = default_branch(git).await? else {
        return Ok(Outcome::skipped(
            SkipReason::NoDefaultBranch,
            "Could not determine the default branch",
        ));
    };
    let tree = &status.working_tree;
    if tree.branch.as_deref() == Some(default.name.as_str()) {
        return Ok(Outcome::succeeded(format!("Already on {}", default.name)));
    }
    let dirty = tree.tracked_changes + tree.conflicts;
    if dirty > 0 {
        return Ok(Outcome::skipped(
            SkipReason::UncommittedChanges,
            format!("{} with uncommitted changes", plural(dirty, "file")),
        ));
    }

    let local_ref = format!("refs/heads/{}", default.name);
    let switch = if git
        .succeeds(&["show-ref", "--verify", "--quiet", &local_ref])
        .await?
    {
        git.run(&["switch", &default.name]).await?
    } else if let Some(remote) = &default.remote {
        let tracking = format!("{remote}/{}", default.name);
        git.run(&["switch", "--create", &default.name, "--track", &tracking])
            .await?
    } else {
        return Ok(Outcome::failed(format!(
            "Branch {} does not exist",
            default.name
        )));
    };

    Ok(if switch.success() {
        Outcome::succeeded(format!("Switched to {}", default.name))
    } else {
        Outcome::failed(failure_message(&switch))
    })
}

async fn pull(git: &mut Git) -> Result<Outcome, GitError> {
    let status = repo_status(git).await?;
    if let Some(blocked) = blocked_by_operation(&status) {
        return Ok(blocked);
    }
    let Some(branch) = status.working_tree.branch else {
        return Ok(Outcome::skipped(
            SkipReason::DetachedHead,
            "HEAD is detached",
        ));
    };
    if status.working_tree.upstream.is_none() {
        return Ok(Outcome::skipped(
            SkipReason::NoUpstream,
            format!("{branch} has no upstream branch"),
        ));
    }

    let before = git.run_ok(&["rev-parse", "HEAD"]).await?;
    let pulled = git
        .run(&[
            "pull",
            "--no-rebase",
            "--ff-only",
            "--no-autostash",
            "--prune",
        ])
        .await?;
    if !pulled.success() {
        let message = failure_message(&pulled);
        return Ok(Outcome::failed(
            if message.contains("Not possible to fast-forward") {
                format!("{branch} has diverged from its upstream; fast-forward is not possible")
            } else {
                message
            },
        ));
    }
    let after = git.run_ok(&["rev-parse", "HEAD"]).await?;
    if before == after {
        return Ok(Outcome::succeeded("Already up to date"));
    }
    let range = format!("{}..{}", before.trim(), after.trim());
    let count: u32 = git
        .run_ok(&["rev-list", "--count", &range])
        .await?
        .trim()
        .parse()
        .unwrap_or(0);
    Ok(Outcome::succeeded(format!(
        "Fast-forwarded {branch} by {}",
        plural(count, "commit")
    )))
}

async fn stash(git: &mut Git) -> Result<Outcome, GitError> {
    let status = repo_status(git).await?;
    if let Some(blocked) = blocked_by_operation(&status) {
        return Ok(blocked);
    }
    if status.working_tree.tracked_changes == 0 {
        return Ok(Outcome::succeeded("Nothing to stash"));
    }
    let stashed = git
        .run(&["stash", "push", "--message", STASH_MESSAGE])
        .await?;
    Ok(if stashed.success() {
        Outcome::succeeded(format!(
            "Stashed {}",
            plural(status.working_tree.tracked_changes, "changed file")
        ))
    } else {
        Outcome::failed(failure_message(&stashed))
    })
}

async fn commit(git: &mut Git, message: &str) -> Result<Outcome, GitError> {
    let message = message.trim();
    if message.is_empty() {
        return Ok(Outcome::failed("A commit message is required"));
    }
    let status = repo_status(git).await?;
    if let Some(blocked) = blocked_by_operation(&status) {
        return Ok(blocked);
    }
    if status.working_tree.tracked_changes == 0 {
        return Ok(Outcome::succeeded("Nothing to commit"));
    }
    let committed = git.run(&["commit", "--all", "--message", message]).await?;
    if !committed.success() {
        return Ok(Outcome::failed(failure_message(&committed)));
    }
    let sha = git.run_ok(&["rev-parse", "--short", "HEAD"]).await?;
    Ok(Outcome::succeeded(format!("Committed {}", sha.trim())))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::test_support::Fixture;

    async fn act(fixture: &Fixture, action: Action) -> Outcome {
        run_action(Git::new(&fixture.work), &action).await.outcome
    }

    fn current_branch(fixture: &Fixture) -> String {
        fixture.git(&fixture.work, &["branch", "--show-current"])
    }

    #[tokio::test]
    async fn summarize_reports_branch_and_default() {
        let fixture = Fixture::new();
        fixture.git(&fixture.work, &["switch", "-c", "feature"]);
        fs::write(fixture.work.join("README.md"), "changed\n").unwrap();
        fs::write(fixture.work.join("new.txt"), "x").unwrap();

        let summary = summarize(&mut Git::new(&fixture.work)).await.unwrap();
        assert_eq!(summary.default_branch.as_deref(), Some("main"));
        assert_eq!(
            summary.status.working_tree.branch.as_deref(),
            Some("feature")
        );
        assert_eq!(summary.status.working_tree.tracked_changes, 1);
        assert_eq!(summary.status.working_tree.untracked, 1);
        assert_eq!(summary.status.operation, None);
    }

    #[tokio::test]
    async fn default_branch_falls_back_to_ls_remote_when_origin_head_is_unset() {
        let fixture = Fixture::new();
        fixture.git(&fixture.work, &["remote", "set-head", "origin", "--delete"]);
        let summary = summarize(&mut Git::new(&fixture.work)).await.unwrap();
        assert_eq!(summary.default_branch.as_deref(), Some("main"));
    }

    #[tokio::test]
    async fn checkout_default_switches_from_clean_feature_branch() {
        let fixture = Fixture::new();
        fixture.git(&fixture.work, &["switch", "-c", "feature"]);
        assert_eq!(
            act(&fixture, Action::CheckoutDefault).await,
            Outcome::succeeded("Switched to main")
        );
        assert_eq!(current_branch(&fixture), "main");
    }

    #[tokio::test]
    async fn checkout_default_creates_tracking_branch_when_missing_locally() {
        let fixture = Fixture::new();
        fixture.git(&fixture.work, &["switch", "-c", "feature"]);
        fixture.git(&fixture.work, &["branch", "-D", "main"]);
        assert_eq!(
            act(&fixture, Action::CheckoutDefault).await,
            Outcome::succeeded("Switched to main")
        );
        assert_eq!(
            fixture.git(
                &fixture.work,
                &["rev-parse", "--abbrev-ref", "main@{upstream}"]
            ),
            "origin/main"
        );
    }

    #[tokio::test]
    async fn checkout_default_skips_when_tracked_files_are_dirty() {
        let fixture = Fixture::new();
        fixture.git(&fixture.work, &["switch", "-c", "feature"]);
        fs::write(fixture.work.join("README.md"), "dirty\n").unwrap();
        assert_eq!(
            act(&fixture, Action::CheckoutDefault).await,
            Outcome::skipped(
                SkipReason::UncommittedChanges,
                "1 file with uncommitted changes"
            )
        );
        assert_eq!(current_branch(&fixture), "feature");
    }

    #[tokio::test]
    async fn checkout_default_ignores_untracked_files() {
        let fixture = Fixture::new();
        fixture.git(&fixture.work, &["switch", "-c", "feature"]);
        fs::write(fixture.work.join("scratch.txt"), "x").unwrap();
        assert_eq!(
            act(&fixture, Action::CheckoutDefault).await,
            Outcome::succeeded("Switched to main")
        );
        assert!(fixture.work.join("scratch.txt").exists());
    }

    #[tokio::test]
    async fn checkout_default_is_a_no_op_on_default_branch() {
        let fixture = Fixture::new();
        fs::write(fixture.work.join("README.md"), "dirty\n").unwrap();
        assert_eq!(
            act(&fixture, Action::CheckoutDefault).await,
            Outcome::succeeded("Already on main")
        );
    }

    #[tokio::test]
    async fn actions_skip_during_merge_conflict() {
        let fixture = Fixture::new();
        fixture.git(&fixture.work, &["switch", "-c", "feature"]);
        fixture.commit(&fixture.work, "README.md", "feature\n", "feature change");
        fixture.git(&fixture.work, &["switch", "main"]);
        fixture.commit(&fixture.work, "README.md", "main\n", "main change");
        fixture.git(&fixture.work, &["switch", "feature"]);
        let merge = Git::new(&fixture.work)
            .run(&["merge", "main"])
            .await
            .unwrap();
        assert!(!merge.success());

        for action in [Action::CheckoutDefault, Action::Pull, Action::Stash] {
            assert!(matches!(
                act(&fixture, action).await,
                Outcome::Skipped {
                    reason: SkipReason::OperationInProgress,
                    ..
                }
            ),);
        }
    }

    #[tokio::test]
    async fn pull_fast_forwards_and_reports_commit_count() {
        let fixture = Fixture::new();
        fixture.commit(&fixture.seed, "a.txt", "a", "a");
        fixture.commit(&fixture.seed, "b.txt", "b", "b");
        fixture.git(&fixture.seed, &["push", "--quiet"]);

        assert_eq!(
            act(&fixture, Action::Pull).await,
            Outcome::succeeded("Fast-forwarded main by 2 commits")
        );
        assert_eq!(
            act(&fixture, Action::Pull).await,
            Outcome::succeeded("Already up to date")
        );
    }

    #[tokio::test]
    async fn pull_refuses_to_merge_diverged_history_even_when_configured_to_rebase() {
        let fixture = Fixture::new();
        fixture.git(&fixture.work, &["config", "pull.rebase", "true"]);
        fixture.commit(&fixture.seed, "upstream.txt", "u", "upstream");
        fixture.git(&fixture.seed, &["push", "--quiet"]);
        fixture.commit(&fixture.work, "local.txt", "l", "local");
        let before = fixture.git(&fixture.work, &["rev-parse", "HEAD"]);

        assert!(matches!(
            act(&fixture, Action::Pull).await,
            Outcome::Failed { message } if message.contains("diverged")
        ));
        assert_eq!(fixture.git(&fixture.work, &["rev-parse", "HEAD"]), before);
    }

    #[tokio::test]
    async fn pull_skips_branch_without_upstream() {
        let fixture = Fixture::new();
        fixture.git(&fixture.work, &["switch", "-c", "local-only"]);
        assert_eq!(
            act(&fixture, Action::Pull).await,
            Outcome::skipped(SkipReason::NoUpstream, "local-only has no upstream branch")
        );
    }

    #[tokio::test]
    async fn pull_skips_detached_head() {
        let fixture = Fixture::new();
        fixture.git(&fixture.work, &["switch", "--detach"]);
        assert!(matches!(
            act(&fixture, Action::Pull).await,
            Outcome::Skipped {
                reason: SkipReason::DetachedHead,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn stash_keeps_untracked_files_in_place() {
        let fixture = Fixture::new();
        fs::write(fixture.work.join("README.md"), "dirty\n").unwrap();
        fs::write(fixture.work.join(".env"), "SECRET=1").unwrap();

        assert_eq!(
            act(&fixture, Action::Stash).await,
            Outcome::succeeded("Stashed 1 changed file")
        );
        assert_eq!(
            fs::read_to_string(fixture.work.join("README.md")).unwrap(),
            "hello\n"
        );
        assert!(fixture.work.join(".env").exists());
        assert!(
            fixture
                .git(&fixture.work, &["stash", "list"])
                .contains(STASH_MESSAGE)
        );
        assert_eq!(
            act(&fixture, Action::Stash).await,
            Outcome::succeeded("Nothing to stash")
        );
    }

    #[tokio::test]
    async fn commit_commits_tracked_changes_only() {
        let fixture = Fixture::new();
        fs::write(fixture.work.join("README.md"), "dirty\n").unwrap();
        fs::write(fixture.work.join(".env"), "SECRET=1").unwrap();

        let outcome = act(
            &fixture,
            Action::Commit {
                message: " WIP \n".into(),
            },
        )
        .await;
        assert!(
            matches!(outcome, Outcome::Succeeded { ref message } if message.starts_with("Committed "))
        );
        assert_eq!(
            fixture.git(&fixture.work, &["log", "-1", "--format=%s"]),
            "WIP"
        );
        assert_eq!(
            fixture.git(&fixture.work, &["status", "--porcelain"]),
            "?? .env"
        );
    }

    #[tokio::test]
    async fn commit_requires_a_message() {
        let fixture = Fixture::new();
        fs::write(fixture.work.join("README.md"), "dirty\n").unwrap();
        assert_eq!(
            act(
                &fixture,
                Action::Commit {
                    message: "  ".into()
                }
            )
            .await,
            Outcome::failed("A commit message is required")
        );
    }

    #[tokio::test]
    async fn results_include_the_commands_that_ran() {
        let fixture = Fixture::new();
        let result = run_action(Git::new(&fixture.work), &Action::Pull).await;
        assert!(
            result
                .commands
                .iter()
                .any(|c| c.args.first().map(String::as_str) == Some("pull"))
        );
    }

    #[test]
    fn deserializes_actions_from_frontend_shape() {
        let action: Action = serde_json::from_str(r#"{"type":"commit","message":"m"}"#).unwrap();
        assert_eq!(
            action,
            Action::Commit {
                message: "m".into()
            }
        );
        let action: Action = serde_json::from_str(r#"{"type":"checkoutDefault"}"#).unwrap();
        assert_eq!(action, Action::CheckoutDefault);
        let action: Action = serde_json::from_str(
            r#"{"type":"push","plan":{"remote":"origin","branch":"main","commits":2,"force":true,"expectedRemoteSha":"abc"}}"#,
        )
        .unwrap();
        assert_eq!(
            action,
            Action::Push {
                plan: PushPlan {
                    remote: "origin".into(),
                    branch: "main".into(),
                    commits: 2,
                    force: true,
                    expected_remote_sha: Some("abc".into()),
                }
            }
        );
    }
}
