import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CleanupResult, CloneActivity, CloneRisks } from "../types";
import { InactiveView } from "./InactiveView";

const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);

const noRisks: CloneRisks = {
  hasRemotes: true,
  unpushedBranches: [],
  stashes: 0,
  dirtyWorktrees: [],
  linkedWorktreesOutside: [],
  nestedRepos: [],
  ignoredFiles: [],
  ignoredFileCount: 0,
};

const activity = (
  commitDaysAgo: number | null,
  activityDaysAgo: number | null,
  risks: Partial<CloneRisks> = {},
): CloneActivity => ({
  identities: ["me@example.com"],
  lastCommitByMeUnix: commitDaysAgo === null ? null : now - commitDaysAgo * DAY,
  lastLocalActivityUnix: activityDaysAgo === null ? null : now - activityDaysAgo * DAY,
  risks: { ...noRisks, ...risks },
  warnings: [],
});

const activities: Record<string, CloneActivity> = {
  "/p/abandoned": activity(400, 400),
  "/p/reference": activity(null, 3),
  "/p/risky": activity(200, 200, { stashes: 1, ignoredFiles: [".env"], ignoredFileCount: 1 }),
  "/p/active": activity(2, 2),
};

function mockBackend({ confirmed = true }: { confirmed?: boolean } = {}) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    switch (cmd) {
      case "clone_activity":
        return activities[args.path as string];
      case "plugin:dialog|message":
        return confirmed
          ? (args.buttons as { OkCancelCustom: [string, string] }).OkCancelCustom[0]
          : "Cancel";
      case "trash_clone":
        return {
          items: [
            {
              item: args.path as string,
              status: "succeeded",
              message: `Moved ${args.path as string} to the Trash`,
            },
          ],
          commands: [],
        } satisfies CleanupResult;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  });
  return calls;
}

const paths = Object.keys(activities);

function rowNames(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[1].firstChild?.textContent ?? "");
}

describe("InactiveView", () => {
  it("shows clones that pass both filters, with Never for missing dates", async () => {
    mockBackend();
    render(<InactiveView paths={paths} onRemoved={vi.fn()} />);

    await waitFor(() => expect(rowNames()).toEqual(["abandoned", "risky"]));
    expect(screen.getByText("2 of 4 repositories look inactive")).toBeInTheDocument();
    expect(screen.getByText("1 stash")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Last local activity older than"));
    expect(rowNames()).toEqual(["abandoned", "risky", "reference"]);
    expect(screen.getAllByText("Never")).toHaveLength(1);

    await user.tripleClick(screen.getByLabelText("Days since my last commit"));
    await user.keyboard("300");
    expect(screen.getByLabelText("Days since my last commit")).toHaveValue(300);
    expect(rowNames()).toEqual(["abandoned", "reference"]);
  });

  it("sorts by a column when its header is clicked", async () => {
    mockBackend();
    const user = userEvent.setup();
    render(<InactiveView paths={paths} onRemoved={vi.fn()} />);
    await waitFor(() => expect(rowNames()).toEqual(["abandoned", "risky"]));

    await user.click(screen.getByRole("button", { name: /Last local activity/ }));
    expect(rowNames()).toEqual(["risky", "abandoned"]);
    expect(screen.getByRole("columnheader", { name: /Last local activity/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
  });

  it("lists what would be lost and moves confirmed clones to the Trash", async () => {
    const calls = mockBackend();
    const onRemoved = vi.fn();
    const user = userEvent.setup();
    render(<InactiveView paths={paths} onRemoved={onRemoved} />);
    await waitFor(() => expect(rowNames()).toEqual(["abandoned", "risky"]));

    await user.click(screen.getByLabelText("Select all shown clones"));
    await user.click(screen.getByRole("button", { name: "Move 2 clones to the Trash" }));

    const dialog = calls.find((c) => c.cmd === "plugin:dialog|message");
    expect(dialog?.args.message).toContain("1 clone has work that would only be in the Trash");
    expect(dialog?.args.message).toContain("Ignored files git can't restore: .env");
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith(["/p/abandoned", "/p/risky"]));
    const trashed = calls.filter((c) => c.cmd === "trash_clone");
    expect(trashed.map((c) => c.args)).toEqual([
      { path: "/p/abandoned", reviewed: activities["/p/abandoned"].risks },
      { path: "/p/risky", reviewed: activities["/p/risky"].risks },
    ]);
    expect(screen.getByText("Moved /p/abandoned to the Trash")).toBeInTheDocument();
    expect(screen.queryAllByRole("row")).toHaveLength(0);
  });

  it("does nothing when the confirmation is cancelled", async () => {
    const calls = mockBackend({ confirmed: false });
    const onRemoved = vi.fn();
    const user = userEvent.setup();
    render(<InactiveView paths={paths} onRemoved={onRemoved} />);
    await waitFor(() => expect(rowNames()).toEqual(["abandoned", "risky"]));

    await user.click(screen.getByLabelText("Select abandoned"));
    await user.click(screen.getByRole("button", { name: "Move 1 clone to the Trash" }));

    await waitFor(() => expect(calls.some((c) => c.cmd === "plugin:dialog|message")).toBe(true));
    expect(calls.some((c) => c.cmd === "trash_clone")).toBe(false);
    expect(onRemoved).not.toHaveBeenCalled();
  });
});
