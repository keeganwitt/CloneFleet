import { describe, expect, it } from "vitest";
import { formatBytes, isPreselected, reclaimableBytes, relativeTo } from "./artifacts";
import type { Artifact } from "./types";

const DAY = 86_400;
const now = 1_000 * DAY;

const artifact = (overrides: Partial<Artifact> = {}): Artifact => ({
  path: "/repo/target",
  worktree: "/repo",
  kind: "Maven",
  tier: "buildOutput",
  bytes: 1_000,
  sharedBytes: 0,
  files: 1,
  modifiedUnix: now - 100 * DAY,
  ...overrides,
});

describe("isPreselected", () => {
  it("preselects only build output unchanged for the threshold", () => {
    expect(isPreselected(artifact(), now, 90)).toBe(true);
    expect(isPreselected(artifact({ modifiedUnix: now - 10 * DAY }), now, 90)).toBe(false);
    expect(isPreselected(artifact({ modifiedUnix: null }), now, 90)).toBe(false);
    expect(isPreselected(artifact({ tier: "reinstall" }), now, 90)).toBe(false);
    expect(isPreselected(artifact({ tier: "unreproducible" }), now, 90)).toBe(false);
  });
});

describe("reclaimableBytes", () => {
  it("leaves out directories that may not be reproducible", () => {
    expect(
      reclaimableBytes([
        artifact({ bytes: 5 }),
        artifact({ tier: "reinstall", bytes: 7 }),
        artifact({ tier: "unreproducible", bytes: 100 }),
      ]),
    ).toBe(12);
  });
});

describe("formatBytes", () => {
  it("uses decimal units", () => {
    expect(formatBytes(999)).toBe("999 bytes");
    expect(formatBytes(1_500)).toBe("1.5 kB");
    expect(formatBytes(2_340_000_000)).toBe("2.3 GB");
  });
});

describe("relativeTo", () => {
  it("strips the worktree prefix with either separator", () => {
    expect(relativeTo("/repo", "/repo/a/node_modules")).toBe("a/node_modules");
    expect(relativeTo("C:\\repo", "C:\\repo\\bin")).toBe("bin");
    expect(relativeTo("/repo", "/elsewhere/bin")).toBe("/elsewhere/bin");
  });
});
