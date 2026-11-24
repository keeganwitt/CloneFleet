import { formatRecent } from "../cleanup";
import type { Freshness } from "../freshness";
import { isStale } from "../freshness";
import { PROBLEMS, buildOverview, type Card, type ProblemKind } from "../problems";
import type { RepoState } from "../state";
import type { RepoHealth } from "../types";

interface Props {
  paths: string[];
  states: Record<string, RepoState>;
  healths: Record<string, RepoHealth | undefined>;
  reclaimable?: Record<string, number | undefined>;
  pendingScans: number;
  lastScannedUnix: number | undefined;
  nowUnix: number;
  freshness: Freshness;
  scopeSummary: string;
  busy: boolean;
  onOpenFinding: (kind: ProblemKind, label: string, paths: string[]) => void;
  onShow: (label: string, paths: string[]) => void;
  onFetchAll: () => void;
  onRescan: () => void;
}

const FINDING_LABELS: Record<ProblemKind, [string, string]> = {
  authRequired: ["Authentication needed", "View repositories"],
  remoteUnreachable: ["Remote unavailable", "View repositories"],
  statusError: ["Repository unavailable", "View repositories"],
  inProgress: ["Git operation in progress", "View repositories"],
  conflicts: ["Conflicts", "View repositories"],
  diverged: ["Diverged from upstream", "View repositories"],
  unpushed: ["Unpushed commits", "Review unpushed work"],
  behind: ["Behind upstream", "View behind repositories"],
  notOnDefault: ["On a non-default branch", "View repositories"],
  uncommitted: ["Working tree changes", "View repositories"],
  stashes: ["Stashes", "Review stashes"],
  mergedBranches: ["Merged branches", "Review merged branches"],
  staleBranches: ["Stale or upstream-deleted branches", "Review stale branches"],
  removableWorktrees: ["Removable worktrees", "Review removable worktrees"],
  staleWorktrees: ["Stale unmerged worktrees", "Review stale worktrees"],
  reclaimableSpace: ["Build and dependency directories", "Review disk space"],
};

function Finding({ card, onOpen }: { card: Card; onOpen: Props["onOpenFinding"] }) {
  const { kind, paths, items } = card;
  const info = PROBLEMS[kind];
  const detail = info.title(paths.length, items);
  const [title, action] = FINDING_LABELS[kind];
  return (
    <li className={`finding finding-${info.severity}`} aria-label={detail}>
      <div>
        <strong>{title}</strong>
        <div className="muted finding-detail">{detail}</div>
      </div>
      <button className="link" onClick={() => onOpen(kind, detail, paths)}>
        {action} <span aria-hidden="true">›</span>
      </button>
    </li>
  );
}

export function Dashboard(props: Props) {
  const { cards, needsAttention, healthy } = buildOverview(
    props.paths,
    props.states,
    props.healths,
    props.reclaimable,
  );
  const { oldestFetchUnix, neverFetched } = props.freshness;
  const stale = isStale(props.nowUnix, oldestFetchUnix) || neverFetched > 0;
  const attention = cards.filter((card) => PROBLEMS[card.kind].section === "attention");
  const updates = cards.filter((card) => PROBLEMS[card.kind].section === "updates");
  const work = cards.filter((card) => PROBLEMS[card.kind].section === "work");
  const housekeeping = cards.filter((card) => PROBLEMS[card.kind].section === "housekeeping");
  const list = (label: string, items: Card[]) =>
    items.length > 0 && (
      <ul className="finding-list" aria-label={label}>
        {items.map((card) => (
          <Finding key={card.kind} card={card} onOpen={props.onOpenFinding} />
        ))}
      </ul>
    );
  const healthyLabel = `${healthy.length} ${healthy.length === 1 ? "repository" : "repositories"} clean and in sync at last fetch`;

  return (
    <section className="dashboard" aria-labelledby="overview-heading">
      <header className="page-heading dashboard-heading">
        <div>
          <h1 id="overview-heading">Overview</h1>
          <p className="muted">{props.scopeSummary}</p>
        </div>
        <div className="toolbar">
          <span className={stale ? "stale" : "muted"}>
            {oldestFetchUnix !== null &&
              `Oldest fetch ${formatRecent(props.nowUnix, oldestFetchUnix)}`}
            {neverFetched > 0 &&
              `${oldestFetchUnix !== null ? " · " : ""}${neverFetched} never fetched`}
          </span>
          <button
            className="primary-button"
            disabled={props.busy || props.paths.length === 0}
            onClick={props.onFetchAll}
          >
            Fetch all {props.paths.length}
          </button>
        </div>
      </header>
      <div className="toolbar overview-refresh">
        <span className="muted" role="status" aria-label="Scan status">
          {props.pendingScans > 0
            ? `Checking branches… ${props.pendingScans} left`
            : props.lastScannedUnix !== undefined
              ? `Checked ${formatRecent(props.nowUnix, props.lastScannedUnix)}`
              : ""}
        </span>
        <button className="link" disabled={props.pendingScans > 0} onClick={props.onRescan}>
          Refresh local status
        </button>
      </div>
      {(attention.length > 0 || updates.length > 0) && (
        <section className="dashboard-section">
          <div className="toolbar dashboard-section-title">
            <h2>Needs attention</h2>
            <button
              className="status-pill status-warning"
              onClick={() => props.onShow("Needs attention", needsAttention)}
            >
              {needsAttention.length} {needsAttention.length === 1 ? "repository" : "repositories"}
            </button>
          </div>
          <div className="finding-panel">
            {list("Needs attention", attention)}
            {list("Updates available", updates)}
          </div>
        </section>
      )}
      <div className="dashboard-columns">
        {work.length > 0 && (
          <section className="dashboard-section">
            <h2>Work in progress</h2>
            {list("Work in progress", work)}
          </section>
        )}
        {housekeeping.length > 0 && (
          <section className="dashboard-section">
            <h2>Cleanup</h2>
            {list("Cleanup", housekeeping)}
          </section>
        )}
      </div>
      {healthy.length > 0 && (
        <div className="healthy-summary">
          <strong>{healthyLabel}</strong>
          <button className="link" onClick={() => props.onShow(healthyLabel, healthy)}>
            View repositories <span aria-hidden="true">›</span>
          </button>
        </div>
      )}
    </section>
  );
}
