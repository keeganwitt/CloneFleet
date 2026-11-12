import type { Action, ActionResult, RepoSummary } from "./types";

export interface RepoState {
  path: string;
  summary?: RepoSummary;
  summaryError?: string;
  loadingSummary: boolean;
  runningAction?: Action["type"];
  result?: ActionResult;
}

export interface State {
  order: string[];
  repos: Record<string, RepoState>;
  selected: ReadonlySet<string>;
}

export type Event =
  | { type: "reposLoaded"; paths: string[] }
  | { type: "summaryStarted"; path: string }
  | { type: "summaryLoaded"; path: string; summary: RepoSummary }
  | { type: "summaryFailed"; path: string; error: string }
  | { type: "actionStarted"; paths: string[]; action: Action["type"] }
  | { type: "actionFinished"; path: string; result: ActionResult }
  | { type: "toggleSelected"; path: string }
  | { type: "setSelection"; paths: string[]; selected: boolean };

export const initialState: State = { order: [], repos: {}, selected: new Set() };

function updateRepo(
  state: State,
  path: string,
  change: (repo: RepoState) => Partial<RepoState>,
): State {
  const repo = state.repos[path];
  if (!repo) return state;
  return { ...state, repos: { ...state.repos, [path]: { ...repo, ...change(repo) } } };
}

export function reducer(state: State, event: Event): State {
  switch (event.type) {
    case "reposLoaded": {
      const repos: Record<string, RepoState> = {};
      for (const path of event.paths) {
        repos[path] = state.repos[path] ?? { path, loadingSummary: false };
      }
      const selected = new Set([...state.selected].filter((p) => p in repos));
      return { order: [...event.paths], repos, selected };
    }
    case "summaryStarted":
      return updateRepo(state, event.path, () => ({ loadingSummary: true }));
    case "summaryLoaded":
      return updateRepo(state, event.path, () => ({
        loadingSummary: false,
        summary: event.summary,
        summaryError: undefined,
      }));
    case "summaryFailed":
      return updateRepo(state, event.path, () => ({
        loadingSummary: false,
        summary: undefined,
        summaryError: event.error,
      }));
    case "actionStarted":
      return event.paths.reduce(
        (next, path) =>
          updateRepo(next, path, () => ({ runningAction: event.action, result: undefined })),
        state,
      );
    case "actionFinished":
      return updateRepo(state, event.path, () => ({
        runningAction: undefined,
        result: event.result,
      }));
    case "toggleSelected": {
      const selected = new Set(state.selected);
      if (!selected.delete(event.path)) selected.add(event.path);
      return { ...state, selected };
    }
    case "setSelection": {
      const selected = new Set(state.selected);
      for (const path of event.paths) {
        if (!(path in state.repos)) continue;
        if (event.selected) selected.add(path);
        else selected.delete(path);
      }
      return { ...state, selected };
    }
  }
}

export function isBusy(repo: RepoState): boolean {
  return repo.runningAction !== undefined;
}
