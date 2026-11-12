import { describe, expect, it } from "vitest";
import { initialState, reducer, type State } from "./state";
import type { ActionResult, RepoSummary } from "./types";

const summary: RepoSummary = {
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

const result: ActionResult = {
  outcome: { status: "succeeded", message: "ok" },
  followUp: null,
  commands: [],
};

function loaded(...paths: string[]): State {
  return reducer(initialState, { type: "reposLoaded", paths });
}

describe("reducer", () => {
  it("keeps existing repo state and drops removed repos from selection", () => {
    let state = loaded("/a", "/b");
    state = reducer(state, { type: "summaryLoaded", path: "/a", summary });
    state = reducer(state, { type: "setSelection", paths: ["/a", "/b"], selected: true });
    state = reducer(state, { type: "reposLoaded", paths: ["/a", "/c"] });

    expect(state.order).toEqual(["/a", "/c"]);
    expect(state.repos["/a"].summary).toEqual(summary);
    expect(state.repos["/c"]).toEqual({ path: "/c", loadingSummary: false });
    expect([...state.selected]).toEqual(["/a"]);
  });

  it("tracks summary loading and errors", () => {
    let state = reducer(loaded("/a"), { type: "summaryStarted", path: "/a" });
    expect(state.repos["/a"].loadingSummary).toBe(true);
    state = reducer(state, { type: "summaryFailed", path: "/a", error: "boom" });
    expect(state.repos["/a"]).toMatchObject({ loadingSummary: false, summaryError: "boom" });
    state = reducer(state, { type: "summaryLoaded", path: "/a", summary });
    expect(state.repos["/a"].summaryError).toBeUndefined();
  });

  it("clears the previous result when an action starts and stores the new one", () => {
    let state = reducer(loaded("/a", "/b"), { type: "actionFinished", path: "/a", result });
    state = reducer(state, { type: "actionStarted", paths: ["/a"], action: "pull" });
    expect(state.repos["/a"]).toMatchObject({ runningAction: "pull", result: undefined });
    expect(state.repos["/b"].runningAction).toBeUndefined();

    state = reducer(state, { type: "actionFinished", path: "/a", result });
    expect(state.repos["/a"]).toMatchObject({ runningAction: undefined, result });
  });

  it("toggles selection", () => {
    let state = reducer(loaded("/a"), { type: "toggleSelected", path: "/a" });
    expect(state.selected.has("/a")).toBe(true);
    state = reducer(state, { type: "toggleSelected", path: "/a" });
    expect(state.selected.has("/a")).toBe(false);
  });

  it("adds and removes only the given paths from the selection", () => {
    let state = reducer(loaded("/a", "/b", "/c"), {
      type: "setSelection",
      paths: ["/a", "/b", "/unknown"],
      selected: true,
    });
    expect([...state.selected].sort()).toEqual(["/a", "/b"]);
    state = reducer(state, { type: "setSelection", paths: ["/b", "/c"], selected: false });
    expect([...state.selected]).toEqual(["/a"]);
  });

  it("ignores events for unknown repos", () => {
    const state = loaded("/a");
    expect(reducer(state, { type: "summaryStarted", path: "/missing" })).toBe(state);
  });
});
