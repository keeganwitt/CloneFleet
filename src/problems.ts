import type { RepoState } from "./state";
import type { RepoHealth } from "./types";

export type ProblemKind =
  | "authRequired"
  | "remoteUnreachable"
  | "statusError"
  | "inProgress"
  | "conflicts"
  | "diverged"
  | "unpushed"
  | "behind"
  | "notOnDefault"
  | "uncommitted"
  | "stashes"
  | "mergedBranches"
  | "staleBranches"
  | "removableWorktrees";

export type Section = "attention" | "updates" | "work" | "housekeeping";
export type Severity = "danger" | "warning" | "neutral";
export type Fix = "pull" | "checkoutDefault" | "reviewUnpushed" | "cleanup";

interface ProblemInfo {
  section: Section;
  severity: Severity;
  fix?: Fix;
  title: (repos: number, items: number) => string;
}

const repos = (n: number) => `${n} ${n === 1 ? "repository" : "repositories"}`;
const branches = (n: number) => `${n} ${n === 1 ? "branch" : "branches"}`;

export const PROBLEMS: Record<ProblemKind, ProblemInfo> = {
  authRequired: {
    section: "attention",
    severity: "danger",
    title: (n) => `${repos(n)} need authentication`,
  },
  remoteUnreachable: {
    section: "attention",
    severity: "warning",
    title: (n) => `${repos(n)} couldn't reach their remote`,
  },
  statusError: {
    section: "attention",
    severity: "danger",
    title: (n) => `${repos(n)} couldn't be read`,
  },
  inProgress: {
    section: "attention",
    severity: "danger",
    title: (n) => `${repos(n)} stopped mid-operation`,
  },
  conflicts: {
    section: "attention",
    severity: "danger",
    title: (n) => `${repos(n)} with conflicts`,
  },
  diverged: {
    section: "attention",
    severity: "warning",
    title: (n) => `${repos(n)} diverged from upstream`,
  },
  unpushed: {
    section: "attention",
    severity: "warning",
    fix: "reviewUnpushed",
    title: (n, items) => `${branches(items)} with unpushed commits in ${repos(n)}`,
  },
  behind: {
    section: "updates",
    severity: "warning",
    fix: "pull",
    title: (n) => `${repos(n)} behind upstream`,
  },
  notOnDefault: {
    section: "work",
    severity: "neutral",
    fix: "checkoutDefault",
    title: (n) => `${repos(n)} not on the default branch`,
  },
  uncommitted: {
    section: "work",
    severity: "neutral",
    title: (n) => `${repos(n)} with uncommitted changes`,
  },
  stashes: {
    section: "work",
    severity: "neutral",
    fix: "reviewUnpushed",
    title: (n, items) => `${items} ${items === 1 ? "stash" : "stashes"} in ${repos(n)}`,
  },
  mergedBranches: {
    section: "housekeeping",
    severity: "neutral",
    fix: "cleanup",
    title: (n, items) => `${branches(items)} merged in ${repos(n)}`,
  },
  staleBranches: {
    section: "housekeeping",
    severity: "neutral",
    fix: "cleanup",
    title: (n, items) => `${branches(items)} stale or with a deleted remote in ${repos(n)}`,
  },
  removableWorktrees: {
    section: "housekeeping",
    severity: "neutral",
    fix: "cleanup",
    title: (n, items) =>
      `${items} ${items === 1 ? "worktree" : "worktrees"} ready to remove in ${repos(n)}`,
  },
};

export const SECTIONS: [Section, string][] = [
  ["attention", "Needs attention"],
  ["updates", "Updates available"],
  ["work", "Work in progress"],
  ["housekeeping", "Housekeeping"],
];

const ORDER = Object.keys(PROBLEMS) as ProblemKind[];

export function repoProblems(repo: RepoState, health?: RepoHealth): [ProblemKind, number][] {
  const found: [ProblemKind, number][] = [];
  const outcome = repo.runningAction === undefined ? repo.result?.outcome : undefined;
  if (outcome?.status === "failed" && outcome.reason) {
    const auth =
      outcome.reason === "authenticationRequired" || outcome.reason === "hostKeyUnverified";
    found.push([auth ? "authRequired" : "remoteUnreachable", 1]);
  }
  if (repo.summaryError) found.push(["statusError", 1]);
  const summary = repo.summary;
  if (summary) {
    const ahead = summary.ahead ?? 0;
    const behind = summary.behind ?? 0;
    if (summary.operation) found.push(["inProgress", 1]);
    if (summary.conflicts > 0) found.push(["conflicts", 1]);
    if (ahead > 0 && behind > 0) found.push(["diverged", 1]);
    else if (behind > 0) found.push(["behind", 1]);
    if (summary.defaultBranch && summary.branch !== summary.defaultBranch) {
      found.push(["notOnDefault", 1]);
    }
    if (summary.trackedChanges > 0) found.push(["uncommitted", 1]);
  }
  if (health) {
    if (health.unpushedBranches > 0) found.push(["unpushed", health.unpushedBranches]);
    if (health.stashes > 0) found.push(["stashes", health.stashes]);
    if (health.mergedBranches > 0) found.push(["mergedBranches", health.mergedBranches]);
    const stale = health.staleBranches + health.remoteDeletedBranches;
    if (stale > 0) found.push(["staleBranches", stale]);
    if (health.removableWorktrees > 0)
      found.push(["removableWorktrees", health.removableWorktrees]);
  }
  return found;
}

export interface Card {
  kind: ProblemKind;
  paths: string[];
  items: number;
}

export interface Overview {
  cards: Card[];
  needsAttention: string[];
  healthy: string[];
}

export function buildOverview(
  paths: string[],
  states: Record<string, RepoState>,
  healths: Record<string, RepoHealth | undefined>,
): Overview {
  const cards = new Map<ProblemKind, Card>();
  const needsAttention: string[] = [];
  const healthy: string[] = [];
  for (const path of paths) {
    const repo = states[path];
    if (!repo) continue;
    const problems = repoProblems(repo, healths[path]);
    for (const [kind, items] of problems) {
      const card = cards.get(kind) ?? { kind, paths: [], items: 0 };
      card.paths.push(path);
      card.items += items;
      cards.set(kind, card);
    }
    const severities = problems.map(([kind]) => PROBLEMS[kind].severity);
    if (severities.some((s) => s !== "neutral")) needsAttention.push(path);
    else if (
      repo.summary &&
      problems.every(([kind]) => PROBLEMS[kind].section === "housekeeping")
    ) {
      healthy.push(path);
    }
  }
  return {
    cards: ORDER.flatMap((kind) => cards.get(kind) ?? []),
    needsAttention,
    healthy,
  };
}
