import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "./App";
import type { Action, ActionResult, Outcome, PushPlan, RepoSummary } from "./types";

const summary: RepoSummary = {
  branch: "feature",
  upstream: "origin/feature",
  ahead: 1,
  behind: 0,
  trackedChanges: 2,
  untracked: 0,
  conflicts: 0,
  operation: null,
  defaultBranch: "main",
};

interface Backend {
  repos: string[];
  summaries?: Record<string, Partial<RepoSummary>>;
  outcomes?: Partial<Record<Action["type"], Outcome>>;
  discovered?: string[];
  pushPlans?: Record<string, PushPlan>;
  renames?: Record<string, Action>;
  confirmed?: boolean;
}

function followUpFor(backend: Backend, action: Action, path: string): Action | null {
  if (action.type === "rebaseFork") {
    const plan = backend.pushPlans?.[path];
    return plan ? { type: "push", plan } : null;
  }
  if (action.type === "syncDefaultBranch") return backend.renames?.[path] ?? null;
  return null;
}

function mockBackend(backend: Backend) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    switch (cmd) {
      case "list_repos":
        return backend.repos;
      case "repo_summary":
        return { ...summary, ...backend.summaries?.[args.path as string] };
      case "run_action": {
        const action = args.action as Action;
        const outcome = backend.outcomes?.[action.type] ?? {
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
      case "plugin:dialog|message":
        return backend.confirmed === false ? "Cancel" : "Push";
      case "add_directory":
        backend.repos = [...backend.repos, ...(backend.discovered ?? [])].sort();
        return backend.repos;
      case "remove_repos": {
        const removed = args.paths as string[];
        backend.repos = backend.repos.filter((p) => !removed.includes(p));
        return backend.repos;
      }
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  });
  return calls;
}

function actionCalls(calls: ReturnType<typeof mockBackend>) {
  return calls.filter((c) => c.cmd === "run_action").map((c) => [c.args.path, c.args.action]);
}

describe("App", () => {
  it("shows an empty state when no repositories are configured", async () => {
    mockBackend({ repos: [] });
    render(<App />);
    expect(await screen.findByText(/No repositories yet/)).toBeInTheDocument();
  });

  it("lists repositories with their status", async () => {
    mockBackend({ repos: ["/src/alpha"] });
    render(<App />);
    const row = (await screen.findByText("alpha")).closest("tr")!;
    await waitFor(() => expect(within(row).getByText("feature")).toBeInTheDocument());
    expect(within(row).getByText("default: main")).toBeInTheDocument();
    expect(within(row).getByText("2 modified")).toBeInTheDocument();
    expect(within(row).getByText("↑1")).toBeInTheDocument();
  });

  it("expands a repository to show its changed files", async () => {
    const user = userEvent.setup();
    const calls = mockBackend({ repos: ["/src/alpha"] });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Show changes in alpha" }));

    expect(await screen.findByText("src/app.ts")).toBeInTheDocument();
    expect(calls.filter((c) => c.cmd === "list_changes")).toEqual([
      { cmd: "list_changes", args: { path: "/src/alpha" } },
    ]);
    await user.click(screen.getByRole("button", { name: "Hide changes in alpha" }));
    expect(screen.queryByText("src/app.ts")).not.toBeInTheDocument();
  });

  it("does not offer a changes list for clean repositories", async () => {
    mockBackend({ repos: ["/src/alpha"], summaries: { "/src/alpha": { trackedChanges: 0 } } });
    render(<App />);
    expect(await screen.findByRole("cell", { name: "Clean" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /changes in alpha/ })).not.toBeInTheDocument();
  });

  it("runs an action on every selected repository", async () => {
    const user = userEvent.setup();
    const calls = mockBackend({ repos: ["/src/alpha", "/src/beta", "/src/gamma"] });
    render(<App />);
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
    render(<App />);
    await user.click(await screen.findByLabelText("Select all"));
    await user.click(screen.getByRole("button", { name: "Checkout default branch" }));
    await screen.findByText("2 files with uncommitted changes");

    await user.click(screen.getByRole("button", { name: "Commit…" }));
    const submit = screen.getByRole("button", { name: "Commit" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("Commit message for alpha"), "WIP");
    await user.click(submit);

    expect(await screen.findByText("commit done")).toBeInTheDocument();
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
    render(<App />);
    await waitFor(() => expect(screen.getAllByText("feature")).toHaveLength(3));

    await user.click(screen.getByLabelText("Select all"));
    await user.selectOptions(screen.getByLabelText("Filter by changes"), "clean");
    expect(screen.queryByText("gamma")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Filter by sync"), "behind");
    expect(screen.queryByText("beta")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 1 selected (2 hidden by filters)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Pull" }));
    await screen.findByText("pull done");
    expect(actionCalls(calls)).toEqual([["/src/alpha", { type: "pull" }]]);

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("gamma")).toBeInTheDocument();
  });

  it("searches by repository name", async () => {
    const user = userEvent.setup();
    mockBackend({ repos: ["/src/alpha", "/src/beta"] });
    render(<App />);
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
    render(<App />);
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
    render(<App />);
    await user.click(await screen.findByLabelText("Select all"));
    await user.click(screen.getByRole("button", { name: "Rebase fork on upstream" }));

    await user.click(await screen.findByRole("button", { name: "Force push to origin…" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === "plugin:dialog|message")).toHaveLength(1),
    );
    await user.click(screen.getByRole("button", { name: "Push to origin" }));
    expect(await screen.findByText("push done")).toBeInTheDocument();
    expect(calls.filter((c) => c.cmd === "plugin:dialog|message")).toHaveLength(1);
    expect(actionCalls(calls).filter(([, action]) => (action as Action).type === "push")).toEqual([
      ["/src/beta", { type: "push", plan: { ...plan, force: false, expectedRemoteSha: null } }],
    ]);
  });

  it("fetches selected repositories and refreshes their status", async () => {
    const user = userEvent.setup();
    const calls = mockBackend({ repos: ["/src/alpha"] });
    render(<App />);
    await user.click(await screen.findByLabelText("Select all"));
    const summariesBefore = calls.filter((c) => c.cmd === "repo_summary").length;
    await user.click(screen.getByRole("button", { name: "Fetch" }));

    expect(await screen.findByText("fetch done")).toBeInTheDocument();
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
    render(<App />);
    await user.click(await screen.findByLabelText("Select all"));
    await user.click(screen.getByRole("button", { name: "Check default branch" }));

    expect(
      await screen.findByText(/1 repository's default branch was renamed on the remote/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rename master → main" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rename local branches" }));

    expect(await screen.findByText("renameBranch done")).toBeInTheDocument();
    expect(actionCalls(calls).at(-1)).toEqual(["/src/alpha", rename]);
    expect(screen.queryByText(/default branch was renamed/)).not.toBeInTheDocument();
  });

  it("opens the unpushed work view for the selected repositories", async () => {
    const user = userEvent.setup();
    const calls = mockBackend({ repos: ["/src/alpha", "/src/beta"] });
    render(<App />);
    await user.click(await screen.findByLabelText("Select beta"));
    await user.click(screen.getByRole("button", { name: "Unpushed work & stashes…" }));

    expect(await screen.findByText("0 of 1 repository have unpushed work")).toBeInTheDocument();
    expect(calls.filter((c) => c.cmd === "analyze_unpushed")).toEqual([
      { cmd: "analyze_unpushed", args: { path: "/src/beta", fetch: true } },
    ]);
    await user.click(screen.getByRole("button", { name: "← Back" }));
    expect(screen.getByText("alpha")).toBeInTheDocument();
  });

  it("adds repositories discovered in a picked directory", async () => {
    const user = userEvent.setup();
    mockBackend({ repos: [], discovered: ["/picked/one", "/picked/two"] });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Add directory…" }));

    expect(await screen.findByText("Added 2 repositories")).toBeInTheDocument();
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
    render(<App />);
    await user.click(await screen.findByLabelText("Select alpha"));
    await user.click(screen.getByRole("button", { name: "Remove from list" }));

    await waitFor(() => expect(screen.queryByText("alpha")).not.toBeInTheDocument());
    expect(screen.getByText("beta")).toBeInTheDocument();
  });
});
