use std::path::PathBuf;

use serde::Serialize;

use crate::actions::{Outcome, SkipReason};
use crate::branches::{Protection, RepoContext, merge_evidence, worktree_dirty};
use crate::git::{CommandRecord, Git, GitError, failure_message};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ItemOutcome {
    pub item: String,
    #[serde(flatten)]
    pub outcome: Outcome,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub items: Vec<ItemOutcome>,
    pub commands: Vec<CommandRecord>,
}

fn protection_message(branch: &str, protection: Protection, context: &RepoContext) -> String {
    match protection {
        Protection::Default => format!("{branch} is the default branch"),
        Protection::Current => format!("{branch} is checked out"),
        Protection::CheckedOutInWorktree => match context.checked_out().get(branch) {
            Some(path) => format!("{branch} is checked out in {}", path.display()),
            None => format!("{branch} is checked out in another worktree"),
        },
    }
}

async fn force_delete_branch(git: &mut Git, branch: &str, sha: &str) -> Result<Outcome, GitError> {
    let deleted = git.run(&["branch", "-D", branch]).await?;
    Ok(if deleted.success() {
        Outcome::succeeded(format!("Deleted {branch} (was {})", short(sha)))
    } else {
        Outcome::failed(failure_message(&deleted))
    })
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(10)]
}

async fn delete_one_branch(
    git: &mut Git,
    context: &RepoContext,
    name: &str,
    allow_unmerged: bool,
) -> Result<Outcome, GitError> {
    let Some(branch) = context.branches.iter().find(|b| b.name == name) else {
        return Ok(Outcome::skipped(
            SkipReason::NotFound,
            format!("{name} no longer exists"),
        ));
    };
    if let Some(protection) = context.protection(name) {
        return Ok(Outcome::skipped(
            SkipReason::Protected,
            protection_message(name, protection, context),
        ));
    }
    if !allow_unmerged && merge_evidence(git, name, &context.bases).await?.is_none() {
        return Ok(Outcome::skipped(
            SkipReason::NotMerged,
            format!("{name} is not merged"),
        ));
    }
    force_delete_branch(git, name, &branch.sha).await
}

pub async fn delete_branches(
    mut git: Git,
    names: &[String],
    allow_unmerged: bool,
) -> Result<CleanupResult, GitError> {
    let context = RepoContext::load(&mut git).await?;
    let mut items = Vec::with_capacity(names.len());
    for name in names {
        let outcome = delete_one_branch(&mut git, &context, name, allow_unmerged)
            .await
            .unwrap_or_else(|e| Outcome::failed(e.to_string()));
        items.push(ItemOutcome {
            item: name.clone(),
            outcome,
        });
    }
    Ok(CleanupResult {
        items,
        commands: git.into_log(),
    })
}

async fn remove_one_worktree(
    git: &mut Git,
    context: &RepoContext,
    path: &PathBuf,
    delete_branch: bool,
    allow_unmerged: bool,
) -> Result<Outcome, GitError> {
    let Some((index, worktree)) = context
        .worktrees
        .iter()
        .enumerate()
        .find(|(_, w)| &w.path == path)
    else {
        return Ok(Outcome::skipped(
            SkipReason::NotFound,
            "Worktree no longer exists",
        ));
    };
    if index == 0 || worktree.bare {
        return Ok(Outcome::skipped(
            SkipReason::Protected,
            "The main worktree cannot be removed",
        ));
    }
    if worktree.locked {
        return Ok(Outcome::skipped(
            SkipReason::WorktreeLocked,
            "Worktree is locked",
        ));
    }

    let rev = worktree.branch.as_deref().or(worktree.head.as_deref());
    let merged = match rev {
        Some(rev) => merge_evidence(git, rev, &context.bases).await?,
        None => None,
    };

    let mut message = if worktree.prunable {
        git.run_ok(&["worktree", "prune"]).await?;
        "Pruned missing worktree".to_string()
    } else {
        if merged.is_none() && !(allow_unmerged && worktree.branch.is_some()) {
            return Ok(Outcome::skipped(
                SkipReason::NotMerged,
                if worktree.branch.is_some() {
                    "Worktree has unmerged commits"
                } else {
                    "Worktree is detached with unmerged commits that only it holds"
                },
            ));
        }
        if worktree_dirty(git, worktree).await? {
            return Ok(Outcome::skipped(
                SkipReason::WorktreeDirty,
                "Worktree has uncommitted or untracked files",
            ));
        }
        let path = worktree.path.to_string_lossy();
        let removed = git.run(&["worktree", "remove", &path]).await?;
        if !removed.success() {
            return Ok(Outcome::failed(failure_message(&removed)));
        }
        match (&merged, &worktree.branch) {
            (None, Some(branch)) => format!("Removed worktree; kept unmerged branch {branch}"),
            _ => "Removed worktree".to_string(),
        }
    };

    if let (true, Some(_), Some(branch)) = (delete_branch, &merged, &worktree.branch) {
        let sha = worktree.head.as_deref().unwrap_or_default();
        match force_delete_branch(git, branch, sha).await? {
            Outcome::Succeeded { message: deleted } => message = format!("{message}; {deleted}"),
            Outcome::Failed { message: error, .. } | Outcome::Skipped { message: error, .. } => {
                message = format!("{message}; could not delete {branch}: {error}")
            }
        }
    }
    Ok(Outcome::succeeded(message))
}

pub async fn remove_worktrees(
    mut git: Git,
    paths: &[PathBuf],
    delete_branches: bool,
    allow_unmerged: bool,
) -> Result<CleanupResult, GitError> {
    let context = RepoContext::load(&mut git).await?;
    let mut items = Vec::with_capacity(paths.len());
    for path in paths {
        let outcome =
            remove_one_worktree(&mut git, &context, path, delete_branches, allow_unmerged)
                .await
                .unwrap_or_else(|e| Outcome::failed(e.to_string()));
        items.push(ItemOutcome {
            item: path.to_string_lossy().into_owned(),
            outcome,
        });
    }
    Ok(CleanupResult {
        items,
        commands: git.into_log(),
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use super::*;
    use crate::branches::{BranchInfo, BranchReport, MergeEvidence, Merged, analyze};
    use crate::test_support::Fixture;

    fn feature_branch(fixture: &Fixture, name: &str, file: &str) {
        feature_branch_with(fixture, name, &[file]);
    }

    fn feature_branch_with(fixture: &Fixture, name: &str, files: &[&str]) {
        fixture.git(&fixture.work, &["switch", "--quiet", "-c", name, "main"]);
        for file in files {
            fixture.commit(
                &fixture.work,
                file,
                "feature work\n",
                &format!("add {file}"),
            );
        }
        fixture.git(&fixture.work, &["push", "--quiet", "-u", "origin", name]);
        fixture.git(&fixture.work, &["switch", "--quiet", "main"]);
    }

    fn upstream_change(fixture: &Fixture, steps: &[&[&str]]) {
        fixture.git(&fixture.seed, &["fetch", "--quiet", "origin"]);
        for step in steps {
            fixture.git(&fixture.seed, step);
        }
        fixture.git(&fixture.seed, &["push", "--quiet", "origin", "main"]);
    }

    async fn report(fixture: &Fixture) -> BranchReport {
        analyze(&mut Git::new(&fixture.work), true).await.unwrap()
    }

    fn branch<'a>(report: &'a BranchReport, name: &str) -> &'a BranchInfo {
        report.branches.iter().find(|b| b.name == name).unwrap()
    }

    fn evidence(report: &BranchReport, name: &str) -> Option<MergeEvidence> {
        branch(report, name).merged.as_ref().map(|m| m.evidence)
    }

    fn branch_exists(fixture: &Fixture, name: &str) -> bool {
        !fixture
            .git(&fixture.work, &["branch", "--list", name])
            .is_empty()
    }

    #[tokio::test]
    async fn detects_merge_commits_rebases_and_squashes() {
        let fixture = Fixture::new();
        feature_branch(&fixture, "merged", "merged.txt");
        feature_branch(&fixture, "rebased", "rebased.txt");
        feature_branch_with(&fixture, "squashed", &["squash-1.txt", "squash-2.txt"]);
        feature_branch(&fixture, "open", "open.txt");
        fixture.commit(&fixture.seed, "moved.txt", "base moved\n", "move base");
        upstream_change(
            &fixture,
            &[
                &[
                    "merge",
                    "--quiet",
                    "--no-ff",
                    "-m",
                    "merge",
                    "origin/merged",
                ],
                &["cherry-pick", "origin/rebased"],
                &["merge", "--squash", "origin/squashed"],
                &["commit", "--quiet", "-m", "squash"],
            ],
        );

        let report = report(&fixture).await;
        assert_eq!(report.bases, vec!["origin/main", "main"]);
        assert_eq!(evidence(&report, "merged"), Some(MergeEvidence::Ancestor));
        assert_eq!(
            evidence(&report, "rebased"),
            Some(MergeEvidence::PatchEquivalent)
        );
        assert_eq!(evidence(&report, "squashed"), Some(MergeEvidence::Squashed));
        assert_eq!(evidence(&report, "open"), None);
        assert_eq!(branch(&report, "open").unique_commits, Some(1));
        assert_eq!(
            branch(&report, "main").protection,
            Some(Protection::Default)
        );
        assert!(report.warnings.is_empty(), "{:?}", report.warnings);
    }

    #[tokio::test]
    async fn reports_branches_whose_remote_branch_was_deleted() {
        let fixture = Fixture::new();
        feature_branch(&fixture, "abandoned", "abandoned.txt");
        fixture.git(
            &fixture.seed,
            &["push", "--quiet", "origin", "--delete", "abandoned"],
        );

        let report = report(&fixture).await;
        let abandoned = branch(&report, "abandoned");
        assert!(abandoned.upstream_gone);
        assert_eq!(abandoned.merged, None);
    }

    #[tokio::test]
    async fn compares_forks_against_the_upstream_remote() {
        let fixture = Fixture::new();
        let upstream = fixture.root().join("upstream.git");
        fixture.git(
            fixture.root(),
            &[
                "clone",
                "--quiet",
                "--bare",
                fixture.remote.to_str().unwrap(),
                upstream.to_str().unwrap(),
            ],
        );
        fixture.git(
            &fixture.work,
            &["remote", "add", "upstream", upstream.to_str().unwrap()],
        );
        feature_branch(&fixture, "contrib", "contrib.txt");
        fixture.git(
            &fixture.work,
            &[
                "push",
                "--quiet",
                upstream.to_str().unwrap(),
                "contrib:main",
            ],
        );

        let report = report(&fixture).await;
        assert_eq!(report.bases, vec!["upstream/main", "origin/main", "main"]);
        assert_eq!(
            branch(&report, "contrib").merged,
            Some(Merged {
                evidence: MergeEvidence::Ancestor,
                base: "upstream/main".into()
            })
        );
    }

    #[tokio::test]
    async fn deletes_only_merged_unprotected_branches_unless_forced() {
        let fixture = Fixture::new();
        feature_branch(&fixture, "squashed", "squashed.txt");
        feature_branch(&fixture, "open", "open.txt");
        upstream_change(
            &fixture,
            &[
                &["merge", "--squash", "origin/squashed"],
                &["commit", "--quiet", "-m", "squash"],
            ],
        );
        fixture.git(&fixture.work, &["fetch", "--quiet"]);
        fixture.git(&fixture.work, &["switch", "--quiet", "-c", "current"]);

        let names: Vec<String> = ["squashed", "open", "main", "current", "missing"]
            .map(String::from)
            .into();
        let result = delete_branches(Git::new(&fixture.work), &names, false)
            .await
            .unwrap();
        let outcomes: Vec<&Outcome> = result.items.iter().map(|i| &i.outcome).collect();
        assert!(
            matches!(outcomes[0], Outcome::Succeeded { message } if message.starts_with("Deleted squashed (was "))
        );
        assert!(matches!(
            outcomes[1],
            Outcome::Skipped {
                reason: SkipReason::NotMerged,
                ..
            }
        ));
        assert_eq!(
            outcomes[2],
            &Outcome::skipped(SkipReason::Protected, "main is the default branch")
        );
        assert_eq!(
            outcomes[3],
            &Outcome::skipped(SkipReason::Protected, "current is checked out")
        );
        assert!(matches!(
            outcomes[4],
            Outcome::Skipped {
                reason: SkipReason::NotFound,
                ..
            }
        ));
        assert!(!branch_exists(&fixture, "squashed"));
        assert!(branch_exists(&fixture, "open"));

        let forced = delete_branches(Git::new(&fixture.work), &["open".to_string()], true)
            .await
            .unwrap();
        assert!(matches!(forced.items[0].outcome, Outcome::Succeeded { .. }));
        assert!(!branch_exists(&fixture, "open"));
    }

    #[tokio::test]
    async fn honors_configured_main_branches() {
        use crate::actions::{Action, Outcome as ActionOutcome, run_action, summarize};
        use crate::store::BranchSettings;

        let fixture = Fixture::new();
        let work = &fixture.work;
        for branch in ["dev", "2.x"] {
            fixture.git(work, &["switch", "--quiet", "-c", branch, "main"]);
            fixture.git(work, &["push", "--quiet", "-u", "origin", branch]);
        }
        feature_branch(&fixture, "backport", "backport.txt");
        fixture.git(work, &["switch", "--quiet", "2.x"]);
        fixture.git(
            work,
            &[
                "merge",
                "--quiet",
                "--no-ff",
                "-m",
                "merge backport",
                "backport",
            ],
        );
        fixture.git(work, &["push", "--quiet", "origin", "2.x"]);
        fixture.git(work, &["switch", "--quiet", "-c", "elsewhere", "main"]);
        let settings = BranchSettings {
            primary: Some("dev".into()),
            additional: vec!["2.x".into()],
        };
        let git = || Git::with_settings(work, settings.clone());

        let summary = summarize(&mut git()).await.unwrap();
        assert_eq!(summary.default_branch.as_deref(), Some("dev"));
        assert_eq!(summary.main_branches, vec!["dev", "2.x"]);
        assert!(summary.default_overridden);

        let report = analyze(&mut git(), false).await.unwrap();
        assert_eq!(branch(&report, "dev").protection, Some(Protection::Default));
        assert_eq!(branch(&report, "2.x").protection, Some(Protection::Default));
        assert_eq!(branch(&report, "main").protection, None);
        assert_eq!(
            branch(&report, "backport").merged,
            Some(Merged {
                evidence: MergeEvidence::Ancestor,
                base: "origin/2.x".into()
            })
        );

        let result = run_action(git(), &Action::CheckoutDefault).await;
        assert_eq!(result.outcome, ActionOutcome::succeeded("Switched to dev"));
    }

    fn add_worktree(fixture: &Fixture, branch: &str) -> PathBuf {
        let path = fixture.root().join(format!("wt-{branch}"));
        fixture.git(
            &fixture.work,
            &["worktree", "add", "--quiet", path.to_str().unwrap(), branch],
        );
        path
    }

    fn listed_path(report: &BranchReport, suffix: &str) -> PathBuf {
        report
            .worktrees
            .iter()
            .find(|w| w.path.ends_with(suffix))
            .unwrap()
            .path
            .clone()
    }

    #[tokio::test]
    async fn removes_clean_merged_worktrees_and_their_branches() {
        let fixture = Fixture::new();
        feature_branch(&fixture, "done", "done.txt");
        feature_branch(&fixture, "dirty", "dirty.txt");
        feature_branch(&fixture, "open", "open.txt");
        upstream_change(
            &fixture,
            &[
                &["merge", "--quiet", "--no-ff", "-m", "m1", "origin/done"],
                &["merge", "--quiet", "--no-ff", "-m", "m2", "origin/dirty"],
            ],
        );
        add_worktree(&fixture, "done");
        let dirty_path = add_worktree(&fixture, "dirty");
        add_worktree(&fixture, "open");
        fs::write(dirty_path.join("scratch.txt"), "x").unwrap();

        let report = report(&fixture).await;
        let main = &report.worktrees[0];
        assert!(main.is_main);
        let done = report
            .worktrees
            .iter()
            .find(|w| w.branch.as_deref() == Some("done"))
            .unwrap();
        assert_eq!(done.dirty, Some(false));
        assert!(done.merged.is_some());
        assert_eq!(
            branch(&report, "done").protection,
            Some(Protection::CheckedOutInWorktree)
        );

        let paths = vec![
            listed_path(&report, "wt-done"),
            listed_path(&report, "wt-dirty"),
            listed_path(&report, "wt-open"),
            main.path.clone(),
        ];
        let result = remove_worktrees(Git::new(&fixture.work), &paths, true, false)
            .await
            .unwrap();
        let outcomes: Vec<&Outcome> = result.items.iter().map(|i| &i.outcome).collect();
        assert!(
            matches!(outcomes[0], Outcome::Succeeded { message } if message.starts_with("Removed worktree; Deleted done")),
            "{outcomes:?}"
        );
        assert!(matches!(
            outcomes[1],
            Outcome::Skipped {
                reason: SkipReason::WorktreeDirty,
                ..
            }
        ));
        assert!(matches!(
            outcomes[2],
            Outcome::Skipped {
                reason: SkipReason::NotMerged,
                ..
            }
        ));
        assert!(matches!(
            outcomes[3],
            Outcome::Skipped {
                reason: SkipReason::Protected,
                ..
            }
        ));
        assert!(!fixture.root().join("wt-done").exists());
        assert!(!branch_exists(&fixture, "done"));
        assert!(dirty_path.join("scratch.txt").exists());
    }

    #[tokio::test]
    async fn prunes_worktrees_whose_directory_is_gone() {
        let fixture = Fixture::new();
        feature_branch(&fixture, "done", "done.txt");
        upstream_change(
            &fixture,
            &[&["merge", "--quiet", "--no-ff", "-m", "m", "origin/done"]],
        );
        let path = add_worktree(&fixture, "done");
        let report_before = report(&fixture).await;
        let listed = listed_path(&report_before, "wt-done");
        fs::remove_dir_all(&path).unwrap();

        let report = report(&fixture).await;
        assert!(report.worktrees[1].prunable);
        assert_eq!(report.worktrees[1].dirty, None);

        let result = remove_worktrees(Git::new(&fixture.work), &[listed], false, false)
            .await
            .unwrap();
        assert_eq!(
            result.items[0].outcome,
            Outcome::succeeded("Pruned missing worktree")
        );
        let worktrees = fixture.git(&fixture.work, &["worktree", "list"]);
        assert!(!worktrees.contains("wt-done"), "{worktrees}");
        assert!(branch_exists(&fixture, "done"));
    }

    #[tokio::test]
    async fn removes_unmerged_worktrees_only_when_allowed_and_keeps_their_branch() {
        let fixture = Fixture::new();
        feature_branch(&fixture, "open", "open.txt");
        add_worktree(&fixture, "open");
        let listed = listed_path(&report(&fixture).await, "wt-open");
        let detached = fixture.root().join("wt-detached");
        fixture.git(
            &fixture.work,
            &[
                "worktree",
                "add",
                "--quiet",
                "--detach",
                detached.to_str().unwrap(),
                "open",
            ],
        );
        fixture.commit(
            &detached,
            "only-here.txt",
            "x\n",
            "commit only in the detached worktree",
        );
        let detached_listed = listed_path(&report(&fixture).await, "wt-detached");

        let refused = remove_worktrees(
            Git::new(&fixture.work),
            std::slice::from_ref(&listed),
            false,
            false,
        )
        .await
        .unwrap();
        assert!(matches!(
            refused.items[0].outcome,
            Outcome::Skipped {
                reason: SkipReason::NotMerged,
                ..
            }
        ));

        let result = remove_worktrees(
            Git::new(&fixture.work),
            &[listed, detached_listed],
            true,
            true,
        )
        .await
        .unwrap();
        assert_eq!(
            result.items[0].outcome,
            Outcome::succeeded("Removed worktree; kept unmerged branch open")
        );
        assert!(matches!(
            &result.items[1].outcome,
            Outcome::Skipped { reason: SkipReason::NotMerged, message } if message.contains("detached")
        ));
        assert!(branch_exists(&fixture, "open"));
        assert!(!fixture.root().join("wt-open").exists());
        assert!(detached.exists());
    }

    #[tokio::test]
    async fn skips_locked_worktrees() {
        let fixture = Fixture::new();
        feature_branch(&fixture, "done", "done.txt");
        upstream_change(
            &fixture,
            &[&["merge", "--quiet", "--no-ff", "-m", "m", "origin/done"]],
        );
        let path = add_worktree(&fixture, "done");
        fixture.git(&fixture.work, &["worktree", "lock", path.to_str().unwrap()]);
        let listed = listed_path(&report(&fixture).await, "wt-done");

        let result = remove_worktrees(Git::new(&fixture.work), &[listed], true, false)
            .await
            .unwrap();
        assert_eq!(
            result.items[0].outcome,
            Outcome::skipped(SkipReason::WorktreeLocked, "Worktree is locked")
        );
        assert!(Path::new(&path).exists());
    }
}
