import { useState } from "react";
import { basename, describeChanges, describeSync, parentDirectory } from "../format";
import type { RepoState } from "../state";
import { formatRecent } from "../cleanup";
import { isStale } from "../freshness";
import { FAILURE_HINTS } from "../actionLabels";
import { followUpOf } from "../followUps";
import type { Action } from "../types";
import { CommandLog } from "./CommandLog";

const RUNNING_LABELS: Record<Action["type"], string> = {
  checkoutDefault: "Checking out…",
  pull: "Pulling…",
  stash: "Stashing…",
  commit: "Committing…",
  rebaseFork: "Rebasing…",
  push: "Pushing…",
  fetch: "Fetching…",
  syncDefaultBranch: "Checking default branch…",
  renameBranch: "Renaming…",
  setRemoteUrl: "Updating remote…",
};

function followUpLabel(action: Action): string {
  switch (action.type) {
    case "push":
      return action.plan.force
        ? `Force push to ${action.plan.remote}…`
        : `Push to ${action.plan.remote}`;
    case "renameBranch":
      return `Rename ${action.from} → ${action.to}`;
    default:
      return action.type;
  }
}

interface Props {
  repo: RepoState;
  selected: boolean;
  nowUnix: number;
  onToggle: (extendRange: boolean) => void;
  onAction: (action: Action) => void;
  onFollowUp: (action: Action) => void;
  onOpenDetails: (tab: "changes" | "branches") => void;
}

export function RepoRow({
  repo,
  selected,
  nowUnix,
  onToggle,
  onAction,
  onFollowUp,
  onOpenDetails,
}: Props) {
  const [showLog, setShowLog] = useState(false);
  const [commitMessage, setCommitMessage] = useState<string>();
  const name = basename(repo.path);
  const summary = repo.summary;
  const outcome = repo.result?.outcome;
  const followUp = followUpOf(repo);
  const canResolveChanges =
    outcome?.status === "skipped" &&
    outcome.reason === "uncommittedChanges" &&
    repo.runningAction === undefined;

  const submitCommit = () => {
    if (!commitMessage?.trim()) return;
    onAction({ type: "commit", message: commitMessage });
    setCommitMessage(undefined);
  };

  return (
    <>
      <tr className={selected ? "selected" : undefined}>
        <td>
          <input
            type="checkbox"
            aria-label={`Select ${name}`}
            checked={selected}
            onChange={(event) => onToggle((event.nativeEvent as MouseEvent).shiftKey === true)}
          />
        </td>
        <td>
          <button
            className="repo-name file-button"
            aria-label={`Open details for ${name}`}
            onClick={() => onOpenDetails("branches")}
          >
            {name}
          </button>
          <div className="repo-path truncate-start muted" title={repo.path}>
            <span>{parentDirectory(repo.path)}</span>
          </div>
        </td>
        <td>
          {summary ? (
            <>
              {summary.branch ?? <span className="muted">(detached)</span>}
              {summary.defaultOverridden && (
                <div className="muted" title="Main branches are configured for this repository">
                  main: {summary.mainBranches.join(", ")}
                </div>
              )}
              {!summary.defaultOverridden &&
                summary.defaultBranch &&
                summary.branch !== summary.defaultBranch && (
                  <div className="muted">default: {summary.defaultBranch}</div>
                )}
            </>
          ) : repo.summaryError ? (
            <span className="error" title={repo.summaryError}>
              Unavailable
            </span>
          ) : (
            <span className="muted">Loading…</span>
          )}
        </td>
        <td>
          {summary &&
            (summary.trackedChanges + summary.untracked + summary.conflicts > 0 ? (
              <button
                className="changes-toggle"
                aria-label={`Show changes in ${name}`}
                onClick={() => onOpenDetails("changes")}
              >
                {describeChanges(summary)}
              </button>
            ) : (
              describeChanges(summary)
            ))}
        </td>
        <td>
          {summary && (
            <>
              {describeSync(summary)}
              {summary.hasRemotes ? (
                <div
                  className={`muted fetched${isStale(nowUnix, summary.lastFetchUnix) ? " stale" : ""}`}
                >
                  {summary.lastFetchUnix === null
                    ? "never fetched"
                    : `fetched ${formatRecent(nowUnix, summary.lastFetchUnix)}`}
                </div>
              ) : (
                <div className="muted">no remote</div>
              )}
            </>
          )}
        </td>
        <td className="result">
          {repo.runningAction ? (
            <span className="muted">{RUNNING_LABELS[repo.runningAction]}</span>
          ) : outcome ? (
            <>
              <span className={`outcome-${outcome.status}`}>{outcome.message}</span>
              {outcome.status === "failed" && outcome.reason && FAILURE_HINTS[outcome.reason] && (
                <div className="muted hint">{FAILURE_HINTS[outcome.reason]}</div>
              )}
            </>
          ) : null}
          {canResolveChanges && commitMessage === undefined && (
            <div className="inline-actions">
              <button onClick={() => onAction({ type: "stash" })}>Stash</button>
              <button onClick={() => setCommitMessage("")}>Commit…</button>
            </div>
          )}
          {followUp && (
            <div className="inline-actions">
              <button onClick={() => onFollowUp(followUp)}>{followUpLabel(followUp)}</button>
            </div>
          )}
          {commitMessage !== undefined && (
            <form
              className="inline-actions"
              onSubmit={(event) => {
                event.preventDefault();
                submitCommit();
              }}
            >
              <input
                autoFocus
                aria-label={`Commit message for ${name}`}
                placeholder="Commit message"
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
              />
              <button type="submit" disabled={!commitMessage.trim()}>
                Commit
              </button>
              <button type="button" onClick={() => setCommitMessage(undefined)}>
                Cancel
              </button>
            </form>
          )}
        </td>
        <td>
          {repo.result && (
            <button className="link" onClick={() => setShowLog(!showLog)}>
              {showLog ? "Hide log" : "Log"}
            </button>
          )}
        </td>
      </tr>
      {showLog && repo.result && (
        <tr className="log-row">
          <td />
          <td colSpan={6}>
            <CommandLog commands={repo.result.commands} />
          </td>
        </tr>
      )}
    </>
  );
}
