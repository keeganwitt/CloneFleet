import { useMemo, useState } from "react";
import { api } from "./api";
import { CleanupView } from "./components/CleanupView";
import { UnpushedView } from "./components/UnpushedView";
import { FilterBar } from "./components/FilterBar";
import { RepoRow } from "./components/RepoRow";
import { defaultFilters, matchesFilters, type Filters } from "./filters";
import { pendingFollowUps } from "./followUps";
import { describePushes } from "./push";
import { isBusy } from "./state";
import type { Action, PushPlan } from "./types";

type View = { kind: "cleanup" | "unpushed"; paths: string[] };
import { useRepoManager } from "./useRepoManager";
import "./App.css";

function App() {
  const manager = useRepoManager();
  const { state } = manager;
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [view, setView] = useState<View>();

  const visible = useMemo(
    () => state.order.filter((path) => matchesFilters(state.repos[path], filters)),
    [state.order, state.repos, filters],
  );
  const targets = visible.filter((path) => state.selected.has(path));
  const hiddenSelected = state.selected.size - targets.length;
  const actionsDisabled = targets.length === 0 || targets.some((p) => isBusy(state.repos[p]));
  const allVisibleSelected = targets.length > 0 && targets.length === visible.length;
  const pendingPushes = pendingFollowUps(visible, state.repos, "push").map(
    ([path, action]): [string, PushPlan] => [path, action.plan],
  );
  const pendingRenames = pendingFollowUps(visible, state.repos, "renameBranch");
  const forcedPushes = pendingPushes.filter(([, plan]) => plan.force).length;

  const push = async (pushes: [string, PushPlan][], alwaysConfirm: boolean) => {
    const needsConfirm = alwaysConfirm || pushes.some(([, plan]) => plan.force);
    if (needsConfirm && !(await api.confirmDestructive(describePushes(pushes), "Push"))) return;
    await manager.runActions(pushes.map(([path, plan]) => [path, { type: "push", plan }]));
  };

  const runFollowUp = (path: string, action: Action) =>
    action.type === "push" ? push([[path, action.plan]], false) : manager.runAction([path], action);
  const run = (action: Action) => manager.runAction(targets, action);

  return (
    <main>
      <header className="toolbar">
        <h1>CloneFleet</h1>
        <button onClick={manager.addDirectories}>Add directory…</button>
      </header>

      {manager.notice && (
        <div className="notice" role="status">
          {manager.notice}
          <button className="link" onClick={manager.dismissNotice} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {view?.kind === "cleanup" ? (
        <CleanupView
          paths={view.paths}
          onClose={() => setView(undefined)}
          onChanged={manager.refreshSummaries}
        />
      ) : view?.kind === "unpushed" ? (
        <UnpushedView
          paths={view.paths}
          onClose={() => setView(undefined)}
          onChanged={manager.refreshSummaries}
        />
      ) : state.order.length === 0 ? (
        <p className="empty muted">
          No repositories yet. Add a directory to scan it for git repositories.
        </p>
      ) : (
        <>
          <FilterBar filters={filters} onChange={setFilters} />
          <div className="toolbar">
            <span className="muted">
              {targets.length} of {visible.length} selected
              {hiddenSelected > 0 && ` (${hiddenSelected} hidden by filters)`}
            </span>
            <button
              disabled={targets.length === 0}
              onClick={() => manager.refreshSummaries(targets)}
            >
              Refresh status
            </button>
            <button disabled={actionsDisabled} onClick={() => manager.removeRepos(targets)}>
              Remove from list
            </button>
          </div>
          <div className="toolbar" role="group" aria-label="Update">
            <span className="toolbar-label muted">Update</span>
            <button disabled={actionsDisabled} onClick={() => run({ type: "fetch" })}>
              Fetch
            </button>
            <button disabled={actionsDisabled} onClick={() => run({ type: "pull" })}>
              Pull
            </button>
            <button disabled={actionsDisabled} onClick={() => run({ type: "checkoutDefault" })}>
              Checkout default branch
            </button>
            <button disabled={actionsDisabled} onClick={() => run({ type: "rebaseFork" })}>
              Rebase fork on upstream
            </button>
            <button disabled={actionsDisabled} onClick={() => run({ type: "syncDefaultBranch" })}>
              Check default branch
            </button>
          </div>
          <div className="toolbar" role="group" aria-label="Review">
            <span className="toolbar-label muted">Review</span>
            <button
              disabled={actionsDisabled}
              onClick={() => setView({ kind: "unpushed", paths: targets })}
            >
              Unpushed work &amp; stashes…
            </button>
            <button
              disabled={actionsDisabled}
              onClick={() => setView({ kind: "cleanup", paths: targets })}
            >
              Clean up branches…
            </button>
          </div>

          {pendingPushes.length > 0 && (
            <div className="notice" role="status">
              <span>
                {pendingPushes.length}{" "}
                {pendingPushes.length === 1 ? "repository has" : "repositories have"} rebased
                commits to push
                {forcedPushes > 0 && ` (${forcedPushes} need a force push)`}.
              </span>
              <button onClick={() => push(pendingPushes, true)}>Push all…</button>
            </div>
          )}

          {pendingRenames.length > 0 && (
            <div className="notice" role="status">
              <span>
                {pendingRenames.length}{" "}
                {pendingRenames.length === 1 ? "repository's" : "repositories'"} default branch was
                renamed on the remote.
              </span>
              <button onClick={() => manager.runActions(pendingRenames)}>
                Rename local branches
              </button>
            </div>
          )}

          <table>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={allVisibleSelected}
                    disabled={visible.length === 0}
                    onChange={() => manager.setSelection(visible, !allVisibleSelected)}
                  />
                </th>
                <th>Repository</th>
                <th>Branch</th>
                <th>Changes</th>
                <th>Sync</th>
                <th>Last result</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((path) => (
                <RepoRow
                  key={path}
                  repo={state.repos[path]}
                  selected={state.selected.has(path)}
                  onToggle={() => manager.toggleSelected(path)}
                  onAction={(action) => manager.runAction([path], action)}
                  onFollowUp={(action) => runFollowUp(path, action)}
                />
              ))}
            </tbody>
          </table>
          {visible.length === 0 && (
            <p className="empty muted">No repositories match the current filters.</p>
          )}
        </>
      )}
    </main>
  );
}

export default App;
