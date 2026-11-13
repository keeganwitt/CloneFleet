import type { Artifact, ArtifactTier } from "./types";

export const ARTIFACT_TIERS: { value: ArtifactTier; label: string; hint: string }[] = [
  {
    value: "buildOutput",
    label: "Build output",
    hint: "Compiled files and caches, such as target, dist, and __pycache__. The next build or test run recreates them.",
  },
  {
    value: "reinstall",
    label: "Needs reinstalling",
    hint: "Downloaded dependencies and tool state, such as node_modules, .gradle, and .terraform. Run the install step again before building, for example npm install or terraform init.",
  },
  {
    value: "unreproducible",
    label: "May not be reproducible",
    hint: "Python virtualenvs. Packages installed into one by hand aren't recorded anywhere, so recreating it can miss some.",
  },
];

export const DEFAULT_TIERS: ArtifactTier[] = ["buildOutput"];

const DAY_SECONDS = 24 * 60 * 60;

export function tierLabel(tier: ArtifactTier): string {
  return ARTIFACT_TIERS.find((t) => t.value === tier)?.label ?? tier;
}

export function isPreselected(artifact: Artifact, nowUnix: number, unusedDays: number): boolean {
  return (
    artifact.tier === "buildOutput" &&
    artifact.modifiedUnix !== null &&
    nowUnix - artifact.modifiedUnix >= unusedDays * DAY_SECONDS
  );
}

export function reclaimableBytes(artifacts: Artifact[]): number {
  return artifacts
    .filter((artifact) => artifact.tier !== "unreproducible")
    .reduce((total, artifact) => total + artifact.bytes, 0);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = units[0];
  for (const candidate of units) {
    value /= 1000;
    unit = candidate;
    if (value < 1000) break;
  }
  return `${value.toFixed(1)} ${unit}`;
}

export function relativeTo(root: string, path: string): string {
  const prefix = root.endsWith("/") || root.endsWith("\\") ? root : `${root}/`;
  if (path.startsWith(prefix)) return path.slice(prefix.length);
  const windowsPrefix = root.endsWith("\\") ? root : `${root}\\`;
  return path.startsWith(windowsPrefix) ? path.slice(windowsPrefix.length) : path;
}
