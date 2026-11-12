import { basename } from "./format";
import type { RepoState } from "./state";

export type SortKey = "name" | "branch" | "changes" | "sync" | "fetched" | "result";
export type SortDirection = "ascending" | "descending";

export interface Sort {
  key: SortKey;
  direction: SortDirection;
}

export const defaultSort: Sort = { key: "name", direction: "ascending" };

const RESULT_RANK = { failed: 0, skipped: 1, succeeded: 2 } as const;

function value(repo: RepoState, key: SortKey): string | number | undefined {
  const summary = repo.summary;
  switch (key) {
    case "name":
      return basename(repo.path).toLowerCase();
    case "branch":
      return summary?.branch?.toLowerCase();
    case "changes":
      return summary && summary.trackedChanges + summary.conflicts + summary.untracked;
    case "sync":
      return summary && (summary.behind ?? 0) * 1_000_000 + (summary.ahead ?? 0);
    case "fetched":
      return summary?.lastFetchUnix ?? undefined;
    case "result":
      return repo.result && RESULT_RANK[repo.result.outcome.status];
  }
}

export function sortPaths(paths: string[], repos: Record<string, RepoState>, sort: Sort): string[] {
  const sign = sort.direction === "ascending" ? 1 : -1;
  return [...paths].sort((a, b) => {
    const left = value(repos[a], sort.key);
    const right = value(repos[b], sort.key);
    if (left !== right) {
      if (left === undefined) return 1;
      if (right === undefined) return -1;
      return (left < right ? -1 : 1) * sign;
    }
    return basename(a).localeCompare(basename(b));
  });
}

export function nextSort(current: Sort, key: SortKey): Sort {
  if (current.key !== key) {
    const descendingFirst = key === "changes" || key === "sync";
    return { key, direction: descendingFirst ? "descending" : "ascending" };
  }
  return { key, direction: current.direction === "ascending" ? "descending" : "ascending" };
}
