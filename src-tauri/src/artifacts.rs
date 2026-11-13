use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::actions::{Outcome, SkipReason};
use crate::branches::{RawWorktree, load_worktrees};
use crate::cleanup::{CleanupResult, ItemOutcome};
use crate::git::{CommandRecord, Git, GitError};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Tier {
    BuildOutput,
    Reinstall,
    Unreproducible,
}

enum Marker {
    None,
    Beside(&'static [&'static str]),
    BesideWithExtension(&'static [&'static str]),
    Inside(&'static str),
}

struct Rule {
    kind: &'static str,
    names: &'static [&'static str],
    marker: Marker,
    tier: Tier,
}

const GRADLE_FILES: &[&str] = &[
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
];

const RULES: &[Rule] = &[
    Rule {
        kind: "Maven",
        names: &["target"],
        marker: Marker::Beside(&["pom.xml"]),
        tier: Tier::BuildOutput,
    },
    Rule {
        kind: "Cargo",
        names: &["target"],
        marker: Marker::Beside(&["Cargo.toml"]),
        tier: Tier::BuildOutput,
    },
    Rule {
        kind: "Gradle",
        names: &["build", ".gradle"],
        marker: Marker::Beside(GRADLE_FILES),
        tier: Tier::Reinstall,
    },
    Rule {
        kind: "JavaScript build cache",
        names: &[
            ".next",
            ".nuxt",
            ".svelte-kit",
            ".turbo",
            ".parcel-cache",
            ".angular",
        ],
        marker: Marker::Beside(&["package.json"]),
        tier: Tier::BuildOutput,
    },
    Rule {
        kind: "Distribution output",
        names: &["dist"],
        marker: Marker::Beside(&["package.json", "pyproject.toml", "setup.py"]),
        tier: Tier::BuildOutput,
    },
    Rule {
        kind: "Python cache",
        names: &["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"],
        marker: Marker::None,
        tier: Tier::BuildOutput,
    },
    Rule {
        kind: ".NET",
        names: &["bin", "obj"],
        marker: Marker::BesideWithExtension(&["csproj", "fsproj", "vbproj"]),
        tier: Tier::BuildOutput,
    },
    Rule {
        kind: "Swift package",
        names: &[".build"],
        marker: Marker::Beside(&["Package.swift"]),
        tier: Tier::BuildOutput,
    },
    Rule {
        kind: "Elixir build",
        names: &["_build"],
        marker: Marker::Beside(&["mix.exs"]),
        tier: Tier::BuildOutput,
    },
    Rule {
        kind: "Stack",
        names: &[".stack-work"],
        marker: Marker::Beside(&["stack.yaml"]),
        tier: Tier::BuildOutput,
    },
    Rule {
        kind: "Cabal",
        names: &["dist-newstyle"],
        marker: Marker::Beside(&["cabal.project"]),
        tier: Tier::BuildOutput,
    },
    Rule {
        kind: "Cabal",
        names: &["dist-newstyle"],
        marker: Marker::BesideWithExtension(&["cabal"]),
        tier: Tier::BuildOutput,
    },
    Rule {
        kind: "Zig",
        names: &[".zig-cache", "zig-cache", "zig-out"],
        marker: Marker::Beside(&["build.zig"]),
        tier: Tier::BuildOutput,
    },
    Rule {
        kind: "Node.js packages",
        names: &["node_modules"],
        marker: Marker::Beside(&["package.json"]),
        tier: Tier::Reinstall,
    },
    Rule {
        kind: "Tox",
        names: &[".tox"],
        marker: Marker::Beside(&["tox.ini", "pyproject.toml", "setup.cfg"]),
        tier: Tier::Reinstall,
    },
    Rule {
        kind: "Nox",
        names: &[".nox"],
        marker: Marker::Beside(&["noxfile.py"]),
        tier: Tier::Reinstall,
    },
    Rule {
        kind: "Elixir dependencies",
        names: &["deps"],
        marker: Marker::Beside(&["mix.exs"]),
        tier: Tier::Reinstall,
    },
    Rule {
        kind: "Terraform",
        names: &[".terraform"],
        marker: Marker::BesideWithExtension(&["tf"]),
        tier: Tier::Reinstall,
    },
    Rule {
        kind: "Vendored dependencies",
        names: &["vendor"],
        marker: Marker::Beside(&["go.mod", "composer.json"]),
        tier: Tier::Reinstall,
    },
    Rule {
        kind: "Python virtualenv",
        names: &[],
        marker: Marker::Inside("pyvenv.cfg"),
        tier: Tier::Unreproducible,
    },
];

fn marker_present(marker: &Marker, dir: &Path, parent: &Path) -> bool {
    match marker {
        Marker::None => true,
        Marker::Beside(files) => files.iter().any(|f| parent.join(f).is_file()),
        Marker::BesideWithExtension(extensions) => fs::read_dir(parent).is_ok_and(|entries| {
            entries.flatten().any(|entry| {
                let path = entry.path();
                path.is_file()
                    && path
                        .extension()
                        .is_some_and(|ext| extensions.iter().any(|e| ext == *e))
            })
        }),
        Marker::Inside(file) => dir.join(file).is_file(),
    }
}

fn classify(dir: &Path) -> Option<&'static Rule> {
    let name = dir.file_name()?.to_str()?;
    let parent = dir.parent()?;
    RULES.iter().find(|rule| {
        (rule.names.is_empty() || rule.names.contains(&name))
            && marker_present(&rule.marker, dir, parent)
    })
}

#[derive(Debug, Default, PartialEq, Eq)]
struct Inspection {
    bytes: u64,
    shared_bytes: u64,
    files: u64,
    newest_unix: Option<i64>,
    contains_repository: bool,
}

fn disk_usage(metadata: &fs::Metadata) -> (u64, bool) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (
            metadata.blocks() * 512,
            metadata.is_file() && metadata.nlink() > 1,
        )
    }
    #[cfg(not(unix))]
    {
        (metadata.len(), false)
    }
}

fn inspect(dir: &Path) -> Inspection {
    let mut found = Inspection::default();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(current) = pending.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry.file_name() == ".git" {
                found.contains_repository = true;
                continue;
            }
            let Ok(metadata) = entry.path().symlink_metadata() else {
                continue;
            };
            let (bytes, shared) = disk_usage(&metadata);
            if shared {
                found.shared_bytes += bytes;
            } else {
                found.bytes += bytes;
            }
            if let Some(modified) = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            {
                let modified = modified.as_secs() as i64;
                found.newest_unix = Some(found.newest_unix.map_or(modified, |n| n.max(modified)));
            }
            if metadata.is_dir() {
                pending.push(entry.path());
            } else {
                found.files += 1;
            }
        }
    }
    found
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub path: PathBuf,
    pub worktree: PathBuf,
    pub kind: &'static str,
    pub tier: Tier,
    pub bytes: u64,
    pub shared_bytes: u64,
    pub files: u64,
    pub modified_unix: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactReport {
    pub artifacts: Vec<Artifact>,
    pub warnings: Vec<String>,
}

fn is_plain_relative(path: &Path) -> bool {
    path.components().next().is_some()
        && path.components().all(|c| matches!(c, Component::Normal(_)))
}

fn git_pathspec(relative: &Path) -> String {
    let parts: Vec<_> = relative
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect();
    parts.join("/")
}

/// Directories git reports as wholly ignored: everything inside is ignored and nothing is tracked.
async fn ignored_directories(
    git: &mut Git,
    pathspec: Option<&str>,
) -> Result<Vec<PathBuf>, GitError> {
    let mut args = vec![
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
    ];
    let literal = pathspec.map(|p| format!(":(literal){p}/"));
    if let Some(literal) = &literal {
        args.extend(["--", literal.as_str()]);
    }
    let output = git.run_ok(&args).await?;
    Ok(output
        .split('\0')
        .filter_map(|entry| entry.strip_suffix('/'))
        .map(PathBuf::from)
        .filter(|path| is_plain_relative(path))
        .collect())
}

fn usable_worktrees(worktrees: &[RawWorktree]) -> impl Iterator<Item = &RawWorktree> {
    worktrees.iter().filter(|w| !w.bare && !w.prunable)
}

pub async fn scan(git: &mut Git) -> Result<ArtifactReport, GitError> {
    let worktrees = load_worktrees(git).await?;
    let mut candidates = Vec::new();
    let mut warnings = Vec::new();
    for (index, worktree) in worktrees.iter().enumerate() {
        if worktree.bare || worktree.prunable {
            continue;
        }
        let root = if index == 0 {
            git.repo().to_path_buf()
        } else {
            worktree.path.clone()
        };
        let mut worktree_git = git.at(&root);
        match ignored_directories(&mut worktree_git, None).await {
            Ok(mut directories) => {
                directories.sort();
                let mut kept: Option<PathBuf> = None;
                for relative in directories {
                    if kept.as_ref().is_some_and(|k| relative.starts_with(k)) {
                        continue;
                    }
                    let path = root.join(&relative);
                    if let Some(rule) = classify(&path) {
                        candidates.push((path, root.clone(), rule));
                        kept = Some(relative);
                    }
                }
            }
            Err(error) => warnings.push(format!(
                "Couldn't list ignored files in {}: {error}",
                root.display()
            )),
        }
    }
    let artifacts = tokio::task::spawn_blocking(move || {
        candidates
            .into_iter()
            .filter_map(|(path, worktree, rule)| {
                let found = inspect(&path);
                (!found.contains_repository).then_some(Artifact {
                    path,
                    worktree,
                    kind: rule.kind,
                    tier: rule.tier,
                    bytes: found.bytes,
                    shared_bytes: found.shared_bytes,
                    files: found.files,
                    modified_unix: found.newest_unix,
                })
            })
            .collect()
    })
    .await
    .unwrap_or_default();
    Ok(ArtifactReport {
        artifacts,
        warnings,
    })
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Removal {
    Delete,
    Trash,
}

impl Removal {
    fn log_args(self, path: &str) -> [&str; 2] {
        match self {
            Removal::Delete => ["delete", path],
            Removal::Trash => ["move-to-trash", path],
        }
    }

    fn remove(self, path: &Path) -> Result<(), String> {
        match self {
            Removal::Delete => fs::remove_dir_all(path).map_err(|e| e.to_string()),
            Removal::Trash => {
                #[allow(unused_mut)]
                let mut context = trash::TrashContext::default();
                #[cfg(target_os = "macos")]
                {
                    use trash::macos::{DeleteMethod, TrashContextExtMacos};
                    // The default Finder method asks for Automation permission and plays a sound.
                    context.set_delete_method(DeleteMethod::NsFileManager);
                }
                context.delete(path).map_err(|e| e.to_string())
            }
        }
    }

    fn outcome(self, shown: &str, kind: &str, bytes: u64, result: Result<(), String>) -> Outcome {
        let size = format_bytes(bytes);
        match (self, result) {
            (Removal::Delete, Ok(())) => {
                Outcome::succeeded(format!("Deleted {shown} ({kind}, freed {size})"))
            }
            (Removal::Trash, Ok(())) => {
                Outcome::succeeded(format!("Moved {shown} to the Trash ({kind}, {size})"))
            }
            (Removal::Delete, Err(error)) => {
                Outcome::failed(format!("Couldn't delete {shown}: {error}"))
            }
            (Removal::Trash, Err(error)) => {
                Outcome::failed(format!("Couldn't move {shown} to the Trash: {error}"))
            }
        }
    }
}

pub fn format_bytes(bytes: u64) -> String {
    const UNITS: &[&str] = &["kB", "MB", "GB", "TB"];
    if bytes < 1000 {
        return format!("{bytes} bytes");
    }
    let mut value = bytes as f64;
    let mut unit = "";
    for candidate in UNITS {
        value /= 1000.0;
        unit = candidate;
        if value < 1000.0 {
            break;
        }
    }
    format!("{value:.1} {unit}")
}

async fn delete_one(
    git: &mut Git,
    worktrees: &[RawWorktree],
    path: &Path,
    tiers: &[Tier],
    removal: Removal,
) -> Result<Outcome, GitError> {
    let not_found = || {
        Ok(Outcome::skipped(
            SkipReason::NotFound,
            format!("{} isn't in this repository", path.display()),
        ))
    };
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return not_found();
    };
    let Ok(resolved_parent) = parent.canonicalize() else {
        return not_found();
    };
    let resolved = resolved_parent.join(name);
    let roots: Vec<PathBuf> = usable_worktrees(worktrees)
        .map(|w| w.path.canonicalize().unwrap_or_else(|_| w.path.clone()))
        .collect();
    let Some(root) = roots
        .into_iter()
        .filter(|root| resolved.starts_with(root))
        .max_by_key(|root| root.as_os_str().len())
    else {
        return not_found();
    };
    let path = resolved.as_path();
    let relative = path.strip_prefix(&root).unwrap_or(path);
    let shown = relative.display();
    if !is_plain_relative(relative) {
        return Ok(Outcome::skipped(
            SkipReason::NotArtifact,
            format!("{shown} isn't a build or dependency directory"),
        ));
    }
    match path.symlink_metadata() {
        Err(_) => {
            return Ok(Outcome::skipped(
                SkipReason::NotFound,
                format!("{shown} no longer exists"),
            ));
        }
        Ok(metadata) if !metadata.is_dir() => {
            return Ok(Outcome::skipped(
                SkipReason::NotArtifact,
                format!("{shown} isn't a directory"),
            ));
        }
        Ok(_) => {}
    }
    let Some(rule) = classify(path) else {
        return Ok(Outcome::skipped(
            SkipReason::NotArtifact,
            format!("{shown} no longer looks like a build or dependency directory"),
        ));
    };
    if !tiers.contains(&rule.tier) {
        return Ok(Outcome::skipped(
            SkipReason::TierHidden,
            format!("{shown} is in a category that isn't shown"),
        ));
    }

    let pathspec = git_pathspec(relative);
    let mut worktree_git = git.at(&root);
    let ignored = ignored_directories(&mut worktree_git, Some(&pathspec)).await;
    for record in worktree_git.into_log() {
        git.record(record);
    }
    if !ignored?.iter().any(|d| d == relative) {
        return Ok(Outcome::skipped(
            SkipReason::NotIgnored,
            format!("{shown} is no longer entirely ignored by git"),
        ));
    }

    let target = path.to_path_buf();
    let checked = tokio::task::spawn_blocking(move || {
        let inside = match (target.canonicalize(), root.canonicalize()) {
            (Ok(target), Ok(root)) => target.starts_with(root),
            _ => false,
        };
        (inside, inspect(&target))
    })
    .await;
    let Ok((inside, found)) = checked else {
        return Ok(Outcome::failed(format!("Couldn't inspect {shown}")));
    };
    if !inside {
        return Ok(Outcome::skipped(
            SkipReason::NotArtifact,
            format!("{shown} resolves outside the repository"),
        ));
    }
    if found.contains_repository {
        return Ok(Outcome::skipped(
            SkipReason::ContainsRepository,
            format!("{shown} contains a git repository"),
        ));
    }

    let target = path.to_path_buf();
    let removed = tokio::task::spawn_blocking(move || removal.remove(&target))
        .await
        .unwrap_or_else(|e| Err(e.to_string()));
    let display = path.to_string_lossy();
    git.record(CommandRecord::filesystem(
        &removal.log_args(&display),
        removed.as_ref().err().cloned(),
    ));
    Ok(removal.outcome(&shown.to_string(), rule.kind, found.bytes, removed))
}

pub async fn delete(
    mut git: Git,
    paths: &[PathBuf],
    tiers: &[Tier],
    removal: Removal,
) -> Result<CleanupResult, GitError> {
    let worktrees = load_worktrees(&mut git).await?;
    let mut items = Vec::with_capacity(paths.len());
    for path in paths {
        let outcome = delete_one(&mut git, &worktrees, path, tiers, removal).await?;
        items.push(ItemOutcome {
            item: path.display().to_string(),
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
    use super::*;
    use crate::test_support::Fixture;

    const ALL_TIERS: &[Tier] = &[Tier::BuildOutput, Tier::Reinstall, Tier::Unreproducible];

    fn write(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    fn kind_of(path: &Path) -> Option<&'static str> {
        classify(path).map(|rule| rule.kind)
    }

    #[test]
    fn classifies_directories_by_name_and_marker() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("maven/pom.xml"), "");
        write(&root.join("cargo/Cargo.toml"), "");
        write(&root.join("dotnet/App.csproj"), "");
        write(&root.join("env/pyvenv.cfg"), "");
        for sub in [
            "maven/target",
            "cargo/target",
            "bare/target",
            "dotnet/bin",
            "src/__pycache__",
        ] {
            fs::create_dir_all(root.join(sub)).unwrap();
        }

        assert_eq!(kind_of(&root.join("maven/target")), Some("Maven"));
        assert_eq!(kind_of(&root.join("cargo/target")), Some("Cargo"));
        assert_eq!(kind_of(&root.join("bare/target")), None);
        assert_eq!(kind_of(&root.join("dotnet/bin")), Some(".NET"));
        assert_eq!(kind_of(&root.join("src/__pycache__")), Some("Python cache"));
        assert_eq!(kind_of(&root.join("env")), Some("Python virtualenv"));
    }

    #[test]
    fn formats_sizes_in_decimal_units() {
        assert_eq!(format_bytes(999), "999 bytes");
        assert_eq!(format_bytes(1_500), "1.5 kB");
        assert_eq!(format_bytes(2_340_000_000), "2.3 GB");
    }

    fn node_project(fixture: &Fixture, ignore: &str) -> PathBuf {
        let work = fixture.work.clone();
        fixture.commit(&work, ".gitignore", ignore, "ignore");
        fixture.commit(&work, "package.json", "{}", "package");
        write(
            &work.join("node_modules/left-pad/index.js"),
            "module.exports = 1;\n",
        );
        work
    }

    #[tokio::test]
    async fn finds_ignored_artifacts_and_their_size() {
        let fixture = Fixture::new();
        let work = node_project(&fixture, "node_modules/\n");
        let report = scan(&mut Git::new(&work)).await.unwrap();
        assert_eq!(report.artifacts.len(), 1, "{report:?}");
        let artifact = &report.artifacts[0];
        assert_eq!(artifact.path, work.join("node_modules"));
        assert_eq!(artifact.worktree, work);
        assert_eq!(artifact.kind, "Node.js packages");
        assert_eq!(artifact.tier, Tier::Reinstall);
        assert_eq!(artifact.files, 1);
        assert!(artifact.bytes > 0);
        assert!(artifact.modified_unix.is_some());
    }

    #[tokio::test]
    async fn skips_directories_that_are_not_entirely_ignored() {
        let fixture = Fixture::new();
        let work = node_project(&fixture, "target/\n");
        fixture.commit(&work, "pom.xml", "<project/>", "pom");
        write(&work.join("target/classes/A.class"), "x");
        write(&work.join("target/keep.txt"), "x");
        fixture.git(&work, &["add", "-f", "target/keep.txt"]);
        fixture.git(&work, &["commit", "--quiet", "-m", "keep"]);

        let report = scan(&mut Git::new(&work)).await.unwrap();
        assert!(report.artifacts.is_empty(), "{report:?}");
    }

    #[tokio::test]
    async fn skips_ignored_directories_containing_a_repository() {
        let fixture = Fixture::new();
        let work = node_project(&fixture, "node_modules/\n");
        fs::create_dir_all(work.join("node_modules/left-pad/.git")).unwrap();
        let report = scan(&mut Git::new(&work)).await.unwrap();
        assert!(report.artifacts.is_empty(), "{report:?}");
    }

    #[tokio::test]
    async fn reports_only_the_outermost_artifact() {
        let fixture = Fixture::new();
        let work = node_project(&fixture, "dist/\nnode_modules/\n");
        write(&work.join("dist/node_modules/x/index.js"), "x");
        write(&work.join("dist/package.json"), "{}");
        let report = scan(&mut Git::new(&work)).await.unwrap();
        let paths: Vec<_> = report.artifacts.iter().map(|a| a.path.clone()).collect();
        assert_eq!(paths, vec![work.join("dist"), work.join("node_modules")]);
    }

    #[tokio::test]
    async fn includes_linked_worktrees() {
        let fixture = Fixture::new();
        let work = node_project(&fixture, "node_modules/\n");
        let linked = fixture.root().join("linked");
        fixture.git(
            &work,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "feature",
                linked.to_str().unwrap(),
            ],
        );
        write(&linked.join("node_modules/x/index.js"), "x");
        let report = scan(&mut Git::new(&work)).await.unwrap();
        let worktrees: Vec<_> = report
            .artifacts
            .iter()
            .map(|a| a.worktree.clone())
            .collect();
        assert_eq!(worktrees.len(), 2, "{report:?}");
        assert!(worktrees.iter().any(|w| w.ends_with("linked")));
    }

    #[cfg(unix)]
    #[test]
    fn counts_hard_linked_files_as_shared() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("store/file");
        write(&store, &"x".repeat(10_000));
        let artifact = dir.path().join("node_modules");
        fs::create_dir_all(&artifact).unwrap();
        fs::hard_link(&store, artifact.join("file")).unwrap();
        let found = inspect(&artifact);
        assert!(found.shared_bytes > 0);
        assert_eq!(found.files, 1);
    }

    #[tokio::test]
    async fn deletes_artifacts_and_logs_the_deletion() {
        let fixture = Fixture::new();
        let work = node_project(&fixture, "node_modules/\n");
        let target = work.join("node_modules");
        let result = delete(
            Git::new(&work),
            std::slice::from_ref(&target),
            ALL_TIERS,
            Removal::Delete,
        )
        .await
        .unwrap();
        assert!(
            matches!(result.items[0].outcome, Outcome::Succeeded { .. }),
            "{result:?}"
        );
        assert!(!target.exists());
        let last = result.commands.last().unwrap();
        assert_eq!(last.kind, crate::git::CommandKind::Filesystem);
        assert_eq!(last.args[0], "delete");
        assert_eq!(
            Path::new(&last.args[1]),
            work.canonicalize().unwrap().join("node_modules")
        );
    }

    fn skip_reason(result: &CleanupResult) -> Option<SkipReason> {
        match &result.items[0].outcome {
            Outcome::Skipped { reason, .. } => Some(*reason),
            _ => None,
        }
    }

    #[test]
    fn describes_each_removal_method() {
        assert_eq!(Removal::Trash.log_args("/r/x"), ["move-to-trash", "/r/x"]);
        assert_eq!(
            Removal::Trash.outcome("dist", "Distribution output", 2_000, Ok(())),
            Outcome::succeeded("Moved dist to the Trash (Distribution output, 2.0 kB)")
        );
        assert_eq!(
            Removal::Delete.outcome("dist", "Distribution output", 2_000, Ok(())),
            Outcome::succeeded("Deleted dist (Distribution output, freed 2.0 kB)")
        );
        assert!(matches!(
            Removal::Trash.outcome("dist", "Distribution output", 0, Err("no trash".into())),
            Outcome::Failed { message, .. } if message == "Couldn't move dist to the Trash: no trash"
        ));
    }

    #[tokio::test]
    async fn rechecks_before_deleting() {
        let fixture = Fixture::new();
        let work = node_project(&fixture, "node_modules/\n");
        let target = work.join("node_modules");

        let hidden = delete(
            Git::new(&work),
            std::slice::from_ref(&target),
            &[Tier::BuildOutput],
            Removal::Delete,
        )
        .await
        .unwrap();
        assert_eq!(skip_reason(&hidden), Some(SkipReason::TierHidden));

        fixture.commit(&work, ".gitignore", "", "stop ignoring");
        let unignored = delete(
            Git::new(&work),
            std::slice::from_ref(&target),
            ALL_TIERS,
            Removal::Delete,
        )
        .await
        .unwrap();
        assert_eq!(skip_reason(&unignored), Some(SkipReason::NotIgnored));

        let outside = delete(
            Git::new(&work),
            &[fixture.root().join("elsewhere")],
            ALL_TIERS,
            Removal::Delete,
        )
        .await
        .unwrap();
        assert_eq!(skip_reason(&outside), Some(SkipReason::NotFound));
        assert!(target.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn never_deletes_through_a_symlink() {
        let fixture = Fixture::new();
        let work = node_project(&fixture, "node_modules\n");
        let outside = fixture.root().join("outside");
        write(&outside.join("precious.txt"), "keep");
        fs::remove_dir_all(work.join("node_modules")).unwrap();
        std::os::unix::fs::symlink(&outside, work.join("node_modules")).unwrap();

        let result = delete(
            Git::new(&work),
            &[work.join("node_modules")],
            ALL_TIERS,
            Removal::Delete,
        )
        .await
        .unwrap();
        assert_eq!(skip_reason(&result), Some(SkipReason::NotArtifact));
        assert!(outside.join("precious.txt").exists());
    }
}
