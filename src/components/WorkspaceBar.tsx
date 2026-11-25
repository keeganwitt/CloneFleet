import { uniqueLabels } from "../format";
import type { RootView } from "../types";

interface Props {
  roots: RootView[];
  recent: string[][];
  excludedCount: number;
  directory: string;
  onDirectory: (path: string) => void;
  onAdd: () => void;
  onOpen: () => void;
  onOpenRecent: (roots: string[]) => void;
  onClearRecent: () => void;
  onRemoveDirectory: (path: string) => void;
  onRescan: () => void;
  onRestoreExcluded: () => void;
}

export function WorkspaceBar({
  roots,
  recent,
  excludedCount,
  directory,
  onDirectory,
  onAdd,
  onOpen,
  onOpenRecent,
  onClearRecent,
  onRemoveDirectory,
  onRescan,
  onRestoreExcluded,
}: Props) {
  const paths = roots.map((root) => root.path);
  const labels = uniqueLabels(paths);
  const recentLabels = uniqueLabels([...paths, ...recent.flat()]);
  return (
    <div className="workspace-bar" role="group" aria-label="Directories">
      <label>
        <span className="workspace-label">Workspace</span>
        <select
          value={directory}
          aria-label="Filter by directory"
          onChange={(event) => onDirectory(event.target.value)}
        >
          <option value="">All directories</option>
          {roots.map((root) => (
            <option key={root.path} value={root.path}>
              {labels.get(root.path)}
              {root.missing ? " (missing)" : ""}
            </option>
          ))}
        </select>
      </label>
      <details className="toolbar-menu workspace-menu">
        <summary>Manage directories</summary>
        <div className="toolbar-menu-content">
          {roots.length > 0 && <button onClick={onAdd}>Add directory…</button>}
          <button onClick={onOpen}>
            {roots.length > 0 ? "Replace open directories…" : "Open directory…"}
          </button>
          {recent.length > 0 && (
            <select
              aria-label="Open recent"
              value=""
              onChange={(event) => {
                const value = event.target.value;
                if (!value) return;
                if (value === "clear") onClearRecent();
                else {
                  const entry = recent[Number(value)];
                  if (entry) onOpenRecent(entry);
                }
              }}
            >
              <option value="">Open recent…</option>
              {recent.map((entry, index) => (
                <option key={entry.join("\n")} value={index}>
                  {entry.map((root) => recentLabels.get(root)).join(" + ")}
                </option>
              ))}
              <option value="clear">Clear recent</option>
            </select>
          )}
          {roots.length > 0 && <button onClick={onRescan}>Rescan directories</button>}
          {roots.map((root) => (
            <button
              key={root.path}
              onClick={() => onRemoveDirectory(root.path)}
              title={root.path}
              aria-label={`Remove directory ${root.path}`}
            >
              Remove {labels.get(root.path)} <span className="muted">{root.repoCount} repos</span>
            </button>
          ))}
          {roots.length > 0 && excludedCount > 0 && (
            <button onClick={onRestoreExcluded}>
              Restore {excludedCount} hidden {excludedCount === 1 ? "repository" : "repositories"}
            </button>
          )}
        </div>
      </details>
    </div>
  );
}
