import { useState } from "react";
import { api } from "./api";
import { formatRecent } from "./cleanup";
import { ActionBar } from "./components/ActionBar";
import { ActivityView } from "./components/ActivityView";
import { CleanupView } from "./components/CleanupView";
import { Dashboard } from "./components/Dashboard";
import { FilterBar } from "./components/FilterBar";
import { RepoDetailPanel, type DetailTab } from "./components/RepoDetailPanel";
import { RemotesView } from "./components/RemotesView";
import { RepoRow } from "./components/RepoRow";
import { RunSummaryBar } from "./components/RunSummaryBar";
import { SettingsDialog } from "./components/SettingsDialog";
import { UnpushedView } from "./components/UnpushedView";
import { WorkspaceBar } from "./components/WorkspaceBar";
import { defaultFilters, matchesFilters, type Filters } from "./filters";
import { pendingFollowUps } from "./followUps";
import { basename } from "./format";
import { fleetFreshness, isStale } from "./freshness";
import type { Fix } from "./problems";
import { describePushes } from "./push";
import { summarizeRun, type RunStatus } from "./runSummary";
import { defaultSort, nextSort, sortPaths, type Sort, type SortKey } from "./sorting";
import { isBusy } from "./state";
import type { Action, PushPlan } from "./types";
import { useFleetScan } from "./useFleetScan";
import { useNow } from "./useNow";
import { useRepoManager } from "./useRepoManager";
import { useSettings } from "./useSettings";
import "./App.css";

type Page =
  | { kind: "overview" }
  | { kind: "repos" }
  | { kind: "cleanup"; paths: string[] }
  | { kind: "unpushed"; paths: string[] }
  | { kind: "remotes"; paths: string[] }
  | { kind: "activity" };

const FIX_ACTIONS: Partial<Record<Fix, Action>> = {
  pull: { type: "pull" },
  checkoutDefault: { type: "checkoutDefault" },
};

function App() {
  const manager = useRepoManager();
  const settings = useSettings();
  const { state } = manager;
  const fleet = useFleetScan(state.order);
  const nowUnix = useNow();
  const [page, setPage] = useState<Page>({ kind: "overview" });
  const [showSettings, setShowSettings] = useState(false);
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [pathFilter, setPathFilter] = useState<{ label: string; paths: string[] }>();
  const [resultFilter, setResultFilter] = useState<RunStatus>();
  const [anchor, setAnchor] = useState<string>();
  const [sort, setSort] = useState<Sort>(defaultSort);
  const [detail, setDetail] = useState<{ path: string; tab: DetailTab; branch?: string }>();

  const runSummary = manager.lastRun && summarizeRun(manager.lastRun, state.repos);
  const resultPaths =
    resultFilter && runSummary ? new Set(runSummary.byStatus[resultFilter]) : undefined;
  const pinned = pathFilter && new Set(pathFilter.paths);
  const filtered = state.order.filter(
    (path) =>
      (!pinned || pinned.has(path)) &&
      (!resultPaths || resultPaths.has(path)) &&
      matchesFilters(state.repos[path], filters),
  );
  const visible = sortPaths(filtered, state.repos, sort);
  const sortHeader = (key: SortKey, label: string) => (
    <th aria-sort={sort.key === key ? sort.direction : undefined}>
      <button className="sort-button" onClick={() => setSort(nextSort(sort, key))}>
        {label}
        <span aria-hidden="true">
          {sort.key === key ? (sort.direction === "ascending" ? " ▲" : " ▼") : ""}
        </span>
      </button>
    </th>
  );
  const targets = visible.filter((path) => state.selected.has(path));
  const hiddenSelected = state.selected.size - targets.length;
  const busy = targets.some((p) => isBusy(state.repos[p]));
  const anyBusy = state.order.some((p) => isBusy(state.repos[p]));
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

  const scope = page.kind === "overview" ? state.order : visible;
  const pendingPushes = pendingFollowUps(scope, state.repos, "push").map(
    ([path, action]): [string, PushPlan] => [path, action.plan],
  );
  const pendingRenames = pendingFollowUps(scope, state.repos, "renameBranch");
  const forcedPushes = pendingPushes.filter(([, plan]) => plan.force).length;

  const runJobs = async (jobs: [string, Action][]) => {
    setResultFilter(undefined);
    await manager.runBulk(jobs);
    void fleet.scan(jobs.map(([path]) => path));
  };
  const runOn = (paths: string[], action: Action) =>
    runJobs(paths.map((path): [string, Action] => [path, action]));

  const push = async (pushes: [string, PushPlan][], alwaysConfirm: boolean) => {
    const needsConfirm = alwaysConfirm || pushes.some(([, plan]) => plan.force);
    if (needsConfirm && !(await api.confirmDestructive(describePushes(pushes), "Push"))) return;
    await runJobs(pushes.map(([path, plan]) => [path, { type: "push", plan }]));
  };
  const runFollowUp = (path: string, action: Action) =>
    action.type === "push" ? push([[path, action.plan]], false) : manager.runAction([path], action);

  const changed = (paths: string[]) => {
    void manager.refreshSummaries(paths);
    void fleet.scan(paths);
  };

  const show = (label: string, paths: string[]) => {
    setPathFilter({ label, paths });
    setResultFilter(undefined);
    setFilters(defaultFilters);
    setPage({ kind: "repos" });
  };

  const fix = (kind: Fix, paths: string[]) => {
    const action = FIX_ACTIONS[kind];
    if (action) void runOn(paths, action);
    else if (kind === "reviewUnpushed") setPage({ kind: "unpushed", paths });
    else if (kind === "cleanup") setPage({ kind: "cleanup", paths });
  };

  const navigate = (next: Page) => {
    if (next.kind === "repos") setPathFilter(undefined);
    setPage(next);
  };

  const listPage = page.kind === "overview" || page.kind === "repos";
  const navItems: [Page, string][] = [
    [{ kind: "overview" }, "Overview"],
    [{ kind: "repos" }, "Repositories"],
    [{ kind: "cleanup", paths: state.order }, "Branch cleanup"],
    [{ kind: "unpushed", paths: state.order }, "Unpushed work"],
    [{ kind: "remotes", paths: state.order }, "Remotes"],
    [{ kind: "activity" }, "Activity"],
  ];

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
              if (event.target.value === "clear") {
                void manager.clearRecent();
                return;
              }
              const entry = manager.workspace.recent[Number(event.target.value)];
              if (entry) {
                setFilters(defaultFilters);
                setPathFilter(undefined);
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
            <option value="clear">Clear recent</option>
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

      {listPage && (
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

      {state.order.length === 0 ? (
        <p className="empty muted">
          {manager.workspace.roots.length === 0
            ? "No directories open. Open a directory to scan it for git repositories."
            : "No git repositories found in the open directories."}
        </p>
      ) : (
        <div className="layout">
          <nav className="sidebar" aria-label="Sections">
            {navItems.map(([target, label]) => (
              <button
                key={label}
                aria-current={page.kind === target.kind ? "page" : undefined}
                onClick={() => navigate(target)}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="content">
            {listPage && manager.lastRun && runSummary && (
              <RunSummaryBar
                label={manager.lastRun.label}
                summary={runSummary}
                activeStatus={resultFilter}
                onShowStatus={(status) => {
                  setResultFilter(status);
                  if (status) setPage({ kind: "repos" });
                }}
                onDismiss={() => {
                  setResultFilter(undefined);
                  manager.dismissLastRun();
                }}
                cancelled={manager.lastRun.cancelled}
                detail={
                  manager.lastRun.paths.length === 1 && runSummary.running === 0
                    ? state.repos[manager.lastRun.paths[0]]?.result?.outcome.message
                    : undefined
                }
                onCancel={manager.cancelLastRun}
              />
            )}

            {listPage && pendingPushes.length > 0 && (
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

            {listPage && pendingRenames.length > 0 && (
              <div className="notice" role="status">
                <span>
                  {pendingRenames.length}{" "}
                  {pendingRenames.length === 1 ? "repository's" : "repositories'"} default branch
                  was renamed on the remote.
                </span>
                <button onClick={() => runJobs(pendingRenames)}>Rename local branches</button>
              </div>
            )}

            {page.kind === "overview" && (
              <Dashboard
                paths={state.order}
                states={state.repos}
                healths={fleet.healths}
                pendingScans={fleet.pending}
                lastScannedUnix={fleet.lastScannedUnix}
                nowUnix={nowUnix}
                freshness={fleetFreshness(state.order, state.repos)}
                busy={anyBusy}
                onFix={fix}
                onShow={show}
                onFetchAll={() => runOn(state.order, { type: "fetch" })}
                onRescan={() => {
                  void manager.refreshSummaries(state.order);
                  void fleet.scan(state.order);
                }}
              />
            )}

            {page.kind === "cleanup" && (
              <CleanupView
                key={page.paths.join("\n")}
                paths={page.paths}
                onClose={() => setPage({ kind: "overview" })}
                onChanged={changed}
                onOpenBranch={(path, branch) => setDetail({ path, tab: "branches", branch })}
              />
            )}

            {page.kind === "unpushed" && (
              <UnpushedView
                key={page.paths.join("\n")}
                paths={page.paths}
                onClose={() => setPage({ kind: "overview" })}
                onChanged={changed}
              />
            )}

            {page.kind === "activity" && (
              <ActivityView onClose={() => setPage({ kind: "overview" })} />
            )}

            {page.kind === "remotes" && (
              <RemotesView
                key={page.paths.join("\n")}
                paths={page.paths}
                onClose={() => setPage({ kind: "overview" })}
                runJobs={runJobs}
              />
            )}

            {page.kind === "repos" && (
              <>
                <FilterBar
                  filters={filters}
                  directories={manager.workspace.roots.map((root) => root.path)}
                  onChange={setFilters}
                />
                {pathFilter && (
                  <div className="toolbar">
                    <span className="chip path-filter">
                      Showing: {pathFilter.label}
                      <button
                        className="chip-remove"
                        aria-label="Show all repositories"
                        onClick={() => setPathFilter(undefined)}
                      >
                        ×
                      </button>
                    </span>
                  </div>
                )}
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
                        : `Oldest fetch ${formatRecent(nowUnix, freshness.oldestFetchUnix)}`}
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
                  onReview={(kind) => setPage({ kind, paths: targets })}
                  onRefresh={() => changed(targets)}
                  onRemove={() => manager.removeRepos(targets)}
                  onSelectAll={() => manager.setSelection(visible, true)}
                  onClear={() => manager.setSelection([...state.selected], false)}
                />

                <table className="repo-table">
                  <colgroup>
                    <col style={{ width: "36px" }} />
                    <col style={{ width: "27%" }} />
                    <col style={{ width: "17%" }} />
                    <col style={{ width: "15%" }} />
                    <col style={{ width: "16%" }} />
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
                      {sortHeader("name", "Repository")}
                      {sortHeader("branch", "Branch")}
                      {sortHeader("changes", "Changes")}
                      {sortHeader("sync", "Sync")}
                      {sortHeader("result", "Last result")}
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
          </div>
        </div>
      )}

      {showSettings && settings.view && (
        <SettingsDialog
          view={settings.view}
          onSave={async (next) => {
            await settings.save(next);
            await manager.reloadWorkspace();
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
      {detail && state.repos[detail.path] && (
        <RepoDetailPanel
          path={detail.path}
          summary={state.repos[detail.path].summary}
          webHosts={settings.view?.settings.webHosts}
          tab={detail.tab}
          branch={detail.branch}
          onTabChange={(tab) => setDetail({ ...detail, tab })}
          onBranchChange={(branch) => setDetail({ ...detail, branch })}
          onClose={() => setDetail(undefined)}
          onSettingsSaved={() => changed([detail.path])}
        />
      )}
    </main>
  );
}

export default App;
