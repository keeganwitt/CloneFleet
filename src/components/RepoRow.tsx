import { useState } from "react";
import { basename, describeChanges, describeSync } from "../format";
import type { RepoState } from "../state";
import { followUpOf } from "../followUps";
import type { Action } from "../types";
import { ChangesPanel } from "./ChangesPanel";
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
  onToggle: () => void;
  onAction: (action: Action) => void;
  onFollowUp: (action: Action) => void;
}

export function RepoRow({ repo, selected, onToggle, onAction, onFollowUp }: Props) {
  const [showLog, setShowLog] = useState(false);
  const [showChanges, setShowChanges] = useState(false);
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
            onChange={onToggle}
          />
        </td>
        <td>
          <div className="repo-name">{name}</div>
          <div className="repo-path muted" title={repo.path}>
            {repo.path}
          </div>
        </td>
        <td>
          {summary ? (
            <>
              {summary.branch ?? <span className="muted">(detached)</span>}
              {summary.defaultBranch && summary.branch !== summary.defaultBranch && (
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
                aria-expanded={showChanges}
                aria-label={`${showChanges ? "Hide" : "Show"} changes in ${name}`}
                onClick={() => setShowChanges(!showChanges)}
              >
                {describeChanges(summary)}
              </button>
            ) : (
              describeChanges(summary)
            ))}
        </td>
        <td>{summary && describeSync(summary)}</td>
        <td className="result">
          {repo.runningAction ? (
            <span className="muted">{RUNNING_LABELS[repo.runningAction]}</span>
          ) : outcome ? (
            <span className={`outcome-${outcome.status}`}>{outcome.message}</span>
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
      {showChanges && (
        <tr className="log-row">
          <td />
          <td colSpan={6}>
            <ChangesPanel path={repo.path} summary={summary} />
          </td>
        </tr>
      )}
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
