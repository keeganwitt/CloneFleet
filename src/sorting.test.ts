import { describe, expect, it } from "vitest";
import { nextSort, sortPaths, type Sort } from "./sorting";
import type { RepoState } from "./state";
import type { RepoSummary } from "./types";

const base: RepoSummary = {
  branch: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  trackedChanges: 0,
  untracked: 0,
  conflicts: 0,
  operation: null,
  lastFetchUnix: 100,
  defaultBranch: "main",
  mainBranches: ["main"],
  defaultOverridden: false,
  hasRemotes: true,
};

const repo = (
  path: string,
  summary?: Partial<RepoSummary>,
  status?: "failed" | "succeeded",
): RepoState => ({
  path,
  loadingSummary: false,
  summary: summary && { ...base, ...summary },
  result: status && {
    outcome: status === "failed" ? { status, message: "" } : { status, message: "" },
    followUp: null,
    commands: [],
  },
});

const repos: Record<string, RepoState> = {
  "/x/beta": repo("/x/beta", { behind: 2, trackedChanges: 1, lastFetchUnix: 300 }, "succeeded"),
  "/x/Alpha": repo(
    "/x/Alpha",
    { behind: 0, ahead: 3, branch: "zeta", lastFetchUnix: null },
    "failed",
  ),
  "/x/gamma": repo("/x/gamma", { behind: 5, untracked: 4, branch: "feature" }),
  "/x/delta": repo("/x/delta"),
};
const paths = Object.keys(repos);
const sorted = (sort: Sort) => sortPaths(paths, repos, sort).map((p) => p.slice(3));

describe("sortPaths", () => {
  it("sorts by name case-insensitively", () => {
    expect(sorted({ key: "name", direction: "ascending" })).toEqual([
      "Alpha",
      "beta",
      "delta",
      "gamma",
    ]);
    expect(sorted({ key: "name", direction: "descending" })).toEqual([
      "gamma",
      "delta",
      "beta",
      "Alpha",
    ]);
  });

  it("puts repositories without a value last regardless of direction", () => {
    expect(sorted({ key: "branch", direction: "ascending" })).toEqual([
      "gamma",
      "beta",
      "Alpha",
      "delta",
    ]);
    expect(sorted({ key: "fetched", direction: "descending" })).toEqual([
      "beta",
      "gamma",
      "Alpha",
      "delta",
    ]);
  });

  it("orders sync by how far behind, then ahead", () => {
    expect(sorted({ key: "sync", direction: "descending" })).toEqual([
      "gamma",
      "beta",
      "Alpha",
      "delta",
    ]);
  });

  it("orders results with failures first and changes by file count", () => {
    expect(sorted({ key: "result", direction: "ascending" })).toEqual([
      "Alpha",
      "beta",
      "delta",
      "gamma",
    ]);
    expect(sorted({ key: "changes", direction: "descending" })).toEqual([
      "gamma",
      "beta",
      "Alpha",
      "delta",
    ]);
  });
});

describe("nextSort", () => {
  it("toggles direction on the same key and picks a sensible default for a new key", () => {
    expect(nextSort({ key: "name", direction: "ascending" }, "name").direction).toBe("descending");
    expect(nextSort({ key: "name", direction: "ascending" }, "sync")).toEqual({
      key: "sync",
      direction: "descending",
    });
    expect(nextSort({ key: "sync", direction: "descending" }, "branch")).toEqual({
      key: "branch",
      direction: "ascending",
    });
  });
});
