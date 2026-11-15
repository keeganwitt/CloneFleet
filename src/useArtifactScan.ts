import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { ArtifactReport } from "./types";

export type ArtifactScan =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; report: ArtifactReport };

export function useArtifactScan(paths: string[]) {
  const [scans, setScans] = useState<Record<string, ArtifactScan>>({});
  const requested = useRef(new Set<string>());

  const request = useCallback(async (path: string) => {
    setScans((current) => ({ ...current, [path]: { status: "loading" } }));
    let scan: ArtifactScan;
    try {
      scan = { status: "loaded", report: await api.scanArtifacts(path) };
    } catch (error) {
      scan = { status: "error", error: String(error) };
    }
    setScans((current) => ({ ...current, [path]: scan }));
  }, []);

  useEffect(() => {
    const fresh = paths.filter((path) => !requested.current.has(path));
    for (const path of fresh) requested.current.add(path);
    if (fresh.length === 0) return;
    void Promise.resolve().then(() => Promise.all(fresh.map(request)));
  }, [paths, request]);

  const scan = useCallback(
    async (targets: string[]) => {
      await Promise.all(targets.map(request));
    },
    [request],
  );

  return { scans, scan };
}
