use serde::Serialize;

use crate::branches::RepoContext;
use crate::git::{Git, GitError, failure_message};

pub const MAX_COMMITS: usize = 200;
pub const MAX_PATCH_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub sha: String,
    pub author: String,
    pub date_unix: i64,
    pub subject: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub patch: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchDiff {
    pub branch: String,
    pub base: String,
    pub commits: Vec<CommitInfo>,
    pub commits_truncated: bool,
    pub files: Vec<FileDiff>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NumstatEntry {
    path: String,
    old_path: Option<String>,
    additions: Option<u32>,
    deletions: Option<u32>,
}

fn parse_numstat_z(output: &str) -> Vec<NumstatEntry> {
    let mut entries = Vec::new();
    let mut tokens = output.split('\0');
    while let Some(token) = tokens.next() {
        let mut fields = token.splitn(3, '\t');
        let (Some(added), Some(deleted), Some(path)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let (path, old_path) = if path.is_empty() {
            let old = tokens.next().unwrap_or_default().to_string();
            let new = tokens.next().unwrap_or_default().to_string();
            (new, Some(old))
        } else {
            (path.to_string(), None)
        };
        entries.push(NumstatEntry {
            path,
            old_path,
            additions: added.parse().ok(),
            deletions: deleted.parse().ok(),
        });
    }
    entries
}

fn split_patches(patch: &str) -> Vec<&str> {
    let mut starts: Vec<usize> = patch
        .match_indices("diff --git ")
        .map(|(index, _)| index)
        .filter(|&index| index == 0 || patch.as_bytes()[index - 1] == b'\n')
        .collect();
    starts.push(patch.len());
    starts.windows(2).map(|w| &patch[w[0]..w[1]]).collect()
}

fn truncate_patch(patch: &str) -> (String, bool) {
    if patch.len() <= MAX_PATCH_BYTES {
        return (patch.to_string(), false);
    }
    let mut end = MAX_PATCH_BYTES;
    while !patch.is_char_boundary(end) {
        end -= 1;
    }
    let end = patch[..end].rfind('\n').map_or(end, |i| i + 1);
    (patch[..end].to_string(), true)
}

fn parse_log(output: &str) -> Vec<CommitInfo> {
    output
        .split('\x1e')
        .map(|record| record.trim_start_matches('\n'))
        .filter(|record| !record.is_empty())
        .filter_map(|record| {
            let mut fields = record.splitn(5, '\0');
            Some(CommitInfo {
                sha: fields.next()?.to_string(),
                author: fields.next()?.to_string(),
                date_unix: fields.next()?.parse().unwrap_or(0),
                subject: fields.next()?.to_string(),
                body: fields.next().unwrap_or_default().trim().to_string(),
            })
        })
        .collect()
}

fn invalid(args: &str, message: impl Into<String>) -> GitError {
    GitError::Failed {
        args: args.to_string(),
        message: message.into(),
    }
}

pub async fn branch_diff(
    git: &mut Git,
    branch: &str,
    base: Option<&str>,
) -> Result<BranchDiff, GitError> {
    if branch.starts_with('-') || base.is_some_and(|b| b.starts_with('-')) {
        return Err(invalid("diff", "Invalid branch name"));
    }
    let base = match base {
        Some(base) => base.to_string(),
        None => RepoContext::load(git)
            .await?
            .bases
            .into_iter()
            .next()
            .ok_or_else(|| invalid("diff", "No default branch to compare against"))?,
    };

    let range = format!("{base}..{branch}");
    let max_count = format!("--max-count={}", MAX_COMMITS + 1);
    let log = git
        .run_ok(&[
            "log",
            "--no-color",
            &max_count,
            "--format=%H%x00%an%x00%ct%x00%s%x00%b%x1e",
            &range,
        ])
        .await?;
    let mut commits = parse_log(&log);
    let commits_truncated = commits.len() > MAX_COMMITS;
    commits.truncate(MAX_COMMITS);

    let symmetric = format!("{base}...{branch}");
    let numstat = git
        .run_ok(&["diff", "--no-color", "-M", "--numstat", "-z", &symmetric])
        .await?;
    let patch = git
        .run_ok(&["diff", "--no-color", "--no-ext-diff", "-M", &symmetric])
        .await?;
    let patches = split_patches(&patch);
    let files = parse_numstat_z(&numstat)
        .into_iter()
        .enumerate()
        .map(|(index, entry)| {
            let (patch, truncated) = truncate_patch(patches.get(index).copied().unwrap_or(""));
            FileDiff {
                path: entry.path,
                old_path: entry.old_path,
                additions: entry.additions,
                deletions: entry.deletions,
                patch,
                truncated,
            }
        })
        .collect();

    Ok(BranchDiff {
        branch: branch.to_string(),
        base,
        commits,
        commits_truncated,
        files,
    })
}

fn count_changes(patch: &str) -> (u32, u32) {
    let mut additions = 0;
    let mut deletions = 0;
    for line in patch.lines() {
        if line.starts_with('+') && !line.starts_with("+++") {
            additions += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            deletions += 1;
        }
    }
    (additions, deletions)
}

pub async fn working_file_diff(
    git: &mut Git,
    path: &str,
    untracked: bool,
) -> Result<FileDiff, GitError> {
    let record = if untracked {
        if path.ends_with('/') {
            return Err(invalid(
                "diff",
                "Untracked directories are listed as a whole; open the folder to inspect its files",
            ));
        }
        // git treats /dev/null specially in --no-index mode on every platform, including Windows.
        git.run(&["diff", "--no-color", "--no-index", "--", "/dev/null", path])
            .await?
    } else {
        git.run(&["diff", "--no-color", "--no-ext-diff", "HEAD", "--", path])
            .await?
    };
    let differences_found = untracked && record.exit_code == Some(1);
    if !record.success() && !differences_found {
        return Err(invalid("diff", failure_message(&record)));
    }
    let binary = record.stdout.contains("\nBinary files ");
    let (patch, truncated) = truncate_patch(&record.stdout);
    let (additions, deletions) = count_changes(&patch);
    Ok(FileDiff {
        path: path.to_string(),
        old_path: None,
        additions: (!binary).then_some(additions),
        deletions: (!binary).then_some(deletions),
        patch,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::test_support::Fixture;

    #[test]
    fn parses_numstat_with_renames_and_binaries() {
        let output = "3\t1\tsrc/a b.rs\0-\t-\timage.png\x000\t0\t\0old.rs\0new.rs\0";
        assert_eq!(
            parse_numstat_z(output),
            vec![
                NumstatEntry {
                    path: "src/a b.rs".into(),
                    old_path: None,
                    additions: Some(3),
                    deletions: Some(1),
                },
                NumstatEntry {
                    path: "image.png".into(),
                    old_path: None,
                    additions: None,
                    deletions: None,
                },
                NumstatEntry {
                    path: "new.rs".into(),
                    old_path: Some("old.rs".into()),
                    additions: Some(0),
                    deletions: Some(0),
                },
            ]
        );
    }

    #[test]
    fn parses_commits_with_multi_line_bodies() {
        let output = "aaa\0Ann\x00100\0Subject one\0First paragraph.\n\nSecond paragraph.\n\x1e\nbbb\0Bob\x00200\0Subject two\0\x1e\n";
        let commits = parse_log(output);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].subject, "Subject one");
        assert_eq!(commits[0].body, "First paragraph.\n\nSecond paragraph.");
        assert_eq!(commits[1].sha, "bbb");
        assert_eq!(commits[1].date_unix, 200);
        assert_eq!(commits[1].body, "");
    }

    #[test]
    fn splits_patches_only_at_file_headers() {
        let patch =
            "diff --git a/x b/x\n+text mentioning diff --git inline\ndiff --git a/y b/y\n-y\n";
        assert_eq!(
            split_patches(patch),
            vec![
                "diff --git a/x b/x\n+text mentioning diff --git inline\n",
                "diff --git a/y b/y\n-y\n"
            ]
        );
        assert!(split_patches("").is_empty());
    }

    #[test]
    fn truncates_long_patches_at_a_line_boundary() {
        let line = "+".repeat(99) + "\n";
        let patch = line.repeat(MAX_PATCH_BYTES / 100 + 10);
        let (truncated, was_truncated) = truncate_patch(&patch);
        assert!(was_truncated);
        assert!(truncated.len() <= MAX_PATCH_BYTES);
        assert!(truncated.ends_with('\n'));
        assert_eq!(truncate_patch("small\n"), ("small\n".to_string(), false));
    }

    #[tokio::test]
    async fn diffs_a_branch_against_the_default_branch_from_where_it_diverged() {
        let fixture = Fixture::new();
        let work = &fixture.work;
        fixture.git(work, &["switch", "--quiet", "-c", "feature"]);
        fixture.commit(
            work,
            "feature.txt",
            "one\ntwo\n",
            "add feature\n\nExplains why the feature exists.\nAcross two lines.",
        );
        fixture.git(work, &["mv", "README.md", "DOCS.md"]);
        fixture.git(work, &["commit", "--quiet", "-m", "rename readme"]);
        fixture.git(work, &["switch", "--quiet", "main"]);
        fixture.commit(work, "main-only.txt", "m\n", "main moves on");
        fixture.git(work, &["push", "--quiet", "origin", "main"]);

        let diff = branch_diff(&mut Git::new(work), "feature", None)
            .await
            .unwrap();
        assert_eq!(diff.base, "origin/main");
        let subjects: Vec<&str> = diff.commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, vec!["rename readme", "add feature"]);
        assert_eq!(diff.commits[0].body, "");
        assert_eq!(
            diff.commits[1].body,
            "Explains why the feature exists.\nAcross two lines."
        );
        assert!(!diff.commits_truncated);

        let files: Vec<(&str, Option<&str>, Option<u32>)> = diff
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.old_path.as_deref(), f.additions))
            .collect();
        assert_eq!(
            files,
            vec![
                ("DOCS.md", Some("README.md"), Some(0)),
                ("feature.txt", None, Some(2))
            ]
        );
        assert!(diff.files[1].patch.starts_with("diff --git a/feature.txt"));
        assert!(diff.files[1].patch.contains("+two"));
        assert!(!diff.files.iter().any(|f| f.patch.contains("main-only")));
    }

    #[tokio::test]
    async fn rejects_option_like_branch_names() {
        let fixture = Fixture::new();
        let error = branch_diff(&mut Git::new(&fixture.work), "--output=x", None)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("Invalid branch name"));
    }

    #[tokio::test]
    async fn diffs_tracked_and_untracked_working_files() {
        let fixture = Fixture::new();
        let work = &fixture.work;
        fs::write(work.join("README.md"), "hello\nworld\n").unwrap();
        fs::write(work.join("new file.txt"), "a\nb\nc\n").unwrap();
        fs::create_dir(work.join("folder")).unwrap();
        fs::write(work.join("folder/inner.txt"), "x").unwrap();

        let tracked = working_file_diff(&mut Git::new(work), "README.md", false)
            .await
            .unwrap();
        assert_eq!((tracked.additions, tracked.deletions), (Some(1), Some(0)));
        assert!(tracked.patch.contains("+world"));

        let untracked = working_file_diff(&mut Git::new(work), "new file.txt", true)
            .await
            .unwrap();
        assert_eq!(untracked.additions, Some(3));
        assert!(untracked.patch.contains("+c"));

        let folder = working_file_diff(&mut Git::new(work), "folder/", true).await;
        assert!(
            folder
                .unwrap_err()
                .to_string()
                .contains("Untracked directories")
        );
    }
}
