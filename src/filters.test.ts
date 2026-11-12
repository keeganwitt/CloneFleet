import { describe, expect, it } from "vitest";
import { defaultFilters, isFiltering, matchesFilters, type Filters } from "./filters";
import type { RepoState } from "./state";
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
  defaultBranch: "main",
};

function repo(path: string, summary?: Partial<RepoSummary>): RepoState {
  return { path, loadingSummary: false, summary: summary && { ...clean, ...summary } };
}

const matches = (r: RepoState, f: Partial<Filters>) =>
  matchesFilters(r, { ...defaultFilters, ...f });

describe("search", () => {
  it("matches name, path, and branch case-insensitively with all terms required", () => {
    const r = repo("/work/Widgets", { branch: "feature/login" });
    expect(matches(r, { search: "widg" })).toBe(true);
    expect(matches(r, { search: "work" })).toBe(true);
    expect(matches(r, { search: "LOGIN widgets" })).toBe(true);
    expect(matches(r, { search: "login gadgets" })).toBe(false);
  });

  it("matches by path when the summary has not loaded", () => {
    expect(matches(repo("/work/widgets"), { search: "widgets" })).toBe(true);
  });
});

describe("changes filter", () => {
  it("classifies working tree states", () => {
    const dirty = repo("/a", { trackedChanges: 1 });
    const conflicted = repo("/b", { conflicts: 1, operation: "merge" });
    const untracked = repo("/c", { untracked: 2 });
    const pristine = repo("/d", {});

    expect(matches(pristine, { changes: "clean" })).toBe(true);
    expect(matches(untracked, { changes: "clean" })).toBe(false);
    expect(matches(dirty, { changes: "modified" })).toBe(true);
    expect(matches(conflicted, { changes: "modified" })).toBe(true);
    expect(matches(untracked, { changes: "modified" })).toBe(false);
    expect(matches(untracked, { changes: "untracked" })).toBe(true);
    expect(matches(conflicted, { changes: "inProgress" })).toBe(true);
    expect(matches(dirty, { changes: "inProgress" })).toBe(false);
  });
});

describe("sync filter", () => {
  it("classifies upstream states", () => {
    const ahead = repo("/a", { ahead: 1 });
    const behind = repo("/b", { behind: 1 });
    const diverged = repo("/c", { ahead: 1, behind: 1 });
    const detached = repo("/d", { branch: null, upstream: null });
    const local = repo("/e", { upstream: null, ahead: null, behind: null });

    expect(matches(repo("/f", {}), { sync: "upToDate" })).toBe(true);
    expect(matches(ahead, { sync: "upToDate" })).toBe(false);
    expect(matches(ahead, { sync: "ahead" })).toBe(true);
    expect(matches(diverged, { sync: "ahead" })).toBe(true);
    expect(matches(behind, { sync: "behind" })).toBe(true);
    expect(matches(diverged, { sync: "diverged" })).toBe(true);
    expect(matches(ahead, { sync: "diverged" })).toBe(false);
    expect(matches(detached, { sync: "noUpstream" })).toBe(true);
    expect(matches(local, { sync: "noUpstream" })).toBe(true);
    expect(matches(local, { sync: "upToDate" })).toBe(false);
  });
});

it("hides repos without a summary only when a status filter is active", () => {
  const loading = repo("/a");
  expect(matches(loading, {})).toBe(true);
  expect(matches(loading, { changes: "clean" })).toBe(false);
  expect(matches(loading, { sync: "behind" })).toBe(false);
});

it("reports whether any filter is active", () => {
  expect(isFiltering(defaultFilters)).toBe(false);
  expect(isFiltering({ ...defaultFilters, search: "  " })).toBe(false);
  expect(isFiltering({ ...defaultFilters, sync: "ahead" })).toBe(true);
});
