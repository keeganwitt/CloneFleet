use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;

use crate::git::{Git, GitError, failure_message};
use crate::status::{DefaultBranch, default_branch, primary_remote};

pub const UPSTREAM_REMOTE: &str = "upstream";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MergeEvidence {
    Ancestor,
    PatchEquivalent,
    Squashed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Merged {
    pub evidence: MergeEvidence,
    pub base: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Protection {
    Default,
    Current,
    CheckedOutInWorktree,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawBranch {
    pub name: String,
    pub sha: String,
    pub upstream: Option<String>,
    pub upstream_gone: bool,
    pub last_commit_unix: i64,
    pub author: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub sha: String,
    pub upstream: Option<String>,
    pub upstream_gone: bool,
    pub last_commit_unix: i64,
    pub author: String,
    pub subject: String,
    pub unique_commits: Option<u32>,
    pub merged: Option<Merged>,
    pub protection: Option<Protection>,
    pub worktree: Option<PathBuf>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RawWorktree {
    pub path: PathBuf,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: PathBuf,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub is_main: bool,
    pub locked: bool,
    pub prunable: bool,
    pub dirty: Option<bool>,
    pub merged: Option<Merged>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchReport {
    pub default_branch: Option<String>,
    pub bases: Vec<String>,
    pub branches: Vec<BranchInfo>,
    pub worktrees: Vec<WorktreeInfo>,
    pub warnings: Vec<String>,
}

const BRANCH_FORMAT: &str = "%(refname:lstrip=2)%00%(objectname)%00%(upstream:lstrip=2)%00\
%(upstream:track)%00%(committerdate:unix)%00%(authorname)%00%(subject)";

pub fn parse_branch_refs(output: &str) -> Vec<RawBranch> {
    output
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split('\0').collect();
            let [name, sha, upstream, track, date, author, subject] = fields[..] else {
                return None;
            };
            Some(RawBranch {
                name: name.to_string(),
                sha: sha.to_string(),
                upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
                upstream_gone: track == "[gone]",
                last_commit_unix: date.parse().unwrap_or(0),
                author: author.to_string(),
                subject: subject.to_string(),
            })
        })
        .collect()
}

pub fn parse_worktrees(output: &str) -> Vec<RawWorktree> {
    let mut worktrees = Vec::new();
    let mut current: Option<RawWorktree> = None;
    for line in output.lines() {
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        match key {
            "worktree" => {
                worktrees.extend(current.take());
                current = Some(RawWorktree {
                    path: PathBuf::from(value),
                    ..RawWorktree::default()
                });
            }
            _ => {
                let Some(worktree) = current.as_mut() else {
                    continue;
                };
                match key {
                    "HEAD" => worktree.head = Some(value.to_string()),
                    "branch" => {
                        worktree.branch = Some(
                            value
                                .strip_prefix("refs/heads/")
                                .unwrap_or(value)
                                .to_string(),
                        )
                    }
                    "bare" => worktree.bare = true,
                    "locked" => worktree.locked = true,
                    "prunable" => worktree.prunable = true,
                    _ => {}
                }
            }
        }
    }
    worktrees.extend(current);
    worktrees
}

pub async fn load_branches(git: &mut Git) -> Result<Vec<RawBranch>, GitError> {
    let format = format!("--format={BRANCH_FORMAT}");
    let output = git
        .run_ok(&[
            "for-each-ref",
            &format,
            "--sort=-committerdate",
            "refs/heads/",
        ])
        .await?;
    Ok(parse_branch_refs(&output))
}

pub async fn branch_names(git: &mut Git) -> Result<Vec<String>, GitError> {
    let mut names: Vec<String> = load_branches(git)
        .await?
        .into_iter()
        .map(|b| b.name)
        .collect();
    if let Some(remote) = primary_remote(git).await? {
        let prefix = format!("refs/remotes/{remote}/");
        let remote_refs = git
            .run_ok(&["for-each-ref", "--format=%(refname)", &prefix])
            .await?;
        names.extend(
            remote_refs
                .lines()
                .filter_map(|r| r.strip_prefix(&prefix))
                .filter(|name| *name != "HEAD")
                .map(str::to_string),
        );
    }
    names.sort();
    names.dedup();
    Ok(names)
}

pub async fn load_worktrees(git: &mut Git) -> Result<Vec<RawWorktree>, GitError> {
    let output = git.run_ok(&["worktree", "list", "--porcelain"]).await?;
    Ok(parse_worktrees(&output))
}

async fn ref_exists(git: &mut Git, reference: &str) -> Result<bool, GitError> {
    git.succeeds(&["rev-parse", "--verify", "--quiet", reference])
        .await
}

pub async fn merge_bases(
    git: &mut Git,
    default: &DefaultBranch,
    mains: &[String],
) -> Result<Vec<String>, GitError> {
    let mut remotes = vec![UPSTREAM_REMOTE.to_string()];
    remotes.extend(default.remote.clone());
    remotes.dedup();
    let mut bases = Vec::new();
    for main in mains {
        for remote in &remotes {
            let candidate = format!("{remote}/{main}");
            if ref_exists(git, &format!("refs/remotes/{candidate}")).await? {
                bases.push(candidate);
            }
        }
        if ref_exists(git, &format!("refs/heads/{main}")).await? {
            bases.push(main.clone());
        }
    }
    Ok(bases)
}

pub async fn merge_evidence(
    git: &mut Git,
    rev: &str,
    bases: &[String],
) -> Result<Option<Merged>, GitError> {
    for base in bases {
        if git
            .succeeds(&["merge-base", "--is-ancestor", rev, base])
            .await?
        {
            return Ok(Some(Merged {
                evidence: MergeEvidence::Ancestor,
                base: base.clone(),
            }));
        }
    }
    for base in bases {
        let cherry = git.run(&["cherry", base, rev]).await?;
        if cherry.success()
            && !cherry.stdout.trim().is_empty()
            && cherry.stdout.lines().all(|l| l.starts_with("- "))
        {
            return Ok(Some(Merged {
                evidence: MergeEvidence::PatchEquivalent,
                base: base.clone(),
            }));
        }
    }
    for base in bases {
        if squash_merged_into(git, rev, base).await? {
            return Ok(Some(Merged {
                evidence: MergeEvidence::Squashed,
                base: base.clone(),
            }));
        }
    }
    Ok(None)
}

async fn squash_merged_into(git: &mut Git, rev: &str, base: &str) -> Result<bool, GitError> {
    let merge_base = git.run(&["merge-base", base, rev]).await?;
    if !merge_base.success() {
        return Ok(false);
    }
    let merge_base = merge_base.stdout.trim().to_string();
    let tree = format!("{rev}^{{tree}}");
    // Builds a throwaway commit (never referenced, so gc removes it) holding the branch's whole
    // diff, then asks `git cherry` whether an equivalent patch exists on the base.
    let squashed = git
        .run(&[
            "-c",
            "user.name=CloneFleet",
            "-c",
            "user.email=clonefleet@localhost",
            "commit-tree",
            "--no-gpg-sign",
            &tree,
            "-p",
            &merge_base,
            "-m",
            "squash check",
        ])
        .await?;
    if !squashed.success() {
        return Ok(false);
    }
    let cherry = git.run(&["cherry", base, squashed.stdout.trim()]).await?;
    Ok(cherry.success() && cherry.stdout.starts_with("- "))
}

async fn unique_commits(git: &mut Git, rev: &str, bases: &[String]) -> Option<u32> {
    let base = bases.first()?;
    let range = format!("{base}..{rev}");
    git.run_ok(&["rev-list", "--count", &range])
        .await
        .ok()?
        .trim()
        .parse()
        .ok()
}

pub fn protection(
    branch: &str,
    mains: &[String],
    main_worktree_branch: Option<&str>,
    checked_out: &HashMap<String, PathBuf>,
) -> Option<Protection> {
    if mains.iter().any(|main| main == branch) {
        Some(Protection::Default)
    } else if main_worktree_branch == Some(branch) {
        Some(Protection::Current)
    } else if checked_out.contains_key(branch) {
        Some(Protection::CheckedOutInWorktree)
    } else {
        None
    }
}

pub async fn fetch_remotes(git: &mut Git, warnings: &mut Vec<String>) -> Result<(), GitError> {
    let mut remotes: Vec<String> = primary_remote(git).await?.into_iter().collect();
    let all_remotes = git.run_ok(&["remote"]).await?;
    if all_remotes.lines().any(|r| r.trim() == UPSTREAM_REMOTE) {
        remotes.push(UPSTREAM_REMOTE.to_string());
    }
    remotes.dedup();
    for remote in remotes {
        let fetched = git.run(&["fetch", "--prune", "--quiet", &remote]).await?;
        if !fetched.success() {
            warnings.push(format!(
                "Could not fetch {remote}: {}",
                failure_message(&fetched)
            ));
        }
    }
    Ok(())
}

pub struct RepoContext {
    pub default: Option<DefaultBranch>,
    pub mains: Vec<String>,
    pub bases: Vec<String>,
    pub branches: Vec<RawBranch>,
    pub worktrees: Vec<RawWorktree>,
}

impl RepoContext {
    pub async fn load(git: &mut Git) -> Result<Self, GitError> {
        let default = default_branch(git).await?;
        let mains = match &default {
            Some(default) => git.branch_settings().main_branches(&default.name),
            None => git.branch_settings().additional.clone(),
        };
        let bases = match &default {
            Some(default) => merge_bases(git, default, &mains).await?,
            None => Vec::new(),
        };
        Ok(Self {
            default,
            mains,
            bases,
            branches: load_branches(git).await?,
            worktrees: load_worktrees(git).await?,
        })
    }

    fn main_worktree(&self) -> Option<&RawWorktree> {
        self.worktrees.first()
    }

    pub fn checked_out(&self) -> HashMap<String, PathBuf> {
        self.worktrees
            .iter()
            .skip(1)
            .filter_map(|w| w.branch.clone().map(|b| (b, w.path.clone())))
            .collect()
    }

    pub fn protection(&self, branch: &str) -> Option<Protection> {
        protection(
            branch,
            &self.mains,
            self.main_worktree().and_then(|w| w.branch.as_deref()),
            &self.checked_out(),
        )
    }
}

pub async fn worktree_dirty(git: &mut Git, worktree: &RawWorktree) -> Result<bool, GitError> {
    let path = worktree.path.to_string_lossy();
    let status = git
        .run_ok(&[
            "-C",
            &path,
            "status",
            "--porcelain",
            "--untracked-files=normal",
        ])
        .await?;
    Ok(!status.trim().is_empty())
}

pub async fn analyze(git: &mut Git, fetch: bool) -> Result<BranchReport, GitError> {
    let mut warnings = Vec::new();
    if fetch {
        fetch_remotes(git, &mut warnings).await?;
    }
    let context = RepoContext::load(git).await?;
    if context.bases.is_empty() {
        warnings.push("Could not determine the default branch to compare against".to_string());
    }
    let checked_out = context.checked_out();

    let mut branches = Vec::with_capacity(context.branches.len());
    for raw in &context.branches {
        let protection = context.protection(&raw.name);
        let (merged, unique) = if protection == Some(Protection::Default) {
            (None, None)
        } else {
            (
                merge_evidence(git, &raw.name, &context.bases).await?,
                unique_commits(git, &raw.name, &context.bases).await,
            )
        };
        branches.push(BranchInfo {
            name: raw.name.clone(),
            sha: raw.sha.clone(),
            upstream: raw.upstream.clone(),
            upstream_gone: raw.upstream_gone,
            last_commit_unix: raw.last_commit_unix,
            author: raw.author.clone(),
            subject: raw.subject.clone(),
            unique_commits: unique,
            merged,
            protection,
            worktree: checked_out.get(&raw.name).cloned(),
        });
    }

    let mut worktrees = Vec::with_capacity(context.worktrees.len());
    for (index, raw) in context.worktrees.iter().enumerate() {
        let is_main = index == 0;
        let dirty = if raw.prunable || raw.bare {
            None
        } else {
            Some(worktree_dirty(git, raw).await?)
        };
        let merged = match (is_main, &raw.branch, &raw.head) {
            (true, _, _) => None,
            (false, Some(branch), _) => branches
                .iter()
                .find(|b| &b.name == branch)
                .and_then(|b| b.merged.clone()),
            (false, None, Some(head)) => merge_evidence(git, head, &context.bases).await?,
            (false, None, None) => None,
        };
        worktrees.push(WorktreeInfo {
            path: raw.path.clone(),
            head: raw.head.clone(),
            branch: raw.branch.clone(),
            is_main,
            locked: raw.locked,
            prunable: raw.prunable,
            dirty,
            merged,
        });
    }

    Ok(BranchReport {
        default_branch: context.default.map(|d| d.name),
        bases: context.bases,
        branches,
        worktrees,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_refs() {
        let output = "main\0aaa\0origin/main\0\x001700000000\0Ann\0Initial\n\
feature/x\0bbb\0origin/feature/x\0[gone]\x001600000000\0Bob\0Add x\n\
local\0ccc\0\0\0bad\0Cy\0subject with\0nul-free text\n";
        let branches = parse_branch_refs(output);
        assert_eq!(branches.len(), 2);
        assert_eq!(
            branches[1],
            RawBranch {
                name: "feature/x".into(),
                sha: "bbb".into(),
                upstream: Some("origin/feature/x".into()),
                upstream_gone: true,
                last_commit_unix: 1_600_000_000,
                author: "Bob".into(),
                subject: "Add x".into(),
            }
        );
        assert!(!branches[0].upstream_gone);
    }

    #[test]
    fn parses_worktree_list() {
        let output = "\
worktree /repo
HEAD 111
branch refs/heads/main

worktree /repo-wt/feature
HEAD 222
branch refs/heads/feature
locked on usb drive

worktree /repo-wt/detached
HEAD 333
detached

worktree /gone
HEAD 444
branch refs/heads/old
prunable gitdir file points to non-existent location
";
        let worktrees = parse_worktrees(output);
        assert_eq!(worktrees.len(), 4);
        assert_eq!(worktrees[0].branch.as_deref(), Some("main"));
        assert!(worktrees[1].locked);
        assert_eq!(worktrees[2].branch, None);
        assert_eq!(worktrees[2].head.as_deref(), Some("333"));
        assert!(worktrees[3].prunable);
        assert_eq!(worktrees[3].path, PathBuf::from("/gone"));
    }

    #[test]
    fn protects_default_current_and_checked_out_branches() {
        let checked_out = HashMap::from([("wt".to_string(), PathBuf::from("/wt"))]);
        let mains = vec!["main".to_string(), "2.x".to_string()];
        let check = |b| protection(b, &mains, Some("current"), &checked_out);
        assert_eq!(check("main"), Some(Protection::Default));
        assert_eq!(check("2.x"), Some(Protection::Default));
        assert_eq!(check("current"), Some(Protection::Current));
        assert_eq!(check("wt"), Some(Protection::CheckedOutInWorktree));
        assert_eq!(check("other"), None);
    }
}
