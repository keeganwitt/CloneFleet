import { describe, expect, it } from "vitest";
import { describePushes } from "./push";
import type { PushPlan } from "./types";

const plan: PushPlan = {
  remote: "origin",
  branch: "main",
  commits: 1,
  force: false,
  expectedRemoteSha: null,
};

describe("describePushes", () => {
  it("lists each push and warns about force pushes", () => {
    expect(
      describePushes([
        ["/src/alpha", plan],
        ["/src/beta", { ...plan, force: true, expectedRemoteSha: "abc" }],
      ]),
    ).toBe(
      "Push 2 repositories?\n\n• alpha: 1 commit to origin/main\n• beta: force push to origin/main" +
        "\n\n1 will be force-pushed with a lease: the push is refused if the fork changed since the rebase.",
    );
  });

  it("truncates long lists", () => {
    const pushes = Array.from({ length: 12 }, (_, i): [string, PushPlan] => [
      `/r${i}`,
      { ...plan, commits: 2 },
    ]);
    const message = describePushes(pushes);
    expect(message).toMatch(/^Push 12 repositories\?/);
    expect(message).toContain("• r9: 2 commits to origin/main");
    expect(message).not.toContain("r10");
    expect(message).toContain("• …and 2 more");
    expect(message).not.toContain("force");
  });
});
