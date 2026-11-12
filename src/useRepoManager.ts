import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { api } from "./api";
import { ACTION_LABELS } from "./actionLabels";
import { basename } from "./format";
import type { Run } from "./runSummary";
import { initialState, reducer } from "./state";
import type { Action, ActionResult, WorkspaceView } from "./types";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useRepoManager() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [notice, setNotice] = useState<string>();

  const refreshSummary = useCallback(async (path: string) => {
    dispatch({ type: "summaryStarted", path });
    try {
      dispatch({ type: "summaryLoaded", path, summary: await api.repoSummary(path) });
    } catch (error) {
      dispatch({ type: "summaryFailed", path, error: errorMessage(error) });
    }
  }, []);

  const [workspace, setWorkspace] = useState<Omit<WorkspaceView, "repos">>({
    roots: [],
    excludedCount: 0,
    recent: [],
  });

  const showWorkspace = useCallback(
    (view: WorkspaceView, known: ReadonlySet<string>) => {
      const { repos, ...rest } = view;
      setWorkspace(rest);
      dispatch({ type: "reposLoaded", paths: repos });
      const added = repos.filter((p) => !known.has(p));
      added.forEach(refreshSummary);
      return added;
    },
    [refreshSummary],
  );

  useEffect(() => {
    api
      .loadWorkspace()
      .then((view) => showWorkspace(view, new Set()))
      .catch((error) => setNotice(errorMessage(error)));
  }, [showWorkspace]);

  const known = useMemo(() => new Set(state.order), [state.order]);

  const changeWorkspace = useCallback(
    async (change: () => Promise<WorkspaceView>, describe?: (added: number) => string) => {
      try {
        const added = showWorkspace(await change(), known);
        if (describe) setNotice(describe(added.length));
      } catch (error) {
        setNotice(errorMessage(error));
      }
    },
    [known, showWorkspace],
  );

  const pickAnd = useCallback(
    async (apply: (paths: string[]) => Promise<WorkspaceView>, verb: string) => {
      const directories = await api.pickDirectories().catch((error) => {
        setNotice(errorMessage(error));
        return [];
      });
      if (directories.length === 0) return;
      const names = directories.map(basename).join(", ");
      await changeWorkspace(
        () => apply(directories),
        (added) =>
          added === 0
            ? `No new repositories found in ${names}`
            : `${verb} ${names}: ${added} ${added === 1 ? "repository" : "repositories"}`,
      );
    },
    [changeWorkspace],
  );

  const openDirectories = useCallback(() => pickAnd(api.openDirectories, "Opened"), [pickAnd]);
  const addDirectories = useCallback(() => pickAnd(api.addDirectories, "Added"), [pickAnd]);
  const openRecent = useCallback(
    (roots: string[]) => changeWorkspace(() => api.openRecent(roots)),
    [changeWorkspace],
  );
  const clearRecent = useCallback(() => changeWorkspace(api.clearRecent), [changeWorkspace]);
  const reloadWorkspace = useCallback(() => changeWorkspace(api.loadWorkspace), [changeWorkspace]);
  const removeDirectory = useCallback(
    (path: string) => changeWorkspace(() => api.removeDirectory(path)),
    [changeWorkspace],
  );
  const rescan = useCallback(
    () =>
      changeWorkspace(api.rescanWorkspace, (added) =>
        added === 0
          ? "No new repositories found"
          : `Found ${added} new ${added === 1 ? "repository" : "repositories"}`,
      ),
    [changeWorkspace],
  );
  const removeRepos = useCallback(
    (paths: string[]) => changeWorkspace(() => api.removeRepos(paths)),
    [changeWorkspace],
  );
  const restoreExcluded = useCallback(
    () => changeWorkspace(api.restoreExcluded),
    [changeWorkspace],
  );

  const runActions = useCallback(
    async (jobs: [path: string, action: Action][]) => {
      for (const [path, action] of jobs) {
        dispatch({ type: "actionStarted", paths: [path], action: action.type });
      }
      await Promise.all(
        jobs.map(async ([path, action]) => {
          let result: ActionResult;
          try {
            result = await api.runAction(path, action);
          } catch (error) {
            result = {
              outcome: { status: "failed", message: errorMessage(error) },
              followUp: null,
              commands: [],
            };
          }
          dispatch({ type: "actionFinished", path, result });
          await refreshSummary(path);
        }),
      );
    },
    [refreshSummary],
  );

  const runAction = useCallback(
    (paths: string[], action: Action) =>
      runActions(paths.map((path): [string, Action] => [path, action])),
    [runActions],
  );

  const [lastRun, setLastRun] = useState<Run>();

  const runBulk = useCallback(
    (jobs: [path: string, action: Action][]) => {
      if (jobs.length === 0) return Promise.resolve();
      setLastRun({ label: ACTION_LABELS[jobs[0][1].type], paths: jobs.map(([path]) => path) });
      return runActions(jobs);
    },
    [runActions],
  );

  const refreshSummaries = useCallback(
    (paths: string[]) => Promise.all(paths.map(refreshSummary)),
    [refreshSummary],
  );

  return {
    state,
    notice,
    dismissNotice: () => setNotice(undefined),
    toggleSelected: (path: string) => dispatch({ type: "toggleSelected", path }),
    setSelection: (paths: string[], selected: boolean) =>
      dispatch({ type: "setSelection", paths, selected }),
    workspace,
    openDirectories,
    addDirectories,
    openRecent,
    clearRecent,
    reloadWorkspace,
    removeDirectory,
    rescan,
    removeRepos,
    restoreExcluded,
    runAction,
    runActions,
    runBulk,
    lastRun,
    dismissLastRun: () => setLastRun(undefined),
    refreshSummaries,
  };
}
