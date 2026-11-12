import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RemoteInfo } from "../types";
import { RemotesView } from "./RemotesView";

const remotes: Record<string, RemoteInfo[]> = {
  "/src/api": [{ name: "origin", fetchUrl: "https://github.com/old-org/api.git", pushUrl: null }],
  "/src/web": [
    { name: "origin", fetchUrl: "git@github.com:me/web.git", pushUrl: null },
    { name: "upstream", fetchUrl: "https://github.com/old-org/web.git", pushUrl: null },
  ],
};

function mockRemotes({ confirmed = true } = {}) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    switch (cmd) {
      case "list_remotes":
        return remotes[args.path as string];
      case "check_remotes":
        return args.path === "/src/api"
          ? [
              {
                name: "origin",
                status: "redirected",
                redirectUrl: "https://github.com/new-org/api.git",
                message: null,
              },
            ]
          : [
              { name: "origin", status: "ok", redirectUrl: null, message: null },
              {
                name: "upstream",
                status: "notFound",
                redirectUrl: null,
                message: "remote: Repository not found.",
              },
            ];
      case "plugin:dialog|message":
        return confirmed ? "Update URLs" : "Cancel";
      default:
        throw new Error(`unexpected ${cmd}`);
    }
  });
  return calls;
}

function renderView() {
  const runJobs = vi.fn().mockResolvedValue(undefined);
  render(<RemotesView paths={["/src/api", "/src/web"]} runJobs={runJobs} />);
  return runJobs;
}

describe("RemotesView", () => {
  it("lists remotes and checks them on demand", async () => {
    const user = userEvent.setup();
    const calls = mockRemotes();
    renderView();
    expect(await screen.findByText("git@github.com:me/web.git")).toBeInTheDocument();
    expect(screen.getAllByText("Not checked")).toHaveLength(3);
    expect(calls.some((c) => c.cmd === "check_remotes")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Check all remotes" }));
    expect(await screen.findByText("Moved")).toBeInTheDocument();
    expect(screen.getByText("Not found")).toHaveAttribute("title", "remote: Repository not found.");
    expect(screen.getByText("OK")).toBeInTheDocument();
  });

  it("updates moved remotes to their redirect targets", async () => {
    const user = userEvent.setup();
    mockRemotes();
    const runJobs = renderView();
    await user.click(await screen.findByRole("button", { name: "Check all remotes" }));
    await user.click(await screen.findByRole("button", { name: "Update 1 moved" }));

    await waitFor(() =>
      expect(runJobs).toHaveBeenCalledWith([
        [
          "/src/api",
          { type: "setRemoteUrl", remote: "origin", url: "https://github.com/new-org/api.git" },
        ],
      ]),
    );
    expect(await screen.findByText("Updated 1 remote URL")).toBeInTheDocument();
  });

  it("previews and applies a find-and-replace across repositories", async () => {
    const user = userEvent.setup();
    mockRemotes();
    const runJobs = renderView();
    await user.type(await screen.findByLabelText("Find"), "old-org");
    await user.type(screen.getByLabelText("Replace with"), "new-org");

    const planned = screen.getByRole("list", { name: "Planned URL changes" });
    expect(within(planned).getAllByRole("listitem")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Apply 2 changes" }));
    await waitFor(() =>
      expect(runJobs).toHaveBeenCalledWith([
        [
          "/src/api",
          { type: "setRemoteUrl", remote: "origin", url: "https://github.com/new-org/api.git" },
        ],
        [
          "/src/web",
          { type: "setRemoteUrl", remote: "upstream", url: "https://github.com/new-org/web.git" },
        ],
      ]),
    );
  });

  it("filters by remote name, protocol, and problems, and limits bulk changes to shown remotes", async () => {
    const user = userEvent.setup();
    mockRemotes();
    const runJobs = renderView();
    await screen.findByText("git@github.com:me/web.git");

    await user.selectOptions(screen.getByLabelText("Filter by remote name"), "upstream");
    expect(screen.queryByText("git@github.com:me/web.git")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 3 remotes")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Find"), "old-org");
    await user.type(screen.getByLabelText("Replace with"), "new-org");
    expect(
      within(screen.getByRole("list", { name: "Planned URL changes" })).getAllByRole("listitem"),
    ).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Apply 1 change" }));
    await waitFor(() =>
      expect(runJobs).toHaveBeenCalledWith([
        [
          "/src/web",
          { type: "setRemoteUrl", remote: "upstream", url: "https://github.com/new-org/web.git" },
        ],
      ]),
    );

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await user.selectOptions(screen.getByLabelText("Filter by protocol"), "ssh");
    expect(screen.getByText("git@github.com:me/web.git")).toBeInTheDocument();
    expect(screen.getByText("1 of 3 remotes")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Filter by protocol"), "");

    expect(screen.queryByLabelText("Problems only")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check all remotes" }));
    await user.click(await screen.findByLabelText("Problems only"));
    expect(screen.getByText("2 of 3 remotes")).toBeInTheDocument();
    expect(screen.queryByText("OK")).not.toBeInTheDocument();
  });

  it("converts HTTPS remotes to SSH and respects a cancelled confirmation", async () => {
    const user = userEvent.setup();
    mockRemotes({ confirmed: false });
    const runJobs = renderView();
    await user.click(await screen.findByRole("radio", { name: "HTTPS → SSH" }));
    const planned = screen.getByRole("list", { name: "Planned URL changes" });
    expect(planned).toHaveTextContent("git@github.com:old-org/api.git");
    expect(within(planned).getAllByRole("listitem")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Apply 2 changes" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runJobs).not.toHaveBeenCalled();
  });
});
