use crate::actions::{Action, Outcome, SkipReason};
use crate::git::{Git, GitError, failure_message};
use crate::status::primary_remote;

async fn remotes(git: &mut Git) -> Result<Vec<String>, GitError> {
    Ok(git
        .run_ok(&["remote"])
        .await?
        .lines()
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .map(str::to_string)
        .collect())
}

pub async fn fetch_all(git: &mut Git) -> Result<Outcome, GitError> {
    let remotes = remotes(git).await?;
    if remotes.is_empty() {
        return Ok(Outcome::skipped(
            SkipReason::NoRemote,
            "No remotes configured",
        ));
    }
    let mut fetched = Vec::new();
    let mut failed = Vec::new();
    for remote in &remotes {
        let record = git.run(&["fetch", "--prune", "--quiet", remote]).await?;
        if record.success() {
            fetched.push(remote.as_str());
        } else {
            failed.push(format!("{remote}: {}", failure_message(&record)));
        }
    }
    Ok(if failed.is_empty() {
        Outcome::succeeded(format!("Fetched {}", fetched.join(", ")))
    } else if fetched.is_empty() {
        Outcome::failed(format!("Could not fetch {}", failed.join("; ")))
    } else {
        Outcome::failed(format!(
            "Fetched {}; could not fetch {}",
            fetched.join(", "),
            failed.join("; ")
        ))
    })
}

async fn remote_head(git: &mut Git, remote: &str) -> Result<Option<String>, GitError> {
    let head_ref = format!("refs/remotes/{remote}/HEAD");
    let record = git
        .run(&["symbolic-ref", "--quiet", "--short", &head_ref])
        .await?;
    let prefix = format!("{remote}/");
    Ok(record
        .success()
        .then(|| {
            record
                .stdout
                .trim()
                .strip_prefix(&prefix)
                .map(str::to_string)
        })
        .flatten())
}

async fn local_branch_exists(git: &mut Git, branch: &str) -> Result<bool, GitError> {
    let reference = format!("refs/heads/{branch}");
    git.succeeds(&["show-ref", "--verify", "--quiet", &reference])
        .await
}

pub async fn sync_default_branch(git: &mut Git) -> Result<(Outcome, Option<Action>), GitError> {
    let Some(remote) = primary_remote(git).await? else {
        return Ok((
            Outcome::skipped(SkipReason::NoRemote, "No remote to compare against"),
            None,
        ));
    };
    let previous = remote_head(git, &remote).await?;

    let fetched = git.run(&["fetch", "--prune", "--quiet", &remote]).await?;
    if !fetched.success() {
        return Ok((
            Outcome::failed(format!(
                "Could not fetch {remote}: {}",
                failure_message(&fetched)
            )),
            None,
        ));
    }
    let set_head = git.run(&["remote", "set-head", &remote, "--auto"]).await?;
    if !set_head.success() {
        return Ok((Outcome::failed(failure_message(&set_head)), None));
    }
    let Some(current) = remote_head(git, &remote).await? else {
        return Ok((
            Outcome::failed(format!("{remote} did not report a default branch")),
            None,
        ));
    };

    let Some(previous) = previous.filter(|p| p != &current) else {
        return Ok((
            Outcome::succeeded(format!("{remote}'s default branch is {current}")),
            None,
        ));
    };
    let mut message = format!("{remote}'s default branch changed from {previous} to {current}");
    let mut follow_up = None;
    if local_branch_exists(git, &previous).await? {
        if local_branch_exists(git, &current).await? {
            message.push_str(&format!(
                "; local {current} already exists alongside {previous}"
            ));
        } else {
            message.push_str(&format!("; local {previous} can be renamed"));
            follow_up = Some(Action::RenameBranch {
                remote: remote.clone(),
                from: previous,
                to: current,
            });
        }
    }
    Ok((Outcome::succeeded(message), follow_up))
}

pub async fn rename_branch(
    git: &mut Git,
    remote: &str,
    from: &str,
    to: &str,
) -> Result<Outcome, GitError> {
    if [remote, from, to].iter().any(|n| n.starts_with('-')) {
        return Ok(Outcome::failed("Invalid remote or branch name"));
    }
    if !local_branch_exists(git, from).await? {
        return Ok(Outcome::skipped(
            SkipReason::NotFound,
            format!("{from} no longer exists"),
        ));
    }
    if local_branch_exists(git, to).await? {
        return Ok(Outcome::skipped(
            SkipReason::AlreadyExists,
            format!("{to} already exists"),
        ));
    }
    let renamed = git.run(&["branch", "-m", from, to]).await?;
    if !renamed.success() {
        return Ok(Outcome::failed(failure_message(&renamed)));
    }
    let tracking = format!("{remote}/{to}");
    let tracking_ref = format!("refs/remotes/{tracking}");
    if git
        .succeeds(&["show-ref", "--verify", "--quiet", &tracking_ref])
        .await?
    {
        let upstream = format!("--set-upstream-to={tracking}");
        let tracked = git.run(&["branch", &upstream, to]).await?;
        if !tracked.success() {
            return Ok(Outcome::failed(format!(
                "Renamed {from} to {to}, but could not track {tracking}: {}",
                failure_message(&tracked)
            )));
        }
        return Ok(Outcome::succeeded(format!(
            "Renamed {from} to {to}, tracking {tracking}"
        )));
    }
    Ok(Outcome::succeeded(format!("Renamed {from} to {to}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actions::run_action;
    use crate::test_support::Fixture;

    fn rename_remote_default(fixture: &Fixture, to: &str) {
        let seed = &fixture.seed;
        fixture.git(seed, &["branch", "-m", "main", to]);
        fixture.git(seed, &["push", "--quiet", "origin", to]);
        let head = format!("refs/heads/{to}");
        fixture.git(&fixture.remote, &["symbolic-ref", "HEAD", &head]);
        fixture.git(seed, &["push", "--quiet", "origin", "--delete", "main"]);
    }

    async fn act(fixture: &Fixture, action: Action) -> (Outcome, Option<Action>) {
        let result = run_action(Git::new(&fixture.work), &action).await;
        (result.outcome, result.follow_up)
    }

    #[tokio::test]
    async fn fetch_updates_remote_tracking_refs_without_touching_head() {
        let fixture = Fixture::new();
        fixture.commit(&fixture.seed, "new.txt", "n\n", "new");
        fixture.git(&fixture.seed, &["push", "--quiet"]);
        let head = fixture.git(&fixture.work, &["rev-parse", "HEAD"]);

        assert_eq!(
            act(&fixture, Action::Fetch).await.0,
            Outcome::succeeded("Fetched origin")
        );
        assert_eq!(fixture.git(&fixture.work, &["rev-parse", "HEAD"]), head);
        assert_eq!(
            fixture.git(&fixture.work, &["rev-list", "--count", "HEAD..origin/main"]),
            "1"
        );
    }

    #[tokio::test]
    async fn fetch_reports_remotes_that_failed() {
        let fixture = Fixture::new();
        let missing = fixture.root().join("missing.git");
        fixture.git(
            &fixture.work,
            &["remote", "add", "broken", missing.to_str().unwrap()],
        );
        let (outcome, _) = act(&fixture, Action::Fetch).await;
        assert!(
            matches!(&outcome, Outcome::Failed { message }
                if message.starts_with("Fetched origin; could not fetch broken: ")),
            "{outcome:?}"
        );
    }

    #[tokio::test]
    async fn fetch_skips_repositories_without_remotes() {
        let fixture = Fixture::new();
        fixture.git(&fixture.work, &["remote", "remove", "origin"]);
        assert!(matches!(
            act(&fixture, Action::Fetch).await.0,
            Outcome::Skipped {
                reason: SkipReason::NoRemote,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn detects_a_renamed_default_branch_and_renames_the_local_branch() {
        let fixture = Fixture::new();
        rename_remote_default(&fixture, "trunk");

        let (outcome, follow_up) = act(&fixture, Action::SyncDefaultBranch).await;
        assert_eq!(
            outcome,
            Outcome::succeeded(
                "origin's default branch changed from main to trunk; local main can be renamed"
            )
        );
        let follow_up = follow_up.unwrap();
        assert_eq!(
            follow_up,
            Action::RenameBranch {
                remote: "origin".into(),
                from: "main".into(),
                to: "trunk".into(),
            }
        );
        assert_eq!(
            fixture.git(
                &fixture.work,
                &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]
            ),
            "origin/trunk"
        );

        assert_eq!(
            act(&fixture, follow_up).await.0,
            Outcome::succeeded("Renamed main to trunk, tracking origin/trunk")
        );
        assert_eq!(
            fixture.git(&fixture.work, &["branch", "--show-current"]),
            "trunk"
        );
        assert_eq!(
            fixture.git(
                &fixture.work,
                &["rev-parse", "--abbrev-ref", "trunk@{upstream}"]
            ),
            "origin/trunk"
        );
        assert_eq!(
            act(&fixture, Action::SyncDefaultBranch).await,
            (Outcome::succeeded("origin's default branch is trunk"), None)
        );
    }

    #[tokio::test]
    async fn does_not_offer_a_rename_when_the_new_branch_already_exists_locally() {
        let fixture = Fixture::new();
        rename_remote_default(&fixture, "trunk");
        fixture.git(&fixture.work, &["branch", "trunk"]);
        let (outcome, follow_up) = act(&fixture, Action::SyncDefaultBranch).await;
        assert_eq!(
            outcome,
            Outcome::succeeded(
                "origin's default branch changed from main to trunk; local trunk already exists alongside main"
            )
        );
        assert_eq!(follow_up, None);
    }

    #[tokio::test]
    async fn sets_a_missing_remote_head_without_suggesting_a_rename() {
        let fixture = Fixture::new();
        fixture.git(&fixture.work, &["remote", "set-head", "origin", "--delete"]);
        assert_eq!(
            act(&fixture, Action::SyncDefaultBranch).await,
            (Outcome::succeeded("origin's default branch is main"), None)
        );
    }

    #[tokio::test]
    async fn rename_refuses_to_overwrite_or_accept_option_like_names() {
        let fixture = Fixture::new();
        fixture.git(&fixture.work, &["branch", "other"]);
        let rename = |from: &str, to: &str| Action::RenameBranch {
            remote: "origin".into(),
            from: from.into(),
            to: to.into(),
        };
        assert_eq!(
            act(&fixture, rename("main", "other")).await.0,
            Outcome::skipped(SkipReason::AlreadyExists, "other already exists")
        );
        assert_eq!(
            act(&fixture, rename("gone", "new")).await.0,
            Outcome::skipped(SkipReason::NotFound, "gone no longer exists")
        );
        assert_eq!(
            act(&fixture, rename("main", "--force")).await.0,
            Outcome::failed("Invalid remote or branch name")
        );
    }
}
