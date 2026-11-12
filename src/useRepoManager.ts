import { useCallback, useEffect, useReducer, useState } from "react";
import { api } from "./api";
import { basename } from "./format";
import { initialState, reducer } from "./state";
import type { Action, ActionResult } from "./types";

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

  const showRepos = useCallback(
    (paths: string[], refresh: string[]) => {
      dispatch({ type: "reposLoaded", paths });
      refresh.forEach(refreshSummary);
    },
    [refreshSummary],
  );

  useEffect(() => {
    api
      .listRepos()
      .then((paths) => showRepos(paths, paths))
      .catch((error) => setNotice(errorMessage(error)));
  }, [showRepos]);

  const addDirectories = useCallback(async () => {
    try {
      const directories = await api.pickDirectories();
      if (directories.length === 0) return;
      const before = new Set(state.order);
      let paths = state.order;
      for (const directory of directories) {
        paths = await api.addDirectory(directory);
      }
      const added = paths.filter((p) => !before.has(p));
      showRepos(paths, added);
      setNotice(
        added.length === 0
          ? `No new repositories found in ${directories.map(basename).join(", ")}`
          : `Added ${added.length} ${added.length === 1 ? "repository" : "repositories"}`,
      );
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [showRepos, state.order]);

  const removeRepos = useCallback(
    async (paths: string[]) => {
      try {
        showRepos(await api.removeRepos(paths), []);
      } catch (error) {
        setNotice(errorMessage(error));
      }
    },
    [showRepos],
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
    addDirectories,
    removeRepos,
    runAction,
    runActions,
    refreshSummaries,
  };
}
