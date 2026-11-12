import { useSyncExternalStore } from "react";
import type { CommandRecord } from "./types";

export interface LogEntry {
  id: number;
  timeMs: number;
  repo: string;
  label: string;
  command: CommandRecord;
}

export const MAX_ENTRIES = 5000;

let entries: LogEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function recordCommands(repo: string, label: string, commands: CommandRecord[]) {
  if (commands.length === 0) return;
  const timeMs = Date.now();
  const added = commands.map((command) => ({ id: nextId++, timeMs, repo, label, command }));
  entries = [...added.reverse(), ...entries].slice(0, MAX_ENTRIES);
  emit();
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
  return entry.command.exitCode !== 0;
}

export function matchesLogSearch(entry: LogEntry, search: string): boolean {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [
    entry.repo,
    entry.label,
    entry.command.args.join(" "),
    entry.command.stdout,
    entry.command.stderr,
  ]
    .join("\n")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function formatLog(list: LogEntry[]): string {
  return [...list]
    .reverse()
    .map((entry) => {
      const { args, exitCode, stdout, stderr } = entry.command;
      const lines = [
        `[${new Date(entry.timeMs).toISOString()}] ${entry.repo} (${entry.label})`,
        `$ git ${args.join(" ")}`,
        `exit ${exitCode ?? "signal"}`,
      ];
      if (stdout.trim()) lines.push(stdout.trimEnd());
      if (stderr.trim()) lines.push(stderr.trimEnd());
      return lines.join("\n");
    })
    .join("\n\n");
}
