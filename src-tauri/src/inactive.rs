use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::actions::{Outcome, SkipReason};
use crate::artifacts::{Removal, is_artifact, usable_worktrees};
use crate::branches::load_worktrees;
use crate::cleanup::{CleanupResult, ItemOutcome};
use crate::git::{CommandRecord, Git, GitError, REFLOG_ACTION};
use crate::unpushed::analyze_unpushed;

const SHOWN_IGNORED_FILES: usize = 20;
const OS_METADATA_FILES: &[&str] = &[".DS_Store", "Thumbs.db", "desktop.ini"];
const LEGACY_PULL_SUBJECT: &str = "pull --no-rebase --ff-only --no-autostash --prune";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloneRisks {
    pub has_remotes: bool,
    pub unpushed_branches: Vec<String>,
    pub stashes: u32,
    pub dirty_worktrees: Vec<PathBuf>,
    pub linked_worktrees_outside: Vec<PathBuf>,
    pub nested_repos: Vec<PathBuf>,
    pub ignored_files: Vec<PathBuf>,
    pub ignored_file_count: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloneActivity {
    pub identities: Vec<String>,
    pub last_commit_by_me_unix: Option<i64>,
    pub last_local_activity_unix: Option<i64>,
    pub risks: CloneRisks,
    pub warnings: Vec<String>,
}

fn escape_extended_regex(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for c in text.chars() {
        if "\\.^$|?*+()[]{}".contains(c) {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    escaped
}

/// `--author` matches against `Name <email>`, so anchor each identity to its part of that.
pub fn author_pattern(identity: &str) -> String {
    let escaped = escape_extended_regex(identity);
    if identity.contains('<') {
        format!("^{escaped}$")
    } else if identity.contains('@') {
        format!("<{escaped}>$")
    } else {
        format!("^{escaped} <")
    }
}

async fn config_value(git: &mut Git, key: &str) -> Result<Option<String>, GitError> {
    let record = git.run(&["config", "--get", key]).await?;
    let value = record.stdout.trim();
    Ok((record.success() && !value.is_empty()).then(|| value.to_string()))
}

pub async fn resolve_identities(git: &mut Git, extra: &[String]) -> Result<Vec<String>, GitError> {
    let configured = match config_value(git, "user.email").await? {
        Some(email) => Some(email),
        None => config_value(git, "user.name").await?,
    };
    let mut identities: Vec<String> = Vec::new();
    for identity in configured.into_iter().chain(extra.iter().cloned()) {
        let identity = identity.trim().to_string();
        if !identity.is_empty()
            && !identities
                .iter()
                .any(|known| known.eq_ignore_ascii_case(&identity))
        {
            identities.push(identity);
        }
    }
    Ok(identities)
}

pub async fn last_commit_by(git: &mut Git, identities: &[String]) -> Result<Option<i64>, GitError> {
    if identities.is_empty() {
        return Ok(None);
    }
    let authors: Vec<String> = identities
        .iter()
        .map(|identity| format!("--author={}", author_pattern(identity)))
        .collect();
    let mut args = vec![
        "log",
        "--all",
        "--use-mailmap",
        "--extended-regexp",
        "--regexp-ignore-case",
        "-1",
        "--format=%ct",
    ];
    args.extend(authors.iter().map(String::as_str));
    let record = git.run(&args).await?;
    Ok(if record.success() {
        record.stdout.trim().parse().ok()
    } else {
        None
    })
}

pub fn is_own_entry(subject: &str) -> bool {
    subject.starts_with(REFLOG_ACTION) || subject.starts_with(LEGACY_PULL_SUBJECT)
}

fn reflog_time(selector: &str) -> Option<i64> {
    let (_, rest) = selector.rsplit_once("@{")?;
    rest.strip_suffix('}')?.parse().ok()
}

pub fn newest_activity(reflog: &str) -> Option<i64> {
    reflog
        .lines()
        .filter_map(|line| line.split_once('\0'))
        .filter(|(_, subject)| !is_own_entry(subject))
        .filter_map(|(selector, _)| reflog_time(selector))
        .max()
}

async fn worktree_roots(git: &mut Git) -> Result<Vec<PathBuf>, GitError> {
    let worktrees = load_worktrees(git).await?;
    Ok(usable_worktrees(&worktrees)
        .map(|w| w.path.clone())
        .collect())
}

pub async fn last_local_activity(git: &mut Git) -> Result<Option<i64>, GitError> {
    let mut newest = None;
    for root in worktree_roots(git).await? {
        let root = root.to_string_lossy();
        let record = git
            .run(&[
                "-C",
                &root,
                "reflog",
                "show",
                "--date=unix",
                "--format=%gd%x00%gs",
                "HEAD",
                "--",
            ])
            .await?;
        if record.success() {
            newest = newest.max(newest_activity(&record.stdout));
        }
    }
    Ok(newest)
}

fn is_os_metadata(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| OS_METADATA_FILES.contains(&name))
}

async fn ignored_files(git: &mut Git, root: &Path) -> Result<Vec<PathBuf>, GitError> {
    let output = git
        .run_ok(&[
            "ls-files",
            "-z",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
        ])
        .await?;
    let mut files: Vec<PathBuf> = output
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .map(|entry| PathBuf::from(entry.trim_end_matches('/')))
        .filter(|relative| !is_os_metadata(relative) && !is_artifact(&root.join(relative)))
        .collect();
    files.sort();
    Ok(files)
}

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

pub async fn clone_risks(
    git: &mut Git,
    known_repos: &BTreeSet<PathBuf>,
) -> Result<(CloneRisks, Vec<String>), GitError> {
    let repo = git.repo().to_path_buf();
    let unpushed = analyze_unpushed(git, false).await?;
    let root = canonical(&repo);
    let linked_worktrees_outside = worktree_roots(git)
        .await?
        .into_iter()
        .filter(|path| !canonical(path).starts_with(&root))
        .collect();
    let nested_repos = known_repos
        .iter()
        .filter(|known| *known != &repo && known.starts_with(&repo))
        .cloned()
        .collect();
    let mut ignored = ignored_files(git, &repo).await?;
    let ignored_file_count = u32::try_from(ignored.len()).unwrap_or(u32::MAX);
    ignored.truncate(SHOWN_IGNORED_FILES);
    let risks = CloneRisks {
        has_remotes: unpushed.has_remotes,
        unpushed_branches: unpushed
            .branches
            .into_iter()
            .filter(|b| b.merged.is_none())
            .map(|b| b.name)
            .collect(),
        stashes: u32::try_from(unpushed.stashes.len()).unwrap_or(u32::MAX),
        dirty_worktrees: unpushed.dirty_worktrees,
        linked_worktrees_outside,
        nested_repos,
        ignored_files: ignored,
        ignored_file_count,
    };
    Ok((risks, unpushed.warnings))
}

pub async fn clone_activity(
    git: &mut Git,
    extra_identities: &[String],
    known_repos: &BTreeSet<PathBuf>,
) -> Result<CloneActivity, GitError> {
    let identities = resolve_identities(git, extra_identities).await?;
    let last_commit_by_me_unix = last_commit_by(git, &identities).await?;
    let last_local_activity_unix = last_local_activity(git).await?;
    let (risks, mut warnings) = clone_risks(git, known_repos).await?;
    if identities.is_empty() {
        warnings.push(
            "No git identity is configured here; set user.email or add one in Settings".into(),
        );
    }
    Ok(CloneActivity {
        identities,
        last_commit_by_me_unix,
        last_local_activity_unix,
        risks,
        warnings,
    })
}

async fn check_repository_root(git: &mut Git) -> Result<Option<Outcome>, GitError> {
    let repo = git.repo().to_path_buf();
    let shown = repo.display();
    let not_root = |message: String| {
        Ok(Some(Outcome::skipped(
            SkipReason::NotRepositoryRoot,
            message,
        )))
    };
    match repo.symlink_metadata() {
        Err(_) => {
            return Ok(Some(Outcome::skipped(
                SkipReason::NotFound,
                format!("{shown} no longer exists"),
            )));
        }
        Ok(metadata) if !metadata.is_dir() => {
            return not_root(format!("{shown} isn't a directory"));
        }
        Ok(_) => {}
    }
    if repo.parent().is_none()
        || std::env::home_dir().is_some_and(|home| canonical(&home) == canonical(&repo))
    {
        return not_root(format!("{shown} is too broad to remove"));
    }
    if !repo.join(".git").is_dir() {
        return not_root(format!("{shown} isn't the main clone of a repository"));
    }
    let top_level = git.run(&["rev-parse", "--show-toplevel"]).await?;
    if !top_level.success() || canonical(Path::new(top_level.stdout.trim())) != canonical(&repo) {
        return not_root(format!("{shown} isn't the top of a repository"));
    }
    Ok(None)
}

fn removal_outcome(removal: Removal, shown: &str, result: Result<(), String>) -> Outcome {
    match (removal, result) {
        (Removal::Delete, Ok(())) => Outcome::succeeded(format!("Deleted {shown}")),
        (Removal::Trash, Ok(())) => Outcome::succeeded(format!("Moved {shown} to the Trash")),
        (Removal::Delete, Err(error)) => {
            Outcome::failed(format!("Couldn't delete {shown}: {error}"))
        }
        (Removal::Trash, Err(error)) => {
            Outcome::failed(format!("Couldn't move {shown} to the Trash: {error}"))
        }
    }
}

async fn remove_clone(
    git: &mut Git,
    reviewed: &CloneRisks,
    removal: Removal,
    known_repos: &BTreeSet<PathBuf>,
) -> Result<Outcome, GitError> {
    if let Some(refused) = check_repository_root(git).await? {
        return Ok(refused);
    }
    let (current, _) = clone_risks(git, known_repos).await?;
    if &current != reviewed {
        return Ok(Outcome::skipped(
            SkipReason::ChangedSinceReview,
            "Changed since you reviewed it; rescan and check again",
        ));
    }
    let target = git.repo().to_path_buf();
    let shown = target.display().to_string();
    let removed = tokio::task::spawn_blocking(move || removal.remove(&target))
        .await
        .unwrap_or_else(|e| Err(e.to_string()));
    git.record(CommandRecord::filesystem(
        &removal.log_args(&shown),
        removed.as_ref().err().cloned(),
    ));
    Ok(removal_outcome(removal, &shown, removed))
}

pub async fn trash_clone(
    mut git: Git,
    reviewed: &CloneRisks,
    removal: Removal,
    known_repos: &BTreeSet<PathBuf>,
) -> Result<CleanupResult, GitError> {
    let outcome = remove_clone(&mut git, reviewed, removal, known_repos).await?;
    Ok(CleanupResult {
        items: vec![ItemOutcome {
            item: git.repo().display().to_string(),
            outcome,
        }],
        commands: git.into_log(),
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::test_support::Fixture;

    const DAY: i64 = 86_400;

    fn now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    fn days_ago(timestamp: Option<i64>) -> Option<i64> {
        timestamp.map(|t| (now() - t + DAY / 2) / DAY)
    }

    fn clear_reflog(fixture: &Fixture) {
        fixture.git(
            &fixture.work,
            &["reflog", "expire", "--expire=all", "--all"],
        );
    }

    fn use_identity(fixture: &Fixture, email: &str) {
        fixture.git(&fixture.work, &["config", "user.email", email]);
    }

    async fn commit_days(fixture: &Fixture, extra: &[&str]) -> Option<i64> {
        let mut git = Git::new(&fixture.work);
        let extra: Vec<String> = extra.iter().map(|s| s.to_string()).collect();
        let identities = resolve_identities(&mut git, &extra).await.unwrap();
        days_ago(last_commit_by(&mut git, &identities).await.unwrap())
    }

    #[test]
    fn anchors_author_patterns_to_their_part_of_the_ident() {
        assert_eq!(author_pattern("bob@x.com"), r"<bob@x\.com>$");
        assert_eq!(author_pattern("Bob Smith"), "^Bob Smith <");
        assert_eq!(author_pattern("Bob <bob@x.com>"), r"^Bob <bob@x\.com>$");
        assert_eq!(author_pattern("a+b(c)"), r"^a\+b\(c\) <");
    }

    #[test]
    fn skips_reflog_entries_clonefleet_wrote() {
        let reflog = "HEAD@{300}\0clonefleet: Fast-forward\n\
                      HEAD@{250}\0pull --no-rebase --ff-only --no-autostash --prune: Fast-forward\n\
                      HEAD@{200}\0checkout: moving from main to feature\n\
                      HEAD@{100}\0clone: from /remote";
        assert_eq!(newest_activity(reflog), Some(200));
        assert_eq!(
            newest_activity("HEAD@{300}\0clonefleet: updating HEAD"),
            None
        );
        assert_eq!(newest_activity(""), None);
    }

    #[tokio::test]
    async fn finds_the_newest_commit_by_any_of_my_identities() {
        let fixture = Fixture::new();
        let work = &fixture.work;
        use_identity(&fixture, "me@example.com");
        fixture.commit_as(work, "Me", "me@example.com", 200, "mine.txt");
        fixture.commit_as(work, "Old Me", "old@example.com", 50, "old-me.txt");
        fixture.commit_as(work, "Someone", "notme@example.com", 1, "theirs.txt");
        fixture.commit_as(work, "Someone", "me@example.com.evil", 1, "evil.txt");

        assert_eq!(commit_days(&fixture, &[]).await, Some(200));
        assert_eq!(commit_days(&fixture, &["OLD@example.com"]).await, Some(50));
    }

    #[tokio::test]
    async fn matches_names_when_no_email_is_configured() {
        let fixture = Fixture::new();
        let work = &fixture.work;
        use_identity(&fixture, "");
        fixture.git(work, &["config", "user.name", "Me Myself"]);
        fixture.commit_as(work, "Me Myself", "laptop@host.local", 30, "mine.txt");
        fixture.commit_as(work, "Me Myselfish", "x@example.com", 1, "theirs.txt");

        let mut git = Git::new(work);
        assert_eq!(
            resolve_identities(&mut git, &[]).await.unwrap(),
            vec!["Me Myself"]
        );
        assert_eq!(commit_days(&fixture, &[]).await, Some(30));
    }

    #[tokio::test]
    async fn counts_commits_under_mailmap_aliases() {
        let fixture = Fixture::new();
        let work = &fixture.work;
        use_identity(&fixture, "me@example.com");
        fixture.commit_as(work, "Laptop", "laptop@host.local", 40, "mine.txt");
        fs::write(
            work.join(".mailmap"),
            "Me <me@example.com> <laptop@host.local>\n",
        )
        .unwrap();

        assert_eq!(commit_days(&fixture, &[]).await, Some(40));
    }

    #[tokio::test]
    async fn never_committed_has_no_date() {
        let fixture = Fixture::new();
        use_identity(&fixture, "nobody@example.com");
        assert_eq!(commit_days(&fixture, &[]).await, None);
    }

    #[tokio::test]
    async fn local_activity_ignores_what_clonefleet_did() {
        let fixture = Fixture::new();
        let work = &fixture.work;
        clear_reflog(&fixture);
        fixture.git_dated(work, 120, &["switch", "--quiet", "-c", "feature"]);
        fixture.git_dated(work, 120, &["switch", "--quiet", "main"]);

        fixture.commit(&fixture.seed, "next.txt", "n\n", "next");
        fixture.git(&fixture.seed, &["push", "--quiet"]);
        fixture.git(
            work,
            &[
                "pull",
                "--no-rebase",
                "--ff-only",
                "--no-autostash",
                "--prune",
            ],
        );
        fixture.commit(&fixture.seed, "again.txt", "a\n", "again");
        fixture.git(&fixture.seed, &["push", "--quiet"]);
        let mut git = Git::new(work);
        git.run_ok(&["pull", "--quiet", "--ff-only"]).await.unwrap();
        git.run_ok(&["switch", "--quiet", "feature"]).await.unwrap();

        assert_eq!(
            days_ago(last_local_activity(&mut git).await.unwrap()),
            Some(120)
        );

        fixture.git(work, &["switch", "--quiet", "main"]);
        assert_eq!(
            days_ago(last_local_activity(&mut git).await.unwrap()),
            Some(0)
        );
    }

    #[tokio::test]
    async fn local_activity_includes_linked_worktrees() {
        let fixture = Fixture::new();
        let work = &fixture.work;
        let linked = fixture.root().join("linked");
        fixture.git(
            work,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "side",
                linked.to_str().unwrap(),
            ],
        );
        clear_reflog(&fixture);
        fixture.git(&linked, &["reflog", "expire", "--expire=all", "--all"]);
        let mut git = Git::new(work);
        assert_eq!(last_local_activity(&mut git).await.unwrap(), None);

        fixture.git_dated(&linked, 10, &["switch", "--quiet", "--detach"]);
        assert_eq!(
            days_ago(last_local_activity(&mut git).await.unwrap()),
            Some(10)
        );
    }

    #[tokio::test]
    async fn reports_what_would_be_lost() {
        let fixture = Fixture::new();
        let work = &fixture.work;
        fixture.git(work, &["switch", "--quiet", "-c", "local-only"]);
        fixture.commit(work, "local.txt", "l\n", "local");
        fixture.git(work, &["switch", "--quiet", "main"]);
        fs::write(work.join("README.md"), "stash me\n").unwrap();
        fixture.git(work, &["stash", "push", "--quiet"]);
        fs::write(
            work.join(".gitignore"),
            ".env\n.DS_Store\nnode_modules/\nnested/\n",
        )
        .unwrap();
        fs::write(work.join(".env"), "SECRET=1\n").unwrap();
        fs::write(work.join(".DS_Store"), "").unwrap();
        fs::write(work.join("package.json"), "{}").unwrap();
        fs::create_dir_all(work.join("node_modules/left-pad")).unwrap();
        let nested = work.join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("file.txt"), "x\n").unwrap();
        let outside = fixture.root().join("outside");
        fixture.git(
            work,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "side",
                outside.to_str().unwrap(),
            ],
        );
        let known: BTreeSet<PathBuf> = [work.clone(), nested.clone()].into();

        let (mut risks, _) = clone_risks(&mut Git::new(work), &known).await.unwrap();
        for path in risks
            .dirty_worktrees
            .iter_mut()
            .chain(&mut risks.linked_worktrees_outside)
        {
            *path = path.canonicalize().unwrap();
        }
        assert_eq!(
            risks,
            CloneRisks {
                has_remotes: true,
                unpushed_branches: vec!["local-only".into()],
                stashes: 1,
                dirty_worktrees: vec![canonical(work)],
                linked_worktrees_outside: vec![canonical(&outside)],
                nested_repos: vec![nested],
                ignored_files: vec![".env".into(), "nested".into()],
                ignored_file_count: 2,
            }
        );
    }

    #[tokio::test]
    async fn removes_a_clone_only_when_nothing_changed_since_review() {
        let fixture = Fixture::new();
        let work = fixture.work.clone();
        let known: BTreeSet<PathBuf> = [work.clone()].into();
        let (reviewed, _) = clone_risks(&mut Git::new(&work), &known).await.unwrap();

        fs::write(work.join("new.txt"), "new\n").unwrap();
        let refused = trash_clone(Git::new(&work), &reviewed, Removal::Delete, &known)
            .await
            .unwrap();
        assert!(matches!(
            refused.items[0].outcome,
            Outcome::Skipped {
                reason: SkipReason::ChangedSinceReview,
                ..
            }
        ));
        assert!(work.exists());

        fs::remove_file(work.join("new.txt")).unwrap();
        let removed = trash_clone(Git::new(&work), &reviewed, Removal::Delete, &known)
            .await
            .unwrap();
        assert!(
            matches!(removed.items[0].outcome, Outcome::Succeeded { .. }),
            "{:?}",
            removed.items
        );
        assert!(!work.exists());
        assert!(
            removed
                .commands
                .iter()
                .any(|c| c.args.first().is_some_and(|a| a == "delete"))
        );
    }

    #[tokio::test]
    async fn refuses_to_remove_a_subdirectory_or_linked_worktree() {
        let fixture = Fixture::new();
        let work = &fixture.work;
        let sub = work.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let linked = fixture.root().join("linked");
        fixture.git(
            work,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "side",
                linked.to_str().unwrap(),
            ],
        );

        for path in [&sub, &linked] {
            let known: BTreeSet<PathBuf> = [path.clone()].into();
            let (reviewed, _) = clone_risks(&mut Git::new(path), &known).await.unwrap();
            let result = trash_clone(Git::new(path), &reviewed, Removal::Delete, &known)
                .await
                .unwrap();
            assert!(
                matches!(
                    result.items[0].outcome,
                    Outcome::Skipped {
                        reason: SkipReason::NotRepositoryRoot,
                        ..
                    }
                ),
                "{path:?}: {:?}",
                result.items
            );
            assert!(path.exists());
        }
    }
}
