import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { UnpushedBranch, UnpushedReport } from "../types";
import { UnpushedView, describeUnpushedBranch, olderThan, summarizeUnpushed } from "./UnpushedView";

const now = Math.floor(Date.now() / 1000);

const branch = (name: string, overrides: Partial<UnpushedBranch> = {}): UnpushedBranch => ({
  name,
  upstream: null,
  upstreamGone: false,
  commits: 1,
  lastCommitUnix: now - 86_400,
  merged: null,
  ...overrides,
});

const empty: UnpushedReport = {
  hasRemotes: true,
  branches: [],
  stashes: [],
  dirtyWorktrees: [],
  warnings: [],
};

const busy: UnpushedReport = {
  ...empty,
  branches: [
    branch("local-only", { commits: 3 }),
    branch("squashed", {
      commits: 2,
      upstream: "origin/squashed",
      upstreamGone: true,
      merged: { evidence: "squashed", base: "origin/main" },
    }),
  ],
  stashes: [
    { index: 0, sha: "s0", createdUnix: now - 3600, message: "On main: recent" },
    { index: 1, sha: "s1", createdUnix: now - 90 * 86_400, message: "WIP on main: old" },
  ],
  dirtyWorktrees: ["/busy"],
};

describe("describeUnpushedBranch", () => {
  it("explains where the commits are missing from", () => {
    expect(describeUnpushedBranch(branch("x"))).toBe("1 commit on no remote (never pushed)");
    expect(describeUnpushedBranch(branch("x", { upstream: "origin/x", commits: 2 }))).toBe(
      "2 commits on no remote (not yet pushed to origin/x)",
    );
    expect(describeUnpushedBranch(busy.branches[1])).toBe(
      "2 commits on no remote (remote branch origin/squashed was deleted); " +
        "changes are already in origin/main (squash-merged)",
    );
  });
});

describe("olderThan", () => {
  it("keeps branches and stashes at least the given age, and all uncommitted changes", () => {
    const filtered = olderThan(busy, now, 30);
    expect(filtered.branches).toEqual([]);
    expect(filtered.stashes.map((s) => s.sha)).toEqual(["s1"]);
    expect(filtered.dirtyWorktrees).toEqual(["/busy"]);
    expect(olderThan(busy, now, null)).toBe(busy);
  });
});

describe("summarizeUnpushed", () => {
  it("summarizes each kind of unpushed work", () => {
    expect(summarizeUnpushed(empty)).toBe("Nothing unpushed");
    expect(summarizeUnpushed(busy)).toBe("2 branches · 2 stashes · uncommitted changes");
  });
});

function mockBackend(confirmed = true) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    switch (cmd) {
      case "analyze_unpushed":
        return args.path === "/busy" ? busy : empty;
      case "plugin:dialog|message":
        return confirmed ? "Drop stashes" : "Cancel";
      case "drop_stashes":
        return {
          items: (args.stashes as string[]).map((item) => ({
            item,
            status: "succeeded",
            message: `Dropped ${item}`,
          })),
          commands: [],
        };
      default:
        throw new Error(`unexpected ${cmd}`);
    }
  });
  return calls;
}

function renderView() {
  const onChanged = vi.fn();
  render(<UnpushedView paths={["/busy", "/clean"]} onClose={() => {}} onChanged={onChanged} />);
  return onChanged;
}

describe("UnpushedView", () => {
  it("shows unpushed work and hides clean repositories by default", async () => {
    const user = userEvent.setup();
    mockBackend();
    renderView();

    expect(await screen.findByText("1 of 2 repositories has unpushed work")).toBeInTheDocument();
    expect(screen.getByText("2 branches · 2 stashes · uncommitted changes")).toBeInTheDocument();
    expect(screen.getByText("local-only")).toBeInTheDocument();
    expect(screen.getByText("3 commits on no remote (never pushed)")).toBeInTheDocument();
    expect(screen.getByText("WIP on main: old")).toBeInTheDocument();
    expect(screen.getByText("3mo ago")).toBeInTheDocument();
    expect(screen.queryByText("clean")).not.toBeInTheDocument();

    await user.click(screen.getByLabelText("Hide repositories with nothing unpushed"));
    expect(screen.getByText("Nothing unpushed")).toBeInTheDocument();
  });

  it("drops only the selected stashes after confirmation", async () => {
    const user = userEvent.setup();
    const calls = mockBackend();
    const onChanged = renderView();
    await user.click(await screen.findByLabelText("Select stash WIP on main: old in busy"));
    await user.click(screen.getByRole("button", { name: "Drop 1 stash" }));

    expect(await screen.findByText("Dropped s1")).toBeInTheDocument();
    const dialog = calls.find((c) => c.cmd === "plugin:dialog|message")!;
    expect(dialog.args.message).toContain("recovered by SHA");
    expect(calls.filter((c) => c.cmd === "drop_stashes").map((c) => c.args)).toEqual([
      { path: "/busy", stashes: ["s1"] },
    ]);
    expect(calls.filter((c) => c.cmd === "analyze_unpushed").at(-1)?.args).toEqual({
      path: "/busy",
      fetch: false,
    });
    expect(onChanged).toHaveBeenCalledWith(["/busy"]);
  });

  it("does not drop stashes when the confirmation is cancelled", async () => {
    const user = userEvent.setup();
    const calls = mockBackend(false);
    renderView();
    await user.click(await screen.findByLabelText("Select stash On main: recent in busy"));
    await user.click(screen.getByRole("button", { name: "Drop 1 stash" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === "plugin:dialog|message")).toHaveLength(1),
    );
    expect(calls.filter((c) => c.cmd === "drop_stashes")).toHaveLength(0);
  });

  it("filters to work older than a number of days", async () => {
    const user = userEvent.setup();
    mockBackend();
    renderView();
    await screen.findByText("local-only");
    expect(screen.getByLabelText("Minimum age in days")).toBeDisabled();
    await user.click(screen.getByLabelText("Only older than"));

    expect(screen.queryByText("local-only")).not.toBeInTheDocument();
    expect(screen.queryByText("On main: recent")).not.toBeInTheDocument();
    expect(screen.getByText("WIP on main: old")).toBeInTheDocument();
    expect(
      screen.getByText("1 of 2 repositories has unpushed work older than 30 days"),
    ).toBeInTheDocument();

    const days = screen.getByLabelText("Minimum age in days");
    await user.clear(days);
    await user.type(days, "120");
    expect(screen.queryByText("WIP on main: old")).not.toBeInTheDocument();
    expect(screen.getByText("uncommitted changes")).toBeInTheDocument();
  });

  it("re-analyzes with or without fetching", async () => {
    const user = userEvent.setup();
    const calls = mockBackend();
    renderView();
    await screen.findByText("local-only");
    await user.click(screen.getByLabelText("Fetch remotes"));
    await user.click(screen.getByRole("button", { name: "Re-analyze" }));
    await waitFor(() => expect(calls.filter((c) => c.cmd === "analyze_unpushed")).toHaveLength(4));
    expect(
      calls
        .filter((c) => c.cmd === "analyze_unpushed")
        .slice(2)
        .map((c) => c.args.fetch),
    ).toEqual([false, false]);
  });
});
