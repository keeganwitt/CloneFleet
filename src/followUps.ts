import type { RepoState } from "./state";
import type { Action } from "./types";

export type ActionOf<T extends Action["type"]> = Extract<Action, { type: T }>;

export function followUpOf(repo: RepoState): Action | undefined {
  if (repo.runningAction !== undefined) return undefined;
  return repo.result?.followUp ?? undefined;
}

export function pendingFollowUps<T extends Action["type"]>(
  paths: string[],
  repos: Record<string, RepoState>,
  type: T,
): [string, ActionOf<T>][] {
  return paths.flatMap((path): [string, ActionOf<T>][] => {
    const followUp = followUpOf(repos[path]);
    return followUp?.type === type ? [[path, followUp as ActionOf<T>]] : [];
  });
}
