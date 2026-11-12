import { mockIPC } from "@tauri-apps/api/mocks";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { clearLog, recordCommands } from "../activityLog";
import { ActivityView } from "./ActivityView";

afterEach(() => clearLog());

function seed() {
  recordCommands("/src/api", "Fetch", [
    { args: ["fetch", "--prune", "origin"], exitCode: 0, stdout: "", stderr: "" },
  ]);
  recordCommands("/src/web", "Pull", [
    {
      args: ["pull", "--ff-only"],
      exitCode: 1,
      stdout: "",
      stderr: "Not possible to fast-forward",
    },
  ]);
}

describe("ActivityView", () => {
  it("lists commands, filters to failures, and searches output", async () => {
    const user = userEvent.setup();
    seed();
    render(<ActivityView onClose={() => {}} />);
    const log = screen.getByRole("list", { name: "Activity log" });
    expect(within(log).getAllByRole("listitem")).toHaveLength(2);
    expect(within(log).getByText("git pull --ff-only")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Failures only"));
    expect(within(log).getAllByRole("listitem")).toHaveLength(1);
    await user.click(screen.getByLabelText("Failures only"));
    await user.type(screen.getByLabelText("Search activity"), "prune");
    expect(within(log).getAllByRole("listitem")).toHaveLength(1);
    expect(within(log).getByText("api")).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
  });

  it("updates live and clears", async () => {
    const user = userEvent.setup();
    render(<ActivityView onClose={() => {}} />);
    expect(screen.getByText("Nothing has run yet.")).toBeInTheDocument();
    act(() => seed());
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
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
    render(<ActivityView onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Save log…" }));

    expect(await screen.findByText("Saved 2 entries")).toBeInTheDocument();
    const saved = calls.find((c) => c.cmd === "save_text_file")?.args;
    expect(saved?.path).toBe("/tmp/activity.log");
    expect(saved?.contents).toContain("$ git pull --ff-only\nexit 1\nNot possible to fast-forward");
    await waitFor(() => expect(calls.map((c) => c.cmd)).toContain("plugin:dialog|save"));
  });
});
