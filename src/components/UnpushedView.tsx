import { useCallback, useEffect, useState } from "react";
import { recordCommands } from "../activityLog";
import { api } from "../api";
import { formatAge } from "../cleanup";
import { basename } from "../format";
import type { ItemOutcome, MergeEvidence, UnpushedBranch, UnpushedReport } from "../types";

type RepoUnpushed =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; report: UnpushedReport };

interface Props {
  paths: string[];
  onClose: () => void;
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

export function UnpushedView({ paths, onClose, onChanged }: Props) {
  const [fetchFirst, setFetchFirst] = useState(true);
  const [hideClean, setHideClean] = useState(true);
  const [reports, setReports] = useState<Record<string, RepoUnpushed>>(() =>
    Object.fromEntries(paths.map((repo) => [repo, { status: "loading" }])),
  );
  const [selectedStashes, setSelectedStashes] = useState<ReadonlySet<string>>(new Set());
  const [results, setResults] = useState<Record<string, ItemOutcome[]>>({});
  const [busy, setBusy] = useState(false);
  const [nowUnix, setNowUnix] = useState(currentUnixTime);

  const applyReport = useCallback((repo: string, unpushed: RepoUnpushed) => {
    setReports((current) => ({ ...current, [repo]: unpushed }));
    setSelectedStashes(
      (current) => new Set([...current].filter((k) => !k.startsWith(`${repo}\n`))),
    );
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

  const loaded = paths.flatMap((repo) => {
    const entry = reports[repo];
    return entry?.status === "loaded" ? [[repo, entry.report] as const] : [];
  });
  const withWork = loaded.filter(([, report]) => hasUnpushedWork(report)).length;
  const stashTargets = loaded.flatMap(([repo, report]) =>
    report.stashes.map((s) => key(repo, s.sha)).filter((k) => selectedStashes.has(k)),
  );

  const dropStashes = async () => {
    const message =
      `Drop ${plural(stashTargets.length, "stash", "stashes")}?\n\n` +
      "Dropped stashes can only be recovered by SHA until git garbage-collects them.";
    if (!(await api.confirmDestructive(message, "Drop stashes"))) return;
    setBusy(true);
    const groups = new Map<string, string[]>();
    for (const target of stashTargets) {
      const [repo, sha] = target.split("\n");
      groups.set(repo, [...(groups.get(repo) ?? []), sha]);
    }
    try {
      await Promise.all(
        [...groups].map(async ([repo, shas]) => {
          let items: ItemOutcome[];
          try {
            const result = await api.dropStashes(repo, shas);
            recordCommands(repo, "Drop stashes", result.commands);
            items = result.items;
          } catch (error) {
            items = shas.map((item) => ({ item, status: "failed", message: errorMessage(error) }));
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

  const toggleStash = (itemKey: string) =>
    setSelectedStashes((current) => {
      const next = new Set(current);
      if (!next.delete(itemKey)) next.add(itemKey);
      return next;
    });

  return (
    <div className="cleanup">
      <div className="toolbar">
        <button onClick={onClose}>← Back</button>
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
              } unpushed work`}
        </span>
        <label>
          <input
            type="checkbox"
            checked={hideClean}
            onChange={(event) => setHideClean(event.target.checked)}
          />
          Hide repositories with nothing unpushed
        </label>
        <button disabled={busy || stashTargets.length === 0} onClick={dropStashes}>
          Drop {plural(stashTargets.length, "stash", "stashes")}
        </button>
      </div>

      {paths.map((repo) => {
        const entry = reports[repo];
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
            onToggleStash={(sha) => toggleStash(key(repo, sha))}
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
}

function RepoSection({
  repo,
  entry,
  results,
  nowUnix,
  isStashSelected,
  onToggleStash,
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
