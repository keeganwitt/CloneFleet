import { useCallback, useEffect, useState } from "react";
import { recordAction, summarizeItems } from "../activityLog";
import { api } from "../api";
import { formatAge } from "../cleanup";
import { basename } from "../format";
import type {
  CleanupResult,
  ItemOutcome,
  MergeEvidence,
  UnpushedBranch,
  UnpushedReport,
} from "../types";

type RepoUnpushed =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; report: UnpushedReport };

interface Props {
  paths: string[];
  onChanged: (paths: string[]) => void;
}

const currentUnixTime = () => Math.floor(Date.now() / 1000);
const key = (repo: string, sha: string) => `${repo}\n${sha}`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchReport(repo: string, fetch: boolean): Promise<RepoUnpushed> {
  try {
    return { status: "loaded", report: await api.analyzeUnpushed(repo, fetch) };
  } catch (error) {
    return { status: "error", error: errorMessage(error) };
  }
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const DAY_SECONDS = 24 * 60 * 60;

export function olderThan(
  report: UnpushedReport,
  nowUnix: number,
  minAgeDays: number | null,
): UnpushedReport {
  if (minAgeDays === null) return report;
  const cutoff = nowUnix - minAgeDays * DAY_SECONDS;
  return {
    ...report,
    branches: report.branches.filter((b) => b.lastCommitUnix <= cutoff),
    stashes: report.stashes.filter((s) => s.createdUnix <= cutoff),
  };
}

export function hasUnpushedWork(report: UnpushedReport): boolean {
  return (
    report.branches.length > 0 || report.stashes.length > 0 || report.dirtyWorktrees.length > 0
  );
}

export function summarizeUnpushed(report: UnpushedReport): string {
  const parts: string[] = [];
  if (report.branches.length > 0) parts.push(plural(report.branches.length, "branch", "branches"));
  if (report.stashes.length > 0) parts.push(plural(report.stashes.length, "stash", "stashes"));
  if (report.dirtyWorktrees.length > 0) parts.push("uncommitted changes");
  return parts.length === 0 ? "Nothing unpushed" : parts.join(" · ");
}

const MERGED_LABELS: Record<MergeEvidence, string> = {
  ancestor: "merged",
  patchEquivalent: "rebased",
  squashed: "squash-merged",
};

export function describeUnpushedBranch(branch: UnpushedBranch): string {
  const commits = `${plural(branch.commits, "commit")} on no remote`;
  const where = branch.upstreamGone
    ? `remote branch ${branch.upstream} was deleted`
    : branch.upstream
      ? `not yet pushed to ${branch.upstream}`
      : "never pushed";
  const merged = branch.merged
    ? `; changes are already in ${branch.merged.base} (${MERGED_LABELS[branch.merged.evidence]})`
    : "";
  return `${commits} (${where})${merged}`;
}

export function UnpushedView({ paths, onChanged }: Props) {
  const [fetchFirst, setFetchFirst] = useState(true);
  const [hideClean, setHideClean] = useState(true);
  const [ageFilter, setAgeFilter] = useState(false);
  const [minAgeDays, setMinAgeDays] = useState(30);
  const [reports, setReports] = useState<Record<string, RepoUnpushed>>(() =>
    Object.fromEntries(paths.map((repo) => [repo, { status: "loading" }])),
  );
  const [selectedStashes, setSelectedStashes] = useState<ReadonlySet<string>>(new Set());
  const [selectedBranches, setSelectedBranches] = useState<ReadonlySet<string>>(new Set());
  const [results, setResults] = useState<Record<string, ItemOutcome[]>>({});
  const [busy, setBusy] = useState(false);
  const [nowUnix, setNowUnix] = useState(currentUnixTime);

  const applyReport = useCallback((repo: string, unpushed: RepoUnpushed) => {
    setReports((current) => ({ ...current, [repo]: unpushed }));
    const otherRepos = (current: ReadonlySet<string>) =>
      new Set([...current].filter((k) => !k.startsWith(`${repo}\n`)));
    setSelectedStashes(otherRepos);
    setSelectedBranches(otherRepos);
    setNowUnix(currentUnixTime());
  }, []);

  useEffect(() => {
    for (const repo of paths) {
      void fetchReport(repo, true).then((unpushed) => applyReport(repo, unpushed));
    }
  }, [applyReport, paths]);

  const analyze = async (repos: string[], fetch: boolean) => {
    setReports((current) => {
      const next = { ...current };
      for (const repo of repos) next[repo] = { status: "loading" };
      return next;
    });
    await Promise.all(
      repos.map((repo) => fetchReport(repo, fetch).then((unpushed) => applyReport(repo, unpushed))),
    );
  };

  const shownEntry = (repo: string): RepoUnpushed | undefined => {
    const entry = reports[repo];
    return entry?.status === "loaded"
      ? { ...entry, report: olderThan(entry.report, nowUnix, ageFilter ? minAgeDays : null) }
      : entry;
  };
  const loaded = paths.flatMap((repo) => {
    const entry = shownEntry(repo);
    return entry?.status === "loaded" ? [[repo, entry.report] as const] : [];
  });
  const withWork = loaded.filter(([, report]) => hasUnpushedWork(report)).length;
  const stashTargets = loaded.flatMap(([repo, report]) =>
    report.stashes.map((s) => key(repo, s.sha)).filter((k) => selectedStashes.has(k)),
  );

  const branchTargets = loaded.flatMap(([repo, report]) =>
    report.branches.map((b) => key(repo, b.name)).filter((k) => selectedBranches.has(k)),
  );
  const unmergedBranchTargets = new Set(
    loaded.flatMap(([repo, report]) =>
      report.branches.filter((b) => !b.merged).map((b) => key(repo, b.name)),
    ),
  );

  const applyToRepos = async (
    targets: string[],
    action: string,
    run: (repo: string, items: string[]) => Promise<CleanupResult>,
  ) => {
    setBusy(true);
    const groups = new Map<string, string[]>();
    for (const target of targets) {
      const index = target.indexOf("\n");
      const repo = target.slice(0, index);
      groups.set(repo, [...(groups.get(repo) ?? []), target.slice(index + 1)]);
    }
    try {
      await Promise.all(
        [...groups].map(async ([repo, names]) => {
          let items: ItemOutcome[];
          try {
            const result = await run(repo, names);
            recordAction(repo, action, summarizeItems(result.items), result.commands);
            items = result.items;
          } catch (error) {
            items = names.map((item) => ({ item, status: "failed", message: errorMessage(error) }));
          }
          setResults((current) => ({ ...current, [repo]: items }));
        }),
      );
      const repos = [...groups.keys()];
      await analyze(repos, false);
      onChanged(repos);
    } finally {
      setBusy(false);
    }
  };

  const dropStashes = async () => {
    const message =
      `Drop ${plural(stashTargets.length, "stash", "stashes")}?\n\n` +
      "Dropped stashes can only be recovered by SHA until git garbage-collects them.";
    if (!(await api.confirmDestructive(message, "Drop stashes"))) return;
    await applyToRepos(stashTargets, "Drop stashes", (repo, shas) => api.dropStashes(repo, shas));
  };

  const deleteBranches = async () => {
    const unmerged = branchTargets.filter((k) => unmergedBranchTargets.has(k));
    let message =
      `Delete ${plural(branchTargets.length, "branch", "branches")} with unpushed commits?\n\n` +
      "Their commits exist on no remote and can only be recovered by SHA until git " +
      "garbage-collects them.";
    if (unmerged.length < branchTargets.length) {
      message += ` ${branchTargets.length - unmerged.length} of them ${
        branchTargets.length - unmerged.length === 1 ? "has its" : "have their"
      } changes already in a base branch.`;
    }
    if (!(await api.confirmDestructive(message, "Delete branches"))) return;
    const unmergedSet = new Set(unmerged);
    await applyToRepos(branchTargets, "Delete branches", (repo, names) =>
      api.deleteBranches(
        repo,
        names,
        names.some((name) => unmergedSet.has(key(repo, name))),
      ),
    );
  };

  const toggle = (setter: typeof setSelectedStashes, itemKey: string) =>
    setter((current) => {
      const next = new Set(current);
      if (!next.delete(itemKey)) next.add(itemKey);
      return next;
    });

  return (
    <div className="cleanup">
      <div className="toolbar">
        <h2>Unpushed work &amp; stashes</h2>
        <label>
          <input
            type="checkbox"
            checked={fetchFirst}
            onChange={(event) => setFetchFirst(event.target.checked)}
          />
          Fetch remotes
        </label>
        <button disabled={busy} onClick={() => analyze(paths, fetchFirst)}>
          Re-analyze
        </button>
      </div>

      <div className="toolbar">
        <span className="muted">
          {loaded.length < paths.length
            ? `Analyzed ${loaded.length} of ${paths.length}…`
            : `${withWork} of ${plural(paths.length, "repository", "repositories")} ${
                withWork === 1 ? "has" : "have"
              } unpushed work${ageFilter ? ` older than ${minAgeDays} days` : ""}`}
        </span>
        <label>
          <input
            type="checkbox"
            checked={hideClean}
            onChange={(event) => setHideClean(event.target.checked)}
          />
          Hide repositories with nothing unpushed
        </label>
        <label>
          <input
            type="checkbox"
            checked={ageFilter}
            onChange={(event) => setAgeFilter(event.target.checked)}
          />
          Only older than
        </label>
        <span className="stale-days">
          <input
            type="number"
            min={1}
            className="days"
            aria-label="Minimum age in days"
            disabled={!ageFilter}
            value={minAgeDays}
            onChange={(event) => setMinAgeDays(Math.max(1, Number(event.target.value) || 1))}
          />
          days
        </span>
        <button disabled={busy || branchTargets.length === 0} onClick={deleteBranches}>
          Delete {plural(branchTargets.length, "branch", "branches")}
        </button>
        <button disabled={busy || stashTargets.length === 0} onClick={dropStashes}>
          Drop {plural(stashTargets.length, "stash", "stashes")}
        </button>
      </div>

      {paths.map((repo) => {
        const entry = shownEntry(repo);
        if (hideClean && entry?.status === "loaded" && !hasUnpushedWork(entry.report)) {
          return null;
        }
        return (
          <RepoSection
            key={repo}
            repo={repo}
            entry={entry}
            results={results[repo]}
            nowUnix={nowUnix}
            isStashSelected={(sha) => selectedStashes.has(key(repo, sha))}
            onToggleStash={(sha) => toggle(setSelectedStashes, key(repo, sha))}
            isBranchSelected={(name) => selectedBranches.has(key(repo, name))}
            onToggleBranch={(name) => toggle(setSelectedBranches, key(repo, name))}
          />
        );
      })}
    </div>
  );
}

interface SectionProps {
  repo: string;
  entry: RepoUnpushed | undefined;
  results: ItemOutcome[] | undefined;
  nowUnix: number;
  isStashSelected: (sha: string) => boolean;
  onToggleStash: (sha: string) => void;
  isBranchSelected: (name: string) => boolean;
  onToggleBranch: (name: string) => void;
}

function RepoSection({
  repo,
  entry,
  results,
  nowUnix,
  isStashSelected,
  onToggleStash,
  isBranchSelected,
  onToggleBranch,
}: SectionProps) {
  const name = basename(repo);
  let body;
  let headline;
  if (!entry || entry.status === "loading") {
    body = <p className="muted">Analyzing…</p>;
  } else if (entry.status === "error") {
    body = <p className="error">{entry.error}</p>;
  } else {
    const { report } = entry;
    headline = (
      <span className={hasUnpushedWork(report) ? "outcome-skipped" : "outcome-succeeded"}>
        {summarizeUnpushed(report)}
      </span>
    );
    body = (
      <>
        {report.warnings.map((warning) => (
          <p key={warning} className="outcome-skipped">
            {warning}
          </p>
        ))}
        {!report.hasRemotes && (
          <p className="outcome-skipped">
            No remotes: everything here exists only on this machine.
          </p>
        )}
        {report.dirtyWorktrees.length > 0 && (
          <>
            <h4>Uncommitted changes</h4>
            <ul className="change-list">
              {report.dirtyWorktrees.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
          </>
        )}
        {report.branches.length > 0 && (
          <>
            <h4>Branches with unpushed commits</h4>
            <table>
              <tbody>
                {report.branches.map((branch) => (
                  <tr key={branch.name}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select branch ${branch.name} in ${name}`}
                        checked={isBranchSelected(branch.name)}
                        onChange={() => onToggleBranch(branch.name)}
                      />
                    </td>
                    <td>
                      <code>{branch.name}</code>
                    </td>
                    <td className={branch.merged ? "muted" : "outcome-skipped"}>
                      {describeUnpushedBranch(branch)}
                    </td>
                    <td className="muted">{formatAge(nowUnix, branch.lastCommitUnix)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {report.stashes.length > 0 && (
          <>
            <h4>Stashes</h4>
            <table>
              <tbody>
                {report.stashes.map((stash) => (
                  <tr key={stash.sha}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select stash ${stash.message} in ${name}`}
                        checked={isStashSelected(stash.sha)}
                        onChange={() => onToggleStash(stash.sha)}
                      />
                    </td>
                    <td>
                      <code>stash@{`{${stash.index}}`}</code>
                    </td>
                    <td>{stash.message}</td>
                    <td className="muted">{formatAge(nowUnix, stash.createdUnix)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </>
    );
  }

  return (
    <section className="cleanup-repo">
      <h3 className="tree-row">
        {name}
        {headline}
        <span className="muted repo-path">{repo}</span>
      </h3>
      {results && results.length > 0 && (
        <ul className="cleanup-results">
          {results.map((result) => (
            <li key={result.item} className={`outcome-${result.status}`}>
              {result.message}
            </li>
          ))}
        </ul>
      )}
      {body}
    </section>
  );
}
