import type { BranchInfo, MergeEvidence, WorktreeInfo } from "./types";

export type BranchCategory = "merged" | "remoteDeleted" | "stale" | "active" | "protected";

export const BRANCH_CATEGORIES: { value: BranchCategory; label: string }[] = [
  { value: "merged", label: "Merged" },
  { value: "remoteDeleted", label: "Remote deleted" },
  { value: "stale", label: "Stale" },
  { value: "active", label: "Active" },
  { value: "protected", label: "Protected" },
];

const DAY_SECONDS = 24 * 60 * 60;

export function categorizeBranch(
  branch: BranchInfo,
  nowUnix: number,
  staleDays: number,
): BranchCategory {
  if (branch.protection) return "protected";
  if (branch.merged) return "merged";
  if (branch.upstreamGone) return "remoteDeleted";
  if (nowUnix - branch.lastCommitUnix >= staleDays * DAY_SECONDS) return "stale";
  return "active";
}

const EVIDENCE_LABELS: Record<MergeEvidence, string> = {
  ancestor: "merged into",
  patchEquivalent: "rebased onto",
  squashed: "squash-merged into",
};

export function describeBranch(branch: BranchInfo, category: BranchCategory): string {
  switch (category) {
    case "protected":
      switch (branch.protection) {
        case "default":
          return "Default branch";
        case "current":
          return "Checked out";
        default:
          return `Checked out in ${branch.worktree ?? "another worktree"}`;
      }
    case "merged":
      return `${capitalize(EVIDENCE_LABELS[branch.merged!.evidence])} ${branch.merged!.base}`;
    case "remoteDeleted":
      return `${branch.upstream} was deleted; ${commits(branch.uniqueCommits)} not on default branch`;
    case "stale":
    case "active":
      return `${commits(branch.uniqueCommits)} not on default branch`;
  }
}

function commits(count: number | null): string {
  if (count === null) return "unknown commits";
  return count === 1 ? "1 commit" : `${count} commits`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatRecent(nowUnix: number, thenUnix: number): string {
  const seconds = Math.max(0, nowUnix - thenUnix);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return formatAge(nowUnix, thenUnix);
}

export function formatAge(nowUnix: number, thenUnix: number): string {
  const days = Math.floor((nowUnix - thenUnix) / DAY_SECONDS);
  if (days < 1) return "today";
  if (days < 60) return `${days}d ago`;
  if (days < 730) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export type WorktreeState =
  { removable: true; label: string } | { removable: false; label: string };

export function worktreeState(worktree: WorktreeInfo): WorktreeState {
  if (worktree.isMain) return { removable: false, label: "Main worktree" };
  if (worktree.locked) return { removable: false, label: "Locked" };
  if (worktree.prunable) return { removable: true, label: "Directory missing; can be pruned" };
  if (!worktree.merged) return { removable: false, label: "Has unmerged commits" };
  if (worktree.dirty) return { removable: false, label: "Has uncommitted or untracked files" };
  return {
    removable: true,
    label: `${capitalize(EVIDENCE_LABELS[worktree.merged.evidence])} ${worktree.merged.base}`,
  };
}
