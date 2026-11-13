import type { Action, FailureReason, SkipReason } from "./types";

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
  setRemoteUrl: "Update remote URL",
};

export const FAILURE_REASON_LABELS: Record<FailureReason, string> = {
  authenticationRequired: "authentication required",
  hostKeyUnverified: "unknown host key",
  repositoryNotFound: "remote not found",
  networkUnreachable: "network unreachable",
  timedOut: "timed out",
};

export const FAILURE_HINTS: Partial<Record<FailureReason, string>> = {
  authenticationRequired:
    "Git can't ask for a password from here. Use a credential helper (for example the macOS Keychain or Git Credential Manager) or an SSH key loaded in your SSH agent.",
  hostKeyUnverified:
    "This host's SSH key isn't trusted yet. Connect once from a terminal (for example `ssh -T git@host`) to accept it.",
  repositoryNotFound: "The remote URL may be wrong, renamed, or deleted.",
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
  cancelled: "cancelled",
  notIgnored: "not ignored by git",
  notArtifact: "not a build directory",
  containsRepository: "contains a repository",
  tierHidden: "category not shown",
};
