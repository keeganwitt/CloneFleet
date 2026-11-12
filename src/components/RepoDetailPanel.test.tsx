import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { BranchDiff, BranchInfo, BranchSettings, RepoSummary } from "../types";
import { RepoDetailPanel, type DetailTab } from "./RepoDetailPanel";

const now = Math.floor(Date.now() / 1000);

const summary: RepoSummary = {
  branch: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  trackedChanges: 1,
  untracked: 1,
  conflicts: 0,
  operation: null,
  lastFetchUnix: now,
  defaultBranch: "main",
  mainBranches: ["main"],
  defaultOverridden: false,
  hasRemotes: true,
};

const branch = (name: string, overrides: Partial<BranchInfo> = {}): BranchInfo => ({
  name,
  sha: `${name}-sha`,
  upstream: null,
  upstreamGone: false,
  lastCommitUnix: now - 86_400,
  author: "Ann",
  subject: `Work on ${name}`,
  uniqueCommits: 1,
  merged: null,
  protection: null,
  worktree: null,
  ...overrides,
});

const diff: BranchDiff = {
  branch: "feature",
  base: "origin/main",
  commits: [{ sha: "abcdef1234567", author: "Ann", dateUnix: now - 3600, subject: "Add feature" }],
  commitsTruncated: false,
  files: [
    {
      path: "feature.txt",
      oldPath: null,
      additions: 1,
      deletions: 0,
      patch: "diff --git a/feature.txt b/feature.txt\n@@ -0,0 +1 @@\n+hello\n",
      truncated: false,
    },
  ],
};

function mockBackend(settings: BranchSettings = { primary: null, additional: [] }) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    switch (cmd) {
      case "list_changes":
        return [
          { path: "app.ts", originalPath: null, kind: "modified", staged: false, unstaged: true },
          {
            path: "notes.md",
            originalPath: null,
            kind: "untracked",
            staged: false,
            unstaged: true,
          },
        ];
      case "working_file_diff":
        return {
          path: args.file,
          oldPath: null,
          additions: 2,
          deletions: 1,
          patch: "diff --git a/app.ts b/app.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n",
          truncated: false,
        };
      case "analyze_branches":
        return {
          defaultBranch: "main",
          bases: ["origin/main"],
          branches: [branch("main", { protection: "default" }), branch("feature")],
          worktrees: [],
          warnings: [],
        };
      case "branch_diff":
        return diff;
      case "get_branch_settings":
        return settings;
      case "list_branch_names":
        return ["2.x", "dev", "feature", "main"];
      case "set_branch_settings":
        return null;
      case "list_remotes":
        return [{ name: "origin", fetchUrl: "git@gitlab-work:team/repo.git", pushUrl: null }];
      case "open_repo":
        if (args.target === "editor") throw "Choose an editor in Settings first";
        return null;
      case "open_web":
        return null;
      default:
        throw new Error(`unexpected ${cmd}`);
    }
  });
  return calls;
}

function Harness({ initialTab, initialBranch }: { initialTab: DetailTab; initialBranch?: string }) {
  const [tab, setTab] = useState(initialTab);
  const [branchName, setBranch] = useState(initialBranch);
  return (
    <RepoDetailPanel
      path="/src/repo"
      summary={summary}
      webHosts={[{ host: "gitlab-work", webUrl: "https://gitlab.example.com" }]}
      tab={tab}
      branch={branchName}
      onTabChange={setTab}
      onBranchChange={setBranch}
      onClose={() => {}}
      onSettingsSaved={onSaved}
    />
  );
}

const onSaved = vi.fn();

describe("RepoDetailPanel", () => {
  it("shows the diff for a selected changed file", async () => {
    const user = userEvent.setup();
    const calls = mockBackend();
    render(<Harness initialTab="changes" />);
    await user.click(await screen.findByRole("button", { name: "notes.md" }));

    expect(await screen.findByText("+more")).toBeInTheDocument();
    expect(screen.getByText("+2 −1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close diff for notes.md" }));
    expect(screen.queryByText("+more")).not.toBeInTheDocument();
    expect(screen.getByText("Select a file to see its changes.")).toBeInTheDocument();
    expect(calls.find((c) => c.cmd === "working_file_diff")?.args).toEqual({
      path: "/src/repo",
      file: "notes.md",
      untracked: true,
    });
  });

  it("lists branches and shows a selected branch's commits and changes", async () => {
    const user = userEvent.setup();
    const calls = mockBackend();
    render(<Harness initialTab="branches" />);
    await user.click(await screen.findByRole("button", { name: "feature" }));

    expect(await screen.findByText("1 commit not on origin/main")).toBeInTheDocument();
    expect(screen.getByText("Add feature")).toBeInTheDocument();
    expect(screen.getByText("abcdef12")).toBeInTheDocument();
    expect(screen.getByText("+hello")).toBeInTheDocument();
    expect(calls.find((c) => c.cmd === "branch_diff")?.args).toEqual({
      path: "/src/repo",
      branch: "feature",
      base: null,
    });
    expect(calls.find((c) => c.cmd === "analyze_branches")?.args).toEqual({
      path: "/src/repo",
      fetch: false,
    });
  });

  it("opens directly to a requested branch", async () => {
    mockBackend();
    render(<Harness initialTab="branches" initialBranch="feature" />);
    expect(await screen.findByText("Add feature")).toBeInTheDocument();
  });

  it("saves main branch settings", async () => {
    const user = userEvent.setup();
    const calls = mockBackend({ primary: null, additional: ["2.x"] });
    render(<Harness initialTab="mainBranches" />);
    await user.selectOptions(await screen.findByLabelText("Primary branch"), "dev");
    expect(screen.getByRole("option", { name: "Remote default (main)" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "2.x" })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "dev" })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Filter branches"), "fea");
    await user.click(screen.getByRole("checkbox", { name: "feature" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.find((c) => c.cmd === "set_branch_settings")?.args).toEqual({
      path: "/src/repo",
      settings: { primary: "dev", additional: ["2.x", "feature"] },
    });
    expect(within(screen.getByRole("tabpanel")).getByRole("status")).toHaveTextContent("Saved");
  });

  it("resets to the remote default", async () => {
    const user = userEvent.setup();
    const calls = mockBackend({ primary: "dev", additional: ["2.x"] });
    render(<Harness initialTab="mainBranches" />);
    await user.click(await screen.findByRole("button", { name: "Reset to remote default" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "set_branch_settings")?.args).toEqual({
        path: "/src/repo",
        settings: { primary: null, additional: [] },
      }),
    );
  });

  it("opens the repository in other apps and on the web", async () => {
    const user = userEvent.setup();
    const calls = mockBackend();
    render(<Harness initialTab="changes" />);
    const open = screen.getByRole("group", { name: "Open in" });
    await user.click(within(open).getByRole("button", { name: "Terminal" }));
    await waitFor(() => expect(within(open).getByRole("button", { name: "Web" })).toBeEnabled());
    await user.click(within(open).getByRole("button", { name: "Web" }));
    await user.click(within(open).getByRole("button", { name: "Editor" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose an editor in Settings first",
    );
    expect(calls.filter((c) => c.cmd === "open_repo").map((c) => c.args)).toEqual([
      { path: "/src/repo", target: "terminal" },
      { path: "/src/repo", target: "editor" },
    ]);
    expect(calls.find((c) => c.cmd === "open_web")?.args).toEqual({
      url: "https://gitlab.example.com/team/repo",
    });
  });

  it("switches tabs", async () => {
    const user = userEvent.setup();
    mockBackend();
    render(<Harness initialTab="changes" />);
    await user.click(screen.getByRole("tab", { name: "Main branches" }));
    expect(await screen.findByLabelText("Primary branch")).toBeInTheDocument();
  });
});
