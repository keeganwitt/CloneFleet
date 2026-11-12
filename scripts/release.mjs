import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const versionFiles = [
  "package.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];

export function release(args, cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..")) {
  const values = args.filter((arg) => arg !== "--");
  const version = values[0]?.replace(/^v/, "");
  if (values.length !== 1 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? "")) {
    throw new Error("Usage: pnpm release <version> (for example: pnpm release 0.1.0)");
  }
  const git = (...command) =>
    execFileSync("git", command, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  if (git("status", "--porcelain")) {
    throw new Error("Commit or stash all changes, including untracked files, before releasing.");
  }
  if (git("branch", "--show-current") !== "main") {
    throw new Error("Releases must be made from main.");
  }
  const tag = `v${version}`;
  if (git("tag", "--list", tag)) {
    throw new Error(`Tag ${tag} already exists locally.`);
  }
  const remoteRefs = git("ls-remote", "origin", "refs/heads/main", `refs/tags/${tag}`);
  const refs = new Map(
    remoteRefs
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [hash, ref] = line.split(/\s+/);
        return [ref, hash];
      }),
  );
  if (refs.has(`refs/tags/${tag}`)) {
    throw new Error(`Tag ${tag} already exists on origin.`);
  }
  const remoteMain = refs.get("refs/heads/main");
  if (remoteMain) {
    try {
      git("merge-base", "--is-ancestor", remoteMain, "HEAD");
    } catch {
      throw new Error("Fetch origin and integrate origin/main before releasing.");
    }
  }

  const originals = new Map(
    versionFiles.map((file) => [file, readFileSync(resolve(cwd, file), "utf8")]),
  );
  const currentVersion = JSON.parse(originals.get("package.json")).version;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(currentVersion)) {
    throw new Error("The current package version must be a stable version (X.Y.Z).");
  }
  const currentParts = currentVersion.split(".").map(BigInt);
  const nextParts = version.split(".").map(BigInt);
  const differentPart = nextParts.findIndex((part, index) => part !== currentParts[index]);
  if (differentPart !== -1 && nextParts[differentPart] < currentParts[differentPart]) {
    throw new Error(`Release version ${version} is older than ${currentVersion}.`);
  }

  const updates = new Map();
  for (const file of ["package.json", "src-tauri/tauri.conf.json"]) {
    const source = originals.get(file);
    if (JSON.parse(source).version !== currentVersion) {
      throw new Error(`Version in ${file} does not match ${currentVersion}.`);
    }
    updates.set(
      file,
      source.replace(
        /("version"\s*:\s*")[^"]+("[ \t]*[,}])/,
        (_, prefix, suffix) => `${prefix}${version}${suffix}`,
      ),
    );
  }
  let packageMatches = 0;
  updates.set(
    "src-tauri/Cargo.toml",
    originals
      .get("src-tauri/Cargo.toml")
      .replace(
        /(\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m,
        (_, prefix, oldVersion, suffix) => {
          if (oldVersion !== currentVersion) {
            throw new Error(`Cargo.toml version does not match ${currentVersion}.`);
          }
          packageMatches++;
          return `${prefix}${version}${suffix}`;
        },
      ),
  );
  let lockMatches = 0;
  updates.set(
    "src-tauri/Cargo.lock",
    originals
      .get("src-tauri/Cargo.lock")
      .replace(
        /(^name = "clonefleet"\r?\nversion = ")([^"]+)(")/gm,
        (_, prefix, oldVersion, suffix) => {
          if (oldVersion !== currentVersion) {
            throw new Error(`Cargo.lock version does not match ${currentVersion}.`);
          }
          lockMatches++;
          return `${prefix}${version}${suffix}`;
        },
      ),
  );
  if (packageMatches !== 1 || lockMatches !== 1) {
    throw new Error("Could not locate the CloneFleet versions in Cargo.toml and Cargo.lock.");
  }
  for (const [file, content] of updates) {
    if (content !== originals.get(file)) writeFileSync(resolve(cwd, file), content);
  }
  if (git("diff", "--name-only")) {
    git("add", "--", ...versionFiles);
    git("commit", "-m", `Release ${tag}`);
  }
  git("tag", "-a", tag, "-m", `Release ${tag}`);
  try {
    git("push", "--atomic", "origin", "HEAD:refs/heads/main", `refs/tags/${tag}`);
  } catch (error) {
    throw new Error(
      `Push failed. The release commit and tag remain local. After resolving the failure, retry:\ngit push --atomic origin HEAD:refs/heads/main refs/tags/${tag}`,
      { cause: error },
    );
  }
  return tag;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const tag = release(process.argv.slice(2));
    console.log(
      `Pushed ${tag}. GitHub Actions will build a draft release. Review and publish it on GitHub once the builds finish.`,
    );
  } catch (error) {
    console.error(error.message);
    if (error.cause?.stderr) console.error(error.cause.stderr.toString().trim());
    process.exitCode = 1;
  }
}
