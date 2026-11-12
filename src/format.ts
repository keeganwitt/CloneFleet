import type { InProgressOperation, RepoSummary } from "./types";

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

const OPERATION_LABELS: Record<InProgressOperation, string> = {
  rebase: "Rebase in progress",
  merge: "Merge in progress",
  cherryPick: "Cherry-pick in progress",
  revert: "Revert in progress",
  bisect: "Bisect in progress",
};

export function describeChanges(summary: RepoSummary): string {
  const parts: string[] = [];
  if (summary.operation) parts.push(OPERATION_LABELS[summary.operation]);
  if (summary.conflicts > 0) parts.push(`${summary.conflicts} conflicted`);
  if (summary.trackedChanges > 0) parts.push(`${summary.trackedChanges} modified`);
  if (summary.untracked > 0) parts.push(`${summary.untracked} untracked`);
  return parts.length === 0 ? "Clean" : parts.join(" · ");
}

export function describeSync(summary: RepoSummary): string {
  if (summary.branch === null) return "Detached";
  if (summary.upstream === null) return "No upstream";
  const ahead = summary.ahead ?? 0;
  const behind = summary.behind ?? 0;
  if (ahead === 0 && behind === 0) return "Up to date";
  return [ahead > 0 ? `↑${ahead}` : "", behind > 0 ? `↓${behind}` : ""].filter(Boolean).join(" ");
}
