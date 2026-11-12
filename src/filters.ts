import { basename, isWithin } from "./format";
import type { RepoState } from "./state";
import type { RepoSummary } from "./types";

export type ChangesFilter = "all" | "clean" | "modified" | "untracked" | "inProgress";
export type SyncFilter = "all" | "upToDate" | "ahead" | "behind" | "diverged" | "noUpstream";

export interface Filters {
  directory: string;
  search: string;
  changes: ChangesFilter;
  sync: SyncFilter;
}

export const defaultFilters: Filters = { directory: "", search: "", changes: "all", sync: "all" };

export const CHANGES_OPTIONS: { value: ChangesFilter; label: string }[] = [
  { value: "all", label: "Any changes" },
  { value: "clean", label: "Clean" },
  { value: "modified", label: "Uncommitted changes" },
  { value: "untracked", label: "Untracked files" },
  { value: "inProgress", label: "Operation in progress" },
];

export const SYNC_OPTIONS: { value: SyncFilter; label: string }[] = [
  { value: "all", label: "Any sync state" },
  { value: "upToDate", label: "Up to date" },
  { value: "ahead", label: "Ahead" },
  { value: "behind", label: "Behind" },
  { value: "diverged", label: "Diverged" },
  { value: "noUpstream", label: "No upstream" },
];

function matchesChanges(summary: RepoSummary, filter: ChangesFilter): boolean {
  const modified = summary.trackedChanges > 0 || summary.conflicts > 0;
  switch (filter) {
    case "all":
      return true;
    case "clean":
      return !modified && summary.untracked === 0 && summary.operation === null;
    case "modified":
      return modified;
    case "untracked":
      return summary.untracked > 0;
    case "inProgress":
      return summary.operation !== null;
  }
}

function matchesSync(summary: RepoSummary, filter: SyncFilter): boolean {
  const tracked = summary.branch !== null && summary.upstream !== null;
  const ahead = (summary.ahead ?? 0) > 0;
  const behind = (summary.behind ?? 0) > 0;
  switch (filter) {
    case "all":
      return true;
    case "upToDate":
      return tracked && !ahead && !behind;
    case "ahead":
      return tracked && ahead;
    case "behind":
      return tracked && behind;
    case "diverged":
      return tracked && ahead && behind;
    case "noUpstream":
      return !tracked;
  }
}

function matchesSearch(repo: RepoState, search: string): boolean {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [basename(repo.path), repo.path, repo.summary?.branch ?? ""]
    .join("\n")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function isFiltering(filters: Filters): boolean {
  return (
    filters.directory !== "" ||
    filters.search.trim() !== "" ||
    filters.changes !== "all" ||
    filters.sync !== "all"
  );
}

export function matchesFilters(repo: RepoState, filters: Filters): boolean {
  if (filters.directory && !isWithin(repo.path, filters.directory)) return false;
  if (!matchesSearch(repo, filters.search)) return false;
  if (filters.changes === "all" && filters.sync === "all") return true;
  const summary = repo.summary;
  if (!summary) return false;
  return matchesChanges(summary, filters.changes) && matchesSync(summary, filters.sync);
}
