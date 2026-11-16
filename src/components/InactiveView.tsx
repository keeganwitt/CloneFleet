import { useCallback, useEffect, useState } from "react";
import { recordAction, summarizeItems } from "../activityLog";
import { api } from "../api";
import { formatAge } from "../cleanup";
import { basename } from "../format";
import {
  type InactiveSort,
  type InactiveSortKey,
  compareInactive,
  describeRisks,
  isInactive,
  nextInactiveSort,
} from "../inactive";
import type { CloneActivity, ItemOutcome } from "../types";

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
  const shown = loaded
    .filter(([, activity]) =>
      isInactive(
        activity,
        nowUnix,
        commitFilter ? commitDays : null,
        activityFilter ? activityDays : null,
      ),
    )
    .sort((a, b) => compareInactive(a, b, sort, basename));
  const targets = shown.filter(([repo]) => selected.has(repo));
  const allSelected = shown.length > 0 && targets.length === shown.length;

  const toggle = (repo: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(repo)) next.add(repo);
      return next;
    });

  const moveToTrash = async () => {
    const details = targets.map(([repo, activity]) => {
      const risks = describeRisks(activity.risks);
      const body =
        risks.length === 0
          ? "  Nothing found that the remote doesn't have."
          : risks.map((risk) => `  • ${risk}`).join("\n");
      return `${repo}\n${body}`;
    });
    const atRisk = targets.filter(([, a]) => describeRisks(a.risks).length > 0).length;
    const message =
      `Move ${plural(targets.length, "clone")} to the Trash?\n\n` +
      (atRisk > 0
        ? `${plural(atRisk, "clone has", "clones have")} work that would only be in the Trash afterward.\n\n`
        : "") +
      details.join("\n\n");
    if (!(await api.confirmDestructive(message, "Move to Trash"))) return;

    setBusy(true);
    try {
      const outcomes = await Promise.all(
        targets.map(async ([repo, activity]): Promise<[string, ItemOutcome[]]> => {
          try {
            const result = await api.trashClone(repo, activity.risks);
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
        .filter(([, items]) => items.every((item) => item.status === "succeeded"))
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
    <div className="cleanup">
      <div className="toolbar">
        <h2>Inactive clones</h2>
        <button disabled={busy} onClick={() => analyze(present)}>
          Re-analyze
        </button>
      </div>

      <div className="toolbar">
        <span className="muted">
          {loaded.length + failed.length < present.length
            ? `Analyzed ${loaded.length + failed.length} of ${present.length}…`
            : `${shown.length} of ${plural(present.length, "repository", "repositories")} ${
                shown.length === 1 ? "looks" : "look"
              } inactive`}
        </span>
        <DaysFilter
          label="Last commit by me older than"
          inputLabel="Days since my last commit"
          enabled={commitFilter}
          days={commitDays}
          onEnabled={setCommitFilter}
          onDays={setCommitDays}
        />
        <DaysFilter
          label="Last local activity older than"
          inputLabel="Days since last local activity"
          enabled={activityFilter}
          days={activityDays}
          onEnabled={setActivityFilter}
          onDays={setActivityDays}
        />
        <button disabled={busy || targets.length === 0} onClick={moveToTrash}>
          Move {plural(targets.length, "clone")} to the Trash
        </button>
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
        <table>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="Select all shown clones"
                  checked={allSelected}
                  onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(shown.map(([repo]) => repo)))
                  }
                />
              </th>
              {sortHeader("name", "Repository")}
              {sortHeader("lastCommit", "Last commit by me")}
              {sortHeader("lastActivity", "Last local activity", ACTIVITY_HELP)}
              <th>At risk</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(([repo, activity]) => {
              const risks = describeRisks(activity.risks);
              return (
                <tr key={repo}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${basename(repo)}`}
                      checked={selected.has(repo)}
                      onChange={() => toggle(repo)}
                    />
                  </td>
                  <td>
                    {basename(repo)}
                    <div className="muted repo-path">{repo}</div>
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
                      <span className="outcome-succeeded">Nothing found</span>
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
      )}
    </div>
  );
}
