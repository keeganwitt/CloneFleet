import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_ENTRIES,
  clearLog,
  entryFailed,
  formatLog,
  matchesLogSearch,
  recordAction,
  summarizeItems,
  useActivityLog,
} from "./activityLog";
import type { CommandRecord } from "./types";

const command = (args: string[], exitCode = 0, stderr = ""): CommandRecord => ({
  args,
  exitCode,
  stdout: "",
  stderr,
});

afterEach(() => clearLog());

function logSnapshot() {
  const { result } = renderHook(() => useActivityLog());
  return result.current;
}

describe("activity log", () => {
  it("records one entry per action, newest first, using the outcome for failures", () => {
    const { result } = renderHook(() => useActivityLog());
    act(() =>
      recordAction("/a", "Checkout default branch", { status: "succeeded", message: "Switched" }, [
        command(["show-ref", "--verify", "--quiet", "refs/heads/main"], 1),
        command(["switch", "main"]),
      ]),
    );
    act(() =>
      recordAction("/b", "Pull", { status: "failed", message: "diverged" }, [
        command(["pull"], 1, "Not possible"),
      ]),
    );
    expect(result.current.map((e) => [e.repo, e.label])).toEqual([
      ["/b", "Pull"],
      ["/a", "Checkout default branch"],
    ]);
    expect(result.current.filter(entryFailed).map((e) => e.repo)).toEqual(["/b"]);
    expect(result.current[1].commands).toHaveLength(2);
  });

  it("skips no-op entries but keeps failures without commands, and caps the log", () => {
    const { result } = renderHook(() => useActivityLog());
    act(() => recordAction("/a", "Fetch", { status: "succeeded", message: "" }, []));
    expect(result.current).toEqual([]);
    act(() => recordAction("/a", "Fetch", { status: "failed", message: "not in list" }, []));
    expect(result.current).toHaveLength(1);
    act(() => {
      for (let i = 0; i < MAX_ENTRIES + 3; i++) {
        recordAction("/a", "Fetch", { status: "succeeded", message: `${i}` }, [command(["x"])]);
      }
    });
    expect(result.current).toHaveLength(MAX_ENTRIES);
    expect(result.current[0].message).toBe(`${MAX_ENTRIES + 2}`);
  });

  it("searches repo, label, message, arguments, and output", () => {
    recordAction("/src/api", "Pull", { status: "failed", message: "diverged from upstream" }, [
      command(["pull", "--ff-only"], 1, "Not possible"),
    ]);
    const [entry] = logSnapshot();
    expect(matchesLogSearch(entry, "api ff-only")).toBe(true);
    expect(matchesLogSearch(entry, "not possible")).toBe(true);
    expect(matchesLogSearch(entry, "diverged")).toBe(true);
    expect(matchesLogSearch(entry, "web")).toBe(false);
  });

  it("formats the log oldest first with indented commands", () => {
    recordAction("/a", "Fetch", { status: "succeeded", message: "Fetched origin" }, [
      command(["fetch"]),
    ]);
    recordAction("/b", "Pull", { status: "failed", message: "boom" }, [
      command(["pull"], 1, "err"),
    ]);
    const text = formatLog(logSnapshot());
    expect(text.indexOf("Fetched origin")).toBeLessThan(text.indexOf("boom"));
    expect(text).toContain("/b — Pull: failed\nboom\n  $ git pull  (exit 1)\n    err");
  });

  it("writes filesystem commands without a git prefix", () => {
    recordAction(
      "/r",
      "Delete build and dependency directories",
      { status: "succeeded", message: "Deleted" },
      [{ ...command(["delete", "/r/node_modules"]), kind: "filesystem" }, command(["ls-files"])],
    );
    const text = formatLog(logSnapshot());
    expect(text).toContain("  $ delete /r/node_modules  (exit 0)");
    expect(text).toContain("  $ git ls-files  (exit 0)");
  });

  it("summarizes cleanup item results", () => {
    expect(
      summarizeItems([
        { status: "succeeded", message: "Deleted a" },
        { status: "skipped", message: "b is protected" },
      ]),
    ).toEqual({ status: "succeeded", message: "Deleted a; b is protected" });
    expect(summarizeItems([{ status: "skipped", message: "x" }]).status).toBe("skipped");
    expect(summarizeItems([{ status: "failed", message: "x" }]).status).toBe("failed");
  });
});
