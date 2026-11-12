import { describe, expect, it } from "vitest";
import { PROBLEMS, buildOverview, repoProblems } from "./problems";
import type { RepoState } from "./state";
import type { RepoHealth, RepoSummary } from "./types";

const clean: RepoSummary = {
  branch: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  trackedChanges: 0,
  untracked: 0,
  conflicts: 0,
  operation: null,
  lastFetchUnix: 0,
  defaultBranch: "main",
  mainBranches: ["main"],
  defaultOverridden: false,
  hasRemotes: true,
};

const noHealth: RepoHealth = {
  mergedBranches: 0,
  remoteDeletedBranches: 0,
  staleBranches: 0,
  removableWorktrees: 0,
  staleWorktrees: 0,
  unpushedBranches: 0,
  stashes: 0,
  warnings: [],
};

const repo = (path: string, summary: Partial<RepoSummary> = {}): RepoState => ({
  path,
  loadingSummary: false,
  summary: { ...clean, ...summary },
});

describe("repoProblems", () => {
  it("reports nothing for a clean repository on its default branch", () => {
    expect(repoProblems(repo("/a"), noHealth)).toEqual([]);
  });

  it("distinguishes diverged from behind and reports work in progress", () => {
    expect(repoProblems(repo("/a", { ahead: 1, behind: 2 }))).toEqual([["diverged", 1]]);
    expect(repoProblems(repo("/a", { behind: 2, branch: "feature", trackedChanges: 3 }))).toEqual([
      ["behind", 1],
      ["notOnDefault", 1],
      ["uncommitted", 1],
    ]);
  });

  it("reports broken states and health counts", () => {
    const broken: RepoState = { path: "/b", loadingSummary: false, summaryError: "boom" };
    expect(repoProblems(broken)).toEqual([["statusError", 1]]);
    expect(
      repoProblems(repo("/a", { operation: "rebase", conflicts: 1 }), {
        ...noHealth,
        unpushedBranches: 2,
        stashes: 1,
        mergedBranches: 3,
        staleBranches: 1,
        remoteDeletedBranches: 2,
        removableWorktrees: 1,
      }),
    ).toEqual([
      ["inProgress", 1],
      ["conflicts", 1],
      ["unpushed", 2],
      ["stashes", 1],
      ["mergedBranches", 3],
      ["staleBranches", 3],
      ["removableWorktrees", 1],
    ]);
  });
});

describe("failure reasons", () => {
  const failed = (reason: string | null): RepoState => ({
    ...repo("/a"),
    result: {
      outcome: { status: "failed", message: "x", reason: reason as never },
      followUp: null,
      commands: [],
    },
  });

  it("groups authentication and connectivity failures from the last result", () => {
    expect(repoProblems(failed("authenticationRequired"))).toEqual([["authRequired", 1]]);
    expect(repoProblems(failed("hostKeyUnverified"))).toEqual([["authRequired", 1]]);
    expect(repoProblems(failed("timedOut"))).toEqual([["remoteUnreachable", 1]]);
    expect(repoProblems(failed(null))).toEqual([]);
  });
});

describe("buildOverview", () => {
  it("groups repositories into cards and separates attention from healthy", () => {
    const states = {
      "/behind": repo("/behind", { behind: 3 }),
      "/dirty": repo("/dirty", { trackedChanges: 1 }),
      "/tidy": repo("/tidy"),
      "/cleanup": repo("/cleanup"),
      "/also-behind": repo("/also-behind", { behind: 1 }),
      "/loading": { path: "/loading", loadingSummary: true },
    };
    const healths = {
      "/cleanup": { ...noHealth, mergedBranches: 4 },
      "/behind": { ...noHealth, mergedBranches: 1 },
    };
    const overview = buildOverview(Object.keys(states), states, healths);
    expect(overview.cards.map((c) => [c.kind, c.paths, c.items])).toEqual([
      ["behind", ["/behind", "/also-behind"], 2],
      ["uncommitted", ["/dirty"], 1],
      ["mergedBranches", ["/behind", "/cleanup"], 5],
    ]);
    expect(overview.needsAttention).toEqual(["/behind", "/also-behind"]);
    expect(overview.healthy).toEqual(["/tidy", "/cleanup"]);
  });
});

describe("problem titles", () => {
  it("pluralize repositories and items", () => {
    expect(PROBLEMS.behind.title(1, 1)).toBe("1 repository behind upstream");
    expect(PROBLEMS.mergedBranches.title(2, 5)).toBe("5 branches merged in 2 repositories");
    expect(PROBLEMS.stashes.title(1, 1)).toBe("1 stash in 1 repository");
  });
});
