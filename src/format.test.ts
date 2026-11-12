import { describe, expect, it } from "vitest";
import { basename, describeChanges, describeSync, parentDirectory } from "./format";
import type { RepoSummary } from "./types";

const clean: RepoSummary = {
  branch: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  trackedChanges: 0,
  untracked: 0,
  conflicts: 0,
  operation: null,
  lastFetchUnix: null,
  defaultBranch: "main",
  mainBranches: ["main"],
  defaultOverridden: false,
};

describe("basename", () => {
  it("handles POSIX and Windows paths", () => {
    expect(basename("/home/me/repo/")).toBe("repo");
    expect(basename("C:\\src\\repo")).toBe("repo");
  });
});

describe("parentDirectory", () => {
  it("returns the directory containing a path on POSIX and Windows", () => {
    expect(parentDirectory("/Users/me/src/repo")).toBe("/Users/me/src");
    expect(parentDirectory("/Users/me/src/repo/")).toBe("/Users/me/src");
    expect(parentDirectory("C:\\src\\repo")).toBe("C:\\src");
    expect(parentDirectory("/repo")).toBe("/");
    expect(parentDirectory("repo")).toBe("");
  });
});

describe("describeChanges", () => {
  it("reports a clean tree", () => {
    expect(describeChanges(clean)).toBe("Clean");
  });

  it("lists operation, conflicts, modified and untracked counts", () => {
    expect(
      describeChanges({
        ...clean,
        operation: "rebase",
        conflicts: 1,
        trackedChanges: 2,
        untracked: 3,
      }),
    ).toBe("Rebase in progress · 1 conflicted · 2 modified · 3 untracked");
  });
});

describe("describeSync", () => {
  it("describes detached, untracked and in-sync branches", () => {
    expect(describeSync({ ...clean, branch: null })).toBe("Detached");
    expect(describeSync({ ...clean, upstream: null })).toBe("No upstream");
    expect(describeSync(clean)).toBe("Up to date");
  });

  it("shows ahead and behind counts", () => {
    expect(describeSync({ ...clean, ahead: 2, behind: 5 })).toBe("↑2 ↓5");
    expect(describeSync({ ...clean, behind: 1 })).toBe("↓1");
  });
});
