// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { release } from "./release.mjs";

const folders = [];
const fixtureFiles = {
  "package.json": '{"name":"clonefleet","version":"0.1.0"}\n',
  "src-tauri/tauri.conf.json": '{"productName":"CloneFleet","version":"0.1.0"}\n',
  "src-tauri/Cargo.toml": '[package]\nversion = "0.1.0"\n',
  "src-tauri/Cargo.lock": `version = 4

[[package]]
name = "clonefleet"
version = "0.1.0"
dependencies = ["other-dependency"]

[[package]]
name = "other-dependency"
version = "0.1.0"
`,
};
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function fixture() {
  const folder = mkdtempSync(resolve(tmpdir(), "clonefleet-release-"));
  folders.push(folder);
  const repo = resolve(folder, "repo");
  const remote = resolve(folder, "remote.git");
  mkdirSync(repo);
  mkdirSync(resolve(repo, "src-tauri"));
  git(folder, "init", "--bare", remote);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Release Test");
  git(repo, "config", "user.email", "release@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "tag.gpgsign", "false");
  for (const [file, content] of Object.entries(fixtureFiles))
    writeFileSync(resolve(repo, file), content);
  git(repo, "add", ".");
  git(repo, "commit", "-m", "Initial commit");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "origin", "main");
  return { repo, remote, folder };
}

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("release", { timeout: 30_000 }, () => {
  it("releases the initial 0.1.0 version without creating a redundant commit", () => {
    const { repo, remote } = fixture();
    const head = git(repo, "rev-parse", "HEAD");
    expect(release(["0.1.0"], repo)).toBe("v0.1.0");
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(git(remote, "rev-parse", "refs/tags/v0.1.0^{}")).toBe(head);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("updates all versions and atomically pushes the version commit and annotated tag", () => {
    const { repo, remote } = fixture();
    const oldLock = readFileSync(resolve(repo, "src-tauri/Cargo.lock"), "utf8");
    expect(release(["--", "v0.2.0"], repo)).toBe("v0.2.0");
    expect(JSON.parse(readFileSync(resolve(repo, "package.json"))).version).toBe("0.2.0");
    expect(JSON.parse(readFileSync(resolve(repo, "src-tauri/tauri.conf.json"))).version).toBe(
      "0.2.0",
    );
    expect(readFileSync(resolve(repo, "src-tauri/Cargo.toml"), "utf8")).toContain(
      'version = "0.2.0"',
    );
    expect(readFileSync(resolve(repo, "src-tauri/Cargo.lock"), "utf8")).toBe(
      oldLock.replace(/(name = "clonefleet"\r?\nversion = ")0\.1\.0/g, "$10.2.0"),
    );
    const head = git(repo, "rev-parse", "HEAD");
    expect(git(repo, "log", "-1", "--format=%s")).toBe("Release v0.2.0");
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(head);
    expect(git(remote, "rev-parse", "refs/tags/v0.2.0^{}")).toBe(head);
    expect(git(remote, "cat-file", "-t", "refs/tags/v0.2.0")).toBe("tag");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("rejects invalid arguments and older versions without modifying files", () => {
    const { repo } = fixture();
    for (const args of [[], ["0.2"], ["01.2.3"], ["0.2.0", "extra"], ["0.0.9"]]) {
      expect(() => release(args, repo)).toThrow();
      expect(git(repo, "status", "--porcelain")).toBe("");
      expect(git(repo, "tag", "--list")).toBe("");
    }
  });

  it("rejects untracked changes and releases outside main", () => {
    const { repo } = fixture();
    writeFileSync(resolve(repo, "untracked.txt"), "work in progress");
    expect(() => release(["0.2.0"], repo)).toThrow("Commit or stash");
    rmSync(resolve(repo, "untracked.txt"));
    git(repo, "checkout", "-b", "feature");
    expect(() => release(["0.2.0"], repo)).toThrow("from main");
    expect(git(repo, "tag", "--list")).toBe("");
  });

  it("rejects existing tags locally and on the remote", () => {
    const { repo } = fixture();
    git(repo, "tag", "v0.2.0");
    expect(() => release(["0.2.0"], repo)).toThrow("already exists locally");
    git(repo, "push", "origin", "refs/tags/v0.2.0");
    git(repo, "tag", "-d", "v0.2.0");
    expect(() => release(["0.2.0"], repo)).toThrow("already exists on origin");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("stops before modifying files or tagging if remote main has advanced", () => {
    const { repo, remote, folder } = fixture();
    const initial = git(repo, "rev-parse", "HEAD");
    const other = resolve(folder, "other");
    git(folder, "clone", "--branch", "main", remote, other);
    git(other, "config", "user.name", "Release Test");
    git(other, "config", "user.email", "release@example.invalid");
    git(other, "config", "commit.gpgsign", "false");
    writeFileSync(resolve(other, "remote-change.txt"), "new remote work");
    git(other, "add", ".");
    git(other, "commit", "-m", "Remote change");
    git(other, "push", "origin", "main");
    expect(git(repo, "rev-parse", "origin/main")).toBe(initial);
    expect(() => release(["0.2.0"], repo)).toThrow("integrate origin/main");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "tag", "--list")).toBe("");
    expect(git(repo, "rev-parse", "HEAD")).toBe(initial);
  });

  it("validates all file versions before writing any changes", () => {
    const { repo } = fixture();
    const lock = resolve(repo, "src-tauri/Cargo.lock");
    writeFileSync(
      lock,
      readFileSync(lock, "utf8").replace(/(name = "clonefleet"\r?\nversion = ")0\.1\.0/, "$10.0.9"),
    );
    git(repo, "add", ".");
    git(repo, "commit", "-m", "Mismatched lock version");
    expect(() => release(["0.2.0"], repo)).toThrow("Cargo.lock version does not match");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "tag", "--list")).toBe("");
  });

  it("preserves local state with recovery instructions when the atomic push fails", () => {
    const { repo, remote } = fixture();
    const hook = resolve(remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    const remoteHead = git(remote, "rev-parse", "refs/heads/main");
    expect(() => release(["0.2.0"], repo)).toThrow(
      "git push --atomic origin HEAD:refs/heads/main refs/tags/v0.2.0",
    );
    expect(git(repo, "tag", "--list")).toBe("v0.2.0");
    expect(git(repo, "log", "-1", "--format=%s")).toBe("Release v0.2.0");
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(remoteHead);
    expect(git(remote, "tag", "--list")).toBe("");
  });
});
