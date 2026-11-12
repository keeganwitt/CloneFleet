import { formatRecent } from "../cleanup";
import { basename } from "../format";
import type { Freshness } from "../freshness";
import { isStale } from "../freshness";
import { PROBLEMS, SECTIONS, buildOverview, type Card, type Fix } from "../problems";
import type { RepoState } from "../state";
import type { RepoHealth } from "../types";

const FIX_LABELS: Record<Fix, string> = {
  pull: "Pull all",
  checkoutDefault: "Check out default",
  reviewUnpushed: "Review",
  cleanup: "Clean up",
};

const PREVIEW_COUNT = 4;

interface Props {
  paths: string[];
  states: Record<string, RepoState>;
  healths: Record<string, RepoHealth | undefined>;
  pendingScans: number;
  lastScannedUnix: number | undefined;
  nowUnix: number;
  freshness: Freshness;
  busy: boolean;
  onFix: (fix: Fix, paths: string[]) => void;
  onShow: (label: string, paths: string[]) => void;
  onFetchAll: () => void;
  onRescan: () => void;
}

function RepoNames({ paths }: { paths: string[] }) {
  const shown = paths.slice(0, PREVIEW_COUNT).map(basename);
  const more = paths.length - shown.length;
  return (
    <span className="muted card-repos">
      {shown.join(", ")}
      {more > 0 && ` and ${more} more`}
    </span>
  );
}

function ProblemCard({
  card,
  busy,
  onFix,
  onShow,
}: { card: Card; busy: boolean } & Pick<Props, "onFix" | "onShow">) {
  const info = PROBLEMS[card.kind];
  const title = info.title(card.paths.length, card.items);
  return (
    <li className={`card card-${info.severity}`} aria-label={title}>
      <div className="card-text">
        <strong>{title}</strong>
        <RepoNames paths={card.paths} />
      </div>
      <div className="card-actions">
        {info.fix && (
          <button disabled={busy} onClick={() => onFix(info.fix!, card.paths)}>
            {FIX_LABELS[info.fix]}
          </button>
        )}
        <button className="link" onClick={() => onShow(title, card.paths)}>
          Show
        </button>
      </div>
    </li>
  );
}

export function Dashboard(props: Props) {
  const overview = buildOverview(props.paths, props.states, props.healths);
  const { oldestFetchUnix, neverFetched } = props.freshness;
  const stale = isStale(props.nowUnix, oldestFetchUnix) || neverFetched > 0;

  return (
    <section className="dashboard" aria-label="Overview">
      <div className="toolbar dashboard-header">
        <span>
          <strong>{props.paths.length}</strong>{" "}
          {props.paths.length === 1 ? "repository" : "repositories"}
          {" · "}
          <strong>{overview.needsAttention.length}</strong> need attention
        </span>
        <span className="freshness">
          <span className={stale ? "stale" : "muted"}>
            {oldestFetchUnix === null
              ? "Never fetched"
              : `Oldest fetch ${formatRecent(props.nowUnix, oldestFetchUnix)}`}
            {neverFetched > 0 && oldestFetchUnix !== null && ` · ${neverFetched} never fetched`}
          </span>
          <button disabled={props.busy || props.paths.length === 0} onClick={props.onFetchAll}>
            Fetch all
          </button>
          <span className="muted" role="status" aria-label="Scan status">
            {props.pendingScans > 0
              ? `Checking branches… ${props.pendingScans} left`
              : props.lastScannedUnix !== undefined
                ? `Checked ${formatRecent(props.nowUnix, props.lastScannedUnix)}`
                : ""}
          </span>
          <button className="link" disabled={props.pendingScans > 0} onClick={props.onRescan}>
            Recheck
          </button>
        </span>
      </div>

      {SECTIONS.map(([section, label]) => {
        const cards = overview.cards.filter((card) => PROBLEMS[card.kind].section === section);
        if (cards.length === 0) return null;
        return (
          <div key={section} className="dashboard-section">
            <h3>{label}</h3>
            <ul className="cards" aria-label={label}>
              {cards.map((card) => (
                <ProblemCard
                  key={card.kind}
                  card={card}
                  busy={props.busy}
                  onFix={props.onFix}
                  onShow={props.onShow}
                />
              ))}
            </ul>
          </div>
        );
      })}

      {overview.healthy.length > 0 && (
        <p className="healthy">
          <span className="outcome-succeeded">
            ✓ {overview.healthy.length}{" "}
            {overview.healthy.length === 1 ? "repository is" : "repositories are"} up to date and
            clean
          </span>
          <button
            className="link"
            onClick={() => props.onShow("Up to date and clean", overview.healthy)}
          >
            Show
          </button>
        </p>
      )}
      {overview.cards.length === 0 && overview.healthy.length === props.paths.length && (
        <p className="empty muted">Everything is up to date. Nothing needs attention.</p>
      )}
    </section>
  );
}
