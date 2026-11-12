use std::path::PathBuf;

use serde::Serialize;

use crate::actions::{Outcome, SkipReason};
use crate::branches::{Merged, RepoContext, fetch_remotes, merge_evidence, worktree_dirty};
use crate::cleanup::{CleanupResult, ItemOutcome};
use crate::git::{Git, GitError, failure_message};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnpushedBranch {
    pub name: String,
    pub upstream: Option<String>,
    pub upstream_gone: bool,
    pub commits: u32,
    pub last_commit_unix: i64,
    pub merged: Option<Merged>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub index: usize,
    pub sha: String,
    pub created_unix: i64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnpushedReport {
    pub has_remotes: bool,
    pub branches: Vec<UnpushedBranch>,
    pub stashes: Vec<StashEntry>,
    pub dirty_worktrees: Vec<PathBuf>,
    pub warnings: Vec<String>,
}

pub fn parse_stash_list(output: &str) -> Vec<StashEntry> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(3, '\0');
            let sha = fields.next()?.to_string();
            let created_unix = fields.next()?.parse().unwrap_or(0);
            let message = fields.next()?.to_string();
            Some((sha, created_unix, message))
        })
        .enumerate()
        .map(|(index, (sha, created_unix, message))| StashEntry {
            index,
            sha,
            created_unix,
            message,
        })
        .collect()
}

pub async fn list_stashes(git: &mut Git) -> Result<Vec<StashEntry>, GitError> {
    let output = git
        .run_ok(&["stash", "list", "--format=%H%x00%ct%x00%gs"])
        .await?;
    Ok(parse_stash_list(&output))
}

pub async fn analyze_unpushed(git: &mut Git, fetch: bool) -> Result<UnpushedReport, GitError> {
    let mut warnings = Vec::new();
    if fetch {
        fetch_remotes(git, &mut warnings).await?;
    }
    let has_remotes = !git.run_ok(&["remote"]).await?.trim().is_empty();
    let context = RepoContext::load(git).await?;

    let mut branches = Vec::new();
    for raw in &context.branches {
        let commits: u32 = git
            .run_ok(&["rev-list", "--count", &raw.name, "--not", "--remotes"])
            .await?
            .trim()
            .parse()
            .unwrap_or(0);
        if commits == 0 {
            continue;
        }
        let other_bases: Vec<String> = context
            .bases
            .iter()
            .filter(|base| **base != raw.name)
            .cloned()
            .collect();
        branches.push(UnpushedBranch {
            name: raw.name.clone(),
            upstream: raw.upstream.clone(),
            upstream_gone: raw.upstream_gone,
            commits,
            last_commit_unix: raw.last_commit_unix,
            merged: merge_evidence(git, &raw.name, &other_bases).await?,
        });
    }

    let mut dirty_worktrees = Vec::new();
    for worktree in &context.worktrees {
        if !worktree.prunable && !worktree.bare && worktree_dirty(git, worktree).await? {
            dirty_worktrees.push(worktree.path.clone());
        }
    }

    Ok(UnpushedReport {
        has_remotes,
        branches,
        stashes: list_stashes(git).await?,
        dirty_worktrees,
        warnings,
    })
}

pub async fn drop_stashes(mut git: Git, shas: &[String]) -> Result<CleanupResult, GitError> {
    let stashes = list_stashes(&mut git).await?;
    let mut targets: Vec<&StashEntry> = stashes.iter().filter(|s| shas.contains(&s.sha)).collect();
    // Dropping stash@{n} renumbers every later entry, so drop from the highest index down.
    targets.sort_by_key(|stash| std::cmp::Reverse(stash.index));

    let mut items = Vec::with_capacity(shas.len());
    for stash in targets {
        let reference = format!("stash@{{{}}}", stash.index);
        let dropped = git.run(&["stash", "drop", "--quiet", &reference]).await?;
        let outcome = if dropped.success() {
            Outcome::succeeded(format!(
                "Dropped {} ({})",
                stash.message,
                &stash.sha[..stash.sha.len().min(10)]
            ))
        } else {
            Outcome::failed(failure_message(&dropped))
        };
        items.push(ItemOutcome {
            item: stash.sha.clone(),
            outcome,
        });
    }
    for sha in shas {
        if !stashes.iter().any(|s| &s.sha == sha) {
            items.push(ItemOutcome {
                item: sha.clone(),
                outcome: Outcome::skipped(SkipReason::NotFound, "Stash no longer exists"),
            });
        }
    }
    Ok(CleanupResult {
        items,
        commands: git.into_log(),
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::branches::MergeEvidence;
    use crate::test_support::Fixture;

    fn stash(fixture: &Fixture, contents: &str, message: &str) {
        fs::write(fixture.work.join("README.md"), contents).unwrap();
        fixture.git(&fixture.work, &["stash", "push", "--quiet", "-m", message]);
    }

    fn stash_messages(fixture: &Fixture) -> Vec<String> {
        fixture
            .git(&fixture.work, &["stash", "list", "--format=%gs"])
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn parses_stash_list() {
        let output =
            "aaa\x001700000000\x00On main: first\nbbb\x001600000000\x00WIP on x: 123 msg\n";
        assert_eq!(
            parse_stash_list(output),
            vec![
                StashEntry {
                    index: 0,
                    sha: "aaa".into(),
                    created_unix: 1_700_000_000,
                    message: "On main: first".into(),
                },
                StashEntry {
                    index: 1,
                    sha: "bbb".into(),
                    created_unix: 1_600_000_000,
                    message: "WIP on x: 123 msg".into(),
                },
            ]
        );
    }

    #[tokio::test]
    async fn clean_pushed_repository_has_nothing_unpushed() {
        let fixture = Fixture::new();
        let report = analyze_unpushed(&mut Git::new(&fixture.work), false)
            .await
            .unwrap();
        assert_eq!(
            report,
            UnpushedReport {
                has_remotes: true,
                branches: vec![],
                stashes: vec![],
                dirty_worktrees: vec![],
                warnings: vec![],
            }
        );
    }

    #[tokio::test]
    async fn finds_unpushed_branches_stashes_and_dirty_worktrees() {
        let fixture = Fixture::new();
        let work = &fixture.work;
        fixture.commit(work, "main.txt", "m\n", "unpushed on main");
        fixture.git(work, &["switch", "--quiet", "-c", "local-only"]);
        fixture.commit(work, "a.txt", "a\n", "a");
        fixture.commit(work, "b.txt", "b\n", "b");
        fixture.git(work, &["switch", "--quiet", "-c", "pushed", "origin/main"]);
        fixture.commit(work, "p.txt", "p\n", "p");
        fixture.git(work, &["push", "--quiet", "-u", "origin", "pushed"]);

        fixture.git(
            work,
            &["switch", "--quiet", "-c", "squashed", "origin/main"],
        );
        fixture.commit(work, "s1.txt", "1\n", "s1");
        fixture.commit(work, "s2.txt", "2\n", "s2");
        fixture.git(&fixture.seed, &["fetch", "--quiet", "origin"]);
        fixture.git(work, &["push", "--quiet", "-u", "origin", "squashed"]);
        fixture.git(&fixture.seed, &["fetch", "--quiet", "origin"]);
        fixture.git(&fixture.seed, &["merge", "--squash", "origin/squashed"]);
        fixture.git(&fixture.seed, &["commit", "--quiet", "-m", "squash"]);
        fixture.git(&fixture.seed, &["push", "--quiet", "origin", "main"]);
        fixture.git(work, &["push", "--quiet", "origin", "--delete", "squashed"]);

        fixture.git(work, &["switch", "--quiet", "main"]);
        stash(&fixture, "stashed\n", "keep me");
        fs::write(work.join("untracked.txt"), "x").unwrap();
        let linked = fixture.root().join("linked");
        fixture.git(
            work,
            &[
                "worktree",
                "add",
                "--quiet",
                linked.to_str().unwrap(),
                "pushed",
            ],
        );

        let report = analyze_unpushed(&mut Git::new(work), true).await.unwrap();
        let mut summary: Vec<(&str, u32, Option<MergeEvidence>)> = report
            .branches
            .iter()
            .map(|b| {
                (
                    b.name.as_str(),
                    b.commits,
                    b.merged.as_ref().map(|m| m.evidence),
                )
            })
            .collect();
        summary.sort_by_key(|(name, _, _)| *name);
        assert_eq!(
            summary,
            vec![
                ("local-only", 3, None),
                ("main", 1, None),
                ("squashed", 2, Some(MergeEvidence::Squashed)),
            ]
        );
        let squashed = report
            .branches
            .iter()
            .find(|b| b.name == "squashed")
            .unwrap();
        assert!(squashed.upstream_gone);
        assert_eq!(report.stashes.len(), 1);
        assert_eq!(report.stashes[0].message, "On main: keep me");
        assert_eq!(report.dirty_worktrees.len(), 1);
        assert!(report.dirty_worktrees[0].ends_with("work"));
    }

    #[tokio::test]
    async fn drops_selected_stashes_by_sha_regardless_of_order() {
        let fixture = Fixture::new();
        stash(&fixture, "1\n", "oldest");
        stash(&fixture, "2\n", "middle");
        stash(&fixture, "3\n", "newest");
        let stashes = list_stashes(&mut Git::new(&fixture.work)).await.unwrap();
        let sha = |message: &str| {
            stashes
                .iter()
                .find(|s| s.message.ends_with(message))
                .unwrap()
                .sha
                .clone()
        };

        let result = drop_stashes(
            Git::new(&fixture.work),
            &[sha("newest"), sha("oldest"), "missing".into()],
        )
        .await
        .unwrap();
        assert_eq!(stash_messages(&fixture), vec!["On main: middle"]);
        let outcomes: Vec<&Outcome> = result.items.iter().map(|i| &i.outcome).collect();
        assert!(
            matches!(outcomes[0], Outcome::Succeeded { message } if message.starts_with("Dropped On main: oldest"))
        );
        assert!(
            matches!(outcomes[1], Outcome::Succeeded { message } if message.starts_with("Dropped On main: newest"))
        );
        assert_eq!(
            outcomes[2],
            &Outcome::skipped(SkipReason::NotFound, "Stash no longer exists")
        );
    }
}
