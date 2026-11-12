import type { RunStatus, RunSummary } from "../runSummary";

const STATUS_LABELS: Record<RunStatus, string> = {
  succeeded: "succeeded",
  skipped: "skipped",
  failed: "failed",
};

interface Props {
  label: string;
  summary: RunSummary;
  activeStatus: RunStatus | undefined;
  onShowStatus: (status: RunStatus | undefined) => void;
  onDismiss: () => void;
}

export function RunSummaryBar({ label, summary, activeStatus, onShowStatus, onDismiss }: Props) {
  const statuses = (Object.keys(STATUS_LABELS) as RunStatus[]).filter(
    (status) => summary.byStatus[status].length > 0,
  );
  const reasons = summary.skipReasons.map(([reason, count]) => `${count} ${reason}`).join(", ");
  return (
    <div className="notice run-summary" role="status" aria-label="Last run">
      <span className="run-summary-items">
        <strong>{label}</strong>
        {summary.running > 0 && <span className="muted">{summary.running} running…</span>}
        {statuses.map((status) => (
          <button
            key={status}
            className={`link outcome-${status}${activeStatus === status ? " active" : ""}`}
            aria-pressed={activeStatus === status}
            onClick={() => onShowStatus(activeStatus === status ? undefined : status)}
          >
            {summary.byStatus[status].length} {STATUS_LABELS[status]}
          </button>
        ))}
        {reasons && <span className="muted">({reasons})</span>}
        {activeStatus && (
          <button className="link" onClick={() => onShowStatus(undefined)}>
            Show all
          </button>
        )}
      </span>
      <button className="link" onClick={onDismiss} aria-label="Dismiss run summary">
        ×
      </button>
    </div>
  );
}
