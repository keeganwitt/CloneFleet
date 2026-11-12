import { describe, expect, it } from "vitest";
import { categorizeBranch, describeBranch, formatAge, worktreeState } from "./cleanup";
import type { BranchInfo, WorktreeInfo } from "./types";

const DAY = 86_400;
const NOW = 1_800_000_000;

const branch = (overrides: Partial<BranchInfo>): BranchInfo => ({
  name: "feature",
  sha: "abc",
  upstream: "origin/feature",
  upstreamGone: false,
  lastCommitUnix: NOW - DAY,
  author: "Ann",
  subject: "Work",
  uniqueCommits: 2,
  merged: null,
  protection: null,
  worktree: null,
  ...overrides,
});

const worktree = (overrides: Partial<WorktreeInfo>): WorktreeInfo => ({
  path: "/wt",
  head: "abc",
  branch: "feature",
  isMain: false,
  locked: false,
  prunable: false,
  dirty: false,
  merged: { evidence: "ancestor", base: "origin/main" },
  ...overrides,
});

describe("categorizeBranch", () => {
  it("prioritizes protection, then merge evidence, then deleted remote, then age", () => {
    const merged = { evidence: "squashed", base: "origin/main" } as const;
    const old = NOW - 100 * DAY;
    expect(categorizeBranch(branch({ protection: "default", merged }), NOW, 90)).toBe("protected");
    expect(categorizeBranch(branch({ merged, upstreamGone: true }), NOW, 90)).toBe("merged");
    expect(categorizeBranch(branch({ upstreamGone: true, lastCommitUnix: old }), NOW, 90)).toBe(
      "remoteDeleted",
    );
    expect(categorizeBranch(branch({ lastCommitUnix: old }), NOW, 90)).toBe("stale");
    expect(categorizeBranch(branch({ lastCommitUnix: old }), NOW, 120)).toBe("active");
    expect(categorizeBranch(branch({}), NOW, 90)).toBe("active");
  });
});

describe("describeBranch", () => {
  it("explains why a branch is in its category", () => {
    expect(
      describeBranch(branch({ merged: { evidence: "squashed", base: "upstream/main" } }), "merged"),
    ).toBe("Squash-merged into upstream/main");
    expect(
      describeBranch(branch({ merged: { evidence: "patchEquivalent", base: "main" } }), "merged"),
    ).toBe("Rebased onto main");
    expect(describeBranch(branch({ upstreamGone: true }), "remoteDeleted")).toBe(
      "origin/feature was deleted; 2 commits not on default branch",
    );
    expect(describeBranch(branch({ uniqueCommits: 1 }), "stale")).toBe(
      "1 commit not on default branch",
    );
    expect(
      describeBranch(branch({ protection: "checkedOutInWorktree", worktree: "/wt" }), "protected"),
    ).toBe("Checked out in /wt");
  });
});

describe("formatAge", () => {
  it("uses coarse units", () => {
    expect(formatAge(NOW, NOW - 3600)).toBe("today");
    expect(formatAge(NOW, NOW - 5 * DAY)).toBe("5d ago");
    expect(formatAge(NOW, NOW - 120 * DAY)).toBe("4mo ago");
    expect(formatAge(NOW, NOW - 800 * DAY)).toBe("2y ago");
  });
});

describe("worktreeState", () => {
  it("only allows clean merged worktrees or missing directories", () => {
    expect(worktreeState(worktree({})).removable).toBe(true);
    expect(worktreeState(worktree({ prunable: true, merged: null, dirty: null })).removable).toBe(
      true,
    );
    expect(worktreeState(worktree({ isMain: true }))).toEqual({
      removable: false,
      label: "Main worktree",
    });
    expect(worktreeState(worktree({ locked: true })).removable).toBe(false);
    expect(worktreeState(worktree({ merged: null })).label).toBe("Has unmerged commits");
    expect(worktreeState(worktree({ dirty: true })).label).toBe(
      "Has uncommitted or untracked files",
    );
  });
});
