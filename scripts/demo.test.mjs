import { describe, expect, it } from "vitest";
import { commands, parseArgs } from "./demo.mjs";

describe("parseArgs", () => {
  it("defaults to a temp directory and tauri dev", () => {
    expect(parseArgs([], "/tmp/default")).toEqual({ dir: "/tmp/default", app: undefined });
  });

  it("accepts a directory and app, and rejects unknown or incomplete options", () => {
    const options = parseArgs(["--dir", "/x/demo", "--app", "/Apps/CloneFleet"], "/tmp/d");
    expect(options).toEqual({ dir: "/x/demo", app: "/Apps/CloneFleet" });
    expect(() => parseArgs(["--dir"])).toThrow("--dir needs a value");
    expect(() => parseArgs(["--nope"])).toThrow("Unknown option --nope");
  });
});

describe("commands", () => {
  it("generates the demo home and launches tauri dev or a built app", () => {
    const dev = commands({ dir: "/tmp/demo", app: undefined }, "darwin");
    expect(dev.generate).toEqual([
      "run",
      "--quiet",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--example",
      "demo_home",
      "--",
      "/tmp/demo",
      "--json",
    ]);
    expect(dev.launch).toEqual({ command: "pnpm", args: ["tauri", "dev"], shell: false });
    expect(commands({ dir: "/d", app: undefined }, "win32").launch.shell).toBe(true);
    expect(commands({ dir: "/d", app: "/bin/cf" }).launch).toEqual({
      command: "/bin/cf",
      args: [],
      shell: false,
    });
  });
});
