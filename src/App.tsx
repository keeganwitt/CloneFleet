import { useMemo, useState } from "react";
import { api } from "./api";
import { formatRecent } from "./cleanup";
import { ActionPanel } from "./components/ActionBar";
import { TriStateCheckbox } from "./components/BranchTree";
import { ActivityView } from "./components/ActivityView";
import { ArtifactsView } from "./components/ArtifactsView";
import { CleanupView, type CleanupCategory } from "./components/CleanupView";
import { Dashboard } from "./components/Dashboard";
import { FilterBar } from "./components/FilterBar";
import { RepoDetailPanel, type DetailTab } from "./components/RepoDetailPanel";
import { ReviewDialog } from "./components/ReviewDialog";
import { RemotesView } from "./components/RemotesView";
import { RepoRow } from "./components/RepoRow";
import { RunSummaryBar } from "./components/RunSummaryBar";
import { SettingsDialog } from "./components/SettingsDialog";
import { Icon } from "./components/Icon";
import { InactiveView } from "./components/InactiveView";
import { UnpushedView } from "./components/UnpushedView";
import { WorkspaceBar } from "./components/WorkspaceBar";
import { defaultFilters, matchesFilters, type Filters } from "./filters";
import { pendingFollowUps } from "./followUps";
import { isWithin, uniqueLabels } from "./format";
import logo from "../assets/clonefleet.svg";
import { fleetFreshness, isStale } from "./freshness";
import type { ProblemKind } from "./problems";
import { describePushes } from "./push";
import { summarizeRun, type RunStatus } from "./runSummary";
import { defaultSort, nextSort, sortPaths, type Sort, type SortKey } from "./sorting";
import { isBusy } from "./state";
import type { Action, PushPlan } from "./types";
import { reclaimableBytes } from "./artifacts";
import { useArtifactScan } from "./useArtifactScan";
import { useFleetScan } from "./useFleetScan";
import { useNow } from "./useNow";
import { useRepoManager } from "./useRepoManager";
import { useSettings } from "./useSettings";
import "./App.css";

type PageKind =
  "overview" | "repos" | "cleanup" | "artifacts" | "unpushed" | "inactive" | "remotes" | "activity";
type LocalWorkFilter = "unpushed" | "stashes";

interface Page {
  kind: PageKind;
  paths?: string[];
  category?: CleanupCategory;
  localWork?: LocalWorkFilter;
}

const REPOSITORY_TABS = [
  ["repos", "All repositories"],
  ["unpushed", "Local work"],
  ["remotes", "Remotes"],
] as const;

const CLEANUP_TABS = [
  ["cleanup", "Branches & worktrees"],
  ["artifacts", "Disk space"],
  ["inactive", "Inactive clones"],
] as const;

const NAV_ITEMS = [
  ["overview", "Overview"],
  ["repos", "Repositories"],
  ["cleanup", "Cleanup"],
  ["activity", "Activity"],
] as const;

function sectionOf(kind: PageKind) {
  if (REPOSITORY_TABS.some(([tab]) => tab === kind)) return "repos";
  if (CLEANUP_TABS.some(([tab]) => tab === kind)) return "cleanup";
  return kind;
}

function App() {
  const manager = useRepoManager();
  const settings = useSettings();
  const { state } = manager;
  const fleet = useFleetScan(state.order);
  const artifactScan = useArtifactScan(state.order);
  const reclaimable: Record<string, number | undefined> = {};
  for (const path of state.order) {
    const scan = artifactScan.scans[path];
    if (scan?.status === "loaded") reclaimable[path] = reclaimableBytes(scan.report.artifacts);
  }
  const nowUnix = useNow();
  const [page, setPage] = useState<Page>({ kind: "overview" });
  const [directory, setDirectory] = useState("");
  const [review, setReview] = useState<{ paths: string[]; action: Action }>();
  const scopePaths = useMemo(
    () => state.order.filter((path) => !directory || isWithin(path, directory)),
    [directory, state.order],
  );
  const toolPaths = useMemo(() => {
    if (!page.paths) return scopePaths;
    const included = new Set(page.paths);
    return scopePaths.filter((path) => included.has(path));
  }, [page.paths, scopePaths]);
  const section = sectionOf(page.kind);
  const scopeLabel = directory
    ? uniqueLabels(manager.workspace.roots.map((root) => root.path)).get(directory)
    : undefined;
  const workspaceCount = manager.workspace.roots.length;
  const scopeSummary = `${scopePaths.length} ${scopePaths.length === 1 ? "repository" : "repositories"}${scopeLabel ? ` in ${scopeLabel}` : ` across ${workspaceCount} ${workspaceCount === 1 ? "directory" : "directories"}`}`;
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
  const filtered = scopePaths.filter(
    (path) =>
      (!pinned || pinned.has(path)) &&
      (!resultPaths || resultPaths.has(path)) &&
      matchesFilters(state.repos[path], filters),
  );
  const visible = sortPaths(filtered, state.repos, sort);
  const repoLabels = uniqueLabels(scopePaths);
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
  const anyBusy = scopePaths.some((p) => isBusy(state.repos[p]));
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

  const scope = page.kind === "overview" ? scopePaths : visible;
  const pendingPushes = pendingFollowUps(scope, state.repos, "push").map(
    ([path, action]): [string, PushPlan] => [path, action.plan],
  );
  const pendingRenames = pendingFollowUps(scope, state.repos, "renameBranch");
  const forcedPushes = pendingPushes.filter(([, plan]) => plan.force).length;

  const runJobs = async (jobs: [string, Action][]) => {
    setResultFilter(undefined);
    const outcomes = await manager.runBulk(jobs);
    void fleet.scan([...new Set(jobs.map(([path]) => path))]);
    return outcomes;
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

  const openFinding = (kind: ProblemKind, label: string, paths: string[]) => {
    switch (kind) {
      case "unpushed":
      case "stashes":
        setPage({ kind: "unpushed", paths, localWork: kind });
        break;
      case "mergedBranches":
      case "staleBranches":
      case "removableWorktrees":
      case "staleWorktrees":
        setPage({
          kind: "cleanup",
          paths,
          category:
            kind === "mergedBranches"
              ? "merged"
              : kind === "staleBranches"
                ? "stale"
                : kind === "staleWorktrees"
                  ? "staleWorktrees"
                  : "worktrees",
        });
        break;
      case "reclaimableSpace":
        setPage({ kind: "artifacts", paths });
        break;
      default:
        show(label, paths);
    }
  };

  const navigate = (kind: PageKind) => {
    if (kind === "repos") setPathFilter(undefined);
    setPage({ kind });
  };

  const startAction = (action: Action) => {
    if (action.type === "pull" || action.type === "checkoutDefault")
      setReview({ paths: targets, action });
    else void runOn(targets, action);
  };
  const changeDirectory = (path: string, kind = page.kind) => {
    setDirectory(path);
    setPathFilter(undefined);
    setResultFilter(undefined);
    setPage({ kind });
    manager.setSelection([...state.selected], false);
  };
  const refreshScope = () => {
    changed(scopePaths);
    void artifactScan.scan(scopePaths);
  };

  const listPage = page.kind === "overview" || page.kind === "repos";
  const tabs =
    section === "repos" ? REPOSITORY_TABS : section === "cleanup" ? CLEANUP_TABS : undefined;
  const reviewTitle = review?.action.type === "pull" ? "Review pull" : "Review branch switch";
  const reviewCount = review
    ? `${review.paths.length} ${review.paths.length === 1 ? "repository" : "repositories"}`
    : "";
  const summaryVisible = listPage || (runSummary?.running ?? 0) > 0;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="workspace-brand">
          <img src={logo} alt="" />
          <strong>CloneFleet</strong>
        </div>
        <WorkspaceBar
          roots={manager.workspace.roots}
          recent={manager.workspace.recent}
          excludedCount={manager.workspace.excludedCount}
          directory={directory}
          onDirectory={changeDirectory}
          onAdd={manager.addDirectories}
          onOpen={() => {
            changeDirectory("");
            void manager.openDirectories();
          }}
          onOpenRecent={(roots) => {
            changeDirectory("");
            setFilters(defaultFilters);
            void manager.openRecent(roots);
          }}
          onClearRecent={manager.clearRecent}
          onCloseDirectory={(path) => {
            if (directory === path) changeDirectory("");
            void manager.removeDirectory(path);
          }}
          onCloseAll={() => {
            changeDirectory("", "overview");
            setFilters(defaultFilters);
            setDetail(undefined);
            void manager.closeAllDirectories();
          }}
          onRescan={manager.rescan}
          onRestoreExcluded={manager.restoreExcluded}
        />
        <nav aria-label="Main navigation">
          {NAV_ITEMS.map(([kind, label]) => (
            <button
              key={kind}
              aria-current={section === kind ? "page" : undefined}
              onClick={() => navigate(kind)}
            >
              <Icon name={kind} />
              {label}
              {kind === "activity" && (runSummary?.running ?? 0) > 0 && (
                <span className="activity-count"> {runSummary?.running}</span>
              )}
            </button>
          ))}
        </nav>
        <button disabled={!settings.view} onClick={() => setShowSettings(true)}>
          <Icon name="settings" />
          Settings
        </button>
      </aside>
      <main className="content">
        {settings.view?.activeGit.error && (
          <div className="notice error" role="alert">
            {settings.view.activeGit.error}
            <button className="link" onClick={() => setShowSettings(true)}>
              Open settings
            </button>
          </div>
        )}

        {manager.notice && (
          <div className="notice" role="status">
            {manager.notice}
            <button onClick={manager.dismissNotice} aria-label="Close notice">
              Close
            </button>
          </div>
        )}

        {state.order.length === 0 && page.kind !== "activity" ? (
          <div className="empty muted first-run">
            <p>
              {manager.workspace.roots.length === 0
                ? "No directories open. Open a directory to scan it for git repositories."
                : "No git repositories found in the open directories."}
            </p>
            <button className="primary-button" onClick={manager.addDirectories}>
              Add directory…
            </button>
          </div>
        ) : (
          <>
            {tabs && (
              <>
                <header className="page-heading">
                  <h1>{section === "repos" ? "Repositories" : "Cleanup"}</h1>
                  <p className="muted">{scopeSummary}</p>
                </header>
                <nav
                  className="view-tabs"
                  aria-label={section === "repos" ? "Repository views" : "Cleanup views"}
                >
                  {tabs.map(([kind, label]) => (
                    <button
                      key={kind}
                      aria-current={page.kind === kind ? "page" : undefined}
                      onClick={() => navigate(kind)}
                    >
                      {label}
                    </button>
                  ))}
                </nav>
              </>
            )}
            {summaryVisible && manager.lastRun && runSummary && (
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
                paths={scopePaths}
                states={state.repos}
                healths={fleet.healths}
                reclaimable={reclaimable}
                pendingScans={
                  scopePaths.filter((path) => !fleet.entries[path] || fleet.inFlight.has(path))
                    .length
                }
                lastScannedUnix={fleet.lastScannedUnix}
                nowUnix={nowUnix}
                freshness={fleetFreshness(scopePaths, state.repos)}
                scopeSummary={scopeSummary}
                busy={anyBusy}
                onOpenFinding={openFinding}
                onShow={show}
                onFetchAll={() => runOn(scopePaths, { type: "fetch" })}
                onRescan={refreshScope}
              />
            )}

            {page.paths && (
              <div className="toolbar scope-line">
                <span>
                  Showing {toolPaths.length} of {scopePaths.length} repositories
                </span>
                <button
                  className="link"
                  onClick={() => setPage({ kind: page.kind, category: page.category })}
                >
                  Clear repository scope
                </button>
              </div>
            )}

            {page.kind === "cleanup" && (
              <CleanupView
                key={`${toolPaths.join("\n")}:${page.category ?? ""}`}
                paths={toolPaths}
                initialCategory={page.category}
                onChanged={changed}
                onOpenBranch={(path, branch) => setDetail({ path, tab: "branches", branch })}
              />
            )}

            {page.kind === "artifacts" && (
              <ArtifactsView
                key={toolPaths.join("\n")}
                paths={toolPaths}
                scans={artifactScan.scans}
                onRescan={artifactScan.scan}
              />
            )}

            {page.kind === "unpushed" && (
              <UnpushedView
                key={`${toolPaths.join("\n")}:${page.localWork ?? ""}`}
                paths={toolPaths}
                initialFilter={page.localWork}
                onChanged={changed}
              />
            )}

            {page.kind === "inactive" && (
              <InactiveView
                key={toolPaths.join("\n")}
                paths={toolPaths}
                onRemoved={() => void manager.reloadWorkspace()}
              />
            )}

            {page.kind === "activity" && <ActivityView />}

            {page.kind === "remotes" && (
              <RemotesView key={toolPaths.join("\n")} paths={toolPaths} runJobs={runJobs} />
            )}

            {page.kind === "repos" && (
              <>
                {pathFilter && (
                  <div className="toolbar scope-line">
                    <span>{pathFilter.label}</span>
                    <button className="link" onClick={() => setPathFilter(undefined)}>
                      Clear repository filter
                    </button>
                  </div>
                )}
                <div className="list-panel">
                  <div className={`list-toolbar${targets.length ? " has-selection" : ""}`}>
                    <FilterBar filters={filters} onChange={setFilters} />
                    {targets.length > 0 ? (
                      <ActionPanel
                        selected={targets.length}
                        hiddenSelected={hiddenSelected}
                        busy={busy}
                        onClear={() => manager.setSelection([...state.selected], false)}
                        onRun={startAction}
                        onReview={(kind) => setPage({ kind, paths: targets })}
                        onRefresh={() => changed(targets)}
                        onRemove={() => manager.removeRepos(targets)}
                      />
                    ) : (
                      <div className="toolbar list-actions">
                        {hiddenSelected > 0 && (
                          <button
                            className="link"
                            onClick={() => manager.setSelection([...state.selected], false)}
                          >
                            Clear {hiddenSelected} hidden{" "}
                            {hiddenSelected === 1 ? "selection" : "selections"}
                          </button>
                        )}
                        <button
                          className="primary-button"
                          disabled={
                            visible.length === 0 ||
                            visible.some((path) => isBusy(state.repos[path]))
                          }
                          onClick={() => runOn(visible, { type: "fetch" })}
                        >
                          {visible.length === scopePaths.length
                            ? `Fetch all ${visible.length}`
                            : `Fetch ${visible.length} matching`}
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="list-context muted">
                    <span>
                      {visible.length} {visible.length === 1 ? "repository" : "repositories"}
                    </span>
                    <span
                      className={
                        isStale(nowUnix, freshness.oldestFetchUnix) || freshness.neverFetched > 0
                          ? "stale"
                          : ""
                      }
                    >
                      {freshness.oldestFetchUnix !== null &&
                        `Oldest fetch ${formatRecent(nowUnix, freshness.oldestFetchUnix)}`}
                      {freshness.neverFetched > 0 &&
                        `${freshness.oldestFetchUnix !== null ? " · " : ""}${freshness.neverFetched} never fetched`}
                    </span>
                  </div>
                  <div className="list-table-scroll">
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
                            <TriStateCheckbox
                              label="Select all matching repositories"
                              names={visible}
                              isSelected={(path) => state.selected.has(path)}
                              onSetSelected={manager.setSelection}
                            />
                          </th>
                          {sortHeader("name", "Repository")}
                          {sortHeader("branch", "Branch")}
                          {sortHeader("changes", "Working tree")}
                          {sortHeader("sync", "Upstream")}
                          {sortHeader("result", "Last result")}
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {visible.map((path) => (
                          <RepoRow
                            key={path}
                            repo={state.repos[path]}
                            label={repoLabels.get(path)}
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
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </main>

      {review && (
        <ReviewDialog
          title={reviewTitle}
          summary={reviewCount}
          confirmLabel={
            review.action.type === "pull" ? `Pull ${reviewCount}` : `Switch ${reviewCount}`
          }
          onClose={() => setReview(undefined)}
          onConfirm={() => {
            setReview(undefined);
            void runOn(review.paths, review.action);
          }}
        >
          <p>
            {review.action.type === "pull"
              ? "Pull updates on the checked-out branches with a fast-forward only."
              : "Switch each repository to its default branch."}
          </p>
          <ul className="review-targets">
            {review.paths.map((path) => (
              <li key={path}>
                <code>{path}</code>
                {state.repos[path]?.summary?.branch && (
                  <div className="muted">{state.repos[path].summary.branch}</div>
                )}
              </li>
            ))}
          </ul>
        </ReviewDialog>
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
    </div>
  );
}

export default App;
