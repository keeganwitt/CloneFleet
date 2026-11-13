use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::store::Config;

pub const MARKER: &str = ".clonefleet-demo";
const DAY: i64 = 24 * 60 * 60;
const HOUR: i64 = 60 * 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DemoEnv {
    pub config_dir: PathBuf,
    pub git_config_global: PathBuf,
    pub projects: PathBuf,
}

impl DemoEnv {
    pub fn variables(&self) -> Vec<(&'static str, String)> {
        vec![
            (
                "CLONEFLEET_CONFIG_DIR",
                self.config_dir.display().to_string(),
            ),
            (
                "GIT_CONFIG_GLOBAL",
                self.git_config_global.display().to_string(),
            ),
            ("GIT_CONFIG_NOSYSTEM", "1".to_string()),
        ]
    }
}

struct Builder {
    root: PathBuf,
    now: i64,
}

fn other(message: impl Into<String>) -> io::Error {
    io::Error::other(message.into())
}

impl Builder {
    fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }

    fn git_at(&self, dir: &Path, args: &[&str], days_ago: f64) -> io::Result<String> {
        let when = format!("@{} +0000", self.now - (days_ago * DAY as f64) as i64);
        let output = Command::new("git")
            .current_dir(dir)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", self.path("gitconfig"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_AUTHOR_DATE", &when)
            .env("GIT_COMMITTER_DATE", &when)
            .output()?;
        if !output.status.success() {
            return Err(other(format!(
                "git {} failed in {}: {}",
                args.join(" "),
                dir.display(),
                String::from_utf8_lossy(&output.stderr)
            )));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    fn git(&self, dir: &Path, args: &[&str]) -> io::Result<String> {
        self.git_at(dir, args, 0.0)
    }

    fn write(&self, dir: &Path, file: &str, contents: &str) -> io::Result<()> {
        let path = dir.join(file);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, contents)
    }

    fn build_output(
        &self,
        dir: &Path,
        file: &str,
        kilobytes: usize,
        days_ago: f64,
    ) -> io::Result<()> {
        self.write(dir, file, &"x".repeat(kilobytes * 1000))?;
        let modified =
            UNIX_EPOCH + Duration::from_secs((self.now - (days_ago * DAY as f64) as i64) as u64);
        fs::File::options()
            .write(true)
            .open(dir.join(file))?
            .set_modified(modified)?;
        let mut ancestor = dir.join(file);
        while ancestor.pop() && ancestor != dir {
            // Windows can't open a directory as a file; ages there show the demo's build time.
            if let Ok(handle) = fs::File::open(&ancestor) {
                let _ = handle.set_modified(modified);
            }
        }
        Ok(())
    }

    fn commit(
        &self,
        dir: &Path,
        file: &str,
        contents: &str,
        message: &str,
        days_ago: f64,
    ) -> io::Result<()> {
        self.write(dir, file, contents)?;
        self.git_at(dir, &["add", file], days_ago)?;
        self.git_at(dir, &["commit", "--quiet", "-m", message], days_ago)?;
        Ok(())
    }

    /// Creates `remotes/<owner>/<name>.git`, a scratch clone in `.seeds` for upstream changes,
    /// and a working clone at `projects/<path>` whose remote is the GitHub-style URL.
    fn repo(
        &self,
        owner: &str,
        name: &str,
        path: &str,
        history: &[(&str, &str, f64)],
    ) -> io::Result<(PathBuf, PathBuf)> {
        let bare = self.path(&format!("remotes/{owner}/{name}.git"));
        let seed = self.path(&format!(".seeds/{owner}-{name}"));
        let work = self.path(&format!("Projects/{path}"));
        let url = format!("https://github.com/{owner}/{name}.git");
        fs::create_dir_all(bare.parent().unwrap())?;
        self.git(
            &self.root,
            &[
                "init",
                "--quiet",
                "--bare",
                "-b",
                "main",
                &bare.to_string_lossy(),
            ],
        )?;
        self.git(
            &self.root,
            &["init", "--quiet", "-b", "main", &seed.to_string_lossy()],
        )?;
        for (file, contents, days_ago) in history {
            self.commit(&seed, file, contents, &format!("Update {file}"), *days_ago)?;
        }
        self.git(&seed, &["remote", "add", "origin", &url])?;
        self.git(&seed, &["push", "--quiet", "-u", "origin", "main"])?;
        fs::create_dir_all(work.parent().unwrap())?;
        self.git(
            &self.root,
            &["clone", "--quiet", &url, &work.to_string_lossy()],
        )?;
        Ok((seed, work))
    }

    fn upstream_commit(
        &self,
        seed: &Path,
        file: &str,
        contents: &str,
        message: &str,
        days_ago: f64,
    ) -> io::Result<()> {
        self.commit(seed, file, contents, message, days_ago)?;
        self.git(seed, &["push", "--quiet", "origin", "HEAD"])?;
        Ok(())
    }

    fn set_fetched(&self, work: &Path, seconds_ago: i64) -> io::Result<()> {
        let fetch_head = work.join(".git/FETCH_HEAD");
        if !fetch_head.exists() {
            fs::write(&fetch_head, "")?;
        }
        let when = UNIX_EPOCH + Duration::from_secs((self.now - seconds_ago).max(0) as u64);
        fs::File::options()
            .write(true)
            .open(fetch_head)?
            .set_modified(when)
    }
}

fn prepare(root: &Path) -> io::Result<()> {
    if root.exists() {
        let has_files = fs::read_dir(root)?.next().is_some();
        if has_files && !root.join(MARKER).exists() {
            return Err(other(format!(
                "{} is not empty and wasn't created by the demo; refusing to overwrite it",
                root.display()
            )));
        }
        fs::remove_dir_all(root)?;
    }
    fs::create_dir_all(root)?;
    fs::write(
        root.join(MARKER),
        "Created by the CloneFleet demo. Safe to delete.\n",
    )
}

fn config_path(path: &Path) -> String {
    path.display().to_string().replace('\\', "/")
}

fn git_config(root: &Path) -> String {
    let remotes = root.join("remotes");
    format!(
        "[user]\n\tname = Dana Developer\n\temail = dana@example.com\n\
         [init]\n\tdefaultBranch = main\n\
         [commit]\n\tgpgsign = false\n\
         [core]\n\thooksPath = {hooks}\n\tautocrlf = false\n\
         [advice]\n\tdetachedHead = false\n\
         [url \"{acme}/\"]\n\tinsteadOf = https://github.com/acme/\n\
         [url \"{dana}/\"]\n\tinsteadOf = https://github.com/dana/\n\
         [url \"http://127.0.0.1:9/\"]\n\tinsteadOf = https://git.legacy.example/\n",
        hooks = config_path(&root.join("no-hooks")),
        acme = config_path(&remotes.join("acme")),
        dana = config_path(&remotes.join("dana")),
    )
}

pub fn write_demo_home(root: &Path) -> io::Result<DemoEnv> {
    let root = std::path::absolute(root)?;
    prepare(&root)?;
    fs::create_dir_all(root.join("no-hooks"))?;
    fs::write(root.join("gitconfig"), git_config(&root))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default();
    let b = Builder {
        root: root.clone(),
        now,
    };
    let readme = |name: &str| format!("# {name}\n\nPart of the Acme platform.\n");

    // Behind its upstream by three commits.
    let (seed, work) = b.repo(
        "acme",
        "api-gateway",
        "services/api-gateway",
        &[
            ("README.md", &readme("api-gateway"), 240.0),
            ("src/routes.ts", "export const routes = [];\n", 120.0),
        ],
    )?;
    for (i, message) in ["Add rate limit headers", "Route /v2/orders", "Bump undici"]
        .iter()
        .enumerate()
    {
        b.upstream_commit(
            &seed,
            &format!("src/change-{i}.ts"),
            "export {};\n",
            message,
            2.0 - i as f64 * 0.5,
        )?;
    }
    b.git(&work, &["fetch", "--quiet"])?;
    b.set_fetched(&work, 2 * HOUR)?;

    // Uncommitted changes, an untracked file, and an older stash.
    let (_, work) = b.repo(
        "acme",
        "billing-service",
        "services/billing-service",
        &[
            ("README.md", &readme("billing-service"), 300.0),
            ("src/invoice.ts", "export const rounding = 2;\n", 30.0),
            ("src/proration.ts", "export const days = 30;\n", 25.0),
        ],
    )?;
    b.write(&work, "src/proration.ts", "export const days = 31;\n")?;
    b.git(
        &work,
        &["stash", "push", "--quiet", "-m", "WIP: proration rounding"],
    )?;
    b.write(&work, "src/invoice.ts", "export const rounding = 4;\n")?;
    b.write(&work, "src/proration.ts", "export const days = 28;\n")?;
    b.write(&work, "notes/tax-questions.md", "- Ask finance about VAT\n")?;
    b.set_fetched(&work, 5 * HOUR)?;

    // On a feature branch with commits that were never pushed.
    let (_, work) = b.repo(
        "acme",
        "auth-service",
        "services/auth-service",
        &[
            ("README.md", &readme("auth-service"), 200.0),
            ("src/tokens.ts", "export const ttl = 3600;\n", 14.0),
        ],
    )?;
    b.git(&work, &["switch", "--quiet", "-c", "feature/oauth-refresh"])?;
    b.commit(
        &work,
        "src/refresh.ts",
        "export const refresh = true;\n",
        "Add refresh token rotation",
        1.0,
    )?;
    b.commit(
        &work,
        "src/refresh.test.ts",
        "test('rotates', () => {});\n",
        "Test refresh rotation",
        0.2,
    )?;
    b.set_fetched(&work, 20 * 60)?;

    // Diverged: a local commit on main and a new upstream commit.
    let (seed, work) = b.repo(
        "acme",
        "search-indexer",
        "services/search-indexer",
        &[
            ("README.md", &readme("search-indexer"), 180.0),
            ("src/indexer.ts", "export const batch = 100;\n", 40.0),
        ],
    )?;
    b.upstream_commit(
        &seed,
        "src/schema.ts",
        "export const version = 3;\n",
        "Schema v3",
        1.0,
    )?;
    b.commit(
        &work,
        "src/indexer.ts",
        "export const batch = 250;\n",
        "Bigger batches",
        0.5,
    )?;
    b.git(&work, &["fetch", "--quiet"])?;
    b.set_fetched(&work, HOUR)?;

    // Stopped partway through a rebase with a conflict.
    let (seed, work) = b.repo(
        "acme",
        "notifications",
        "services/notifications",
        &[
            ("README.md", &readme("notifications"), 150.0),
            (
                "src/templates.ts",
                "export const subject = 'Hello';\n",
                20.0,
            ),
        ],
    )?;
    b.upstream_commit(
        &seed,
        "src/templates.ts",
        "export const subject = 'Welcome';\n",
        "Friendlier subject",
        1.0,
    )?;
    b.commit(
        &work,
        "src/templates.ts",
        "export const subject = 'Hi there';\n",
        "Shorter subject",
        0.8,
    )?;
    b.git(&work, &["fetch", "--quiet"])?;
    let rebase = Command::new("git")
        .current_dir(&work)
        .args(["rebase", "--quiet", "origin/main"])
        .env("GIT_CONFIG_GLOBAL", b.path("gitconfig"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()?;
    if rebase.status.success() {
        return Err(other("expected the notifications rebase to conflict"));
    }
    b.set_fetched(&work, 3 * HOUR)?;

    // Branch cleanup: merged, squash-merged, remote-deleted, stale, and active branches,
    // plus a linked worktree for the merged branch.
    let (seed, work) = b.repo(
        "acme",
        "design-system",
        "libraries/design-system",
        &[
            ("README.md", &readme("design-system"), 400.0),
            ("src/button.tsx", "export const Button = 1;\n", 90.0),
        ],
    )?;
    let branch =
        |name: &str, file: &str, message: &str, days_ago: f64, push: bool| -> io::Result<()> {
            b.git(&work, &["switch", "--quiet", "-c", name, "main"])?;
            b.commit(&work, file, &format!("// {message}\n"), message, days_ago)?;
            if push {
                b.git(&work, &["push", "--quiet", "-u", "origin", name])?;
            }
            Ok(())
        };
    branch(
        "feature/button-variants",
        "src/variants.tsx",
        "Add button variants",
        12.0,
        true,
    )?;
    branch(
        "fix/tooltip-a11y",
        "src/tooltip.tsx",
        "Label tooltips for screen readers",
        9.0,
        true,
    )?;
    b.git(&work, &["switch", "--quiet", "fix/tooltip-a11y"])?;
    b.commit(
        &work,
        "src/tooltip.test.tsx",
        "// aria\n",
        "Test tooltip labels",
        8.5,
    )?;
    b.git(&work, &["push", "--quiet"])?;
    branch(
        "experiment/color-tokens",
        "src/tokens.ts",
        "Try OKLCH color tokens",
        30.0,
        true,
    )?;
    branch(
        "chore/eslint-9",
        "eslint.config.js",
        "Migrate to ESLint 9",
        210.0,
        true,
    )?;
    branch(
        "feature/date-picker",
        "src/date-picker.tsx",
        "Date picker skeleton",
        2.0,
        true,
    )?;
    branch(
        "docs/storybook-intro",
        "docs/intro.mdx",
        "Storybook introduction",
        20.0,
        true,
    )?;
    branch(
        "spike/virtual-list",
        "src/virtual-list.tsx",
        "Prototype a virtualized list",
        150.0,
        true,
    )?;
    b.git(&work, &["switch", "--quiet", "main"])?;
    b.git(&seed, &["fetch", "--quiet", "origin"])?;
    b.git_at(
        &seed,
        &[
            "merge",
            "--quiet",
            "--no-ff",
            "-m",
            "Merge storybook intro",
            "origin/docs/storybook-intro",
        ],
        18.0,
    )?;
    b.git_at(
        &seed,
        &[
            "merge",
            "--quiet",
            "--no-ff",
            "-m",
            "Merge button variants",
            "origin/feature/button-variants",
        ],
        10.0,
    )?;
    b.git_at(
        &seed,
        &["merge", "--quiet", "--squash", "origin/fix/tooltip-a11y"],
        7.0,
    )?;
    b.git_at(
        &seed,
        &["commit", "--quiet", "-m", "Accessible tooltips (#212)"],
        7.0,
    )?;
    b.git(&seed, &["push", "--quiet", "origin", "main"])?;
    b.git(
        &seed,
        &[
            "push",
            "--quiet",
            "origin",
            "--delete",
            "fix/tooltip-a11y",
            "experiment/color-tokens",
        ],
    )?;
    b.git(&work, &["fetch", "--quiet", "--prune"])?;
    b.git(&work, &["merge", "--quiet", "--ff-only", "origin/main"])?;
    let worktree = root.join("Worktrees/design-system-button-variants");
    fs::create_dir_all(worktree.parent().unwrap())?;
    b.git(
        &work,
        &[
            "worktree",
            "add",
            "--quiet",
            &worktree.to_string_lossy(),
            "feature/button-variants",
        ],
    )?;
    let spike = root.join("Worktrees/design-system-virtual-list");
    b.git(
        &work,
        &[
            "worktree",
            "add",
            "--quiet",
            &spike.to_string_lossy(),
            "spike/virtual-list",
        ],
    )?;
    b.set_fetched(&work, 30 * 60)?;

    // Clean and current.
    let (_, work) = b.repo(
        "acme",
        "shared-utils",
        "libraries/shared-utils",
        &[
            ("README.md", &readme("shared-utils"), 500.0),
            (".gitignore", "node_modules/\ndist/\n.venv/\n", 500.0),
            ("package.json", "{ \"name\": \"shared-utils\" }\n", 500.0),
            (
                "src/strings.ts",
                "export const trim = (s: string) => s.trim();\n",
                60.0,
            ),
        ],
    )?;
    b.git(&work, &["fetch", "--quiet"])?;
    b.build_output(&work, "dist/strings.js", 40, 120.0)?;
    b.build_output(&work, "dist/strings.d.ts", 4, 120.0)?;
    b.build_output(&work, "node_modules/typescript/lib/typescript.js", 900, 2.0)?;
    b.build_output(&work, "node_modules/left-pad/index.js", 1, 2.0)?;
    b.build_output(&work, ".venv/pyvenv.cfg", 1, 30.0)?;
    b.build_output(
        &work,
        ".venv/lib/site-packages/mkdocs/__init__.py",
        200,
        30.0,
    )?;

    // A fork whose upstream has moved on.
    let (_, _) = b.repo(
        "acme",
        "analytics-sdk",
        ".seeds/unused-analytics",
        &[
            ("README.md", &readme("analytics-sdk"), 365.0),
            ("src/track.ts", "export const track = () => {};\n", 50.0),
        ],
    )?;
    let fork_bare = b.path("remotes/dana/analytics-sdk.git");
    fs::create_dir_all(fork_bare.parent().unwrap())?;
    b.git(
        &root,
        &[
            "clone",
            "--quiet",
            "--bare",
            "https://github.com/acme/analytics-sdk.git",
            &fork_bare.to_string_lossy(),
        ],
    )?;
    let fork = b.path("Projects/libraries/analytics-sdk");
    b.git(
        &root,
        &[
            "clone",
            "--quiet",
            "https://github.com/dana/analytics-sdk.git",
            &fork.to_string_lossy(),
        ],
    )?;
    b.git(
        &fork,
        &[
            "remote",
            "add",
            "upstream",
            "https://github.com/acme/analytics-sdk.git",
        ],
    )?;
    let upstream_seed = b.path(".seeds/acme-analytics-sdk");
    b.upstream_commit(
        &upstream_seed,
        "src/batch.ts",
        "export const batch = 20;\n",
        "Batch events",
        3.0,
    )?;
    b.upstream_commit(
        &upstream_seed,
        "src/consent.ts",
        "export const consent = true;\n",
        "Respect consent mode",
        1.0,
    )?;
    b.git(&fork, &["fetch", "--quiet", "upstream"])?;
    b.git(&fork, &["remote", "set-head", "upstream", "--auto"])?;
    b.set_fetched(&fork, 4 * HOUR)?;

    // Clean, but last fetched three days ago.
    let (_, work) = b.repo(
        "acme",
        "infra-terraform",
        "tools/infra-terraform",
        &[
            ("README.md", &readme("infra-terraform"), 600.0),
            ("main.tf", "terraform {}\n", 45.0),
            (".gitignore", ".terraform/\n", 45.0),
        ],
    )?;
    b.build_output(
        &work,
        ".terraform/providers/registry.terraform.io/hashicorp/aws/terraform-provider-aws",
        2500,
        45.0,
    )?;
    b.set_fetched(&work, 3 * DAY)?;

    // A remote that can't be reached; its failure shows after Fetch all.
    let (_, work) = b.repo(
        "acme",
        "legacy-portal",
        "tools/legacy-portal",
        &[
            ("README.md", &readme("legacy-portal"), 900.0),
            ("index.php", "<?php echo 'hi';\n", 700.0),
        ],
    )?;
    b.git(
        &work,
        &[
            "remote",
            "set-url",
            "origin",
            "https://git.legacy.example/web/legacy-portal.git",
        ],
    )?;
    b.set_fetched(&work, 40 * DAY)?;

    // A local-only repository with no remote.
    let dotfiles = b.path("Projects/tools/dotfiles");
    fs::create_dir_all(&dotfiles)?;
    b.git(&dotfiles, &["init", "--quiet", "-b", "main"])?;
    b.commit(
        &dotfiles,
        ".zshrc",
        "export EDITOR=vim\n",
        "Shell config",
        100.0,
    )?;
    b.commit(
        &dotfiles,
        ".gitconfig",
        "[pull]\n\trebase = true\n",
        "Git config",
        4.0,
    )?;

    let projects = root.join("Projects");
    let config_dir = root.join("config");
    let config = Config {
        roots: vec![projects.clone()],
        ..Config::default()
    };
    config.save(&config_dir.join("config.json"))?;

    Ok(DemoEnv {
        config_dir,
        git_config_global: root.join("gitconfig"),
        projects,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::actions::summarize;
    use crate::artifacts::Tier;
    use crate::git::Git;
    use crate::health::repo_health;
    use crate::status::InProgressOperation;
    use crate::workspace::scan;

    #[test]
    fn refuses_to_overwrite_folders_it_did_not_create() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("precious.txt"), "keep me").unwrap();
        let error = write_demo_home(dir.path()).unwrap_err();
        assert!(error.to_string().contains("refusing to overwrite"));
        assert!(dir.path().join("precious.txt").exists());
    }

    #[tokio::test]
    async fn demo_home_shows_every_state_the_dashboard_reports() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("demo");
        let env = write_demo_home(&root).unwrap();
        assert!(root.join(MARKER).exists());
        write_demo_home(&root).expect("rerunning replaces an earlier demo home");

        let config = Config::load(&env.config_dir.join("config.json")).unwrap();
        let repos = scan(&config.roots, &config.excluded);
        let names: Vec<String> = repos
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            [
                "analytics-sdk",
                "design-system",
                "shared-utils",
                "api-gateway",
                "auth-service",
                "billing-service",
                "notifications",
                "search-indexer",
                "dotfiles",
                "infra-terraform",
                "legacy-portal",
            ]
        );

        let by_name: BTreeMap<String, PathBuf> = names.into_iter().zip(repos).collect();
        let summary = |name: &str| {
            let path = by_name[name].clone();
            async move { summarize(&mut Git::new(path)).await.unwrap() }
        };
        let health = |name: &str| {
            let path = by_name[name].clone();
            async move { repo_health(&mut Git::new(path), 90).await.unwrap() }
        };

        assert_eq!(
            summary("api-gateway").await.status.working_tree.behind,
            Some(3)
        );
        let billing = summary("billing-service").await;
        assert_eq!(billing.status.working_tree.tracked_changes, 2);
        assert_eq!(billing.status.working_tree.untracked, 1);
        assert_eq!(health("billing-service").await.stashes, 1);
        let auth = summary("auth-service").await;
        assert_eq!(
            auth.status.working_tree.branch.as_deref(),
            Some("feature/oauth-refresh")
        );
        assert_eq!(health("auth-service").await.unpushed_branches, 1);
        let search = summary("search-indexer").await.status.working_tree;
        assert_eq!((search.ahead, search.behind), (Some(1), Some(1)));
        assert_eq!(
            summary("notifications").await.status.operation,
            Some(InProgressOperation::Rebase)
        );
        let design = health("design-system").await;
        assert_eq!(design.merged_branches, 2);
        assert_eq!(design.remote_deleted_branches, 1);
        assert_eq!(design.stale_branches, 1);
        assert_eq!(design.removable_worktrees, 1);
        assert_eq!(design.stale_worktrees, 1);
        assert_eq!(
            summary("shared-utils").await.status.working_tree.behind,
            Some(0)
        );
        let artifacts = |name: &str| {
            let path = by_name[name].clone();
            async move {
                crate::artifacts::scan(&mut Git::new(path))
                    .await
                    .unwrap()
                    .artifacts
                    .into_iter()
                    .map(|a| (a.kind, a.tier))
                    .collect::<Vec<_>>()
            }
        };
        assert_eq!(
            artifacts("shared-utils").await,
            [
                ("Python virtualenv", Tier::Unreproducible),
                ("Distribution output", Tier::BuildOutput),
                ("Node.js packages", Tier::Reinstall),
            ]
        );
        assert_eq!(
            artifacts("infra-terraform").await,
            [("Terraform", Tier::Reinstall)]
        );
        let shared = summary("shared-utils").await.status.working_tree;
        assert_eq!((shared.tracked_changes, shared.untracked), (0, 0));
        assert_eq!(summary("dotfiles").await.status.working_tree.upstream, None);
        assert!(
            summary("infra-terraform")
                .await
                .status
                .last_fetch_unix
                .unwrap()
                < env_now() - 2 * DAY
        );
    }

    fn env_now() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }
}
