use serde::{Deserialize, Serialize};

use crate::actions::{Outcome, SkipReason, blocked_by_operation, plural};
use crate::branches::UPSTREAM_REMOTE;
use crate::git::{Git, GitError, failure_message};
use crate::status::{InProgressOperation, primary_remote, remote_default_branch, repo_status};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PushPlan {
    pub remote: String,
    pub branch: String,
    pub commits: u32,
    pub force: bool,
    pub expected_remote_sha: Option<String>,
}

async fn rev_parse(git: &mut Git, rev: &str) -> Result<Option<String>, GitError> {
    let record = git.run(&["rev-parse", "--verify", "--quiet", rev]).await?;
    Ok(record.success().then(|| record.stdout.trim().to_string()))
}

async fn count(git: &mut Git, range: &str) -> Result<u32, GitError> {
    Ok(git
        .run_ok(&["rev-list", "--count", range])
        .await?
        .trim()
        .parse()
        .unwrap_or(0))
}

async fn fetch(git: &mut Git, remote: &str) -> Result<Option<Outcome>, GitError> {
    let fetched = git.run(&["fetch", "--prune", "--quiet", remote]).await?;
    Ok((!fetched.success()).then(|| {
        Outcome::failed(format!(
            "Could not fetch {remote}: {}",
            failure_message(&fetched)
        ))
    }))
}

pub async fn rebase_fork(git: &mut Git) -> Result<(Outcome, Option<PushPlan>), GitError> {
    let status = repo_status(git).await?;
    if let Some(blocked) = blocked_by_operation(&status) {
        return Ok((blocked, None));
    }
    let remotes = git.run_ok(&["remote"]).await?;
    if !remotes.lines().any(|r| r.trim() == UPSTREAM_REMOTE) {
        return Ok((
            Outcome::skipped(
                SkipReason::NoUpstreamRemote,
                format!("No remote named {UPSTREAM_REMOTE}"),
            ),
            None,
        ));
    }
    let fork = match primary_remote(git).await? {
        Some(remote) if remote != UPSTREAM_REMOTE => remote,
        _ => {
            return Ok((
                Outcome::skipped(
                    SkipReason::NoUpstreamRemote,
                    "No fork remote (origin) to push to",
                ),
                None,
            ));
        }
    };

    for remote in [UPSTREAM_REMOTE, fork.as_str()] {
        if let Some(failed) = fetch(git, remote).await? {
            return Ok((failed, None));
        }
    }
    let configured = git.branch_settings().primary.clone();
    let branch = match configured {
        Some(branch) => Some(branch),
        None => remote_default_branch(git, UPSTREAM_REMOTE).await?,
    };
    let Some(branch) = branch else {
        return Ok((
            Outcome::skipped(
                SkipReason::NoDefaultBranch,
                format!("Could not determine the default branch of {UPSTREAM_REMOTE}"),
            ),
            None,
        ));
    };
    let tree = &status.working_tree;
    if tree.branch.as_deref() != Some(branch.as_str()) {
        return Ok((
            Outcome::skipped(
                SkipReason::NotOnDefaultBranch,
                format!("Not on {branch}; check out the default branch first"),
            ),
            None,
        ));
    }
    let dirty = tree.tracked_changes + tree.conflicts;
    if dirty > 0 {
        return Ok((
            Outcome::skipped(
                SkipReason::UncommittedChanges,
                format!("{} with uncommitted changes", plural(dirty, "file")),
            ),
            None,
        ));
    }

    let target = format!("{UPSTREAM_REMOTE}/{branch}");
    let before = git.run_ok(&["rev-parse", "HEAD"]).await?;
    let rebased = git
        .run(&[
            "-c",
            "rebase.autoStash=false",
            "-c",
            "rebase.updateRefs=false",
            "rebase",
            "--quiet",
            &target,
        ])
        .await?;
    if !rebased.success() {
        let git_dir = git.run_ok(&["rev-parse", "--absolute-git-dir"]).await?;
        let in_progress = crate::status::detect_operation(git_dir.trim().as_ref());
        if in_progress == Some(InProgressOperation::Rebase) {
            git.run(&["rebase", "--abort"]).await?;
            return Ok((
                Outcome::failed(format!(
                    "Rebasing onto {target} hit conflicts and was aborted; nothing changed"
                )),
                None,
            ));
        }
        return Ok((Outcome::failed(failure_message(&rebased)), None));
    }
    let after = git.run_ok(&["rev-parse", "HEAD"]).await?;
    let after = after.trim();

    let mut message = if before.trim() == after {
        format!("{branch} is up to date with {target}")
    } else {
        format!("Rebased {branch} onto {target}")
    };

    let remote_ref = format!("refs/remotes/{fork}/{branch}");
    let remote_sha = rev_parse(git, &remote_ref).await?;
    let plan = match remote_sha {
        Some(sha) if sha == after => None,
        Some(sha) => {
            let force = !git
                .succeeds(&["merge-base", "--is-ancestor", &sha, after])
                .await?;
            Some(PushPlan {
                remote: fork.clone(),
                branch: branch.clone(),
                commits: count(git, &format!("{sha}..{after}")).await?,
                force,
                expected_remote_sha: force.then_some(sha),
            })
        }
        None => Some(PushPlan {
            remote: fork.clone(),
            branch: branch.clone(),
            commits: count(git, after).await?,
            force: false,
            expected_remote_sha: None,
        }),
    };
    match &plan {
        None => message.push_str(&format!("; {fork} is up to date")),
        Some(plan) if plan.force => message.push_str(&format!(
            "; {fork}/{branch} has diverged and needs a force push"
        )),
        Some(plan) => message.push_str(&format!(
            "; {} to push to {fork}",
            plural(plan.commits, "commit")
        )),
    }
    Ok((Outcome::succeeded(message), plan))
}

pub async fn push(git: &mut Git, plan: &PushPlan) -> Result<Outcome, GitError> {
    if plan.remote.starts_with('-') || plan.branch.starts_with('-') {
        return Ok(Outcome::failed("Invalid remote or branch name"));
    }
    let refspec = format!("refs/heads/{0}:refs/heads/{0}", plan.branch);
    let lease;
    let mut args = vec!["push", "--quiet"];
    if plan.force {
        let Some(expected) = &plan.expected_remote_sha else {
            return Ok(Outcome::failed(
                "A force push requires the expected remote commit",
            ));
        };
        lease = format!("--force-with-lease=refs/heads/{}:{expected}", plan.branch);
        args.push(&lease);
    }
    args.extend([plan.remote.as_str(), refspec.as_str()]);

    let pushed = git.run(&args).await?;
    if pushed.success() {
        let verb = if plan.force { "Force-pushed" } else { "Pushed" };
        return Ok(Outcome::succeeded(format!(
            "{verb} {} to {}",
            plan.branch, plan.remote
        )));
    }
    let message = failure_message(&pushed);
    Ok(Outcome::failed(if message.contains("stale info") {
        format!(
            "{}/{} changed since the rebase; run Rebase fork again",
            plan.remote, plan.branch
        )
    } else {
        message
    }))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use super::*;
    use crate::test_support::{Fixture, run};

    struct Fork {
        fixture: Fixture,
        upstream_seed: PathBuf,
    }

    impl Fork {
        fn new() -> Self {
            let fixture = Fixture::new();
            let root = fixture.root().to_path_buf();
            let upstream = root.join("upstream.git");
            let upstream_seed = root.join("upstream-seed");
            run(
                &root,
                &[
                    "clone",
                    "--quiet",
                    "--bare",
                    path(&fixture.remote),
                    path(&upstream),
                ],
            );
            run(
                &root,
                &[
                    "clone",
                    "--quiet",
                    "-c",
                    "core.autocrlf=false",
                    path(&upstream),
                    path(&upstream_seed),
                ],
            );
            fixture.configure(&upstream_seed);
            fixture.git(
                &fixture.work,
                &["remote", "add", UPSTREAM_REMOTE, path(&upstream)],
            );
            Self {
                fixture,
                upstream_seed,
            }
        }

        fn upstream_commit(&self, file: &str, contents: &str) {
            self.fixture.commit(
                &self.upstream_seed,
                file,
                contents,
                &format!("upstream {file}"),
            );
            self.fixture
                .git(&self.upstream_seed, &["push", "--quiet", "origin", "main"]);
        }

        fn work(&self) -> &Path {
            &self.fixture.work
        }

        fn origin_main(&self) -> String {
            self.fixture
                .git(&self.fixture.remote, &["rev-parse", "refs/heads/main"])
        }

        fn head(&self) -> String {
            self.fixture.git(self.work(), &["rev-parse", "HEAD"])
        }
    }

    fn path(p: &Path) -> &str {
        p.to_str().unwrap()
    }

    async fn rebase(fork: &Fork) -> (Outcome, Option<PushPlan>) {
        rebase_fork(&mut Git::new(fork.work())).await.unwrap()
    }

    async fn push_plan(fork: &Fork, plan: &PushPlan) -> Outcome {
        push(&mut Git::new(fork.work()), plan).await.unwrap()
    }

    #[tokio::test]
    async fn skips_repositories_without_an_upstream_remote() {
        let fixture = Fixture::new();
        let (outcome, plan) = rebase_fork(&mut Git::new(&fixture.work)).await.unwrap();
        assert_eq!(
            outcome,
            Outcome::skipped(SkipReason::NoUpstreamRemote, "No remote named upstream")
        );
        assert_eq!(plan, None);
    }

    #[tokio::test]
    async fn fast_forwards_and_plans_a_normal_push() {
        let fork = Fork::new();
        fork.upstream_commit("a.txt", "a\n");
        fork.upstream_commit("b.txt", "b\n");

        let (outcome, plan) = rebase(&fork).await;
        assert_eq!(
            outcome,
            Outcome::succeeded("Rebased main onto upstream/main; 2 commits to push to origin")
        );
        let plan = plan.unwrap();
        assert_eq!(
            plan,
            PushPlan {
                remote: "origin".into(),
                branch: "main".into(),
                commits: 2,
                force: false,
                expected_remote_sha: None,
            }
        );

        assert_eq!(
            push_plan(&fork, &plan).await,
            Outcome::succeeded("Pushed main to origin")
        );
        assert_eq!(fork.origin_main(), fork.head());
    }

    #[tokio::test]
    async fn rewrites_local_commits_and_force_pushes_with_a_lease() {
        let fork = Fork::new();
        fork.fixture
            .commit(fork.work(), "fork.txt", "fork\n", "fork-only change");
        fork.fixture
            .git(fork.work(), &["push", "--quiet", "origin", "main"]);
        let old_origin = fork.origin_main();
        fork.upstream_commit("upstream.txt", "u\n");

        let (outcome, plan) = rebase(&fork).await;
        assert_eq!(
            outcome,
            Outcome::succeeded(
                "Rebased main onto upstream/main; origin/main has diverged and needs a force push"
            )
        );
        let plan = plan.unwrap();
        assert!(plan.force);
        assert_eq!(
            plan.expected_remote_sha.as_deref(),
            Some(old_origin.as_str())
        );
        assert_eq!(
            fork.fixture.git(fork.work(), &["log", "-2", "--format=%s"]),
            "fork-only change\nupstream upstream.txt"
        );

        assert_eq!(
            push_plan(&fork, &plan).await,
            Outcome::succeeded("Force-pushed main to origin")
        );
        assert_eq!(fork.origin_main(), fork.head());
    }

    #[tokio::test]
    async fn force_push_refuses_when_origin_moved_after_the_rebase() {
        let fork = Fork::new();
        fork.fixture
            .commit(fork.work(), "fork.txt", "fork\n", "fork-only change");
        fork.fixture
            .git(fork.work(), &["push", "--quiet", "origin", "main"]);
        fork.upstream_commit("upstream.txt", "u\n");
        let (_, plan) = rebase(&fork).await;
        let plan = plan.unwrap();

        let seed = &fork.fixture.seed;
        fork.fixture.git(seed, &["pull", "--quiet", "--ff-only"]);
        fork.fixture
            .commit(seed, "other.txt", "someone else\n", "pushed meanwhile");
        fork.fixture
            .git(seed, &["push", "--quiet", "origin", "main"]);
        let moved = fork.origin_main();

        assert_eq!(
            push_plan(&fork, &plan).await,
            Outcome::failed("origin/main changed since the rebase; run Rebase fork again")
        );
        assert_eq!(fork.origin_main(), moved);
    }

    #[tokio::test]
    async fn aborts_conflicting_rebases() {
        let fork = Fork::new();
        fork.fixture
            .commit(fork.work(), "README.md", "fork version\n", "fork edit");
        fork.upstream_commit("README.md", "upstream version\n");
        let before = fork.head();

        let (outcome, plan) = rebase(&fork).await;
        assert_eq!(
            outcome,
            Outcome::failed(
                "Rebasing onto upstream/main hit conflicts and was aborted; nothing changed"
            )
        );
        assert_eq!(plan, None);
        assert_eq!(fork.head(), before);
        assert_eq!(
            fs::read_to_string(fork.work().join("README.md")).unwrap(),
            "fork version\n"
        );
        let git_dir = PathBuf::from(
            fork.fixture
                .git(fork.work(), &["rev-parse", "--absolute-git-dir"]),
        );
        assert_eq!(crate::status::detect_operation(&git_dir), None);
    }

    #[tokio::test]
    async fn reports_when_everything_is_up_to_date() {
        let fork = Fork::new();
        let (outcome, plan) = rebase(&fork).await;
        assert_eq!(
            outcome,
            Outcome::succeeded("main is up to date with upstream/main; origin is up to date")
        );
        assert_eq!(plan, None);
    }

    #[tokio::test]
    async fn skips_when_not_on_default_branch_or_dirty() {
        let fork = Fork::new();
        fork.upstream_commit("a.txt", "a\n");
        fork.fixture
            .git(fork.work(), &["switch", "--quiet", "-c", "feature"]);
        assert!(matches!(
            rebase(&fork).await.0,
            Outcome::Skipped {
                reason: SkipReason::NotOnDefaultBranch,
                ..
            }
        ));

        fork.fixture
            .git(fork.work(), &["switch", "--quiet", "main"]);
        fs::write(fork.work().join("README.md"), "dirty\n").unwrap();
        assert!(matches!(
            rebase(&fork).await.0,
            Outcome::Skipped {
                reason: SkipReason::UncommittedChanges,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn rejects_force_push_without_a_lease_and_option_like_names() {
        let fork = Fork::new();
        let plan = PushPlan {
            remote: "origin".into(),
            branch: "main".into(),
            commits: 1,
            force: true,
            expected_remote_sha: None,
        };
        assert!(matches!(
            push_plan(&fork, &plan).await,
            Outcome::Failed { .. }
        ));
        let plan = PushPlan {
            remote: "--mirror".into(),
            force: false,
            ..plan
        };
        assert_eq!(
            push_plan(&fork, &plan).await,
            Outcome::failed("Invalid remote or branch name")
        );
    }
}
