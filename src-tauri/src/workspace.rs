use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::discovery::discover_repositories;
use crate::store::Config;

pub const DISCOVERY_MAX_DEPTH: usize = 4;
pub const MAX_RECENT: usize = 10;

fn dedupe(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = BTreeSet::new();
    paths
        .into_iter()
        .filter(|p| seen.insert(p.clone()))
        .collect()
}

impl Config {
    pub fn open(&mut self, roots: Vec<PathBuf>) {
        let roots = dedupe(roots);
        if roots.is_empty() || roots == self.roots {
            return;
        }
        let previous = std::mem::replace(&mut self.roots, roots.clone());
        self.recent.retain(|r| r != &roots && r != &previous);
        if !previous.is_empty() {
            self.recent.insert(0, previous);
        }
        self.recent.truncate(MAX_RECENT);
    }

    pub fn add(&mut self, roots: Vec<PathBuf>) {
        for root in dedupe(roots) {
            if !self.roots.contains(&root) {
                self.roots.push(root);
            }
        }
    }

    pub fn include_again(&mut self, roots: &[PathBuf]) {
        self.excluded
            .retain(|repo| !roots.iter().any(|root| repo.starts_with(root)));
    }

    pub fn remove_root(&mut self, root: &Path) {
        self.roots.retain(|r| r != root);
    }

    pub fn exclude(&mut self, repos: impl IntoIterator<Item = PathBuf>) {
        self.excluded.extend(repos);
    }
}

pub fn scan(roots: &[PathBuf], excluded: &BTreeSet<PathBuf>) -> BTreeSet<PathBuf> {
    roots
        .iter()
        .flat_map(|root| discover_repositories(root, DISCOVERY_MAX_DEPTH))
        .filter(|repo| !excluded.contains(repo))
        .collect()
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RootView {
    pub path: PathBuf,
    pub repo_count: usize,
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceView {
    pub roots: Vec<RootView>,
    pub repos: Vec<PathBuf>,
    pub excluded_count: usize,
    pub recent: Vec<Vec<PathBuf>>,
}

pub fn view(config: &Config, repos: &BTreeSet<PathBuf>) -> WorkspaceView {
    let in_workspace = |repo: &PathBuf| config.roots.iter().any(|root| repo.starts_with(root));
    WorkspaceView {
        roots: config
            .roots
            .iter()
            .map(|root| RootView {
                path: root.clone(),
                repo_count: repos.iter().filter(|r| r.starts_with(root)).count(),
                missing: !root.is_dir(),
            })
            .collect(),
        repos: repos.iter().cloned().collect(),
        excluded_count: config.excluded.iter().filter(|r| in_workspace(r)).count(),
        recent: config.recent.clone(),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn paths(names: &[&str]) -> Vec<PathBuf> {
        names.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn open_replaces_roots_and_remembers_the_previous_set() {
        let mut config = Config::default();
        config.open(paths(&["/a"]));
        assert!(config.recent.is_empty());
        config.open(paths(&["/b", "/c", "/b"]));
        assert_eq!(config.roots, paths(&["/b", "/c"]));
        assert_eq!(config.recent, vec![paths(&["/a"])]);

        config.open(paths(&["/a"]));
        assert_eq!(config.roots, paths(&["/a"]));
        assert_eq!(config.recent, vec![paths(&["/b", "/c"])]);
    }

    #[test]
    fn reopening_the_current_set_or_nothing_changes_nothing() {
        let mut config = Config::default();
        config.open(paths(&["/a"]));
        config.open(paths(&["/a"]));
        config.open(vec![]);
        assert_eq!(config.roots, paths(&["/a"]));
        assert!(config.recent.is_empty());
    }

    #[test]
    fn recent_is_capped() {
        let mut config = Config::default();
        for i in 0..=MAX_RECENT + 2 {
            config.open(vec![PathBuf::from(format!("/{i}"))]);
        }
        assert_eq!(config.recent.len(), MAX_RECENT);
        assert_eq!(config.recent[0], paths(&[&format!("/{}", MAX_RECENT + 1)]));
    }

    #[test]
    fn add_appends_new_roots_and_remove_drops_one() {
        let mut config = Config::default();
        config.open(paths(&["/a"]));
        config.add(paths(&["/b", "/a", "/c"]));
        assert_eq!(config.roots, paths(&["/a", "/b", "/c"]));
        config.remove_root(Path::new("/b"));
        assert_eq!(config.roots, paths(&["/a", "/c"]));
        assert!(config.recent.is_empty());
    }

    #[test]
    fn exclusions_persist_until_their_directory_is_added_again() {
        let mut config = Config::default();
        config.exclude(paths(&["/a/x", "/b/y"]));
        config.include_again(&paths(&["/a"]));
        assert_eq!(config.excluded, paths(&["/b/y"]).into_iter().collect());
    }

    #[test]
    fn scan_and_view_report_repos_per_root() {
        let dir = tempfile::tempdir().unwrap();
        let root_a = dir.path().join("a");
        let root_b = dir.path().join("b");
        for repo in ["a/one", "a/two", "b/three"] {
            fs::create_dir_all(dir.path().join(repo).join(".git")).unwrap();
        }
        let mut config = Config::default();
        config.open(vec![
            root_a.clone(),
            root_b.clone(),
            dir.path().join("gone"),
        ]);
        config.exclude([root_a.join("two")]);

        let repos = scan(&config.roots, &config.excluded);
        assert_eq!(
            repos.iter().cloned().collect::<Vec<_>>(),
            vec![root_a.join("one"), root_b.join("three")]
        );
        let view = view(&config, &repos);
        let counts: Vec<(usize, bool)> = view
            .roots
            .iter()
            .map(|r| (r.repo_count, r.missing))
            .collect();
        assert_eq!(counts, vec![(1, false), (1, false), (0, true)]);
        assert_eq!(view.excluded_count, 1);
    }
}
