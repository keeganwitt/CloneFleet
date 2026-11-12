import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsView } from "../types";
import { applyTheme } from "../useSettings";
import { SettingsDialog } from "./SettingsDialog";

const view: SettingsView = {
  settings: { gitPath: null, theme: "system" },
  detectedGit: "/opt/homebrew/bin/git",
  activeGit: { path: "/opt/homebrew/bin/git", version: "git version 2.56.0", error: null },
};

function mockGit() {
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    if (cmd === "check_git") {
      return args.path === "/custom/git"
        ? { path: args.path, version: "git version 2.40.0", error: null }
        : { path: args.path, version: null, error: "Could not run it" };
    }
    if (cmd === "plugin:dialog|open") return "/custom/git";
    throw new Error(`unexpected ${cmd}`);
  });
}

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe("SettingsDialog", () => {
  it("shows the detected git and saves a theme", async () => {
    const user = userEvent.setup();
    mockGit();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<SettingsDialog view={view} onSave={onSave} onClose={onClose} />);

    expect(screen.getByText("/opt/homebrew/bin/git")).toBeInTheDocument();
    expect(
      screen.getByText(/In use: \/opt\/homebrew\/bin\/git \(git version 2.56.0\)/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith({ gitPath: null, theme: "dark" });
    expect(onClose).toHaveBeenCalled();
  });

  it("chooses, tests, and saves a custom git location", async () => {
    const user = userEvent.setup();
    mockGit();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SettingsDialog view={view} onSave={onSave} onClose={() => {}} />);

    await user.click(screen.getByRole("radio", { name: "Use a specific git" }));
    await user.click(screen.getByRole("button", { name: "Browse…" }));
    expect(screen.getByLabelText("Git location")).toHaveValue("/custom/git");
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByRole("status")).toHaveTextContent("git version 2.40.0");

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ gitPath: "/custom/git", theme: "system" });
  });

  it("shows a failing test and a rejected save", async () => {
    const user = userEvent.setup();
    mockGit();
    const onSave = vi.fn().mockRejectedValue("/bad is not a working git");
    const onClose = vi.fn();
    render(<SettingsDialog view={view} onSave={onSave} onClose={onClose} />);

    await user.click(screen.getByRole("radio", { name: "Use a specific git" }));
    await user.type(screen.getByLabelText("Git location"), "/bad");
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Could not run it");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("/bad is not a working git");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes with Escape or Cancel", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SettingsDialog view={view} onSave={vi.fn()} onClose={onClose} />);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  });
});

describe("applyTheme", () => {
  it("sets an explicit theme and clears it for system", () => {
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    applyTheme("system");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
