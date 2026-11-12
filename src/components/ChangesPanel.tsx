import { useEffect, useState } from "react";
import { api } from "../api";
import type { ChangeKind, FileChange, RepoSummary } from "../types";

const MAX_SHOWN = 500;

const BADGES: Record<ChangeKind, { letter: string; label: string }> = {
  conflicted: { letter: "U", label: "Conflicted" },
  modified: { letter: "M", label: "Modified" },
  added: { letter: "A", label: "Added" },
  deleted: { letter: "D", label: "Deleted" },
  renamed: { letter: "R", label: "Renamed" },
  copied: { letter: "C", label: "Copied" },
  typeChanged: { letter: "T", label: "Type changed" },
  untracked: { letter: "?", label: "Untracked" },
};

const ORDER: ChangeKind[] = Object.keys(BADGES) as ChangeKind[];

export function sortChanges(changes: FileChange[]): FileChange[] {
  return [...changes].sort(
    (a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.path.localeCompare(b.path),
  );
}

function stageLabel(change: FileChange): string | undefined {
  if (change.kind === "untracked" || change.kind === "conflicted") return undefined;
  if (change.staged && change.unstaged) return "partially staged";
  return change.staged ? "staged" : undefined;
}

function label(change: FileChange): string {
  return change.originalPath ? `${change.originalPath} → ${change.path}` : change.path;
}

interface Props {
  path: string;
  summary: RepoSummary | undefined;
  selected?: FileChange;
  onSelect?: (change: FileChange) => void;
}

type Loaded = { changes: FileChange[] } | { error: string };

export function ChangesPanel({ path, summary, selected, onSelect }: Props) {
  const [loaded, setLoaded] = useState<Loaded>();

  useEffect(() => {
    let cancelled = false;
    api.listChanges(path).then(
      (changes) => !cancelled && setLoaded({ changes: sortChanges(changes) }),
      (error) => !cancelled && setLoaded({ error: String(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [path, summary]);

  if (!loaded) return <p className="muted">Loading changes…</p>;
  if ("error" in loaded) return <p className="error">{loaded.error}</p>;
  if (loaded.changes.length === 0) return <p className="muted">No uncommitted changes.</p>;

  const hidden = loaded.changes.length - MAX_SHOWN;
  return (
    <ul className="change-list" aria-label="Changed files">
      {loaded.changes.slice(0, MAX_SHOWN).map((change) => {
        const badge = BADGES[change.kind];
        const stage = stageLabel(change);
        return (
          <li
            key={`${change.kind}:${change.path}`}
            className={selected?.path === change.path ? "selected" : undefined}
          >
            <span className={`change-badge change-${change.kind}`} title={badge.label}>
              {badge.letter}
            </span>
            {onSelect ? (
              <button
                className="file-button"
                aria-pressed={selected?.path === change.path}
                onClick={() => onSelect(change)}
              >
                <code>{label(change)}</code>
              </button>
            ) : (
              <code>{label(change)}</code>
            )}
            {stage && <span className="muted">{stage}</span>}
          </li>
        );
      })}
      {hidden > 0 && <li className="muted">…and {hidden} more</li>}
    </ul>
  );
}
