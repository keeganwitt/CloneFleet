import type { Action, SkipReason } from "./types";

export const ACTION_LABELS: Record<Action["type"], string> = {
  checkoutDefault: "Checkout default branch",
  pull: "Pull",
  stash: "Stash",
  commit: "Commit",
  rebaseFork: "Rebase fork",
  push: "Push",
  fetch: "Fetch",
  syncDefaultBranch: "Check default branch",
  renameBranch: "Rename branch",
};

export const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  uncommittedChanges: "uncommitted changes",
  operationInProgress: "operation in progress",
  detachedHead: "detached HEAD",
  noUpstream: "no upstream",
  noDefaultBranch: "no default branch",
  protected: "protected",
  notMerged: "not merged",
  worktreeDirty: "dirty worktree",
  worktreeLocked: "locked worktree",
  notFound: "not found",
  noUpstreamRemote: "no upstream remote",
  notOnDefaultBranch: "not on default branch",
  noRemote: "no remote",
  alreadyExists: "already exists",
};
