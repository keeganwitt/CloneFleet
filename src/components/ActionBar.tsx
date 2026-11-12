import type { Action } from "../types";

interface Props {
  selected: number;
  visible: number;
  hiddenSelected: number;
  busy: boolean;
  onRun: (action: Action) => void;
  onReview: (kind: "cleanup" | "unpushed") => void;
  onRefresh: () => void;
  onRemove: () => void;
  onSelectAll: () => void;
  onClear: () => void;
}

const UPDATE_ACTIONS: [Action, string][] = [
  [{ type: "fetch" }, "Fetch"],
  [{ type: "pull" }, "Pull"],
  [{ type: "checkoutDefault" }, "Checkout default branch"],
  [{ type: "rebaseFork" }, "Rebase fork on upstream"],
  [{ type: "syncDefaultBranch" }, "Check default branch"],
];

export function ActionBar(props: Props) {
  if (props.selected === 0) {
    return (
      <div className="toolbar action-bar">
        <span className="muted">
          Select repositories to act on them
          {props.hiddenSelected > 0 && ` (${props.hiddenSelected} selected but hidden by filters)`}
        </span>
        {props.visible > 0 && (
          <button className="link" onClick={props.onSelectAll}>
            Select all {props.visible}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="action-bar action-bar-active" role="region" aria-label="Selection actions">
      <div className="toolbar">
        <strong>{props.selected} selected</strong>
        {props.hiddenSelected > 0 && (
          <span className="muted">({props.hiddenSelected} more hidden by filters)</span>
        )}
        <button className="link" onClick={props.onClear}>
          Clear
        </button>
        <span className="spacer" />
        <button onClick={props.onRefresh}>Refresh status</button>
        <button disabled={props.busy} onClick={props.onRemove}>
          Remove from list
        </button>
      </div>
      <div className="toolbar" role="group" aria-label="Update">
        <span className="toolbar-label muted">Update</span>
        {UPDATE_ACTIONS.map(([action, label]) => (
          <button key={action.type} disabled={props.busy} onClick={() => props.onRun(action)}>
            {label}
          </button>
        ))}
      </div>
      <div className="toolbar" role="group" aria-label="Review">
        <span className="toolbar-label muted">Review</span>
        <button disabled={props.busy} onClick={() => props.onReview("unpushed")}>
          Unpushed work &amp; stashes…
        </button>
        <button disabled={props.busy} onClick={() => props.onReview("cleanup")}>
          Clean up branches…
        </button>
      </div>
    </div>
  );
}
