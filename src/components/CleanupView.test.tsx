import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BranchInfo, BranchReport, CleanupResult } from "../types";
import { CleanupView } from "./CleanupView";

const now = Math.floor(Date.now() / 1000);
const DAY = 86_400;

const branch = (name: string, overrides: Partial<BranchInfo> = {}): BranchInfo => ({
  name,
  sha: `${name}-sha`,
  upstream: `origin/${name}`,
  upstreamGone: false,
  lastCommitUnix: now - DAY,
  author: "Ann",
  subject: `Work on ${name}`,
  uniqueCommits: 1,
  merged: null,
  protection: null,
  worktree: null,
  ...overrides,
});

const report: BranchReport = {
  defaultBranch: "main",
  bases: ["origin/main", "main"],
  branches: [
    branch("main", { protection: "default" }),
    branch("squashed", { merged: { evidence: "squashed", base: "origin/main" } }),
    branch("abandoned", { upstreamGone: true }),
    branch("ancient", { lastCommitUnix: now - 400 * DAY }),
    branch("fresh"),
    branch("in-worktree", {
      merged: { evidence: "ancestor", base: "origin/main" },
      protection: "checkedOutInWorktree",
      worktree: "/wt/done",
    }),
  ],
  worktrees: [
    {
      path: "/repo",
      head: "a",
      branch: "main",
      isMain: true,
      locked: false,
      prunable: false,
      dirty: false,
      merged: null,
      lastCommitUnix: null,
    },
    {
      path: "/wt/done",
      head: "b",
      branch: "in-worktree",
      isMain: false,
      locked: false,
      prunable: false,
      dirty: false,
      merged: { evidence: "ancestor", base: "origin/main" },
      lastCommitUnix: now - DAY,
    },
    {
      path: "/wt/busy",
      head: "c",
      branch: "busy",
      isMain: false,
      locked: false,
      prunable: false,
      dirty: true,
      merged: { evidence: "ancestor", base: "origin/main" },
      lastCommitUnix: now - DAY,
    },
  ],
  warnings: ["Could not fetch upstream: offline"],
};

function mockBackend({ confirmed = true }: { confirmed?: boolean } = {}) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    switch (cmd) {
      case "analyze_branches":
        return report;
      case "plugin:dialog|message":
        return confirmed
          ? (args.buttons as { OkCancelCustom: [string, string] }).OkCancelCustom[0]
          : "Cancel";
      case "delete_branches":
        return {
          items: (args.branches as string[]).map((item) => ({
            item,
            status: "succeeded",
            message: `Deleted ${item}`,
          })),
          commands: [],
        } satisfies CleanupResult;
      case "remove_worktrees":
        return {
          items: (args.worktrees as string[]).map((item) => ({
            item,
            status: "succeeded",
            message: "Removed worktree",
          })),
          commands: [],
        } satisfies CleanupResult;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  });
  return calls;
}

const called = (calls: ReturnType<typeof mockBackend>, cmd: string) =>
  calls.filter((c) => c.cmd === cmd).map((c) => c.args);

function renderView() {
  const onChanged = vi.fn();
  render(<CleanupView paths={["/repo"]} onClose={() => {}} onChanged={onChanged} />);
  return onChanged;
}

describe("CleanupView", () => {
  it("fetches on open and shows candidates with merged branches preselected", async () => {
    const calls = mockBackend();
    renderView();

    expect(await screen.findByText("Squash-merged into origin/main")).toBeInTheDocument();
    expect(called(calls, "analyze_branches")).toEqual([{ path: "/repo", fetch: true }]);
    expect(screen.getByText("Could not fetch upstream: offline")).toBeInTheDocument();
    expect(screen.getByLabelText("Select branch squashed in repo")).toBeChecked();
    expect(screen.getByLabelText("Select branch abandoned in repo")).not.toBeChecked();
    expect(screen.getByLabelText("Select branch ancient in repo")).not.toBeChecked();
    expect(screen.queryByText("fresh")).not.toBeInTheDocument();
    expect(screen.queryByText("main")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Select worktree /wt/done")).toBeChecked();
    expect(screen.queryByText("/wt/busy")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByLabelText("Protected"));
    expect(screen.getByText("Has uncommitted or untracked files")).toBeInTheDocument();
    expect(screen.queryByLabelText("Select worktree /wt/busy")).not.toBeInTheDocument();
  });

  it("hides repositories with nothing to clean up unless asked", async () => {
    const user = userEvent.setup();
    mockIPC((cmd, payload) => {
      const path = (payload as Record<string, unknown>).path;
      if (cmd === "analyze_branches") {
        return path === "/empty"
          ? {
              ...report,
              branches: [branch("main", { protection: "default" })],
              worktrees: [],
              warnings: [],
            }
          : report;
      }
      throw new Error(`unexpected ${cmd}`);
    });
    render(<CleanupView paths={["/repo", "/empty"]} onClose={() => {}} onChanged={() => {}} />);
    expect(
      await screen.findByText("1 repository has nothing to clean up in the selected categories."),
    ).toBeInTheDocument();
    expect(screen.queryByText("empty")).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("Hide repositories with nothing to clean up"));
    expect(screen.getByText("empty")).toBeInTheDocument();
  });

  it("deletes merged branches without allowing unmerged ones", async () => {
    const user = userEvent.setup();
    const calls = mockBackend();
    const onChanged = renderView();
    await user.click(await screen.findByRole("button", { name: "Delete 1 branch" }));

    expect(await screen.findByText("squashed: Deleted squashed")).toBeInTheDocument();
    expect(called(calls, "delete_branches")).toEqual([
      { path: "/repo", branches: ["squashed"], allowUnmerged: false },
    ]);
    expect(called(calls, "analyze_branches").at(-1)).toEqual({ path: "/repo", fetch: false });
    expect(onChanged).toHaveBeenCalledWith(["/repo"]);
  });

  it("warns and allows unmerged deletion when a stale branch is selected", async () => {
    const user = userEvent.setup();
    const calls = mockBackend();
    renderView();
    await user.click(await screen.findByLabelText("Select branch ancient in repo"));
    await user.click(screen.getByRole("button", { name: "Delete 2 branches" }));

    await waitFor(() => expect(called(calls, "delete_branches")).toHaveLength(1));
    const dialog = called(calls, "plugin:dialog|message")[0];
    expect(dialog.message).toContain("1 of them is not merged");
    expect(called(calls, "delete_branches")[0]).toEqual({
      path: "/repo",
      branches: ["squashed", "ancient"],
      allowUnmerged: true,
    });
  });

  it("does nothing when the confirmation is cancelled", async () => {
    const user = userEvent.setup();
    const calls = mockBackend({ confirmed: false });
    renderView();
    await user.click(await screen.findByRole("button", { name: "Delete 1 branch" }));

    await waitFor(() => expect(called(calls, "plugin:dialog|message")).toHaveLength(1));
    expect(called(calls, "delete_branches")).toHaveLength(0);
  });

  it("ignores selected branches hidden by category filters", async () => {
    const user = userEvent.setup();
    mockBackend();
    renderView();
    await user.click(await screen.findByLabelText("Select branch abandoned in repo"));
    expect(screen.getByRole("button", { name: "Delete 2 branches" })).toBeEnabled();
    await user.click(screen.getByLabelText("Remote deleted"));
    expect(screen.getByRole("button", { name: "Delete 1 branch" })).toBeEnabled();
  });

  it("treats branches as stale based on the configured threshold", async () => {
    const user = userEvent.setup();
    mockBackend();
    renderView();
    await screen.findByText("ancient");
    const days = screen.getByLabelText("Stale after days");
    await user.clear(days);
    await user.type(days, "500");
    expect(screen.queryByText("ancient")).not.toBeInTheDocument();
  });

  it("offers stale unmerged worktrees and keeps their branches", async () => {
    const user = userEvent.setup();
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    mockIPC((cmd, payload) => {
      const args = (payload ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args });
      if (cmd === "analyze_branches") {
        return {
          ...report,
          worktrees: [
            report.worktrees[0],
            {
              ...report.worktrees[1],
              path: "/wt/old",
              branch: "experiment",
              merged: null,
              lastCommitUnix: now - 200 * DAY,
            },
          ],
        };
      }
      if (cmd === "plugin:dialog|message") return "Remove worktrees";
      if (cmd === "remove_worktrees") return { items: [], commands: [] };
      throw new Error(`unexpected ${cmd}`);
    });
    renderView();
    const checkbox = await screen.findByLabelText("Select worktree /wt/old");
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText("Not merged; removing it keeps experiment")).toHaveClass(
      "category-stale",
    );
    expect(screen.getByText("6mo ago")).toBeInTheDocument();
    await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: "Remove 1 worktree" }));

    await waitFor(() => expect(calls.some((c) => c.cmd === "remove_worktrees")).toBe(true));
    const dialog = calls.find((c) => c.cmd === "plugin:dialog|message")!;
    expect(dialog.args.message).toContain("Their branches are kept, so no commits are lost.");
    expect(calls.find((c) => c.cmd === "remove_worktrees")?.args).toMatchObject({
      worktrees: ["/wt/old"],
      allowUnmerged: true,
    });
  });

  it("removes worktrees and optionally their branches", async () => {
    const user = userEvent.setup();
    const calls = mockBackend();
    renderView();
    await user.click(await screen.findByLabelText("Also delete merged worktree branches"));
    await user.click(screen.getByRole("button", { name: "Remove 1 worktree" }));

    expect(await screen.findByText("/wt/done: Removed worktree")).toBeInTheDocument();
    expect(called(calls, "remove_worktrees")).toEqual([
      { path: "/repo", worktrees: ["/wt/done"], deleteBranches: false, allowUnmerged: false },
    ]);
  });
});

describe("CleanupView branch tree", () => {
  const treeReport: BranchReport = {
    ...report,
    warnings: [],
    worktrees: [],
    branches: [
      branch("main", { protection: "default" }),
      branch("feature/done", { merged: { evidence: "ancestor", base: "origin/main" } }),
      branch("feature/old", { lastCommitUnix: now - 200 * DAY }),
      branch("feature/nested/gone", { upstreamGone: true }),
      branch("solo", { merged: { evidence: "patchEquivalent", base: "origin/main" } }),
    ],
  };

  function mockTree() {
    const calls: Record<string, unknown>[] = [];
    mockIPC((cmd, payload) => {
      if (cmd === "analyze_branches") return treeReport;
      if (cmd === "plugin:dialog|message") return "Delete branches";
      if (cmd === "delete_branches") {
        calls.push(payload as Record<string, unknown>);
        return { items: [], commands: [] };
      }
      throw new Error(`unexpected ${cmd}`);
    });
    return calls;
  }

  it("groups branches into folders and summarizes categories per repository", async () => {
    mockTree();
    renderView();
    expect(await screen.findByRole("tree", { name: "Branches in repo" })).toBeInTheDocument();
    expect(screen.getByText("2 merged · 1 remote deleted · 1 stale")).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "feature/" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const folder = screen.getByLabelText("Select all in feature/ in repo") as HTMLInputElement;
    expect(folder.checked).toBe(false);
    expect(folder.indeterminate).toBe(true);
  });

  it("selects every branch in a folder and deletes them", async () => {
    const user = userEvent.setup();
    const calls = mockTree();
    renderView();
    await user.click(await screen.findByLabelText("Select all in feature/ in repo"));
    expect(screen.getByLabelText("Select branch feature/nested/gone in repo")).toBeChecked();
    expect(screen.getByLabelText("Select all in feature/nested/ in repo")).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Delete 4 branches" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0].branches as string[]).sort()).toEqual([
      "feature/done",
      "feature/nested/gone",
      "feature/old",
      "solo",
    ]);
    expect(calls[0].allowUnmerged).toBe(true);
  });

  it("clears a fully selected folder and supports the repository-level checkbox", async () => {
    const user = userEvent.setup();
    mockTree();
    renderView();
    const all = await screen.findByLabelText("Select all shown branches in repo");
    await user.click(all);
    expect(screen.getByRole("button", { name: "Delete 4 branches" })).toBeEnabled();
    await user.click(screen.getByLabelText("Select all in feature/ in repo"));
    expect(screen.getByRole("button", { name: "Delete 1 branch" })).toBeEnabled();
    expect((all as HTMLInputElement).indeterminate).toBe(true);
  });

  it("opens a branch's commits and changes from the tree", async () => {
    const user = userEvent.setup();
    mockTree();
    const onOpenBranch = vi.fn();
    render(
      <CleanupView
        paths={["/repo"]}
        onClose={() => {}}
        onChanged={() => {}}
        onOpenBranch={onOpenBranch}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "old" }));
    expect(onOpenBranch).toHaveBeenCalledWith("/repo", "feature/old");
  });

  it("collapses folders", async () => {
    const user = userEvent.setup();
    mockTree();
    renderView();
    await user.click(await screen.findByRole("button", { name: "Collapse feature/" }));
    expect(screen.queryByText("done")).not.toBeInTheDocument();
    expect(screen.getByText("solo")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Expand feature/" }));
    expect(screen.getByText("done")).toBeInTheDocument();
  });

  it("recategorizes stale branches when the day threshold changes", async () => {
    const user = userEvent.setup();
    mockTree();
    renderView();
    await screen.findByText("old");
    const days = screen.getByLabelText("Stale after days");
    await user.clear(days);
    await user.type(days, "365");
    expect(screen.queryByText("old")).not.toBeInTheDocument();
    expect(screen.getByText("2 merged · 1 remote deleted")).toBeInTheDocument();
  });
});
