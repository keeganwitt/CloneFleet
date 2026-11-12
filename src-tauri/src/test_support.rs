use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;

pub struct Fixture {
    dir: TempDir,
    pub remote: PathBuf,
    pub seed: PathBuf,
    pub work: PathBuf,
}

impl Fixture {
    /// A bare `remote.git` with one commit on `main`, a `seed` clone for pushing new
    /// upstream commits, and a `work` clone that the code under test operates on.
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let root = root.as_path();
        let remote = root.join("remote.git");
        let seed = root.join("seed");
        let work = root.join("work");
        let hooks = root.join("no-hooks");
        fs::create_dir(&hooks).unwrap();

        run(
            root,
            &["init", "--quiet", "--bare", "-b", "main", path_str(&remote)],
        );
        run(root, &["init", "--quiet", "-b", "main", path_str(&seed)]);
        let fixture = Self {
            dir,
            remote,
            seed,
            work,
        };
        fixture.configure(&fixture.seed);
        fixture.commit(&fixture.seed, "README.md", "hello\n", "initial");
        run(
            &fixture.seed,
            &["remote", "add", "origin", path_str(&fixture.remote)],
        );
        run(&fixture.seed, &["push", "--quiet", "-u", "origin", "main"]);
        run(
            root,
            &[
                "clone",
                "--quiet",
                "-c",
                "core.autocrlf=false",
                path_str(&fixture.remote),
                path_str(&fixture.work),
            ],
        );
        fixture.configure(&fixture.work);
        fixture
    }

    pub fn root(&self) -> &Path {
        self.dir.path()
    }

    pub fn configure(&self, repo: &Path) {
        let hooks = self.root().join("no-hooks");
        for (key, value) in [
            ("user.name", "Test User"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
            ("core.hooksPath", path_str(&hooks)),
        ] {
            run(repo, &["config", key, value]);
        }
    }

    pub fn commit(&self, repo: &Path, file: &str, contents: &str, message: &str) {
        fs::write(repo.join(file), contents).unwrap();
        run(repo, &["add", file]);
        run(repo, &["commit", "--quiet", "-m", message]);
    }

    pub fn git(&self, repo: &Path, args: &[&str]) -> String {
        run(repo, args)
    }
}

pub fn run(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

pub fn git_at_least(major: u32, minor: u32) -> bool {
    let version = run(Path::new("."), &["--version"]);
    let mut numbers = version
        .trim_start_matches("git version ")
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|n| n.parse::<u32>().ok());
    let found = (numbers.next().unwrap_or(0), numbers.next().unwrap_or(0));
    found >= (major, minor)
}

fn path_str(path: &Path) -> &str {
    path.to_str().unwrap()
}
