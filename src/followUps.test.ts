import { describe, expect, it } from "vitest";
import { followUpOf, pendingFollowUps } from "./followUps";
import type { RepoState } from "./state";
import type { Action } from "./types";

const rename: Action = { type: "renameBranch", remote: "origin", from: "master", to: "main" };
const push: Action = {
  type: "push",
  plan: { remote: "origin", branch: "main", commits: 1, force: false, expectedRemoteSha: null },
};

const repo = (path: string, followUp: Action | null, running = false): RepoState => ({
  path,
  loadingSummary: false,
  runningAction: running ? "fetch" : undefined,
  result: { outcome: { status: "succeeded", message: "" }, followUp, commands: [] },
});

describe("follow-ups", () => {
  const repos = {
    "/a": repo("/a", rename),
    "/b": repo("/b", push),
    "/c": repo("/c", rename, true),
    "/d": repo("/d", null),
  };

  it("hides follow-ups while an action is running", () => {
    expect(followUpOf(repos["/a"])).toEqual(rename);
    expect(followUpOf(repos["/c"])).toBeUndefined();
    expect(followUpOf(repos["/d"])).toBeUndefined();
  });

  it("collects pending follow-ups of one type for the given paths", () => {
    expect(pendingFollowUps(["/a", "/b", "/c", "/d"], repos, "renameBranch")).toEqual([
      ["/a", rename],
    ]);
    expect(pendingFollowUps(["/a", "/c"], repos, "push")).toEqual([]);
  });
});
