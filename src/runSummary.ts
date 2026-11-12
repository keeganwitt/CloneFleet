import { FAILURE_REASON_LABELS, SKIP_REASON_LABELS } from "./actionLabels";
import type { RepoState } from "./state";
import type { Outcome } from "./types";

export interface Run {
  id: number;
  label: string;
  paths: string[];
  cancelled?: boolean;
}

export type RunStatus = Outcome["status"];

export interface RunSummary {
  running: number;
  byStatus: Record<RunStatus, string[]>;
  reasons: [label: string, count: number][];
}

export function summarizeRun(run: Run, repos: Record<string, RepoState>): RunSummary {
  const byStatus: Record<RunStatus, string[]> = { succeeded: [], skipped: [], failed: [] };
  const reasons = new Map<string, number>();
  let running = 0;
  for (const path of run.paths) {
    const repo = repos[path];
    if (!repo) continue;
    if (repo.runningAction !== undefined || !repo.result) {
      running += 1;
      continue;
    }
    const outcome = repo.result.outcome;
    byStatus[outcome.status].push(path);
    const label =
      outcome.status === "skipped"
        ? SKIP_REASON_LABELS[outcome.reason]
        : outcome.status === "failed" && outcome.reason
          ? FAILURE_REASON_LABELS[outcome.reason]
          : undefined;
    if (label) reasons.set(label, (reasons.get(label) ?? 0) + 1);
  }
  return { running, byStatus, reasons: [...reasons].sort((a, b) => b[1] - a[1]) };
}
