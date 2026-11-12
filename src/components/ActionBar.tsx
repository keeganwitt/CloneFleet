import type { Action } from "../types";

interface SelectionProps {
  selected: number;
  visible: number;
  hiddenSelected: number;
  onSelectAll: () => void;
  onClear: () => void;
}

export function SelectionLine({
  selected,
  visible,
  hiddenSelected,
  onSelectAll,
  onClear,
}: SelectionProps) {
  return (
    <div className="toolbar selection-line">
      {selected === 0 ? (
        <span className="muted">
          Select repositories to act on them
          {hiddenSelected > 0 && ` (${hiddenSelected} selected but hidden by filters)`}
        </span>
      ) : (
        <>
          <strong>{selected} selected</strong>
          {hiddenSelected > 0 && (
            <span className="muted">({hiddenSelected} more hidden by filters)</span>
          )}
          <button className="link" onClick={onClear}>
            Clear
          </button>
        </>
      )}
      {visible > selected && (
        <button className="link" onClick={onSelectAll}>
          Select all {visible}
        </button>
      )}
    </div>
  );
}

interface PanelProps {
  selected: number;
  hiddenSelected: number;
  busy: boolean;
  onRun: (action: Action) => void;
  onReview: (kind: "cleanup" | "unpushed") => void;
  onRefresh: () => void;
  onRemove: () => void;
}

const UPDATE_ACTIONS: [Action, string][] = [
  [{ type: "fetch" }, "Fetch"],
  [{ type: "pull" }, "Pull"],
  [{ type: "checkoutDefault" }, "Checkout default branch"],
  [{ type: "rebaseFork" }, "Rebase fork on upstream"],
  [{ type: "syncDefaultBranch" }, "Check default branch"],
];

export function ActionPanel(props: PanelProps) {
  if (props.selected === 0) return null;
  return (
    <div className="action-bar-active" role="region" aria-label="Selection actions">
      <div className="toolbar">
        <strong>{props.selected} selected</strong>
        {props.hiddenSelected > 0 && (
          <span className="muted">({props.hiddenSelected} more hidden by filters)</span>
        )}
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
