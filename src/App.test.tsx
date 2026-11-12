import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "./App";
import type { Action, ActionResult, Outcome, PushPlan, RepoSummary, WorkspaceView } from "./types";

const summary: RepoSummary = {
  branch: "feature",
  upstream: "origin/feature",
  ahead: 1,
  behind: 0,
  trackedChanges: 2,
  untracked: 0,
  conflicts: 0,
  operation: null,
  lastFetchUnix: null,
  defaultBranch: "main",
  mainBranches: ["main"],
  defaultOverridden: false,
};

interface Backend {
  repos: string[];
  summaries?: Record<string, Partial<RepoSummary>>;
  outcomes?: Partial<Record<Action["type"], Outcome>>;
  outcomesByPath?: Record<string, Outcome>;
  discovered?: string[];
  roots?: string[];
  recent?: string[][];
  excluded?: string[];
  pushPlans?: Record<string, PushPlan>;
  renames?: Record<string, Action>;
  confirmed?: boolean;
  gitError?: string;
  health?: Record<string, Record<string, number>>;
  cancelledRuns?: number[];
  slow?: boolean;
}

function followUpFor(backend: Backend, action: Action, path: string): Action | null {
  if (action.type === "rebaseFork") {
    const plan = backend.pushPlans?.[path];
    return plan ? { type: "push", plan } : null;
  }
  if (action.type === "syncDefaultBranch") return backend.renames?.[path] ?? null;
  return null;
}

function defaultRoots(backend: Backend): string[] {
  return [...new Set(backend.repos.map((p) => p.slice(0, p.lastIndexOf("/"))))];
}

function workspaceView(backend: Backend): WorkspaceView {
  const roots = backend.roots ?? defaultRoots(backend);
  return {
    roots: roots.map((path) => ({
      path,
      repoCount: backend.repos.filter((p) => p.startsWith(`${path}/`)).length,
      missing: false,
    })),
    repos: backend.repos,
    excludedCount: backend.excluded?.length ?? 0,
    recent: backend.recent ?? [],
  };
}

function mockBackend(backend: Backend) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    switch (cmd) {
      case "repo_health":
        return {
          mergedBranches: 0,
          remoteDeletedBranches: 0,
          staleBranches: 0,
          removableWorktrees: 0,
          unpushedBranches: 0,
          stashes: 0,
          warnings: [],
          ...backend.health?.[args.path as string],
        };
      case "get_settings":
        return {
          settings: {
            gitPath: null,
            theme: "system",
            reopenLast: true,
            rememberRecent: true,
            terminal: null,
            editor: null,
            webHosts: [],
          },
          detectedGit: "/usr/bin/git",
          activeGit: backend.gitError
            ? { path: null, version: null, error: backend.gitError }
            : { path: "/usr/bin/git", version: "git version 2.56.0", error: null },
        };
      case "plugin:window|set_theme":
        return null;
      case "load_workspace":
        return workspaceView(backend);
      case "open_directories": {
        const paths = args.paths as string[];
        const previous = backend.roots ?? defaultRoots(backend);
        backend.recent = [previous, ...(backend.recent ?? [])];
        backend.roots = paths;
        backend.repos = [...(backend.discovered ?? [])].sort();
        return workspaceView(backend);
      }
      case "open_recent": {
        backend.roots = args.roots as string[];
        backend.repos = backend.repos.filter((p) => backend.roots!.some((r) => p.startsWith(r)));
        return workspaceView(backend);
      }
      case "add_directories":
        backend.roots = [...(backend.roots ?? defaultRoots(backend)), ...(args.paths as string[])];
        backend.repos = [...backend.repos, ...(backend.discovered ?? [])].sort();
        return workspaceView(backend);
      case "remove_directory": {
        const removed = args.path as string;
        backend.roots = (backend.roots ?? defaultRoots(backend)).filter((r) => r !== removed);
        backend.repos = backend.repos.filter((p) => !p.startsWith(`${removed}/`));
        return workspaceView(backend);
      }
      case "clear_recent":
        backend.recent = [];
        return workspaceView(backend);
      case "rescan_workspace":
        backend.repos = [...new Set([...backend.repos, ...(backend.discovered ?? [])])].sort();
        return workspaceView(backend);
      case "restore_excluded":
        backend.repos = [...backend.repos, ...(backend.excluded ?? [])].sort();
        backend.excluded = [];
        return workspaceView(backend);
      case "repo_summary":
        return { ...summary, ...backend.summaries?.[args.path as string] };
      case "run_action": {
        const action = args.action as Action;
        if (backend.slow) {
          return new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  outcome: backend.cancelledRuns?.includes(args.runId as number)
                    ? {
                        status: "skipped",
                        reason: "cancelled",
                        message: "Cancelled before it started",
                      }
                    : { status: "succeeded", message: `${action.type} done` },
                  followUp: null,
                  commands: [],
                }),
              50,
            ),
          );
        }
        const outcome = backend.outcomesByPath?.[args.path as string] ??
          backend.outcomes?.[action.type] ?? {
            status: "succeeded",
            message: `${action.type} done`,
          };
        return {
          outcome,
          followUp: followUpFor(backend, action, args.path as string),
          commands: [],
        } satisfies ActionResult;
      }
      case "list_changes":
        return [
          {
            path: "src/app.ts",
            originalPath: null,
            kind: "modified",
            staged: false,
            unstaged: true,
          },
        ];
      case "plugin:dialog|open":
        return "/picked";
      case "analyze_unpushed":
        return { hasRemotes: true, branches: [], stashes: [], dirtyWorktrees: [], warnings: [] };
      case "cancel_run":
        backend.cancelledRuns = [...(backend.cancelledRuns ?? []), args.runId as number];
        return null;
      case "plugin:dialog|message":
        return backend.confirmed === false ? "Cancel" : "Push";
      case "remove_repos": {
        const removed = args.paths as string[];
        backend.repos = backend.repos.filter((p) => !removed.includes(p));
        backend.excluded = [...(backend.excluded ?? []), ...removed];
        return workspaceView(backend);
      }
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  });
  return calls;
}

async function renderRepositories() {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Repositories" }));
}

function actionCalls(calls: ReturnType<typeof mockBackend>) {
  return calls.filter((c) => c.cmd === "run_action").map((c) => [c.args.path, c.args.action]);
}

describe("App", () => {
  it("shows an empty state when no repositories are configured", async () => {
    mockBackend({ repos: [] });
    render(<App />);
    expect(await screen.findByText(/No directories open/)).toBeInTheDocument();
  });

  it("lists repositories with their status", async () => {
    mockBackend({ repos: ["/src/alpha"] });
    await renderRepositories();
    const row = (await screen.findByText("alpha")).closest("tr")!;
    await waitFor(() => expect(within(row).getByText("feature")).toBeInTheDocument());
    expect(within(row).getByText("default: main")).toBeInTheDocument();
    expect(within(row).getByText("2 modified")).toBeInTheDocument();
    expect(within(row).getByText("↑1")).toBeInTheDocument();
  });

  it("opens the detail panel on the changes tab and closes it with Escape", async () => {
    const user = userEvent.setup();
    const calls = mockBackend({ repos: ["/src/alpha"] });
    await renderRepositories();
    await user.click(await screen.findByRole("button", { name: "Show changes in alpha" }));

    const panel = await screen.findByRole("dialog", { name: "Details for alpha" });
    expect(within(panel).getByRole("tab", { name: "Changes" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await within(panel).findByText("src/app.ts")).toBeInTheDocument();
    expect(calls.filter((c) => c.cmd === "list_changes")).toEqual([
      { cmd: "list_changes", args: { path: "/src/alpha" } },
    ]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not offer a changes list for clean repositories", async () => {
    mockBackend({ repos: ["/src/alpha"], summaries: { "/src/alpha": { trackedChanges: 0 } } });
    await renderRepositories();
    expect(await screen.findByRole("cell", { name: "Clean" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /changes in alpha/ })).not.toBeInTheDocument();
  });

  it("runs an action on every selected repository", async () => {
    const user = userEvent.setup();
    const calls = mockBackend({ repos: ["/src/alpha", "/src/beta", "/src/gamma"] });
    await renderRepositories();
    await screen.findByText("alpha");

    await user.click(screen.getByLabelText("Select alpha"));
    await user.click(screen.getByLabelText("Select gamma"));
    await user.click(screen.getByRole("button", { name: "Pull" }));

    expect(await screen.findAllByText("pull done")).toHaveLength(2);
    expect(actionCalls(calls)).toEqual([
      ["/src/alpha", { type: "pull" }],
      ["/src/gamma", { type: "pull" }],
    ]);
  });

  it("offers stash and commit when checkout is skipped for uncommitted changes", async () => {
    const user = userEvent.setup();
    const calls = mockBackend({
      repos: ["/src/alpha"],
      outcomes: {
        checkoutDefault: {
          status: "skipped",
          reason: "uncommittedChanges",
          message: "2 files with uncommitted changes",
        },
      },
    });
    await renderRepositories();
    await user.click(await screen.findByLabelText("Select all"));
    await user.click(screen.getByRole("button", { name: "Checkout default branch" }));
    await within(screen.getByRole("table")).findByText("2 files with uncommitted changes");

    await user.click(screen.getByRole("button", { name: "Commit…" }));
    const submit = screen.getByRole("button", { name: "Commit" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("Commit message for alpha"), "WIP");
    await user.click(submit);

    expect(await within(screen.getByRole("table")).findByText("commit done")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stash" })).not.toBeInTheDocument();
    expect(actionCalls(calls)).toEqual([
      ["/src/alpha", { type: "checkoutDefault" }],
      ["/src/alpha", { type: "commit", message: "WIP" }],
    ]);
  });

  it("filters the list and only acts on visible selected repositories", async () => {
    const user = userEvent.setup();
    const calls = mockBackend({
      repos: ["/src/alpha", "/src/beta", "/src/gamma"],
      summaries: {
        "/src/alpha": { trackedChanges: 0, behind: 3 },
        "/src/beta": { trackedChanges: 0 },
      },
    });
    await renderRepositories();
    await waitFor(() => expect(screen.getAllByText("feature")).toHaveLength(3));

    await user.click(screen.getByLabelText("Select all"));
    await user.selectOptions(screen.getByLabelText("Filter by changes"), "clean");
    expect(screen.queryByText("gamma")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Filter by sync"), "behind");
    expect(screen.queryByText("beta")).not.toBeInTheDocument();
    const bar = screen.getByRole("region", { name: "Selection actions" });
    expect(bar).toHaveTextContent("1 selected");
    expect(bar).toHaveTextContent("(2 more hidden by filters)");

    await user.click(screen.getByRole("button", { name: "Pull" }));
    await within(screen.getByRole("table")).findByText("pull done");
    expect(actionCalls(calls)).toEqual([["/src/alpha", { type: "pull" }]]);

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("gamma")).toBeInTheDocument();
  });

  it("searches by repository name", async () => {
    const user = userEvent.setup();
    mockBackend({ repos: ["/src/alpha", "/src/beta"] });
    await renderRepositories();
    await user.type(await screen.findByLabelText("Search repositories"), "bet");
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Search repositories"), "x");
    expect(screen.getByText("No repositories match the current filters.")).toBeInTheDocument();
  });

  it("offers to push after rebasing forks and confirms bulk pushes", async () => {
    const user = userEvent.setup();
    const forced: PushPlan = {
      remote: "origin",
      branch: "main",
      commits: 1,
      force: true,
      expectedRemoteSha: "abc",
    };
    const normal: PushPlan = { ...forced, commits: 3, force: false, expectedRemoteSha: null };
    const calls = mockBackend({
      repos: ["/src/alpha", "/src/beta", "/src/gamma"],
      pushPlans: { "/src/alpha": forced, "/src/beta": normal },
    });
    await renderRepositories();
    await user.click(await screen.findByLabelText("Select all"));
    await user.click(screen.getByRole("button", { name: "Rebase fork on upstream" }));

    expect(
      await screen.findByText(
        /2 repositories have rebased commits to push \(1 need a force push\)/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Force push to origin…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Push to origin" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Push all…" }));
    await waitFor(() =>
      expect(screen.queryByText(/rebased commits to push/)).not.toBeInTheDocument(),
    );
    const message = calls.find((c) => c.cmd === "plugin:dialog|message")!.args.message as string;
    expect(message).toContain("alpha: force push to origin/main");
    expect(message).toContain("beta: 3 commits to origin/main");
    expect(actionCalls(calls).filter(([, action]) => (action as Action).type === "push")).toEqual([
      ["/src/alpha", { type: "push", plan: forced }],
      ["/src/beta", { type: "push", plan: normal }],
    ]);
  });

  it("pushes a single fast-forward without a dialog but confirms force pushes", async () => {
    const user = userEvent.setup();
    const plan: PushPlan = {
      remote: "origin",
      branch: "main",
      commits: 1,
      force: true,
      expectedRemoteSha: "abc",
    };
    const calls = mockBackend({
      repos: ["/src/alpha", "/src/beta"],
      pushPlans: {
        "/src/alpha": plan,
        "/src/beta": { ...plan, force: false, expectedRemoteSha: null },
      },
      confirmed: false,
    });
    await renderRepositories();
    await user.click(await screen.findByLabelText("Select all"));
    await user.click(screen.getByRole("button", { name: "Rebase fork on upstream" }));

    await user.click(await screen.findByRole("button", { name: "Force push to origin…" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === "plugin:dialog|message")).toHaveLength(1),
    );
    await user.click(screen.getByRole("button", { name: "Push to origin" }));
    expect(await within(screen.getByRole("table")).findByText("push done")).toBeInTheDocument();
    expect(calls.filter((c) => c.cmd === "plugin:dialog|message")).toHaveLength(1);
    expect(actionCalls(calls).filter(([, action]) => (action as Action).type === "push")).toEqual([
      ["/src/beta", { type: "push", plan: { ...plan, force: false, expectedRemoteSha: null } }],
    ]);
  });

  it("fetches selected repositories and refreshes their status", async () => {
    const user = userEvent.setup();
    const calls = mockBackend({ repos: ["/src/alpha"] });
    await renderRepositories();
    await user.click(await screen.findByLabelText("Select all"));
    const summariesBefore = calls.filter((c) => c.cmd === "repo_summary").length;
    await user.click(screen.getByRole("button", { name: "Fetch" }));

    expect(await within(screen.getByRole("table")).findByText("fetch done")).toBeInTheDocument();
    expect(actionCalls(calls)).toEqual([["/src/alpha", { type: "fetch" }]]);
    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === "repo_summary").length).toBe(summariesBefore + 1),
    );
  });

  it("offers to rename local branches after a remote renamed its default branch", async () => {
    const user = userEvent.setup();
    const rename: Action = { type: "renameBranch", remote: "origin", from: "master", to: "main" };
    const calls = mockBackend({
      repos: ["/src/alpha", "/src/beta"],
      renames: { "/src/alpha": rename },
    });
    await renderRepositories();
    await user.click(await screen.findByLabelText("Select all"));
    await user.click(screen.getByRole("button", { name: "Check default branch" }));

    expect(
      await screen.findByText(/1 repository's default branch was renamed on the remote/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rename master → main" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rename local branches" }));

    expect(
      await within(screen.getByRole("table")).findByText("renameBranch done"),
    ).toBeInTheDocument();
    expect(actionCalls(calls).at(-1)).toEqual(["/src/alpha", rename]);
    expect(screen.queryByText(/default branch was renamed/)).not.toBeInTheDocument();
  });

  it("opens the unpushed work view for the selected repositories", async () => {
    const user = userEvent.setup();
    const calls = mockBackend({ repos: ["/src/alpha", "/src/beta"] });
    await renderRepositories();
    await user.click(await screen.findByLabelText("Select beta"));
    await user.click(screen.getByRole("button", { name: "Unpushed work & stashes…" }));

    expect(await screen.findByText("0 of 1 repository have unpushed work")).toBeInTheDocument();
    expect(calls.filter((c) => c.cmd === "analyze_unpushed")).toEqual([
      { cmd: "analyze_unpushed", args: { path: "/src/beta", fetch: true } },
    ]);
    await user.click(screen.getByRole("button", { name: "← Back" }));
    expect(screen.getByRole("region", { name: "Overview" })).toBeInTheDocument();
  });

  it("opens a directory in place of the current one and can switch back via recent", async () => {
    const user = userEvent.setup();
    const calls = mockBackend({
      repos: ["/src/alpha"],
      roots: ["/src"],
      discovered: ["/picked/one"],
    });
    await renderRepositories();
    await screen.findByText("alpha");
    await user.click(screen.getByRole("button", { name: "Open directory…" }));

    expect(await screen.findByText("Opened picked: 1 repository")).toBeInTheDocument();
    expect(screen.getByText("one")).toBeInTheDocument();
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
    expect(calls.find((c) => c.cmd === "open_directories")?.args).toEqual({ paths: ["/picked"] });

    await user.selectOptions(screen.getByLabelText("Open recent"), "src");
    expect(calls.find((c) => c.cmd === "open_recent")?.args).toEqual({ roots: ["/src"] });

    await user.selectOptions(screen.getByLabelText("Open recent"), "Clear recent");
    await waitFor(() => expect(calls.some((c) => c.cmd === "clear_recent")).toBe(true));
  });

  it("shows open directories with repo counts and removes one", async () => {
    const user = userEvent.setup();
    const calls = mockBackend({
      repos: ["/a/one", "/a/two", "/b/three"],
      roots: ["/a", "/b"],
    });
    await renderRepositories();
    const directories = await screen.findByRole("group", { name: "Directories" });
    expect(directories).toHaveTextContent("a2 repos×b1 repo×");

    await user.click(screen.getByRole("button", { name: "Remove directory /a" }));
    await waitFor(() => expect(screen.queryByText("one")).not.toBeInTheDocument());
    expect(screen.getByText("three")).toBeInTheDocument();
    expect(calls.find((c) => c.cmd === "remove_directory")?.args).toEqual({ path: "/a" });
  });

  it("filters by directory when more than one is open", async () => {
    const user = userEvent.setup();
    mockBackend({ repos: ["/a/one", "/b/two"], roots: ["/a", "/b"] });
    await renderRepositories();
    await user.selectOptions(await screen.findByLabelText("Filter by directory"), "/b");
    expect(screen.queryByText("one")).not.toBeInTheDocument();
    expect(screen.getByText("two")).toBeInTheDocument();
  });

  it("keeps removed subdirectory repositories out until restored", async () => {
    const user = userEvent.setup();
    mockBackend({ repos: ["/src/alpha", "/src/beta"], roots: ["/src"] });
    await renderRepositories();
    await user.click(await screen.findByLabelText("Select alpha"));
    await user.click(screen.getByRole("button", { name: "Remove from list" }));
    expect(await screen.findByText(/1 removed repository/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Rescan" }));
    await screen.findByText("No new repositories found");
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByText("alpha")).toBeInTheDocument();
    expect(screen.queryByText(/removed repositor/)).not.toBeInTheDocument();
  });

  it("summarizes a bulk run and filters the table to one outcome", async () => {
    const user = userEvent.setup();
    const calls = mockBackend({
      repos: ["/src/alpha", "/src/beta", "/src/gamma"],
      outcomesByPath: {
        "/src/beta": { status: "skipped", reason: "uncommittedChanges", message: "dirty" },
        "/src/gamma": { status: "failed", message: "boom" },
      },
    });
    await renderRepositories();
    await user.click(await screen.findByRole("button", { name: "Select all 3" }));
    await user.click(screen.getByRole("button", { name: "Pull" }));

    const summary = await screen.findByRole("status", { name: "Last run" });
    await waitFor(() => expect(summary).toHaveTextContent("1 failed"));
    expect(summary).toHaveTextContent("Pull");
    expect(summary).toHaveTextContent("1 succeeded");
    expect(summary).toHaveTextContent("1 skipped");
    expect(summary).toHaveTextContent("(1 uncommitted changes)");

    await user.click(within(summary).getByRole("button", { name: "1 failed" }));
    expect(screen.getByText("gamma")).toBeInTheDocument();
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
    expect(screen.queryByText("beta")).not.toBeInTheDocument();

    expect(screen.getByRole("region", { name: "Selection actions" })).toHaveTextContent(
      "(2 more hidden by filters)",
    );
    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await waitFor(() =>
      expect(actionCalls(calls).at(-1)).toEqual(["/src/gamma", { type: "fetch" }]),
    );
    expect(await screen.findByText("alpha")).toBeInTheDocument();
  });

  it("shows the outcome message in the summary for a single-repository run", async () => {
    const user = userEvent.setup();
    mockBackend({ repos: ["/src/alpha"] });
    await renderRepositories();
    await user.click(await screen.findByRole("button", { name: "Select all 1" }));
    await user.click(screen.getByRole("button", { name: "Pull" }));
    const summary = await screen.findByRole("status", { name: "Last run" });
    await waitFor(() => expect(summary).toHaveTextContent("1 succeeded"));
    expect(summary).toHaveTextContent("pull done");
  });

  it("cancels a running bulk action", async () => {
    const user = userEvent.setup();
    const calls = mockBackend({ repos: ["/src/alpha", "/src/beta"], slow: true });
    await renderRepositories();
    await user.click(await screen.findByRole("button", { name: "Select all 2" }));
    await user.click(screen.getByRole("button", { name: "Fetch" }));
    const summary = await screen.findByRole("status", { name: "Last run" });
    await user.click(within(summary).getByRole("button", { name: "Cancel" }));

    expect(within(summary).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    const runId = calls.find((c) => c.cmd === "run_action")?.args.runId;
    expect(calls.find((c) => c.cmd === "cancel_run")?.args).toEqual({ runId });
    await waitFor(() => expect(summary).toHaveTextContent("2 skipped"));
    expect(summary).toHaveTextContent("(2 cancelled)");
  });

  it("sorts the table by a column and toggles direction", async () => {
    const user = userEvent.setup();
    mockBackend({
      repos: ["/src/alpha", "/src/beta", "/src/gamma"],
      summaries: { "/src/beta": { behind: 9 }, "/src/gamma": { behind: 2 } },
    });
    await renderRepositories();
    await screen.findByText("alpha");
    const names = () =>
      screen.getAllByRole("button", { name: /^Open details for / }).map((b) => b.textContent);
    expect(names()).toEqual(["alpha", "beta", "gamma"]);

    await user.click(screen.getByRole("button", { name: "Sync" }));
    await waitFor(() => expect(names()).toEqual(["beta", "gamma", "alpha"]));
    expect(screen.getByRole("columnheader", { name: /Sync/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    await user.click(screen.getByRole("button", { name: /Sync/ }));
    expect(names()).toEqual(["alpha", "gamma", "beta"]);
  });

  it("selects a range with shift-click", async () => {
    const user = userEvent.setup();
    mockBackend({ repos: ["/src/a1", "/src/a2", "/src/a3", "/src/a4"] });
    await renderRepositories();
    await user.click(await screen.findByLabelText("Select a1"));
    await user.keyboard("{Shift>}");
    await user.click(screen.getByLabelText("Select a3"));
    await user.keyboard("{/Shift}");
    expect(screen.getByLabelText("Select a2")).toBeChecked();
    expect(screen.getByLabelText("Select a3")).toBeChecked();
    expect(screen.getByLabelText("Select a4")).not.toBeChecked();
    expect(screen.getByRole("region", { name: "Selection actions" })).toHaveTextContent(
      "3 selected",
    );
  });

  it("shows how fresh the fetched data is and fetches everything visible", async () => {
    const user = userEvent.setup();
    const now = Math.floor(Date.now() / 1000);
    const calls = mockBackend({
      repos: ["/src/alpha", "/src/beta"],
      summaries: {
        "/src/alpha": { lastFetchUnix: now - 3 * 86_400 },
        "/src/beta": { lastFetchUnix: now - 600 },
      },
    });
    await renderRepositories();
    expect(await screen.findByText("Oldest fetch 3d ago")).toHaveClass("stale");
    expect(screen.getByText("fetched 3d ago")).toHaveClass("stale");
    await user.click(screen.getByRole("button", { name: "Fetch all 2" }));
    await waitFor(() =>
      expect(actionCalls(calls)).toEqual([
        ["/src/alpha", { type: "fetch" }],
        ["/src/beta", { type: "fetch" }],
      ]),
    );
  });

  it("warns when git cannot be found and links to settings", async () => {
    const user = userEvent.setup();
    mockBackend({ repos: [], gitError: "git was not found; set its location in Settings" });
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("git was not found");
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it("adds repositories discovered in a picked directory", async () => {
    const user = userEvent.setup();
    mockBackend({ repos: [], discovered: ["/picked/one", "/picked/two"] });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Add directory…" }));

    expect(await screen.findByText("Added picked: 2 repositories")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Repositories" }));
    expect(screen.getByText("one")).toBeInTheDocument();
    expect(screen.getByText("two")).toBeInTheDocument();
  });

  it("reports when a picked directory has no new repositories", async () => {
    const user = userEvent.setup();
    mockBackend({ repos: [] });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Add directory…" }));
    expect(await screen.findByText("No new repositories found in picked")).toBeInTheDocument();
  });

  it("removes selected repositories from the list", async () => {
    const user = userEvent.setup();
    mockBackend({ repos: ["/src/alpha", "/src/beta"] });
    await renderRepositories();
    await user.click(await screen.findByLabelText("Select alpha"));
    await user.click(screen.getByRole("button", { name: "Remove from list" }));

    await waitFor(() => expect(screen.queryByText("alpha")).not.toBeInTheDocument());
    expect(screen.getByText("beta")).toBeInTheDocument();
  });
});
