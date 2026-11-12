import type { RepoState } from "./state";

export interface Freshness {
  oldestFetchUnix: number | null;
  neverFetched: number;
}

export function fleetFreshness(paths: string[], repos: Record<string, RepoState>): Freshness {
  let oldestFetchUnix: number | null = null;
  let neverFetched = 0;
  for (const path of paths) {
    const summary = repos[path]?.summary;
    if (!summary?.hasRemotes) continue;
    if (summary.lastFetchUnix === null) {
      neverFetched += 1;
    } else if (oldestFetchUnix === null || summary.lastFetchUnix < oldestFetchUnix) {
      oldestFetchUnix = summary.lastFetchUnix;
    }
  }
  return { oldestFetchUnix, neverFetched };
}

export const STALE_FETCH_SECONDS = 24 * 60 * 60;

export function isStale(nowUnix: number, lastFetchUnix: number | null): boolean {
  return lastFetchUnix === null || nowUnix - lastFetchUnix >= STALE_FETCH_SECONDS;
}
