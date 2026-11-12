import { Fragment, useCallback, useEffect, useState } from "react";
import { api } from "../api";
import {
  BRANCH_CATEGORIES,
  categorizeBranch,
  worktreeState,
  type BranchCategory,
} from "../cleanup";
import { basename } from "../format";
import { BranchTree, TriStateCheckbox, selectableBranches } from "./BranchTree";
import type { BranchReport, ItemOutcome } from "../types";

type RepoCleanup =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; report: BranchReport };

interface Props {
  paths: string[];
  onClose: () => void;
  onChanged: (paths: string[]) => void;
}

const DEFAULT_CATEGORIES: BranchCategory[] = ["merged", "remoteDeleted", "stale"];

async function fetchReport(repo: string, fetch: boolean): Promise<RepoCleanup> {
  try {
    return { status: "loaded", report: await api.analyzeBranches(repo, fetch) };
  } catch (error) {
    return { status: "error", error: errorMessage(error) };
  }
}

const currentUnixTime = () => Math.floor(Date.now() / 1000);

const key = (repo: string, item: string) => `${repo}\n${item}`;

function splitKey(itemKey: string): [string, string] {
  const index = itemKey.indexOf("\n");
  return [itemKey.slice(0, index), itemKey.slice(index + 1)];
}

function groupByRepo(keys: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const itemKey of keys) {
    const [repo, item] = splitKey(itemKey);
    groups.set(repo, [...(groups.get(repo) ?? []), item]);
  }
  return groups;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CleanupView({ paths, onClose, onChanged }: Props) {
  const [fetchFirst, setFetchFirst] = useState(true);
  const [staleDays, setStaleDays] = useState(90);
  const [shown, setShown] = useState<ReadonlySet<BranchCategory>>(new Set(DEFAULT_CATEGORIES));
  const [reports, setReports] = useState<Record<string, RepoCleanup>>(() =>
    Object.fromEntries(paths.map((repo) => [repo, { status: "loading" }])),
  );
  const [selectedBranches, setSelectedBranches] = useState<ReadonlySet<string>>(new Set());
  const [selectedWorktrees, setSelectedWorktrees] = useState<ReadonlySet<string>>(new Set());
  const [deleteWorktreeBranches, setDeleteWorktreeBranches] = useState(true);
  const [results, setResults] = useState<Record<string, ItemOutcome[]>>({});
  const [busy, setBusy] = useState(false);
  const [nowUnix, setNowUnix] = useState(currentUnixTime);

  const applyReport = useCallback((repo: string, cleanup: RepoCleanup) => {
    setReports((current) => ({ ...current, [repo]: cleanup }));
    const report = cleanup.status === "loaded" ? cleanup.report : undefined;
    const ownKey = (k: string) => splitKey(k)[0] === repo;
    setSelectedBranches((current) => {
      const next = new Set([...current].filter((k) => !ownKey(k)));
      report?.branches
        .filter((b) => b.merged && !b.protection)
        .forEach((b) => next.add(key(repo, b.name)));
      return next;
    });
    setSelectedWorktrees((current) => {
      const next = new Set([...current].filter((k) => !ownKey(k)));
      report?.worktrees
        .filter((w) => worktreeState(w).removable)
        .forEach((w) => next.add(key(repo, w.path)));
      return next;
    });
    setNowUnix(currentUnixTime());
  }, []);

  useEffect(() => {
    for (const repo of paths) {
      void fetchReport(repo, true).then((cleanup) => applyReport(repo, cleanup));
    }
  }, [applyReport, paths]);

  const analyze = async (repos: string[], fetch: boolean) => {
    setReports((current) => {
      const next = { ...current };
      for (const repo of repos) next[repo] = { status: "loading" };
      return next;
    });
    await Promise.all(
      repos.map((repo) => fetchReport(repo, fetch).then((cleanup) => applyReport(repo, cleanup))),
    );
  };

  const visibleBranchKeys = new Set<string>();
  const unmergedBranchKeys = new Set<string>();
  const removableWorktreeKeys = new Set<string>();
  for (const repo of paths) {
    const cleanup = reports[repo];
    if (cleanup?.status !== "loaded") continue;
    for (const branch of cleanup.report.branches) {
      const category = categorizeBranch(branch, nowUnix, staleDays);
      if (category === "protected" || !shown.has(category)) continue;
      visibleBranchKeys.add(key(repo, branch.name));
      if (category !== "merged") unmergedBranchKeys.add(key(repo, branch.name));
    }
    for (const worktree of cleanup.report.worktrees) {
      if (worktreeState(worktree).removable) removableWorktreeKeys.add(key(repo, worktree.path));
    }
  }
  const branchTargets = [...selectedBranches].filter((k) => visibleBranchKeys.has(k));
  const worktreeTargets = [...selectedWorktrees].filter((k) => removableWorktreeKeys.has(k));
  const unmergedTargets = branchTargets.filter((k) => unmergedBranchKeys.has(k));

  const toggle = (setter: typeof setSelectedBranches, itemKey: string) =>
    setter((current) => {
      const next = new Set(current);
      if (!next.delete(itemKey)) next.add(itemKey);
      return next;
    });

  const applyCleanup = async (
    targets: string[],
    run: (repo: string, items: string[]) => Promise<ItemOutcome[]>,
  ) => {
    setBusy(true);
    const groups = groupByRepo(targets);
    try {
      await Promise.all(
        [...groups].map(async ([repo, items]) => {
          let outcomes: ItemOutcome[];
          try {
            outcomes = await run(repo, items);
          } catch (error) {
            outcomes = items.map((item) => ({
              item,
              status: "failed",
              message: errorMessage(error),
            }));
          }
          setResults((current) => ({ ...current, [repo]: outcomes }));
        }),
      );
      const repos = [...groups.keys()];
      await analyze(repos, false);
      onChanged(repos);
    } finally {
      setBusy(false);
    }
  };

  const deleteBranches = async () => {
    const repoCount = groupByRepo(branchTargets).size;
    let message =
      `Delete ${plural(branchTargets.length, "local branch", "local branches")} ` +
      `in ${plural(repoCount, "repository", "repositories")}?`;
    if (unmergedTargets.length > 0) {
      message +=
        `\n\n${unmergedTargets.length} of them ${unmergedTargets.length === 1 ? "is" : "are"} ` +
        "not merged. Their commits can only be recovered by SHA until git garbage-collects them.";
    }
    if (!(await api.confirmDestructive(message, "Delete branches"))) return;
    const unmerged = new Set(unmergedTargets);
    await applyCleanup(branchTargets, async (repo, names) => {
      const allowUnmerged = names.some((name) => unmerged.has(key(repo, name)));
      return (await api.deleteBranches(repo, names, allowUnmerged)).items;
    });
  };

  const removeWorktrees = async () => {
    let message = `Remove ${plural(worktreeTargets.length, "worktree")}?`;
    if (deleteWorktreeBranches) message += "\n\nTheir merged branches will also be deleted.";
    if (!(await api.confirmDestructive(message, "Remove worktrees"))) return;
    await applyCleanup(
      worktreeTargets,
      async (repo, worktrees) =>
        (await api.removeWorktrees(repo, worktrees, deleteWorktreeBranches)).items,
    );
  };

  return (
    <div className="cleanup">
      <div className="toolbar">
        <button onClick={onClose}>← Back</button>
        <h2>Branch &amp; worktree cleanup</h2>
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
        <span className="muted">Show:</span>
        {BRANCH_CATEGORIES.map((category) => (
          <Fragment key={category.value}>
            <label>
              <input
                type="checkbox"
                checked={shown.has(category.value)}
                onChange={() =>
                  setShown((current) => {
                    const next = new Set(current);
                    if (!next.delete(category.value)) next.add(category.value);
                    return next;
                  })
                }
              />
              {category.label}
            </label>
            {category.value === "stale" && (
              <span className="muted stale-days">
                (no commits in
                <input
                  type="number"
                  min={1}
                  className="days"
                  aria-label="Stale after days"
                  value={staleDays}
                  onChange={(event) => setStaleDays(Math.max(1, Number(event.target.value) || 1))}
                />
                days)
              </span>
            )}
          </Fragment>
        ))}
      </div>

      <div className="toolbar">
        <button disabled={busy || branchTargets.length === 0} onClick={deleteBranches}>
          Delete {plural(branchTargets.length, "branch", "branches")}
        </button>
        <button disabled={busy || worktreeTargets.length === 0} onClick={removeWorktrees}>
          Remove {plural(worktreeTargets.length, "worktree")}
        </button>
        <label>
          <input
            type="checkbox"
            checked={deleteWorktreeBranches}
            onChange={(event) => setDeleteWorktreeBranches(event.target.checked)}
          />
          Also delete merged worktree branches
        </label>
      </div>

      {paths.map((repo) => (
        <RepoCleanupSection
          key={repo}
          repo={repo}
          cleanup={reports[repo]}
          results={results[repo]}
          nowUnix={nowUnix}
          staleDays={staleDays}
          shown={shown}
          selectedBranches={selectedBranches}
          selectedWorktrees={selectedWorktrees}
          onSetBranches={(names, selected) =>
            setSelectedBranches((current) => {
              const next = new Set(current);
              for (const branch of names) {
                if (selected) next.add(key(repo, branch));
                else next.delete(key(repo, branch));
              }
              return next;
            })
          }
          onToggleWorktree={(path) => toggle(setSelectedWorktrees, key(repo, path))}
        />
      ))}
    </div>
  );
}

interface SectionProps {
  repo: string;
  cleanup: RepoCleanup | undefined;
  results: ItemOutcome[] | undefined;
  nowUnix: number;
  staleDays: number;
  shown: ReadonlySet<BranchCategory>;
  selectedBranches: ReadonlySet<string>;
  selectedWorktrees: ReadonlySet<string>;
  onSetBranches: (names: string[], selected: boolean) => void;
  onToggleWorktree: (path: string) => void;
}

function RepoCleanupSection(props: SectionProps) {
  const { repo, cleanup, results, nowUnix, staleDays, shown } = props;
  const name = basename(repo);
  const categorized =
    cleanup?.status === "loaded"
      ? cleanup.report.branches.map((branch) => ({
          branch,
          category: categorizeBranch(branch, nowUnix, staleDays),
        }))
      : [];
  const branches = categorized.filter(({ category }) => shown.has(category));
  const counts = BRANCH_CATEGORIES.filter((c) => c.value !== "protected" && c.value !== "active")
    .map((c) => [c.label, categorized.filter((e) => e.category === c.value).length] as const)
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${count} ${label.toLowerCase()}`);

  let body;
  if (!cleanup || cleanup.status === "loading") {
    body = <p className="muted">Analyzing…</p>;
  } else if (cleanup.status === "error") {
    body = <p className="error">{cleanup.error}</p>;
  } else {
    const { report } = cleanup;
    const worktrees = report.worktrees.filter((w) => !w.isMain);
    body = (
      <>
        {report.warnings.map((warning) => (
          <p key={warning} className="outcome-skipped">
            {warning}
          </p>
        ))}
        {branches.length === 0 ? (
          <p className="muted">No branches in the selected categories.</p>
        ) : (
          <BranchTree
            repoName={name}
            entries={branches}
            nowUnix={nowUnix}
            isSelected={(branch) => props.selectedBranches.has(key(repo, branch))}
            onSetSelected={props.onSetBranches}
          />
        )}
        {worktrees.length > 0 && (
          <>
            <h4>Worktrees</h4>
            <table>
              <tbody>
                {worktrees.map((worktree) => {
                  const state = worktreeState(worktree);
                  return (
                    <tr key={worktree.path}>
                      <td>
                        {state.removable && (
                          <input
                            type="checkbox"
                            aria-label={`Select worktree ${worktree.path}`}
                            checked={props.selectedWorktrees.has(key(repo, worktree.path))}
                            onChange={() => props.onToggleWorktree(worktree.path)}
                          />
                        )}
                      </td>
                      <td>
                        <code>{worktree.path}</code>
                      </td>
                      <td>{worktree.branch ?? <span className="muted">(detached)</span>}</td>
                      <td className={state.removable ? "category-merged" : "muted"}>
                        {state.label}
                      </td>
                    </tr>
                  );
                })}
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
        <TriStateCheckbox
          label={`Select all shown branches in ${name}`}
          names={selectableBranches(branches)}
          isSelected={(branch) => props.selectedBranches.has(key(repo, branch))}
          onSetSelected={props.onSetBranches}
        />
        {name}
        <span className="muted category-counts">
          {cleanup?.status === "loaded" &&
            (counts.length > 0 ? counts.join(" · ") : "Nothing to clean up")}
        </span>
        <span className="muted repo-path">{repo}</span>
      </h3>
      {results && results.length > 0 && (
        <ul className="cleanup-results">
          {results.map((result) => (
            <li key={result.item} className={`outcome-${result.status}`}>
              {result.item}: {result.message}
            </li>
          ))}
        </ul>
      )}
      {body}
    </section>
  );
}
