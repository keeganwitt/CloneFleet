use serde::Serialize;

use crate::branches::{BranchReport, analyze};
use crate::git::{Git, GitError};
use crate::unpushed::{UnpushedReport, analyze_unpushed};

const DAY_SECONDS: i64 = 24 * 60 * 60;

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoHealth {
    pub merged_branches: u32,
    pub remote_deleted_branches: u32,
    pub stale_branches: u32,
    pub removable_worktrees: u32,
    pub stale_worktrees: u32,
    pub unpushed_branches: u32,
    pub stashes: u32,
    pub warnings: Vec<String>,
}

fn count<T>(items: impl Iterator<Item = T>) -> u32 {
    u32::try_from(items.count()).unwrap_or(u32::MAX)
}

pub fn summarize_health(
    branches: &BranchReport,
    unpushed: &UnpushedReport,
    now_unix: i64,
    stale_days: u32,
) -> RepoHealth {
    let stale_before = now_unix - i64::from(stale_days) * DAY_SECONDS;
    let candidates = || branches.branches.iter().filter(|b| b.protection.is_none());
    RepoHealth {
        merged_branches: count(candidates().filter(|b| b.merged.is_some())),
        remote_deleted_branches: count(
            candidates().filter(|b| b.merged.is_none() && b.upstream_gone),
        ),
        stale_branches: count(candidates().filter(|b| {
            b.merged.is_none() && !b.upstream_gone && b.last_commit_unix <= stale_before
        })),
        removable_worktrees: count(branches.worktrees.iter().filter(|w| {
            !w.is_main
                && !w.locked
                && (w.prunable || (w.merged.is_some() && w.dirty == Some(false)))
        })),
        stale_worktrees: count(branches.worktrees.iter().filter(|w| {
            !w.is_main
                && !w.prunable
                && w.merged.is_none()
                && w.last_commit_unix.is_some_and(|t| t <= stale_before)
        })),
        unpushed_branches: count(unpushed.branches.iter().filter(|b| b.merged.is_none())),
        stashes: count(unpushed.stashes.iter()),
        warnings: branches
            .warnings
            .iter()
            .chain(&unpushed.warnings)
            .cloned()
            .collect(),
    }
}

pub async fn repo_health(git: &mut Git, stale_days: u32) -> Result<RepoHealth, GitError> {
    let branches = analyze(git, false).await?;
    let unpushed = analyze_unpushed(git, false).await?;
    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0);
    Ok(summarize_health(&branches, &unpushed, now_unix, stale_days))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::test_support::Fixture;

    #[tokio::test]
    async fn counts_cleanup_candidates_and_unpushed_work() {
        let fixture = Fixture::new();
        let work = &fixture.work;
        fixture.git(work, &["switch", "--quiet", "-c", "merged"]);
        fixture.git(work, &["switch", "--quiet", "-c", "local-work", "main"]);
        fixture.commit(work, "local.txt", "l\n", "local work");
        fixture.git(work, &["switch", "--quiet", "-c", "abandoned", "main"]);
        fixture.commit(work, "a.txt", "a\n", "abandoned work");
        fixture.git(work, &["push", "--quiet", "-u", "origin", "abandoned"]);
        fixture.git(
            work,
            &["push", "--quiet", "origin", "--delete", "abandoned"],
        );
        fixture.git(work, &["fetch", "--quiet", "--prune"]);
        fixture.git(work, &["switch", "--quiet", "main"]);
        fs::write(work.join("README.md"), "stash me\n").unwrap();
        fixture.git(work, &["stash", "push", "--quiet"]);

        let health = repo_health(&mut Git::new(work), 90).await.unwrap();
        assert_eq!(
            health,
            RepoHealth {
                merged_branches: 1,
                remote_deleted_branches: 1,
                stale_branches: 0,
                removable_worktrees: 0,
                stale_worktrees: 0,
                unpushed_branches: 2,
                stashes: 1,
                warnings: vec![],
            }
        );
    }

    #[tokio::test]
    async fn treats_old_unmerged_branches_as_stale() {
        let fixture = Fixture::new();
        let work = &fixture.work;
        fixture.git(work, &["switch", "--quiet", "-c", "old", "main"]);
        fs::write(work.join("old.txt"), "o\n").unwrap();
        fixture.git(work, &["add", "old.txt"]);
        let output = std::process::Command::new("git")
            .current_dir(work)
            .args(["commit", "--quiet", "-m", "old work"])
            .env("GIT_COMMITTER_DATE", "2000-01-01T00:00:00Z")
            .env("GIT_AUTHOR_DATE", "2000-01-01T00:00:00Z")
            .output()
            .unwrap();
        assert!(output.status.success());
        fixture.git(work, &["switch", "--quiet", "main"]);

        let health = repo_health(&mut Git::new(work), 90).await.unwrap();
        assert_eq!(health.stale_branches, 1);
        assert_eq!(health.unpushed_branches, 1);
    }
}
