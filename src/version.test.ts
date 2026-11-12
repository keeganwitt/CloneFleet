import { describe, expect, it, vi } from "vitest";
import { fetchLatestRelease, isNewer } from "./version";

describe("isNewer", () => {
  it("compares semantic versions numerically", () => {
    expect(isNewer("0.10.0", "0.9.3")).toBe(true);
    expect(isNewer("v1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("0.2.0", "0.2.0")).toBe(false);
    expect(isNewer("0.1.9", "0.2.0")).toBe(false);
    expect(isNewer("1.2", "1.2.0")).toBe(false);
  });
});

describe("fetchLatestRelease", () => {
  const respond = (status: number, body: unknown) =>
    vi.fn().mockResolvedValue({ status, ok: status < 400, json: () => Promise.resolve(body) });

  it("reads the tag and page of the latest release", async () => {
    const fetcher = respond(200, { tag_name: "v0.3.1", html_url: "https://github.com/r/1" });
    await expect(fetchLatestRelease(fetcher)).resolves.toEqual({
      version: "0.3.1",
      url: "https://github.com/r/1",
    });
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/keeganwitt/CloneFleet/releases/latest",
    );
  });

  it("explains missing releases and errors", async () => {
    await expect(fetchLatestRelease(respond(404, {}))).rejects.toThrow("No releases");
    await expect(fetchLatestRelease(respond(500, {}))).rejects.toThrow("GitHub returned 500");
    await expect(fetchLatestRelease(respond(200, {}))).rejects.toThrow("Unexpected response");
  });
});
