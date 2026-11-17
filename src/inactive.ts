import type { CloneActivity, CloneRisks } from "./types";

const DAY_SECONDS = 24 * 60 * 60;

export type InactiveSortKey = "name" | "lastCommit" | "lastActivity";

export interface InactiveSort {
  key: InactiveSortKey;
  direction: "ascending" | "descending";
}

function olderThan(timestamp: number | null, nowUnix: number, days: number | null): boolean {
  if (days === null || timestamp === null) return true;
  return timestamp <= nowUnix - days * DAY_SECONDS;
}

export function isInactive(
  activity: CloneActivity,
  nowUnix: number,
  commitDays: number | null,
  activityDays: number | null,
): boolean {
  return (
    olderThan(activity.lastCommitByMeUnix, nowUnix, commitDays) &&
    olderThan(activity.lastLocalActivityUnix, nowUnix, activityDays)
  );
}

function timestampFor(activity: CloneActivity, key: InactiveSortKey): number {
  const timestamp =
    key === "lastCommit" ? activity.lastCommitByMeUnix : activity.lastLocalActivityUnix;
  return timestamp ?? Number.NEGATIVE_INFINITY;
}

export function compareInactive(
  [pathA, a]: readonly [string, CloneActivity],
  [pathB, b]: readonly [string, CloneActivity],
  sort: InactiveSort,
  nameOf: (path: string) => string,
): number {
  const byName = nameOf(pathA).localeCompare(nameOf(pathB)) || pathA.localeCompare(pathB);
  const primary =
    sort.key === "name" ? byName : timestampFor(a, sort.key) - timestampFor(b, sort.key);
  const ordered = sort.direction === "ascending" ? primary : -primary;
  return ordered || byName;
}

export function nextInactiveSort(current: InactiveSort, key: InactiveSortKey): InactiveSort {
  if (current.key !== key) return { key, direction: "ascending" };
  return { key, direction: current.direction === "ascending" ? "descending" : "ascending" };
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function describeRisks(risks: CloneRisks): string[] {
  const lines: string[] = [];
  if (!risks.hasRemotes) lines.push("No remote, so this is the only copy");
  if (risks.unpushedBranches.length > 0) {
    lines.push(
      `${plural(risks.unpushedBranches.length, "branch", "branches")} with unpushed commits: ${risks.unpushedBranches.join(", ")}`,
    );
  }
  if (risks.stashes > 0) lines.push(plural(risks.stashes, "stash", "stashes"));
  for (const head of risks.unpushedDetachedHeads) {
    lines.push(
      `${plural(head.commits, "unpushed commit")} on detached HEAD ${head.sha.slice(0, 10)} in ${head.worktree}`,
    );
  }
  if (risks.dirtyWorktrees.length > 0) {
    lines.push(`Uncommitted changes in ${risks.dirtyWorktrees.join(", ")}`);
  }
  if (risks.linkedWorktreesOutside.length > 0) {
    lines.push(
      `Linked worktrees that will stop working: ${risks.linkedWorktreesOutside.join(", ")}`,
    );
  }
  if (risks.nestedRepos.length > 0) {
    lines.push(`Repositories inside it: ${risks.nestedRepos.join(", ")}`);
  }
  if (risks.ignoredFileCount > 0) {
    const more = risks.ignoredFileCount - risks.ignoredFiles.length;
    lines.push(
      `Ignored files git can't restore: ${risks.ignoredFiles.join(", ")}${more > 0 ? `, and ${more} more` : ""}`,
    );
  }
  return lines;
}
