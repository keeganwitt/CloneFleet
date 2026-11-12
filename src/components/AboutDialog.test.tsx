import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AboutDialog } from "./AboutDialog";

function mockApp() {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, payload) => {
    calls.push({ cmd, args: (payload ?? {}) as Record<string, unknown> });
    if (cmd === "plugin:app|version") return "0.2.0";
    if (cmd === "open_web") return null;
    throw new Error(`unexpected ${cmd}`);
  });
  return calls;
}

function respondWith(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ status, ok: status < 400, json: () => Promise.resolve(body) }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("AboutDialog", () => {
  it("shows the version and offers a newer release", async () => {
    const user = userEvent.setup();
    const calls = mockApp();
    respondWith({
      tag_name: "v0.3.0",
      html_url: "https://github.com/keeganwitt/CloneFleet/releases/v0.3.0",
    });
    render(<AboutDialog onClose={() => {}} />);
    expect(await screen.findByText("0.2.0")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("0.3.0")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(calls.find((c) => c.cmd === "open_web")?.args).toEqual({
      url: "https://github.com/keeganwitt/CloneFleet/releases/v0.3.0",
    });
  });

  it("says when the app is current and reports errors", async () => {
    const user = userEvent.setup();
    mockApp();
    respondWith({ tag_name: "v0.2.0", html_url: "https://x" });
    const { unmount } = render(<AboutDialog onClose={() => {}} />);
    await screen.findByText("0.2.0");
    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("You're running the latest version.")).toBeInTheDocument();
    unmount();

    respondWith({}, 404);
    render(<AboutDialog onClose={() => {}} />);
    await screen.findByText("0.2.0");
    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("No releases have been published yet")).toBeInTheDocument();
  });

  it("closes with Escape", async () => {
    const user = userEvent.setup();
    mockApp();
    const onClose = vi.fn();
    render(<AboutDialog onClose={onClose} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
