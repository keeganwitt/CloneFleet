import { basename } from "../format";
import type { RootView } from "../types";

interface Props {
  roots: RootView[];
  excludedCount: number;
  onRemoveDirectory: (path: string) => void;
  onRescan: () => void;
  onRestoreExcluded: () => void;
}

export function WorkspaceBar({
  roots,
  excludedCount,
  onRemoveDirectory,
  onRescan,
  onRestoreExcluded,
}: Props) {
  if (roots.length === 0) return null;
  return (
    <div className="toolbar workspace-bar" role="group" aria-label="Directories">
      {roots.map((root) => (
        <span
          key={root.path}
          className={`chip${root.missing ? " chip-missing" : ""}`}
          title={root.path}
        >
          {basename(root.path)}
          <span className="muted">
            {root.missing
              ? "missing"
              : `${root.repoCount} ${root.repoCount === 1 ? "repo" : "repos"}`}
          </span>
          <button
            className="chip-remove"
            aria-label={`Remove directory ${root.path}`}
            onClick={() => onRemoveDirectory(root.path)}
          >
            ×
          </button>
        </span>
      ))}
      <button onClick={onRescan} title="Looks for repositories up to 4 levels below each directory">
        Rescan
      </button>
      {excludedCount > 0 && (
        <span className="muted">
          {excludedCount} removed {excludedCount === 1 ? "repository" : "repositories"} ·{" "}
          <button className="link" onClick={onRestoreExcluded}>
            Restore
          </button>
        </span>
      )}
    </div>
  );
}
