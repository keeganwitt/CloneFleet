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
  hasRemotes: true,
};

const noHealth: RepoHealth = {
  mergedBranches: 0,
  remoteDeletedBranches: 0,
  staleBranches: 0,
  removableWorktrees: 0,
  staleWorktrees: 0,
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

function mockFleet({ summaries: repoSummaries = summaries, healths: repoHealth = healths } = {}) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    const path = args.path as string;
    switch (cmd) {
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
            extraIdentities: [],
          },
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
        return { ...clean, ...repoSummaries[path] };
      case "repo_health":
        return { ...noHealth, ...repoHealth[path] };
      case "scan_artifacts":
        return {
          artifacts:
            path === "/src/web"
              ? [
                  {
                    path: "/src/web/node_modules",
                    worktree: "/src/web",
                    kind: "Node.js packages",
                    tier: "reinstall",
                    bytes: 3_000_000,
                    sharedBytes: 0,
                    files: 40,
                    modifiedUnix: null,
                  },
                ]
              : [],
          warnings: [],
        };
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
    const user = userEvent.setup();
    mockFleet();
    render(<App />);
    const region = await overview();

    expect(region).toHaveTextContent("5 repositories across 1 directory");
    const count = within(region).getByRole("button", {
      name: "View all 4 repositories in Needs attention",
    });
    expect(count).toHaveTextContent("(4 repositories)");
    const attention = within(region).getByRole("list", { name: "Needs attention" });
    expect(
      within(attention).getByLabelText("1 repository stopped mid-operation"),
    ).toHaveTextContent("Git operation in progress");
    expect(
      within(attention).getByLabelText("1 branch with unpushed commits in 1 repository"),
    ).toHaveTextContent("Unpushed commits");
    const updates = within(region).getByRole("list", { name: "Updates available" });
    expect(within(updates).getByLabelText("2 repositories behind upstream")).toHaveTextContent(
      "Behind upstream",
    );
    const housekeeping = within(region).getByRole("list", { name: "Cleanup" });
    expect(
      within(housekeeping).getByLabelText("3 branches merged in 2 repositories"),
    ).toBeInTheDocument();
    expect(within(region).getByText(/clean and in sync at last fetch/)).toBeInTheDocument();

    await user.click(count);
    expect(screen.getByRole("table")).toBeVisible();
    for (const name of ["api", "web", "infra", "docs"])
      expect(screen.getByText(name)).toBeVisible();
    expect(screen.queryByText("lib")).not.toBeInTheDocument();
  });

  it("shows the behind count only on the finding when it is the sole attention finding", async () => {
    mockFleet({
      summaries: { "/src/api": { behind: 3 }, "/src/web": { behind: 1 } },
      healths: {},
    });
    render(<App />);
    const region = await overview();

    expect(within(region).getByText("2 repositories behind upstream")).toBeVisible();
    expect(
      within(region).queryByRole("button", { name: "View all 2 repositories in Needs attention" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    { title: "Work in progress", names: ["web", "infra"] },
    { title: "Cleanup", names: ["web", "lib", "docs"] },
  ])("opens all unique repositories with $title findings", async ({ title, names }) => {
    const user = userEvent.setup();
    mockFleet({
      summaries: { ...summaries, "/src/web": { ...summaries["/src/web"], trackedChanges: 1 } },
      healths: { ...healths, "/src/web": { mergedBranches: 1 } },
    });
    render(<App />);
    const region = await overview();
    await user.click(
      within(region).getByRole("button", {
        name: `View all ${names.length} repositories in ${title}`,
      }),
    );

    const table = within(screen.getByRole("table"));
    expect(screen.getByRole("button", { name: "Clear repository filter" })).toBeVisible();
    for (const path of repos) {
      const name = path.split("/").at(-1)!;
      if (names.includes(name)) expect(table.getByText(name)).toBeVisible();
      else expect(table.queryByText(name)).not.toBeInTheDocument();
    }
  });

  it("pulls every repository on the behind card and rechecks them", async () => {
    const user = userEvent.setup();
    const calls = mockFleet();
    render(<App />);
    const region = await overview();
    const card = within(region).getByLabelText("2 repositories behind upstream");
    await user.click(within(card).getByRole("button", { name: "View behind repositories" }));
    await user.click(screen.getByLabelText("Select all matching repositories"));
    await user.click(screen.getByRole("button", { name: "Pull…" }));
    const review = screen.getByRole("dialog", { name: "Review pull" });
    expect(review).toHaveTextContent("/src/api");
    expect(review).toHaveTextContent("/src/web");
    expect(calls.filter((call) => call.cmd === "run_action")).toHaveLength(0);
    await user.click(within(review).getByRole("button", { name: "Pull 2 repositories" }));

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
    await user.click(within(card).getByRole("button", { name: "View behind repositories" }));

    expect(screen.getByText("2 repositories behind upstream")).toBeInTheDocument();
    expect(screen.getByText("api")).toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.queryByText("lib")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Repositories" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await user.click(screen.getByRole("button", { name: "Clear repository filter" }));
    expect(screen.getByText("lib")).toBeInTheDocument();
  });

  it("opens branch cleanup for the repositories on a housekeeping card", async () => {
    const user = userEvent.setup();
    const calls = mockFleet();
    render(<App />);
    const region = await overview();
    const card = within(region).getByLabelText("3 branches merged in 2 repositories");
    await user.click(within(card).getByRole("button", { name: "Review merged branches" }));

    expect(
      await screen.findByRole("region", { name: "Branches and worktrees" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === "analyze_branches").map((c) => c.args.path)).toEqual([
        "/src/lib",
        "/src/docs",
      ]),
    );
  });

  it("opens build cleanup from the reclaimable space card", async () => {
    const user = userEvent.setup();
    mockFleet();
    render(<App />);
    const region = await overview();
    const card = await within(region).findByLabelText(
      "3.0 MB of build and dependency directories in 1 repository",
    );
    await user.click(within(card).getByRole("button", { name: "Review disk space" }));

    expect(await screen.findByRole("region", { name: "Disk space" })).toBeInTheDocument();

    expect(
      screen.getByRole("checkbox", { name: "Select /src/web/node_modules" }),
    ).not.toBeChecked();
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
