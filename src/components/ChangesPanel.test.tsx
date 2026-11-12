import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FileChange } from "../types";
import { ChangesPanel, sortChanges } from "./ChangesPanel";

const change = (path: string, overrides: Partial<FileChange> = {}): FileChange => ({
  path,
  originalPath: null,
  kind: "modified",
  staged: false,
  unstaged: true,
  ...overrides,
});

function mockChanges(result: FileChange[] | Error) {
  mockIPC((cmd) => {
    if (cmd !== "list_changes") throw new Error(`unexpected ${cmd}`);
    if (result instanceof Error) throw result;
    return result;
  });
}

describe("sortChanges", () => {
  it("puts conflicts first, untracked last, and sorts by path within a kind", () => {
    const sorted = sortChanges([
      change("z.txt", { kind: "untracked" }),
      change("b.rs"),
      change("a.rs"),
      change("c.rs", { kind: "conflicted" }),
    ]);
    expect(sorted.map((c) => c.path)).toEqual(["c.rs", "a.rs", "b.rs", "z.txt"]);
  });
});

describe("ChangesPanel", () => {
  it("lists files with status badges, renames, and staging state", async () => {
    mockChanges([
      change("new.rs", { kind: "renamed", originalPath: "old.rs", staged: true, unstaged: false }),
      change("both.rs", { staged: true, unstaged: true }),
      change("scratch/", { kind: "untracked" }),
    ]);
    render(<ChangesPanel path="/repo" summary={undefined} />);

    const list = await screen.findByRole("list", { name: "Changed files" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Mboth.rspartially staged",
      "Rold.rs → new.rsstaged",
      "?scratch/",
    ]);
    expect(within(items[2]).getByTitle("Untracked")).toBeInTheDocument();
  });

  it("reports when there are no changes or the command fails", async () => {
    mockChanges([]);
    const { unmount } = render(<ChangesPanel path="/repo" summary={undefined} />);
    expect(await screen.findByText("No uncommitted changes.")).toBeInTheDocument();
    unmount();

    mockChanges(new Error("not a git repository"));
    render(<ChangesPanel path="/repo" summary={undefined} />);
    expect(await screen.findByText(/not a git repository/)).toBeInTheDocument();
  });

  it("truncates very long lists", async () => {
    mockChanges(Array.from({ length: 503 }, (_, i) => change(`f${String(i).padStart(3, "0")}`)));
    render(<ChangesPanel path="/repo" summary={undefined} />);
    expect(await screen.findByText("…and 3 more")).toBeInTheDocument();
  });
});
