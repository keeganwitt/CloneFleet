use std::fs;
use std::path::{Path, PathBuf};

const SKIPPED_DIRECTORIES: &[&str] = &["node_modules", "target", "build", "dist", "vendor"];

/// Finds git repositories at or below `root`, descending at most `max_depth` levels.
///
/// Directories whose `.git` is a file (linked worktrees and submodules) are not reported,
/// and the search does not descend into a repository once found.
pub fn discover_repositories(root: &Path, max_depth: usize) -> Vec<PathBuf> {
    let mut found = Vec::new();
    visit(root, max_depth, &mut found);
    found.sort();
    found
}

fn visit(dir: &Path, remaining_depth: usize, found: &mut Vec<PathBuf>) {
    let dot_git = dir.join(".git");
    if let Ok(metadata) = fs::symlink_metadata(&dot_git) {
        if metadata.is_dir() {
            found.push(dir.to_path_buf());
        }
        return;
    }
    if remaining_depth == 0 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || SKIPPED_DIRECTORIES.contains(&name.as_ref()) {
            continue;
        }
        visit(&entry.path(), remaining_depth - 1, found);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_repo(path: &Path) {
        fs::create_dir_all(path.join(".git")).unwrap();
    }

    #[test]
    fn root_that_is_a_repo_returns_only_itself() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path());
        make_repo(&dir.path().join("nested"));
        assert_eq!(
            discover_repositories(dir.path(), 3),
            vec![dir.path().to_path_buf()]
        );
    }

    #[test]
    fn finds_repos_within_depth_and_skips_worktrees_and_ignored_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        make_repo(&root.join("a"));
        make_repo(&root.join("group/b"));
        make_repo(&root.join("group/deeper/too-deep"));
        make_repo(&root.join("node_modules/pkg"));
        make_repo(&root.join(".hidden/repo"));
        fs::create_dir_all(root.join("worktree")).unwrap();
        fs::write(root.join("worktree/.git"), "gitdir: /elsewhere").unwrap();

        assert_eq!(
            discover_repositories(root, 2),
            vec![root.join("a"), root.join("group/b")]
        );
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinked_directories() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        make_repo(&dir.path().join("outside/repo"));
        fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(dir.path().join("outside"), root.join("link")).unwrap();
        assert!(discover_repositories(&root, 3).is_empty());
    }
}
