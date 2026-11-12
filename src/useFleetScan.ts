import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { RepoHealth } from "./types";

export const STALE_BRANCH_DAYS = 90;

export type ScanEntry =
  | { status: "done"; health: RepoHealth; scannedUnix: number }
  | { status: "error"; error: string; scannedUnix: number };

const currentUnixTime = () => Math.floor(Date.now() / 1000);

export function useFleetScan(paths: string[]) {
  const [entries, setEntries] = useState<Record<string, ScanEntry>>({});
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(new Set());
  const requested = useRef(new Set<string>());

  const finish = useCallback((path: string, entry: ScanEntry) => {
    setEntries((current) => ({ ...current, [path]: entry }));
    setInFlight((current) => {
      const next = new Set(current);
      next.delete(path);
      return next;
    });
  }, []);

  const request = useCallback(
    (path: string) =>
      api.repoHealth(path, STALE_BRANCH_DAYS).then(
        (health) => finish(path, { status: "done", health, scannedUnix: currentUnixTime() }),
        (error) =>
          finish(path, { status: "error", error: String(error), scannedUnix: currentUnixTime() }),
      ),
    [finish],
  );

  useEffect(() => {
    const fresh = paths.filter((path) => !requested.current.has(path));
    for (const path of fresh) requested.current.add(path);
    if (fresh.length === 0) return;
    void Promise.resolve().then(() => {
      setInFlight((current) => new Set([...current, ...fresh]));
      return Promise.all(fresh.map(request));
    });
  }, [paths, request]);

  const scan = useCallback(
    async (targets: string[]) => {
      setInFlight((current) => new Set([...current, ...targets]));
      await Promise.all(targets.map(request));
    },
    [request],
  );

  const healths: Record<string, RepoHealth | undefined> = {};
  let lastScannedUnix: number | undefined;
  for (const path of paths) {
    const entry = entries[path];
    if (entry?.status === "done") healths[path] = entry.health;
    if (entry && (lastScannedUnix === undefined || entry.scannedUnix > lastScannedUnix)) {
      lastScannedUnix = entry.scannedUnix;
    }
  }
  const pending = paths.filter((path) => !entries[path] || inFlight.has(path)).length;

  return { healths, entries, pending, lastScannedUnix, scan };
}
