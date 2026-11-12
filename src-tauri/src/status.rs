use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::git::{Git, GitError};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InProgressOperation {
    Rebase,
    Merge,
    CherryPick,
    Revert,
    Bisect,
}

impl InProgressOperation {
    pub fn describe(self) -> &'static str {
        match self {
            Self::Rebase => "a rebase",
            Self::Merge => "a merge",
            Self::CherryPick => "a cherry-pick",
            Self::Revert => "a revert",
            Self::Bisect => "a bisect",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkingTreeStatus {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub tracked_changes: u32,
    pub untracked: u32,
    pub conflicts: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    #[serde(flatten)]
    pub working_tree: WorkingTreeStatus,
    pub operation: Option<InProgressOperation>,
}

pub fn parse_porcelain_v2(output: &str) -> WorkingTreeStatus {
    let mut status = WorkingTreeStatus::default();
    for line in output.lines() {
        if let Some(header) = line.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.head" if value != "(detached)" => status.branch = Some(value.to_string()),
                "branch.upstream" => status.upstream = Some(value.to_string()),
                "branch.ab" => {
                    let mut counts = value.split(' ');
                    status.ahead = counts
                        .next()
                        .and_then(|a| a.trim_start_matches('+').parse().ok());
                    status.behind = counts
                        .next()
                        .and_then(|b| b.trim_start_matches('-').parse().ok());
                }
                _ => {}
            }
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            status.tracked_changes += 1;
        } else if line.starts_with("u ") {
            status.conflicts += 1;
        } else if line.starts_with("? ") {
            status.untracked += 1;
        }
    }
    status
}

pub fn detect_operation(git_dir: &Path) -> Option<InProgressOperation> {
    let exists = |name: &str| git_dir.join(name).exists();
    if exists("rebase-merge") || exists("rebase-apply") {
        Some(InProgressOperation::Rebase)
    } else if exists("MERGE_HEAD") {
        Some(InProgressOperation::Merge)
    } else if exists("CHERRY_PICK_HEAD") {
        Some(InProgressOperation::CherryPick)
    } else if exists("REVERT_HEAD") {
        Some(InProgressOperation::Revert)
    } else if exists("BISECT_LOG") {
        Some(InProgressOperation::Bisect)
    } else {
        None
    }
}

pub async fn repo_status(git: &mut Git) -> Result<RepoStatus, GitError> {
    let porcelain = git
        .run_ok(&[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=normal",
        ])
        .await?;
    let git_dir = git.run_ok(&["rev-parse", "--absolute-git-dir"]).await?;
    Ok(RepoStatus {
        working_tree: parse_porcelain_v2(&porcelain),
        operation: detect_operation(&PathBuf::from(git_dir.trim())),
    })
}

pub async fn primary_remote(git: &mut Git) -> Result<Option<String>, GitError> {
    let remotes = git.run_ok(&["remote"]).await?;
    let remotes: Vec<&str> = remotes
        .lines()
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .collect();
    Ok(if remotes.contains(&"origin") {
        Some("origin".to_string())
    } else if remotes.len() == 1 {
        Some(remotes[0].to_string())
    } else {
        None
    })
}

pub fn parse_ls_remote_symref(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let (reference, name) = line.strip_prefix("ref: ")?.split_once('\t')?;
        (name.trim() == "HEAD")
            .then(|| reference.strip_prefix("refs/heads/"))
            .flatten()
            .map(str::to_string)
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefaultBranch {
    pub name: String,
    pub remote: Option<String>,
}

pub async fn remote_default_branch(
    git: &mut Git,
    remote: &str,
) -> Result<Option<String>, GitError> {
    let head_ref = format!("refs/remotes/{remote}/HEAD");
    let symbolic = git
        .run(&["symbolic-ref", "--quiet", "--short", &head_ref])
        .await?;
    let prefix = format!("{remote}/");
    if symbolic.success()
        && let Some(name) = symbolic.stdout.trim().strip_prefix(&prefix)
    {
        return Ok(Some(name.to_string()));
    }

    let ls_remote = git.run(&["ls-remote", "--symref", remote, "HEAD"]).await?;
    Ok(ls_remote
        .success()
        .then(|| parse_ls_remote_symref(&ls_remote.stdout))
        .flatten())
}

pub async fn default_branch(git: &mut Git) -> Result<Option<DefaultBranch>, GitError> {
    let Some(remote) = primary_remote(git).await? else {
        return local_fallback_branch(git).await;
    };
    if let Some(name) = remote_default_branch(git, &remote).await? {
        return Ok(Some(DefaultBranch {
            name,
            remote: Some(remote),
        }));
    }
    local_fallback_branch(git).await
}

async fn local_fallback_branch(git: &mut Git) -> Result<Option<DefaultBranch>, GitError> {
    for candidate in ["main", "master"] {
        let reference = format!("refs/heads/{candidate}");
        if git
            .succeeds(&["show-ref", "--verify", "--quiet", &reference])
            .await?
        {
            return Ok(Some(DefaultBranch {
                name: candidate.to_string(),
                remote: None,
            }));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_headers_and_entry_counts() {
        let output = "\
# branch.oid 1234567890abcdef
# branch.head feature/x
# branch.upstream origin/feature/x
# branch.ab +2 -5
1 .M N... 100644 100644 100644 abc abc src/a.rs
2 R. N... 100644 100644 100644 abc abc R100 new.rs\told.rs
u UU N... 100644 100644 100644 100644 a b c conflict.rs
? scratch.txt
? notes.md
! target/
";
        assert_eq!(
            parse_porcelain_v2(output),
            WorkingTreeStatus {
                branch: Some("feature/x".into()),
                upstream: Some("origin/feature/x".into()),
                ahead: Some(2),
                behind: Some(5),
                tracked_changes: 2,
                untracked: 2,
                conflicts: 1,
            }
        );
    }

    #[test]
    fn detached_head_has_no_branch() {
        let status = parse_porcelain_v2("# branch.oid abc\n# branch.head (detached)\n");
        assert_eq!(status.branch, None);
        assert_eq!(status.upstream, None);
        assert_eq!(status.ahead, None);
    }

    #[test]
    fn parses_ls_remote_symref() {
        let output = "ref: refs/heads/trunk\tHEAD\n0123abcd\tHEAD\n";
        assert_eq!(parse_ls_remote_symref(output), Some("trunk".into()));
        assert_eq!(parse_ls_remote_symref("0123abcd\tHEAD\n"), None);
    }

    #[test]
    fn detects_in_progress_operations() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(detect_operation(dir.path()), None);
        std::fs::write(dir.path().join("MERGE_HEAD"), "").unwrap();
        assert_eq!(
            detect_operation(dir.path()),
            Some(InProgressOperation::Merge)
        );
        std::fs::create_dir(dir.path().join("rebase-merge")).unwrap();
        assert_eq!(
            detect_operation(dir.path()),
            Some(InProgressOperation::Rebase)
        );
    }
}
