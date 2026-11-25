import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor, within } from "@testing-library/react";
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
  render(<CleanupView paths={["/repo"]} onChanged={onChanged} />);
  return onChanged;
}

describe("CleanupView", () => {
  it("loads candidates with no selection and disables protected items", async () => {
    const calls = mockBackend();
    renderView();
    expect(await screen.findByText("Squash-merged into origin/main")).toBeInTheDocument();
    expect(called(calls, "analyze_branches")).toEqual([{ path: "/repo", fetch: true }]);
    expect(screen.getByLabelText("Select branch squashed in repo")).not.toBeChecked();
    expect(screen.getByLabelText("Select worktree /wt/done")).not.toBeChecked();
    await userEvent.selectOptions(screen.getByLabelText("Cleanup status"), "protected");
    expect(screen.getByText("Has uncommitted or untracked files")).toBeInTheDocument();
    expect(screen.getByLabelText("Select all matching cleanup candidates")).toBeDisabled();
  });

  it("reviews exact branches and worktrees and applies merged and unmerged targets separately", async () => {
    const user = userEvent.setup();
    const calls = mockBackend();
    const onChanged = renderView();
    await user.click(await screen.findByLabelText("Select branch squashed in repo"));
    await user.click(screen.getByLabelText("Select branch ancient in repo"));
    await user.click(screen.getByLabelText("Select worktree /wt/done"));
    await user.click(screen.getByRole("button", { name: "Review 3 items…" }));
    const dialog = screen.getByRole("dialog", { name: "Review branch and worktree cleanup" });
    expect(dialog).toHaveTextContent("3 items across 1 repository");
    expect(dialog).toHaveTextContent("1 branch with commits outside its merge target");
    expect(dialog).toHaveTextContent("Keep branch in-worktree");
    expect(dialog).not.toHaveTextContent("abandoned");
    expect(called(calls, "delete_branches")).toEqual([]);
    expect(called(calls, "remove_worktrees")).toEqual([]);
    await user.click(
      within(dialog).getByRole("button", { name: "Delete 2 branches and remove 1 worktree" }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(["/repo"]));
    expect(called(calls, "delete_branches")).toEqual([
      { path: "/repo", branches: ["squashed"], allowUnmerged: false },
      { path: "/repo", branches: ["ancient"], allowUnmerged: true },
    ]);
    expect(called(calls, "remove_worktrees")).toEqual([
      { path: "/repo", worktrees: ["/wt/done"], deleteBranches: false, allowUnmerged: false },
    ]);
    expect(called(calls, "analyze_branches").at(-1)).toEqual({ path: "/repo", fetch: false });
  });

  it("keeps selection when returning from review and excludes targets hidden by filters", async () => {
    const user = userEvent.setup();
    const calls = mockBackend();
    renderView();
    await user.click(await screen.findByLabelText("Select branch squashed in repo"));
    await user.click(screen.getByLabelText("Select branch abandoned in repo"));
    await user.selectOptions(screen.getByLabelText("Cleanup status"), "merged");
    const opener = screen.getByRole("button", { name: "Review 1 item…" });
    await user.click(opener);
    expect(screen.getByRole("dialog")).not.toHaveTextContent("abandoned");
    await user.click(screen.getByRole("button", { name: "Back to selection" }));
    expect(opener).toHaveFocus();
    expect(screen.getByLabelText("Select branch squashed in repo")).toBeChecked();
    expect(called(calls, "delete_branches")).toEqual([]);
  });

  it("keeps folder-level selection in the grouped view", async () => {
    const user = userEvent.setup();
    mockBackend();
    const onOpenBranch = vi.fn();
    render(<CleanupView paths={["/repo"]} onChanged={vi.fn()} onOpenBranch={onOpenBranch} />);
    await user.click(screen.getByText("Analysis options"));
    await user.click(screen.getByLabelText("Group by repository"));
    const tree = await screen.findByRole("tree", { name: "Branches in repo" });
    await user.click(within(tree).getByRole("button", { name: "squashed" }));
    expect(onOpenBranch).toHaveBeenCalledWith("/repo", "squashed");
    await user.click(screen.getByLabelText("Select candidates in repo"));
    expect(screen.getByRole("button", { name: "Review 4 items…" })).toBeEnabled();
  });

  it("starts Overview branch cleanup with only the requested category", async () => {
    mockBackend();
    render(<CleanupView paths={["/repo"]} initialCategory="merged" onChanged={vi.fn()} />);
    expect(await screen.findByLabelText("Select branch squashed in repo")).toBeInTheDocument();
    expect(screen.queryByLabelText("Select worktree /wt/done")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Select branch ancient in repo")).not.toBeInTheDocument();
  });
});
