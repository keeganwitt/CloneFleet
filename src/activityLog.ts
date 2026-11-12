import { useSyncExternalStore } from "react";
import type { CommandRecord, Outcome } from "./types";

export type EntryStatus = Outcome["status"];

export interface LogEntry {
  id: number;
  timeMs: number;
  repo: string;
  label: string;
  status: EntryStatus;
  message: string;
  commands: CommandRecord[];
}

export const MAX_ENTRIES = 2000;

let entries: LogEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function recordAction(
  repo: string,
  label: string,
  outcome: { status: EntryStatus; message: string },
  commands: CommandRecord[],
) {
  if (commands.length === 0 && outcome.status !== "failed") return;
  const entry: LogEntry = {
    id: nextId++,
    timeMs: Date.now(),
    repo,
    label,
    status: outcome.status,
    message: outcome.message,
    commands,
  };
  entries = [entry, ...entries].slice(0, MAX_ENTRIES);
  emit();
}

export function summarizeItems(items: { status: EntryStatus; message: string }[]): {
  status: EntryStatus;
  message: string;
} {
  const status = items.some((i) => i.status === "failed")
    ? "failed"
    : items.every((i) => i.status === "skipped")
      ? "skipped"
      : "succeeded";
  return { status, message: items.map((i) => i.message).join("; ") };
}

export function clearLog() {
  entries = [];
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useActivityLog(): LogEntry[] {
  return useSyncExternalStore(subscribe, () => entries);
}

export function entryFailed(entry: LogEntry): boolean {
  return entry.status === "failed";
}

export function matchesLogSearch(entry: LogEntry, search: string): boolean {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [
    entry.repo,
    entry.label,
    entry.message,
    ...entry.commands.flatMap((c) => [c.args.join(" "), c.stdout, c.stderr]),
  ]
    .join("\n")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function formatLog(list: LogEntry[]): string {
  return [...list]
    .reverse()
    .map((entry) => {
      const lines = [
        `[${new Date(entry.timeMs).toISOString()}] ${entry.repo} — ${entry.label}: ${entry.status}`,
        entry.message,
      ];
      for (const { args, exitCode, stdout, stderr } of entry.commands) {
        lines.push(`  $ git ${args.join(" ")}  (exit ${exitCode ?? "signal"})`);
        for (const output of [stdout, stderr]) {
          if (output.trim())
            lines.push(
              ...output
                .trimEnd()
                .split("\n")
                .map((l) => `    ${l}`),
            );
        }
      }
      return lines.join("\n");
    })
    .join("\n\n");
}
