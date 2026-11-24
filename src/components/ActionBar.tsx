import type { Action } from "../types";

interface Props {
  selected: number;
  hiddenSelected: number;
  busy: boolean;
  onClear: () => void;
  onRun: (action: Action) => void;
  onReview: (kind: "cleanup" | "unpushed") => void;
  onRefresh: () => void;
  onRemove: () => void;
}

const ACTIONS: [Action, string][] = [
  [{ type: "checkoutDefault" }, "Check out default branch…"],
  [{ type: "rebaseFork" }, "Rebase fork on upstream"],
  [{ type: "syncDefaultBranch" }, "Check default branch"],
];

export function ActionPanel(props: Props) {
  return (
    <div className="toolbar list-actions" role="region" aria-label="Selection actions">
      <strong className="selection-count" aria-live="polite">
        {props.selected} selected
      </strong>
      {props.hiddenSelected > 0 && (
        <span className="muted">{props.hiddenSelected} hidden by filters</span>
      )}
      <button className="link" onClick={props.onClear}>
        Clear selection
      </button>
      <button disabled={props.busy} onClick={() => props.onRun({ type: "fetch" })}>
        Fetch
      </button>
      <button
        className="primary-button"
        disabled={props.busy}
        onClick={() => props.onRun({ type: "pull" })}
      >
        Pull…
      </button>
      <details className="toolbar-menu">
        <summary>More actions</summary>
        <div
          className="toolbar-menu-content"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("button"))
              event.currentTarget.parentElement?.removeAttribute("open");
          }}
        >
          {ACTIONS.map(([action, label]) => (
            <button key={action.type} disabled={props.busy} onClick={() => props.onRun(action)}>
              {label}
            </button>
          ))}
          <button onClick={() => props.onReview("unpushed")}>Review local work</button>
          <button onClick={() => props.onReview("cleanup")}>Review branches &amp; worktrees</button>
          <button onClick={props.onRefresh}>Refresh local status</button>
          <button disabled={props.busy} onClick={props.onRemove}>
            Remove from list
          </button>
        </div>
      </details>
    </div>
  );
}
