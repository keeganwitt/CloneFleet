import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor, within } from "@testing-library/react";
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
  it("shows all directory types without selecting a target automatically", () => {
    mockBackend();
    renderView();
    expect(checkbox("/repo/target")).not.toBeChecked();
    expect(checkbox("/wt/feature/target")).not.toBeChecked();
    expect(checkbox("/repo/web/node_modules")).not.toBeChecked();
    expect(checkbox("/repo/.venv")).not.toBeChecked();
    expect(screen.getByText("Worktree · feature")).toBeInTheDocument();
    expect(screen.getByText("5.0 kB shared")).toBeInTheDocument();
  });

  it("shows exact paths and warnings, then moves approved directories to Trash by default", async () => {
    const user = userEvent.setup();
    const calls = mockBackend();
    const onRescan = renderView();
    await user.click(checkbox("/repo/web/node_modules"));
    await user.click(checkbox("/repo/.venv"));
    await user.click(screen.getByRole("button", { name: "Review 2 directories…" }));
    const dialog = screen.getByRole("dialog", { name: "Review disk cleanup" });
    expect(within(dialog).getByRole("radio", { name: "Move to Trash" })).toBeChecked();
    expect(dialog).toHaveTextContent("/repo/web/node_modules");
    expect(dialog).toHaveTextContent("/repo/.venv");
    expect(dialog).toHaveTextContent("Needs reinstalling");
    expect(dialog).toHaveTextContent("May not be reproducible");
    expect(called(calls, "delete_artifacts")).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Move 2 directories to Trash" }));
    await waitFor(() => expect(onRescan).toHaveBeenCalledWith(["/repo"]));
    expect(called(calls, "delete_artifacts")).toEqual([
      {
        path: "/repo",
        artifacts: ["/repo/web/node_modules", "/repo/.venv"],
        tiers: ["reinstall", "unreproducible"],
        removal: "trash",
      },
    ]);
  });

  it("requires selecting permanent deletion and excludes rows hidden by type and search", async () => {
    const user = userEvent.setup();
    const calls = mockBackend();
    renderView();
    await user.click(screen.getByLabelText("Select all matching directories"));
    await user.selectOptions(screen.getByLabelText("Directory type"), "buildOutput");
    await user.type(screen.getByLabelText("Search cleanup directories"), "/wt/");
    await user.click(screen.getByRole("button", { name: "Review 1 directory…" }));
    const dialog = screen.getByRole("dialog", { name: "Review disk cleanup" });
    expect(dialog).toHaveTextContent("/wt/feature/target");
    expect(dialog).not.toHaveTextContent("node_modules");
    await user.click(within(dialog).getByRole("radio", { name: "Delete permanently" }));
    await user.click(
      within(dialog).getByRole("button", { name: "Delete 1 directory permanently" }),
    );
    expect(called(calls, "delete_artifacts")).toEqual([
      {
        path: "/repo",
        artifacts: ["/wt/feature/target"],
        tiers: ["buildOutput"],
        removal: "delete",
      },
    ]);
  });

  it("allows returning to selection before applying", async () => {
    const user = userEvent.setup();
    const calls = mockBackend();
    renderView();
    await user.click(checkbox("/repo/target"));
    await user.click(screen.getByRole("button", { name: "Review 1 directory…" }));
    await user.click(screen.getByRole("button", { name: "Back to selection" }));
    expect(checkbox("/repo/target")).toBeChecked();
    expect(called(calls, "delete_artifacts")).toEqual([]);
  });
});
