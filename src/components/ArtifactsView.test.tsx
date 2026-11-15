import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactScan } from "../useArtifactScan";
import type { Artifact, CleanupResult } from "../types";
import { ArtifactsView } from "./ArtifactsView";

const now = Math.floor(Date.now() / 1000);
const DAY = 86_400;

const artifact = (path: string, overrides: Partial<Artifact> = {}): Artifact => ({
  path,
  worktree: "/repo",
  kind: "Maven",
  tier: "buildOutput",
  bytes: 2_000_000,
  sharedBytes: 0,
  files: 10,
  modifiedUnix: now - 200 * DAY,
  ...overrides,
});

const scans: Record<string, ArtifactScan> = {
  "/repo": {
    status: "loaded",
    report: {
      artifacts: [
        artifact("/repo/target"),
        artifact("/repo/web/.next", { kind: "JavaScript build cache", modifiedUnix: now - DAY }),
        artifact("/repo/web/node_modules", {
          kind: "Node.js packages",
          tier: "reinstall",
          sharedBytes: 5_000,
        }),
        artifact("/repo/.venv", { kind: "Python virtualenv", tier: "unreproducible" }),
        artifact("/wt/feature/target", { worktree: "/wt/feature" }),
      ],
      warnings: [],
    },
  },
  "/empty": { status: "loaded", report: { artifacts: [], warnings: [] } },
};

function mockBackend({ confirmed = true }: { confirmed?: boolean } = {}) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    switch (cmd) {
      case "plugin:dialog|message":
        return confirmed
          ? (args.buttons as { OkCancelCustom: [string, string] }).OkCancelCustom[0]
          : "Cancel";
      case "delete_artifacts":
        return {
          items: (args.artifacts as string[]).map((item) => ({
            item,
            status: "succeeded",
            message: `Deleted ${item}`,
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
  const onRescan = vi.fn(() => Promise.resolve());
  render(<ArtifactsView paths={["/repo", "/empty"]} scans={scans} onRescan={onRescan} />);
  return onRescan;
}

const checkbox = (path: string) => screen.getByRole("checkbox", { name: `Select ${path}` });

describe("ArtifactsView", () => {
  it("shows only build output by default, preselecting directories unchanged for a while", () => {
    mockBackend();
    renderView();

    expect(checkbox("/repo/target")).toBeChecked();
    expect(checkbox("/wt/feature/target")).toBeChecked();
    expect(checkbox("/repo/web/.next")).not.toBeChecked();
    expect(screen.queryByText("web/node_modules")).not.toBeInTheDocument();
    expect(screen.queryByText(".venv")).not.toBeInTheDocument();
    expect(screen.getByText("feature: target")).toBeInTheDocument();
    expect(screen.getByText(/1 repository has nothing to clean up/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete 2 directories (4.0 MB)" })).toBeEnabled();
  });

  it("explains each category next to its toggle", () => {
    mockBackend();
    renderView();

    expect(
      screen.getByRole("checkbox", { name: "Needs reinstalling" }),
    ).toHaveAccessibleDescription(/Run the install step again before building/);
    expect(
      screen.getByRole("checkbox", { name: "May not be reproducible" }),
    ).toHaveAccessibleDescription(/Python virtualenvs/);
  });

  it("lists the other tiers unselected when their toggles are turned on", async () => {
    mockBackend();
    renderView();

    await userEvent.click(screen.getByRole("checkbox", { name: "Needs reinstalling" }));
    expect(checkbox("/repo/web/node_modules")).not.toBeChecked();
    expect(screen.getByText(/5\.0 kB shared/)).toBeInTheDocument();
    expect(screen.queryByText(".venv")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("checkbox", { name: "May not be reproducible" }));
    expect(checkbox("/repo/.venv")).not.toBeChecked();
  });

  it("confirms with the reinstall warning and deletes with the shown tiers", async () => {
    const calls = mockBackend();
    const onRescan = renderView();

    await userEvent.click(screen.getByRole("checkbox", { name: "Needs reinstalling" }));
    await userEvent.click(checkbox("/repo/web/node_modules"));
    await userEvent.click(checkbox("/wt/feature/target"));
    await userEvent.click(screen.getByRole("button", { name: /^Delete 2 directories/ }));

    await waitFor(() => expect(onRescan).toHaveBeenCalledWith(["/repo"]));
    const [dialog] = called(calls, "plugin:dialog|message");
    expect(dialog.message).toContain("Permanently delete 2 directories (4.0 MB) in 1 repository");
    expect(dialog.message).toContain("1 of them will need reinstalling");
    expect(dialog.message).not.toContain("may not be reproducible");
    expect(called(calls, "delete_artifacts")).toEqual([
      {
        path: "/repo",
        artifacts: ["/repo/target", "/repo/web/node_modules"],
        tiers: ["buildOutput", "reinstall"],
        removal: "delete",
      },
    ]);
    expect(screen.getByText("Deleted /repo/target")).toBeInTheDocument();
  });

  it("moves directories to the Trash when asked", async () => {
    const calls = mockBackend();
    const onRescan = renderView();

    await userEvent.click(
      screen.getByRole("checkbox", { name: "Move to Trash instead of deleting" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Move 2 directories to the Trash (4.0 MB)" }),
    );

    await waitFor(() => expect(onRescan).toHaveBeenCalled());
    const [dialog] = called(calls, "plugin:dialog|message");
    expect(dialog.message).toContain("Move 2 directories (4.0 MB) in 1 repository to the Trash?");
    expect(dialog.message).toContain("freed when the Trash is emptied");
    expect(called(calls, "delete_artifacts")[0]).toMatchObject({ removal: "trash" });
  });

  it("words the warnings for a single directory", async () => {
    const calls = mockBackend();
    renderView();

    await userEvent.click(screen.getByRole("checkbox", { name: "Needs reinstalling" }));
    await userEvent.click(checkbox("/repo/target"));
    await userEvent.click(checkbox("/wt/feature/target"));
    await userEvent.click(checkbox("/repo/web/node_modules"));
    await userEvent.click(screen.getByRole("button", { name: /^Delete 1 directory/ }));

    await waitFor(() => expect(called(calls, "plugin:dialog|message")).toHaveLength(1));
    expect(called(calls, "plugin:dialog|message")[0].message).toContain(
      "It will need reinstalling",
    );
  });

  it("deletes nothing when the confirmation is cancelled", async () => {
    const calls = mockBackend({ confirmed: false });
    const onRescan = renderView();

    await userEvent.click(screen.getByRole("button", { name: /^Delete 2 directories/ }));
    await waitFor(() => expect(called(calls, "plugin:dialog|message")).toHaveLength(1));
    expect(called(calls, "delete_artifacts")).toEqual([]);
    expect(onRescan).not.toHaveBeenCalled();
  });

  it("selects every shown directory in a repository from its header", async () => {
    mockBackend();
    renderView();

    await userEvent.click(
      screen.getByRole("checkbox", { name: "Select all shown directories in repo" }),
    );
    expect(checkbox("/repo/web/.next")).toBeChecked();
    expect(screen.getByRole("button", { name: "Delete 3 directories (6.0 MB)" })).toBeEnabled();
  });
});
