// Starts CloneFleet on a demo home of made-up repositories: `pnpm demo [--dir <dir>]
// [--app <binary>]`. See docs/demo.md.
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = "usage: pnpm demo [--dir <dir>] [--app <clonefleet binary>]";

export function parseArgs(argv, defaultDir = join(tmpdir(), "clonefleet-demo")) {
  const options = { dir: defaultDir, app: undefined };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${arg} needs a value\n${USAGE}`);
      }
      return next;
    };
    if (arg === "--") continue;
    else if (arg === "--dir") options.dir = resolve(value());
    else if (arg === "--app") options.app = resolve(value());
    else throw new Error(`Unknown option ${arg}\n${USAGE}`);
  }
  return options;
}

export function commands(options, platform = process.platform) {
  const generate = [
    "run",
    "--quiet",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--example",
    "demo_home",
    "--",
    options.dir,
    "--json",
  ];
  const launch = options.app
    ? { command: options.app, args: [], shell: false }
    : // pnpm is a .cmd script on Windows, which only a shell can start.
      { command: "pnpm", args: ["tauri", "dev"], shell: platform === "win32" };
  return { generate, launch };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const { generate, launch } = commands(options);
  const output = execFileSync("cargo", generate, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const env = JSON.parse(output);
  console.log(`Demo home: ${options.dir}`);
  const child = spawn(launch.command, launch.args, {
    env: { ...process.env, ...env },
    shell: launch.shell,
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
