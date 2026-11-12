import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "./App";
import type { Action, RepoHealth, RepoSummary } from "./types";

const clean: RepoSummary = {
  branch: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  trackedChanges: 0,
  untracked: 0,
  conflicts: 0,
  operation: null,
  lastFetchUnix: Math.floor(Date.now() / 1000) - 60,
  defaultBranch: "main",
  mainBranches: ["main"],
  defaultOverridden: false,
};

const noHealth: RepoHealth = {
  mergedBranches: 0,
  remoteDeletedBranches: 0,
  staleBranches: 0,
  removableWorktrees: 0,
  unpushedBranches: 0,
  stashes: 0,
  warnings: [],
};

const repos = ["/src/api", "/src/web", "/src/lib", "/src/infra", "/src/docs"];
const summaries: Record<string, Partial<RepoSummary>> = {
  "/src/api": { behind: 3 },
  "/src/web": { behind: 1, branch: "feature/auth" },
  "/src/infra": { trackedChanges: 2, operation: "rebase" },
};
const healths: Record<string, Partial<RepoHealth>> = {
  "/src/lib": { mergedBranches: 2 },
  "/src/docs": { mergedBranches: 1, unpushedBranches: 1 },
};

function mockFleet() {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    const path = args.path as string;
    switch (cmd) {
      case "get_settings":
        return {
          settings: { gitPath: null, theme: "system", reopenLast: true, rememberRecent: true },
          detectedGit: "/usr/bin/git",
          activeGit: { path: "/usr/bin/git", version: "git version 2.56.0", error: null },
        };
      case "plugin:window|set_theme":
        return null;
      case "load_workspace":
        return {
          roots: [{ path: "/src", repoCount: repos.length, missing: false }],
          repos,
          excludedCount: 0,
          recent: [],
        };
      case "repo_summary":
        return { ...clean, ...summaries[path] };
      case "repo_health":
        return { ...noHealth, ...healths[path] };
      case "run_action":
        return {
          outcome: { status: "succeeded", message: `${(args.action as Action).type} done` },
          followUp: null,
          commands: [],
        };
      case "analyze_branches":
        return { defaultBranch: "main", bases: [], branches: [], worktrees: [], warnings: [] };
      default:
        throw new Error(`unexpected ${cmd}`);
    }
  });
  return calls;
}

async function overview() {
  const region = await screen.findByRole("region", { name: "Overview" });
  await waitFor(() =>
    expect(within(region).getByLabelText("Scan status")).toHaveTextContent(/Checked/),
  );
  return region;
}

describe("Dashboard", () => {
  it("lands on the overview with problem cards grouped by section", async () => {
    mockFleet();
    render(<App />);
    const region = await overview();

    expect(region).toHaveTextContent("5 repositories · 4 need attention");
    const attention = within(region).getByRole("list", { name: "Needs attention" });
    expect(
      within(attention).getByLabelText("1 repository stopped mid-operation"),
    ).toHaveTextContent("infra");
    expect(
      within(attention).getByLabelText("1 branch with unpushed commits in 1 repository"),
    ).toHaveTextContent("docs");
    const updates = within(region).getByRole("list", { name: "Updates available" });
    expect(within(updates).getByLabelText("2 repositories behind upstream")).toHaveTextContent(
      "api, web",
    );
    const housekeeping = within(region).getByRole("list", { name: "Housekeeping" });
    expect(
      within(housekeeping).getByLabelText("3 branches merged in 2 repositories"),
    ).toBeInTheDocument();
    expect(region).toHaveTextContent("✓ 1 repository is up to date and clean");
  });

  it("pulls every repository on the behind card and rechecks them", async () => {
    const user = userEvent.setup();
    const calls = mockFleet();
    render(<App />);
    const region = await overview();
    const card = within(region).getByLabelText("2 repositories behind upstream");
    await user.click(within(card).getByRole("button", { name: "Pull all" }));

    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === "run_action").map((c) => c.args)).toEqual([
        { path: "/src/api", action: { type: "pull" }, runId: expect.any(Number) },
        { path: "/src/web", action: { type: "pull" }, runId: expect.any(Number) },
      ]),
    );
    expect(await screen.findByRole("status", { name: "Last run" })).toHaveTextContent(
      "2 succeeded",
    );
    await waitFor(() =>
      expect(
        calls.filter((c) => c.cmd === "repo_health" && c.args.path === "/src/api"),
      ).toHaveLength(2),
    );
  });

  it("shows a card's repositories in the list and can clear the filter", async () => {
    const user = userEvent.setup();
    mockFleet();
    render(<App />);
    const region = await overview();
    const card = within(region).getByLabelText("2 repositories behind upstream");
    await user.click(within(card).getByRole("button", { name: "Show" }));

    expect(screen.getByText("Showing: 2 repositories behind upstream")).toBeInTheDocument();
    expect(screen.getByText("api")).toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.queryByText("lib")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Repositories" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await user.click(screen.getByRole("button", { name: "Show all repositories" }));
    expect(screen.getByText("lib")).toBeInTheDocument();
  });

  it("opens branch cleanup for the repositories on a housekeeping card", async () => {
    const user = userEvent.setup();
    const calls = mockFleet();
    render(<App />);
    const region = await overview();
    const card = within(region).getByLabelText("3 branches merged in 2 repositories");
    await user.click(within(card).getByRole("button", { name: "Clean up" }));

    expect(await screen.findByText("Branch & worktree cleanup")).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === "analyze_branches").map((c) => c.args.path)).toEqual([
        "/src/lib",
        "/src/docs",
      ]),
    );
  });

  it("navigates between sections from the sidebar", async () => {
    const user = userEvent.setup();
    mockFleet();
    render(<App />);
    await overview();
    await user.click(screen.getByRole("button", { name: "Repositories" }));
    expect(screen.getByRole("table")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Overview" }));
    expect(screen.getByRole("region", { name: "Overview" })).toBeInTheDocument();
  });
});
