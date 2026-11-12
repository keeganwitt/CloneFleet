import { mockIPC } from "@tauri-apps/api/mocks";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { clearLog, recordAction } from "../activityLog";
import { ActivityView } from "./ActivityView";

afterEach(() => clearLog());

function seed() {
  recordAction("/src/api", "Fetch", { status: "succeeded", message: "Fetched origin" }, [
    { args: ["fetch", "--prune", "origin"], exitCode: 0, stdout: "", stderr: "" },
  ]);
  recordAction("/src/web", "Pull", { status: "failed", message: "main has diverged" }, [
    {
      args: ["pull", "--ff-only"],
      exitCode: 1,
      stdout: "",
      stderr: "Not possible to fast-forward",
    },
  ]);
}

function entries() {
  const log = screen.getByRole("list", { name: "Activity log" });
  return within(log)
    .getAllByRole("listitem")
    .filter((item) => item.parentElement === log);
}

describe("ActivityView", () => {
  it("lists one entry per action, filters to failures, and searches commands", async () => {
    const user = userEvent.setup();
    seed();
    render(<ActivityView />);
    expect(entries()).toHaveLength(2);
    expect(screen.getByText("main has diverged")).toHaveClass("outcome-failed");
    expect(screen.getByText("git pull --ff-only")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Failures only"));
    expect(entries()).toHaveLength(1);
    await user.click(screen.getByLabelText("Failures only"));
    await user.type(screen.getByLabelText("Search activity"), "prune");
    expect(entries()).toHaveLength(1);
    expect(screen.getByText("api")).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
  });

  it("updates live and clears", async () => {
    const user = userEvent.setup();
    render(<ActivityView />);
    expect(screen.getByText("Nothing has run yet.")).toBeInTheDocument();
    act(() => seed());
    expect(screen.getByText("Fetched origin")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("Nothing has run yet.")).toBeInTheDocument();
  });

  it("saves the shown entries to a chosen file", async () => {
    const user = userEvent.setup();
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    mockIPC((cmd, payload) => {
      calls.push({ cmd, args: (payload ?? {}) as Record<string, unknown> });
      if (cmd === "plugin:dialog|save") return "/tmp/activity.log";
      if (cmd === "save_text_file") return null;
      throw new Error(`unexpected ${cmd}`);
    });
    seed();
    render(<ActivityView />);
    await user.click(screen.getByRole("button", { name: "Save log…" }));

    expect(await screen.findByText("Saved 2 entries")).toBeInTheDocument();
    const saved = calls.find((c) => c.cmd === "save_text_file")?.args;
    expect(saved?.path).toBe("/tmp/activity.log");
    expect(saved?.contents).toContain(
      "$ git pull --ff-only  (exit 1)\n    Not possible to fast-forward",
    );
    await waitFor(() => expect(calls.map((c) => c.cmd)).toContain("plugin:dialog|save"));
  });
});
