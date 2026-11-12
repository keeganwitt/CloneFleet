import { describe, expect, it } from "vitest";
import { fleetFreshness } from "./freshness";
import { summarizeRun } from "./runSummary";
import type { RepoState } from "./state";
import type { Outcome, RepoSummary } from "./types";

const finished = (path: string, outcome: Outcome): RepoState => ({
  path,
  loadingSummary: false,
  result: { outcome, followUp: null, commands: [] },
});

describe("summarizeRun", () => {
  it("groups finished repositories by outcome and counts skip reasons", () => {
    const repos: Record<string, RepoState> = {
      "/a": finished("/a", { status: "succeeded", message: "" }),
      "/b": finished("/b", { status: "skipped", reason: "uncommittedChanges", message: "" }),
      "/c": finished("/c", { status: "skipped", reason: "uncommittedChanges", message: "" }),
      "/d": finished("/d", { status: "skipped", reason: "detachedHead", message: "" }),
      "/e": finished("/e", { status: "failed", message: "" }),
      "/f": { path: "/f", loadingSummary: false, runningAction: "pull" },
      "/other": finished("/other", { status: "failed", message: "" }),
    };
    const summary = summarizeRun(
      { label: "Pull", paths: ["/a", "/b", "/c", "/d", "/e", "/f", "/missing"] },
      repos,
    );
    expect(summary.running).toBe(1);
    expect(summary.byStatus).toEqual({
      succeeded: ["/a"],
      skipped: ["/b", "/c", "/d"],
      failed: ["/e"],
    });
    expect(summary.skipReasons).toEqual([
      ["uncommitted changes", 2],
      ["detached HEAD", 1],
    ]);
  });
});

describe("fleetFreshness", () => {
  const withFetch = (path: string, lastFetchUnix: number | null): RepoState => ({
    path,
    loadingSummary: false,
    summary: { lastFetchUnix } as RepoSummary,
  });

  it("finds the oldest fetch and counts repositories never fetched", () => {
    const repos = {
      "/a": withFetch("/a", 300),
      "/b": withFetch("/b", 100),
      "/c": withFetch("/c", null),
      "/d": { path: "/d", loadingSummary: false },
    };
    expect(fleetFreshness(["/a", "/b", "/c", "/d"], repos)).toEqual({
      oldestFetchUnix: 100,
      neverFetched: 1,
    });
    expect(fleetFreshness(["/a"], repos)).toEqual({ oldestFetchUnix: 300, neverFetched: 0 });
  });
});
