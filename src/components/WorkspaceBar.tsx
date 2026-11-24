import { uniqueLabels } from "../format";
import type { RootView } from "../types";

interface Props {
  roots: RootView[];
  excludedCount: number;
  directory: string;
  onDirectory: (path: string) => void;
  onAdd: () => void;
  onRemoveDirectory: (path: string) => void;
  onRescan: () => void;
  onRestoreExcluded: () => void;
}

export function WorkspaceBar({
  roots,
  excludedCount,
  directory,
  onDirectory,
  onAdd,
  onRemoveDirectory,
  onRescan,
  onRestoreExcluded,
}: Props) {
  const labels = uniqueLabels(roots.map((root) => root.path));
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
      {roots.length > 0 && (
        <details className="toolbar-menu workspace-menu">
          <summary>Manage directories</summary>
          <div className="toolbar-menu-content">
            <button onClick={onAdd}>Add directory…</button>
            <button onClick={onRescan}>Rescan directories</button>
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
            {excludedCount > 0 && (
              <button onClick={onRestoreExcluded}>
                Restore {excludedCount} hidden {excludedCount === 1 ? "repository" : "repositories"}
              </button>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
