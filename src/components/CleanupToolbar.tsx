import type { ReactNode } from "react";

interface Props {
  children: ReactNode;
  busy: boolean;
  analyzeDisabled?: boolean;
  onAnalyze: () => void;
  selected: number;
  selectionDetail?: string;
  reviewLabel: string;
  onClear: () => void;
  onReview: () => void;
}

export function CleanupToolbar({
  children,
  busy,
  analyzeDisabled,
  onAnalyze,
  selected,
  selectionDetail,
  reviewLabel,
  onClear,
  onReview,
}: Props) {
  return (
    <div
      className={`list-toolbar cleanup-toolbar${selected ? " has-selection" : ""}`}
      role="group"
      aria-label="Cleanup tools"
    >
      <div className="toolbar list-filters">{children}</div>
      <div className="toolbar list-actions">
        {selected > 0 ? (
          <>
            <strong className="selection-count" aria-live="polite">
              {selected} selected{selectionDetail && ` · ${selectionDetail}`}
            </strong>
            <button className="link" onClick={onClear} disabled={busy}>
              Clear selection
            </button>
            <button className="primary-button" onClick={onReview} disabled={busy}>
              {reviewLabel}
            </button>
          </>
        ) : (
          <button className="primary-button" onClick={onAnalyze} disabled={busy || analyzeDisabled}>
            Analyze
          </button>
        )}
      </div>
    </div>
  );
}
