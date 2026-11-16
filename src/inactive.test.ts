import { describe, expect, it } from "vitest";
import { compareInactive, describeRisks, isInactive, nextInactiveSort } from "./inactive";
import type { CloneActivity, CloneRisks } from "./types";

const DAY = 86_400;
const now = 1_800_000_000;

const noRisks: CloneRisks = {
  hasRemotes: true,
  unpushedBranches: [],
  unpushedDetachedHeads: [],
  stashes: 0,
  dirtyWorktrees: [],
  linkedWorktreesOutside: [],
  nestedRepos: [],
  ignoredFiles: [],
  ignoredFileCount: 0,
};

const activity = (commitDaysAgo: number | null, activityDaysAgo: number | null): CloneActivity => ({
  identities: ["me@example.com"],
  lastCommitByMeUnix: commitDaysAgo === null ? null : now - commitDaysAgo * DAY,
  lastLocalActivityUnix: activityDaysAgo === null ? null : now - activityDaysAgo * DAY,
  risks: noRisks,
  snapshot: "review-snapshot",
  warnings: [],
});

describe("isInactive", () => {
  it("requires every enabled filter to pass", () => {
    expect(isInactive(activity(200, 200), now, 90, 90)).toBe(true);
    expect(isInactive(activity(200, 10), now, 90, 90)).toBe(false);
    expect(isInactive(activity(10, 200), now, 90, 90)).toBe(false);
    expect(isInactive(activity(10, 200), now, null, 90)).toBe(true);
    expect(isInactive(activity(10, 10), now, null, null)).toBe(true);
  });

  it("treats never as older than any threshold", () => {
    expect(isInactive(activity(null, null), now, 90, 90)).toBe(true);
    expect(isInactive(activity(null, 3), now, 90, 90)).toBe(false);
  });
});

describe("compareInactive", () => {
  const rows = [
    ["/x/beta", activity(30, 30)],
    ["/x/alpha", activity(null, 300)],
    ["/x/gamma", activity(400, null)],
  ] as const;
  const order = (
    key: "name" | "lastCommit" | "lastActivity",
    direction: "ascending" | "descending",
  ) =>
    [...rows]
      .sort((a, b) => compareInactive(a, b, { key, direction }, (p) => p.split("/").pop()!))
      .map(([path]) => path.split("/").pop());

  it("sorts never as the oldest", () => {
    expect(order("lastCommit", "ascending")).toEqual(["alpha", "gamma", "beta"]);
    expect(order("lastActivity", "ascending")).toEqual(["gamma", "alpha", "beta"]);
    expect(order("lastActivity", "descending")).toEqual(["beta", "alpha", "gamma"]);
    expect(order("name", "ascending")).toEqual(["alpha", "beta", "gamma"]);
  });

  it("toggles direction on the same column and resets on a new one", () => {
    const sort = nextInactiveSort({ key: "name", direction: "ascending" }, "name");
    expect(sort).toEqual({ key: "name", direction: "descending" });
    expect(nextInactiveSort(sort, "lastCommit")).toEqual({
      key: "lastCommit",
      direction: "ascending",
    });
  });
});

describe("describeRisks", () => {
  it("is empty when the remote has everything", () => {
    expect(describeRisks(noRisks)).toEqual([]);
  });

  it("warns about unpushed detached HEAD commits", () => {
    expect(
      describeRisks({
        ...noRisks,
        unpushedDetachedHeads: [{ worktree: "/x/repo", sha: "abcdef0123456789", commits: 2 }],
      }),
    ).toEqual(["2 unpushed commits on detached HEAD abcdef0123 in /x/repo"]);
  });

  it("lists everything that would be lost", () => {
    expect(
      describeRisks({
        hasRemotes: false,
        unpushedBranches: ["spike", "wip"],
        unpushedDetachedHeads: [],
        stashes: 1,
        dirtyWorktrees: ["/x/repo"],
        linkedWorktreesOutside: ["/x/repo-feature"],
        nestedRepos: ["/x/repo/vendor/lib"],
        ignoredFiles: [".env", ".idea"],
        ignoredFileCount: 5,
      }),
    ).toEqual([
      "No remote, so this is the only copy",
      "2 branches with unpushed commits: spike, wip",
      "1 stash",
      "Uncommitted changes in /x/repo",
      "Linked worktrees that will stop working: /x/repo-feature",
      "Repositories inside it: /x/repo/vendor/lib",
      "Ignored files git can't restore: .env, .idea, and 3 more",
    ]);
  });
});
