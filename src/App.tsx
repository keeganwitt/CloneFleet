import { useState } from "react";
import { api } from "./api";
import { ActionBar } from "./components/ActionBar";
import { RunSummaryBar } from "./components/RunSummaryBar";
import { formatAge } from "./cleanup";
import { fleetFreshness, isStale } from "./freshness";
import { summarizeRun, type RunStatus } from "./runSummary";
import { useNow } from "./useNow";
import { CleanupView } from "./components/CleanupView";
import { RepoDetailPanel, type DetailTab } from "./components/RepoDetailPanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { useSettings } from "./useSettings";
import { UnpushedView } from "./components/UnpushedView";
import { FilterBar } from "./components/FilterBar";
import { WorkspaceBar } from "./components/WorkspaceBar";
import { basename } from "./format";
import { RepoRow } from "./components/RepoRow";
import { defaultFilters, matchesFilters, type Filters } from "./filters";
import { pendingFollowUps } from "./followUps";
import { describePushes } from "./push";
import { isBusy } from "./state";
import type { Action, PushPlan } from "./types";
import { useRepoManager } from "./useRepoManager";

type View = { kind: "cleanup" | "unpushed"; paths: string[] };
import "./App.css";

function App() {
  const manager = useRepoManager();
  const settings = useSettings();
  const [showSettings, setShowSettings] = useState(false);
  const { state } = manager;
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [view, setView] = useState<View>();
  const [resultFilter, setResultFilter] = useState<RunStatus>();
  const [anchor, setAnchor] = useState<string>();
  const [detail, setDetail] = useState<{ path: string; tab: DetailTab; branch?: string }>();
  const nowUnix = useNow();

  const runSummary = manager.lastRun && summarizeRun(manager.lastRun, state.repos);
  const resultPaths =
    resultFilter && runSummary ? new Set(runSummary.byStatus[resultFilter]) : undefined;
  const visible = state.order.filter(
    (path) => (!resultPaths || resultPaths.has(path)) && matchesFilters(state.repos[path], filters),
  );
  const targets = visible.filter((path) => state.selected.has(path));
  const hiddenSelected = state.selected.size - targets.length;
  const busy = targets.some((p) => isBusy(state.repos[p]));
  const allVisibleSelected = targets.length > 0 && targets.length === visible.length;
  const freshness = fleetFreshness(visible, state.repos);

  const toggle = (path: string, extendRange: boolean) => {
    const from = anchor ? visible.indexOf(anchor) : -1;
    const to = visible.indexOf(path);
    if (extendRange && from >= 0 && to >= 0) {
      const range = visible.slice(Math.min(from, to), Math.max(from, to) + 1);
      manager.setSelection(range, !state.selected.has(path));
    } else {
      manager.toggleSelected(path);
    }
    setAnchor(path);
  };
  const pendingPushes = pendingFollowUps(visible, state.repos, "push").map(
    ([path, action]): [string, PushPlan] => [path, action.plan],
  );
  const pendingRenames = pendingFollowUps(visible, state.repos, "renameBranch");
  const forcedPushes = pendingPushes.filter(([, plan]) => plan.force).length;

  const push = async (pushes: [string, PushPlan][], alwaysConfirm: boolean) => {
    const needsConfirm = alwaysConfirm || pushes.some(([, plan]) => plan.force);
    if (needsConfirm && !(await api.confirmDestructive(describePushes(pushes), "Push"))) return;
    await manager.runBulk(pushes.map(([path, plan]) => [path, { type: "push", plan }]));
  };

  const runFollowUp = (path: string, action: Action) =>
    action.type === "push" ? push([[path, action.plan]], false) : manager.runAction([path], action);
  const runOn = (paths: string[], action: Action) => {
    setResultFilter(undefined);
    return manager.runBulk(paths.map((path): [string, Action] => [path, action]));
  };

  return (
    <main>
      <header className="toolbar">
        <h1>CloneFleet</h1>
        <button onClick={manager.openDirectories}>Open directory…</button>
        <button onClick={manager.addDirectories}>Add directory…</button>
        {manager.workspace.recent.length > 0 && (
          <select
            aria-label="Open recent"
            value=""
            onChange={(event) => {
              const entry = manager.workspace.recent[Number(event.target.value)];
              if (entry) {
                setFilters(defaultFilters);
                void manager.openRecent(entry);
              }
            }}
          >
            <option value="">Recent…</option>
            {manager.workspace.recent.map((roots, index) => (
              <option key={roots.join("\n")} value={index}>
                {roots.map(basename).join(" + ")}
              </option>
            ))}
          </select>
        )}
        <span className="spacer" />
        <button disabled={!settings.view} onClick={() => setShowSettings(true)}>
          Settings
        </button>
      </header>

      {settings.view?.activeGit.error && (
        <div className="notice error" role="alert">
          {settings.view.activeGit.error}
          <button className="link" onClick={() => setShowSettings(true)}>
            Open settings
          </button>
        </div>
      )}

      {!view && (
        <WorkspaceBar
          roots={manager.workspace.roots}
          excludedCount={manager.workspace.excludedCount}
          onRemoveDirectory={(path) => {
            if (filters.directory === path) setFilters({ ...filters, directory: "" });
            void manager.removeDirectory(path);
          }}
          onRescan={manager.rescan}
          onRestoreExcluded={manager.restoreExcluded}
        />
      )}

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
          onOpenBranch={(path, branch) => setDetail({ path, tab: "branches", branch })}
        />
      ) : view?.kind === "unpushed" ? (
        <UnpushedView
          paths={view.paths}
          onClose={() => setView(undefined)}
          onChanged={manager.refreshSummaries}
        />
      ) : state.order.length === 0 ? (
        <p className="empty muted">
          {manager.workspace.roots.length === 0
            ? "No directories open. Open a directory to scan it for git repositories."
            : "No git repositories found in the open directories."}
        </p>
      ) : (
        <>
          <FilterBar
            filters={filters}
            directories={manager.workspace.roots.map((root) => root.path)}
            onChange={setFilters}
          />
          <div className="toolbar freshness-row">
            <span className="muted">
              {visible.length} {visible.length === 1 ? "repository" : "repositories"}
            </span>
            <span className="freshness">
              <span
                className={
                  isStale(nowUnix, freshness.oldestFetchUnix) || freshness.neverFetched > 0
                    ? "stale"
                    : "muted"
                }
              >
                {freshness.oldestFetchUnix === null
                  ? "Never fetched"
                  : `Oldest fetch ${formatAge(nowUnix, freshness.oldestFetchUnix)}`}
                {freshness.neverFetched > 0 &&
                  freshness.oldestFetchUnix !== null &&
                  ` · ${freshness.neverFetched} never fetched`}
              </span>
              <button
                disabled={visible.length === 0 || visible.some((p) => isBusy(state.repos[p]))}
                onClick={() => runOn(visible, { type: "fetch" })}
              >
                Fetch all {visible.length}
              </button>
            </span>
          </div>

          <ActionBar
            selected={targets.length}
            visible={visible.length}
            hiddenSelected={hiddenSelected}
            busy={busy}
            onRun={(action) => runOn(targets, action)}
            onReview={(kind) => setView({ kind, paths: targets })}
            onRefresh={() => manager.refreshSummaries(targets)}
            onRemove={() => manager.removeRepos(targets)}
            onSelectAll={() => manager.setSelection(visible, true)}
            onClear={() => manager.setSelection([...state.selected], false)}
          />

          {manager.lastRun && runSummary && (
            <RunSummaryBar
              label={manager.lastRun.label}
              summary={runSummary}
              activeStatus={resultFilter}
              onShowStatus={setResultFilter}
              onDismiss={() => {
                setResultFilter(undefined);
                manager.dismissLastRun();
              }}
            />
          )}

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
              <button onClick={() => manager.runBulk(pendingRenames)}>Rename local branches</button>
            </div>
          )}

          <table className="repo-table">
            <colgroup>
              <col style={{ width: "36px" }} />
              <col style={{ width: "30%" }} />
              <col style={{ width: "19%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "11%" }} />
              <col />
              <col style={{ width: "72px" }} />
            </colgroup>
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
                  nowUnix={nowUnix}
                  onToggle={(extendRange) => toggle(path, extendRange)}
                  onAction={(action) => manager.runAction([path], action)}
                  onFollowUp={(action) => runFollowUp(path, action)}
                  onOpenDetails={(tab) => setDetail({ path, tab })}
                />
              ))}
            </tbody>
          </table>
          {visible.length === 0 && (
            <p className="empty muted">No repositories match the current filters.</p>
          )}
        </>
      )}
      {showSettings && settings.view && (
        <SettingsDialog
          view={settings.view}
          onSave={settings.save}
          onClose={() => setShowSettings(false)}
        />
      )}
      {detail && state.repos[detail.path] && (
        <RepoDetailPanel
          path={detail.path}
          summary={state.repos[detail.path].summary}
          tab={detail.tab}
          branch={detail.branch}
          onTabChange={(tab) => setDetail({ ...detail, tab })}
          onBranchChange={(branch) => setDetail({ ...detail, branch })}
          onClose={() => setDetail(undefined)}
          onSettingsSaved={() => manager.refreshSummaries([detail.path])}
        />
      )}
    </main>
  );
}

export default App;
