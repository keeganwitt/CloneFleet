import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_ENTRIES,
  clearLog,
  entryFailed,
  formatLog,
  matchesLogSearch,
  recordCommands,
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

describe("activity log", () => {
  it("records commands newest first and notifies subscribers", () => {
    const { result } = renderHook(() => useActivityLog());
    act(() => recordCommands("/a", "Fetch", [command(["fetch", "origin"])]));
    act(() =>
      recordCommands("/b", "Pull", [command(["status"]), command(["pull"], 1, "diverged")]),
    );
    expect(result.current.map((e) => [e.repo, e.command.args[0]])).toEqual([
      ["/b", "pull"],
      ["/b", "status"],
      ["/a", "fetch"],
    ]);
    expect(result.current.filter(entryFailed).map((e) => e.command.args[0])).toEqual(["pull"]);
  });

  it("ignores empty records and caps the log", () => {
    const { result } = renderHook(() => useActivityLog());
    act(() => recordCommands("/a", "Fetch", []));
    expect(result.current).toEqual([]);
    act(() =>
      recordCommands(
        "/a",
        "Fetch",
        Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => command([`c${i}`])),
      ),
    );
    expect(result.current).toHaveLength(MAX_ENTRIES);
    expect(result.current[0].command.args[0]).toBe(`c${MAX_ENTRIES + 4}`);
  });

  it("searches repo, label, arguments, and output", () => {
    recordCommands("/src/api", "Pull", [command(["pull", "--ff-only"], 1, "Not possible")]);
    const [entry] = logSnapshot();
    expect(matchesLogSearch(entry, "api ff-only")).toBe(true);
    expect(matchesLogSearch(entry, "not possible")).toBe(true);
    expect(matchesLogSearch(entry, "web")).toBe(false);
    expect(matchesLogSearch(entry, "  ")).toBe(true);
  });

  it("formats the log oldest first for export", () => {
    recordCommands("/a", "Fetch", [command(["fetch"])]);
    recordCommands("/b", "Pull", [command(["pull"], 1, "boom")]);
    const text = formatLog(logSnapshot());
    expect(text.indexOf("$ git fetch")).toBeLessThan(text.indexOf("$ git pull"));
    expect(text).toContain("/b (Pull)\n$ git pull\nexit 1\nboom");
  });
});

function logSnapshot() {
  const { result } = renderHook(() => useActivityLog());
  return result.current;
}
