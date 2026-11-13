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
  cancelled?: boolean;
  onCancel?: () => void;
  detail?: string;
}

export function RunSummaryBar({
  label,
  summary,
  activeStatus,
  onShowStatus,
  onDismiss,
  cancelled,
  onCancel,
  detail,
}: Props) {
  const statuses = (Object.keys(STATUS_LABELS) as RunStatus[]).filter(
    (status) => summary.byStatus[status].length > 0,
  );
  const reasons = summary.reasons.map(([reason, count]) => `${count} ${reason}`).join(", ");
  return (
    <div className="notice run-summary" role="status" aria-label="Last run">
      <span className="run-summary-items">
        <strong>{label}</strong>
        {summary.running > 0 && (
          <>
            <span className="muted">
              {summary.running} {cancelled ? "finishing…" : "running…"}
            </span>
            {onCancel && !cancelled && (
              <button className="link" onClick={onCancel}>
                Cancel
              </button>
            )}
          </>
        )}
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
        {detail && <span>{detail}</span>}
        {activeStatus && (
          <button className="link" onClick={() => onShowStatus(undefined)}>
            Show all
          </button>
        )}
      </span>
      <button onClick={onDismiss} aria-label="Close run summary">
        Close
      </button>
    </div>
  );
}
