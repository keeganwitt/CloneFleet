import { useCallback, useEffect, useState } from "react";
import { recordAction, summarizeItems } from "../activityLog";
import { api } from "../api";
import { formatAge } from "../cleanup";
import { basename, uniqueLabels } from "../format";
import {
  type InactiveSort,
  type InactiveSortKey,
  compareInactive,
  describeRisks,
  isInactive,
  nextInactiveSort,
} from "../inactive";
import type { CloneActivity, ItemOutcome } from "../types";

import { CleanupToolbar } from "./CleanupToolbar";
import { ReviewDialog } from "./ReviewDialog";
import { TriStateCheckbox } from "./BranchTree";

type RepoActivity =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; activity: CloneActivity };

interface Props {
  paths: string[];
  onRemoved: (paths: string[]) => void;
}

const DEFAULT_DAYS = 90;
const ACTIVITY_HELP =
  "Last checkout, commit, merge, or rebase you made here. CloneFleet's own pulls and switches don't count.";
const currentUnixTime = () => Math.floor(Date.now() / 1000);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchActivity(repo: string): Promise<RepoActivity> {
  try {
    return { status: "loaded", activity: await api.cloneActivity(repo) };
  } catch (error) {
    return { status: "error", error: errorMessage(error) };
  }
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

interface DaysFilterProps {
  label: string;
  inputLabel: string;
  enabled: boolean;
  days: number;
  onEnabled: (enabled: boolean) => void;
  onDays: (days: number) => void;
}

function DaysFilter({ label, inputLabel, enabled, days, onEnabled, onDays }: DaysFilterProps) {
  return (
    <>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onEnabled(event.target.checked)}
        />
        {label}
      </label>
      <span className="stale-days">
        <input
          type="number"
          min={1}
          className="days"
          aria-label={inputLabel}
          disabled={!enabled}
          value={days}
          onChange={(event) => onDays(Math.max(1, Number(event.target.value) || 1))}
        />
        days
      </span>
    </>
  );
}

export function InactiveView({ paths, onRemoved }: Props) {
  const [activities, setActivities] = useState<Record<string, RepoActivity>>(() =>
    Object.fromEntries(paths.map((repo) => [repo, { status: "loading" }])),
  );
  const [query, setQuery] = useState("");
  const [review, setReview] = useState<readonly (readonly [string, CloneActivity])[]>();
  const [commitFilter, setCommitFilter] = useState(true);
  const [commitDays, setCommitDays] = useState(DEFAULT_DAYS);
  const [activityFilter, setActivityFilter] = useState(true);
  const [activityDays, setActivityDays] = useState(DEFAULT_DAYS);
  const [sort, setSort] = useState<InactiveSort>({ key: "lastActivity", direction: "ascending" });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [results, setResults] = useState<ItemOutcome[]>([]);
  const [busy, setBusy] = useState(false);
  const [nowUnix, setNowUnix] = useState(currentUnixTime);

  const applyActivity = useCallback((repo: string, activity: RepoActivity) => {
    setActivities((current) => ({ ...current, [repo]: activity }));
    setNowUnix(currentUnixTime());
  }, []);

  const analyze = useCallback(
    async (repos: string[]) => {
      setActivities((current) => {
        const next = { ...current };
        for (const repo of repos) next[repo] = { status: "loading" };
        return next;
      });
      setSelected(new Set());
      await Promise.all(
        repos.map((repo) => fetchActivity(repo).then((activity) => applyActivity(repo, activity))),
      );
    },
    [applyActivity],
  );

  useEffect(() => {
    for (const repo of paths) {
      void fetchActivity(repo).then((activity) => applyActivity(repo, activity));
    }
  }, [applyActivity, paths]);

  const present = paths.filter((repo) => !removed.has(repo));
  const loaded = present.flatMap((repo) => {
    const entry = activities[repo];
    return entry?.status === "loaded" ? [[repo, entry.activity] as const] : [];
  });
  const failed = present.flatMap((repo) => {
    const entry = activities[repo];
    return entry?.status === "error" ? [[repo, entry.error] as const] : [];
  });
  const labels = uniqueLabels(paths);
  const shown = loaded
    .filter(
      ([repo, activity]) =>
        repo.toLowerCase().includes(query.trim().toLowerCase()) &&
        isInactive(
          activity,
          nowUnix,
          commitFilter ? commitDays : null,
          activityFilter ? activityDays : null,
        ),
    )
    .sort((a, b) => compareInactive(a, b, sort, basename));
  const targets = shown.filter(([repo]) => selected.has(repo));
  const pending = loaded.length + failed.length < present.length;
  const atRisk =
    review?.filter(([, activity]) => describeRisks(activity.risks).length > 0).length ?? 0;

  const toggle = (repo: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(repo)) next.add(repo);
      return next;
    });

  const moveToTrash = async (approved: readonly (readonly [string, CloneActivity])[]) => {
    setReview(undefined);
    setBusy(true);
    try {
      const outcomes = await Promise.all(
        approved.map(async ([repo, activity]): Promise<[string, ItemOutcome[]]> => {
          try {
            const result = await api.trashClone(repo, {
              risks: activity.risks,
              snapshot: activity.snapshot,
            });
            recordAction(
              repo,
              "Move clone to the Trash",
              summarizeItems(result.items),
              result.commands,
            );
            return [repo, result.items];
          } catch (error) {
            return [repo, [{ item: repo, status: "failed", message: errorMessage(error) }]];
          }
        }),
      );
      setResults(outcomes.flatMap(([, items]) => items));
      const gone = outcomes
        .filter(
          ([, items]) => items.length > 0 && items.every((item) => item.status === "succeeded"),
        )
        .map(([repo]) => repo);
      setRemoved((current) => new Set([...current, ...gone]));
      setSelected(new Set());
      const changed = outcomes.map(([repo]) => repo).filter((repo) => !gone.includes(repo));
      if (changed.length > 0) void analyze(changed);
      if (gone.length > 0) onRemoved(gone);
    } finally {
      setBusy(false);
    }
  };

  const sortHeader = (key: InactiveSortKey, label: string, title?: string) => (
    <th aria-sort={sort.key === key ? sort.direction : undefined}>
      <button
        className="sort-button"
        title={title}
        onClick={() => setSort(nextInactiveSort(sort, key))}
      >
        {label}
        <span aria-hidden="true">
          {sort.key === key ? (sort.direction === "ascending" ? " ▲" : " ▼") : ""}
        </span>
      </button>
    </th>
  );
  const age = (timestamp: number | null) =>
    timestamp === null ? "Never" : formatAge(nowUnix, timestamp);

  return (
    <section className="list-panel cleanup-panel" aria-label="Inactive clones">
      <CleanupToolbar
        selected={targets.length}
        busy={busy}
        analyzeDisabled={pending}
        onAnalyze={() => void analyze(present)}
        reviewLabel={`Review ${plural(targets.length, "clone")}…`}
        onReview={() => setReview(targets)}
        onClear={() => setSelected(new Set())}
      >
        <input
          type="search"
          aria-label="Search clones"
          placeholder="Find repository"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="inactive-age-filter">
          <DaysFilter
            label="Last commit by me older than"
            inputLabel="Days since my last commit"
            enabled={commitFilter}
            days={commitDays}
            onEnabled={setCommitFilter}
            onDays={setCommitDays}
          />
        </div>
        <div className="inactive-age-filter">
          <DaysFilter
            label="Last local activity older than"
            inputLabel="Days since last local activity"
            enabled={activityFilter}
            days={activityDays}
            onEnabled={setActivityFilter}
            onDays={setActivityDays}
          />
        </div>
      </CleanupToolbar>
      <div className="list-context" role="status">
        {pending
          ? `Analyzed ${loaded.length + failed.length} of ${present.length}…`
          : `${shown.length} of ${plural(present.length, "repository", "repositories")} ${shown.length === 1 ? "looks" : "look"} inactive`}
      </div>

      {results.length > 0 && (
        <ul className="cleanup-results">
          {results.map((result) => (
            <li key={result.item} className={`outcome-${result.status}`}>
              {result.message}
            </li>
          ))}
        </ul>
      )}

      {failed.map(([repo, error]) => (
        <p key={repo} className="error">
          {basename(repo)}: {error}
        </p>
      ))}

      {shown.length > 0 && (
        <div className="list-table-scroll">
          <table className="cleanup-table">
            <colgroup>
              <col className="selection-column" />
              <col style={{ width: "28%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "18%" }} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th>
                  <TriStateCheckbox
                    label="Select all shown clones"
                    names={shown.map(([repo]) => repo)}
                    isSelected={(repo) => selected.has(repo)}
                    onSetSelected={(repos, checked) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        for (const repo of repos) {
                          if (checked) next.add(repo);
                          else next.delete(repo);
                        }
                        return next;
                      })
                    }
                  />
                </th>
                {sortHeader("name", "Repository")}
                {sortHeader("lastCommit", "My last commit")}
                {sortHeader("lastActivity", "Last local activity", ACTIVITY_HELP)}
                <th>Local data</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(([repo, activity]) => {
                const risks = describeRisks(activity.risks);
                return (
                  <tr key={repo} className={selected.has(repo) ? "selected" : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${labels.get(repo)}`}
                        checked={selected.has(repo)}
                        onChange={() => toggle(repo)}
                      />
                    </td>
                    <td>
                      <strong title={repo}>{labels.get(repo)}</strong>
                      {activity.warnings.map((warning) => (
                        <div key={warning} className="outcome-skipped">
                          {warning}
                        </div>
                      ))}
                    </td>
                    <td>{age(activity.lastCommitByMeUnix)}</td>
                    <td>{age(activity.lastLocalActivityUnix)}</td>
                    <td>
                      {risks.length === 0 ? (
                        <span className="muted">No local-only data found</span>
                      ) : (
                        <ul className="change-list">
                          {risks.map((risk) => (
                            <li key={risk} className="outcome-skipped">
                              {risk}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!pending && shown.length === 0 && (
        <p className="list-message muted">No clones match these filters.</p>
      )}
      {review && (
        <ReviewDialog
          title="Review clones to move to Trash"
          summary={plural(review.length, "local clone")}
          confirmLabel={`Move ${plural(review.length, "clone")} to Trash`}
          danger
          onConfirm={() => void moveToTrash(review)}
          onClose={() => setReview(undefined)}
        >
          {atRisk > 0 && (
            <p className="review-warning">
              <strong>Local data in {plural(atRisk, "clone")}</strong>
              <br />
              Review this data before moving the clones to the Trash.
            </p>
          )}
          <h3>Clones and local data</h3>
          <ul className="review-targets">
            {review.map(([repo, activity]) => {
              const risks = describeRisks(activity.risks);
              return (
                <li key={repo}>
                  <code>{repo}</code>
                  {risks.length ? (
                    <ul className="review-risks">
                      {risks.map((risk) => (
                        <li key={risk}>{risk}</li>
                      ))}
                    </ul>
                  ) : (
                    <div className="muted">No local-only data found</div>
                  )}
                </li>
              );
            })}
          </ul>
        </ReviewDialog>
      )}
    </section>
  );
}
