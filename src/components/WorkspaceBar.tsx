import { useEffect, useId, useRef, useState } from "react";
import { uniqueLabels } from "../format";
import type { RootView } from "../types";
import { SidebarIcon } from "./SidebarIcon";

type WorkspacePanel = "scope" | "recent" | "manage";

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
  const [panel, setPanel] = useState<WorkspacePanel>();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const paths = roots.map((root) => root.path);
  const labels = uniqueLabels(paths);
  const recentLabels = uniqueLabels([...paths, ...recent.flat()]);
  const selectedRoot = roots.find((root) => root.path === directory);
  const scopeLabel = selectedRoot
    ? `${labels.get(selectedRoot.path)}${selectedRoot.missing ? " (missing)" : ""}`
    : "All directories";

  useEffect(() => {
    if (!panel) return;
    const content = panelRef.current;
    if (content) {
      content.scrollTop = 0;
      content.focus({ preventScroll: true });
    }
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !workspaceRef.current?.contains(event.target))
        setPanel(undefined);
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
    };
  }, [panel]);

  const closePanel = () => {
    setPanel(undefined);
    triggerRef.current?.focus();
  };
  const activate = (action: () => void) => {
    closePanel();
    action();
  };
  const chooseDirectory = (path: string) => {
    closePanel();
    if (path !== directory) onDirectory(path);
  };
  const panelLabel =
    panel === "recent"
      ? "Open recent"
      : panel === "manage"
        ? "Manage open directories"
        : "Workspace";

  return (
    <div
      className="workspace-dropdown"
      ref={workspaceRef}
      role="group"
      aria-label="Directories"
      onKeyDown={(event) => {
        if (!panel || event.key !== "Escape") return;
        event.stopPropagation();
        closePanel();
      }}
    >
      <span className="workspace-label">Workspace</span>
      <button
        ref={triggerRef}
        className="workspace-trigger"
        aria-label={`Workspace (${scopeLabel})`}
        aria-expanded={panel !== undefined}
        aria-controls={panel ? panelId : undefined}
        title={directory || undefined}
        onClick={() => (panel ? closePanel() : setPanel("scope"))}
      >
        <SidebarIcon name="workspace" />
        <span className="workspace-trigger-label">{scopeLabel}</span>
        <span className="workspace-chevron" aria-hidden="true" />
      </button>
      {panel && (
        <div
          id={panelId}
          ref={panelRef}
          className="toolbar-menu-content workspace-panel"
          tabIndex={-1}
          role="group"
          aria-label={panelLabel}
        >
          {panel !== "scope" && (
            <div className="workspace-panel-heading">
              <button aria-label="Back to workspace" onClick={() => setPanel("scope")}>
                <span aria-hidden="true">←</span>
              </button>
              <strong>{panelLabel}</strong>
            </div>
          )}
          {panel === "scope" && (
            <>
              <button
                className="workspace-scope-option"
                aria-pressed={!directory}
                onClick={() => chooseDirectory("")}
              >
                <span aria-hidden="true">{!directory && "✓"}</span>
                <span>All directories</span>
              </button>
              {roots.map((root) => (
                <button
                  key={root.path}
                  className="workspace-scope-option"
                  title={root.path}
                  aria-pressed={directory === root.path}
                  onClick={() => chooseDirectory(root.path)}
                >
                  <span aria-hidden="true">{directory === root.path && "✓"}</span>
                  <span>
                    {labels.get(root.path)}
                    {root.missing ? " (missing)" : ""}
                  </span>{" "}
                  <span className="muted">
                    {root.repoCount} {root.repoCount === 1 ? "repo" : "repos"}
                  </span>
                </button>
              ))}
              <hr />
              {roots.length > 0 && <button onClick={() => activate(onAdd)}>Add directory…</button>}
              <button onClick={() => activate(onOpen)}>
                {roots.length > 0 ? "Replace open directories…" : "Open directory…"}
              </button>
              {recent.length > 0 && (
                <button className="workspace-subpanel" onClick={() => setPanel("recent")}>
                  Open recent <span aria-hidden="true">→</span>
                </button>
              )}
              {roots.length > 0 && (
                <>
                  <button onClick={() => activate(onRescan)}>Rescan directories</button>
                  <button className="workspace-subpanel" onClick={() => setPanel("manage")}>
                    Manage open directories <span aria-hidden="true">→</span>
                  </button>
                </>
              )}
            </>
          )}
          {panel === "recent" && (
            <>
              {recent.map((entry) => (
                <button
                  key={entry.join("\n")}
                  title={entry.join("\n")}
                  onClick={() => activate(() => onOpenRecent(entry))}
                >
                  {entry.map((root) => recentLabels.get(root)).join(" + ")}
                </button>
              ))}
              <hr />
              <button onClick={() => activate(onClearRecent)}>Clear recent</button>
            </>
          )}
          {panel === "manage" && (
            <>
              {roots.map((root) => (
                <button
                  key={root.path}
                  title={root.path}
                  aria-label={`Remove directory ${root.path}`}
                  onClick={() => activate(() => onRemoveDirectory(root.path))}
                >
                  Remove {labels.get(root.path)}
                </button>
              ))}
              {excludedCount > 0 && (
                <button onClick={() => activate(onRestoreExcluded)}>
                  Restore {excludedCount} hidden{" "}
                  {excludedCount === 1 ? "repository" : "repositories"}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
