export type InProgressOperation = "rebase" | "merge" | "cherryPick" | "revert" | "bisect";

export interface RepoSummary {
  branch: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  trackedChanges: number;
  untracked: number;
  conflicts: number;
  operation: InProgressOperation | null;
  lastFetchUnix: number | null;
  defaultBranch: string | null;
  mainBranches: string[];
  defaultOverridden: boolean;
}

export type Action =
  | { type: "checkoutDefault" }
  | { type: "pull" }
  | { type: "stash" }
  | { type: "commit"; message: string }
  | { type: "rebaseFork" }
  | { type: "push"; plan: PushPlan }
  | { type: "fetch" }
  | { type: "syncDefaultBranch" }
  | { type: "renameBranch"; remote: string; from: string; to: string }
  | { type: "setRemoteUrl"; remote: string; url: string };

export interface PushPlan {
  remote: string;
  branch: string;
  commits: number;
  force: boolean;
  expectedRemoteSha: string | null;
}

export type SkipReason =
  | "uncommittedChanges"
  | "operationInProgress"
  | "detachedHead"
  | "noUpstream"
  | "noDefaultBranch"
  | "protected"
  | "notMerged"
  | "worktreeDirty"
  | "worktreeLocked"
  | "notFound"
  | "noUpstreamRemote"
  | "notOnDefaultBranch"
  | "noRemote"
  | "alreadyExists"
  | "cancelled";

export type Outcome =
  | { status: "succeeded"; message: string }
  | { status: "skipped"; reason: SkipReason; message: string }
  | { status: "failed"; message: string; reason?: FailureReason | null };

export type FailureReason =
  | "authenticationRequired"
  | "hostKeyUnverified"
  | "repositoryNotFound"
  | "networkUnreachable"
  | "timedOut";

export interface CommandRecord {
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ActionResult {
  outcome: Outcome;
  followUp: Action | null;
  commands: CommandRecord[];
}

export type MergeEvidence = "ancestor" | "patchEquivalent" | "squashed";

export interface Merged {
  evidence: MergeEvidence;
  base: string;
}

export type Protection = "default" | "current" | "checkedOutInWorktree";

export interface BranchInfo {
  name: string;
  sha: string;
  upstream: string | null;
  upstreamGone: boolean;
  lastCommitUnix: number;
  author: string;
  subject: string;
  uniqueCommits: number | null;
  merged: Merged | null;
  protection: Protection | null;
  worktree: string | null;
}

export interface WorktreeInfo {
  path: string;
  head: string | null;
  branch: string | null;
  isMain: boolean;
  locked: boolean;
  prunable: boolean;
  dirty: boolean | null;
  merged: Merged | null;
}

export interface BranchReport {
  defaultBranch: string | null;
  bases: string[];
  branches: BranchInfo[];
  worktrees: WorktreeInfo[];
  warnings: string[];
}

export type ItemOutcome = Outcome & { item: string };

export interface CleanupResult {
  items: ItemOutcome[];
  commands: CommandRecord[];
}

export type ChangeKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "typeChanged"
  | "conflicted"
  | "untracked";

export interface FileChange {
  path: string;
  originalPath: string | null;
  kind: ChangeKind;
  staged: boolean;
  unstaged: boolean;
}

export interface UnpushedBranch {
  name: string;
  upstream: string | null;
  upstreamGone: boolean;
  commits: number;
  lastCommitUnix: number;
  merged: Merged | null;
}

export interface StashEntry {
  index: number;
  sha: string;
  createdUnix: number;
  message: string;
}

export interface UnpushedReport {
  hasRemotes: boolean;
  branches: UnpushedBranch[];
  stashes: StashEntry[];
  dirtyWorktrees: string[];
  warnings: string[];
}

export interface RootView {
  path: string;
  repoCount: number;
  missing: boolean;
}

export interface WorkspaceView {
  roots: RootView[];
  repos: string[];
  excludedCount: number;
  recent: string[][];
}

export interface BranchSettings {
  primary: string | null;
  additional: string[];
}

export interface CommitInfo {
  sha: string;
  author: string;
  dateUnix: number;
  subject: string;
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  additions: number | null;
  deletions: number | null;
  patch: string;
  truncated: boolean;
}

export interface BranchDiff {
  branch: string;
  base: string;
  commits: CommitInfo[];
  commitsTruncated: boolean;
  files: FileDiff[];
}

export type Theme = "system" | "light" | "dark";

export interface AppSettings {
  gitPath: string | null;
  theme: Theme;
  reopenLast: boolean;
  rememberRecent: boolean;
}

export interface GitInfo {
  path: string | null;
  version: string | null;
  error: string | null;
}

export interface SettingsView {
  settings: AppSettings;
  detectedGit: string | null;
  activeGit: GitInfo;
}

export interface RepoHealth {
  mergedBranches: number;
  remoteDeletedBranches: number;
  staleBranches: number;
  removableWorktrees: number;
  unpushedBranches: number;
  stashes: number;
  warnings: string[];
}

export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string | null;
}

export type RemoteStatus =
  "ok" | "redirected" | "notFound" | "authenticationRequired" | "unreachable" | "error";

export interface RemoteCheck {
  name: string;
  status: RemoteStatus;
  redirectUrl: string | null;
  message: string | null;
}
