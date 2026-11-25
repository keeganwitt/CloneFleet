import { useCallback, useEffect, useState } from "react";
import { recordAction, summarizeItems } from "../activityLog";
import { api } from "../api";
import {
  BRANCH_CATEGORIES,
  categorizeBranch,
  describeBranch,
  formatAge,
  worktreeState,
  type BranchCategory,
} from "../cleanup";
import { basename, uniqueLabels } from "../format";
import type { BranchInfo, BranchReport, ItemOutcome, WorktreeInfo } from "../types";
import { BranchTree, TriStateCheckbox } from "./BranchTree";
import { CleanupToolbar } from "./CleanupToolbar";
import { ReviewDialog } from "./ReviewDialog";

export type CleanupCategory = "merged" | "stale" | "worktrees" | "staleWorktrees";
type Report = { data: BranchReport } | { error: string };
type Item = { repo: string; category: BranchCategory; eligible: boolean } & (
  { kind: "branch"; value: BranchInfo } | { kind: "worktree"; value: WorktreeInfo; reason: string }
);

interface Props {
  paths: string[];
  initialCategory?: CleanupCategory;
  onChanged: (paths: string[]) => void;
  onOpenBranch?: (repo: string, branch: string) => void;
}

const now = () => Math.floor(Date.now() / 1000);
const nameOf = (item: Item) => (item.kind === "branch" ? item.value.name : item.value.path);
const idOf = (item: Item) => JSON.stringify([item.repo, item.kind, nameOf(item)]);
const plural = (count: number, name: string, pluralName = `${name}s`) =>
  `${count} ${count === 1 ? name : pluralName}`;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const statusLabel = (item: Item) =>
  item.kind === "worktree" && item.category === "merged"
    ? "Ready to remove"
    : BRANCH_CATEGORIES.find(({ value }) => value === item.category)?.label;

export function CleanupView({ paths, initialCategory, onChanged, onOpenBranch }: Props) {
  const [fetchFirst, setFetchFirst] = useState(true);
  const [staleDays, setStaleDays] = useState(90);
  const [query, setQuery] = useState("");
  const [grouped, setGrouped] = useState(false);
  const [type, setType] = useState(
    initialCategory === "worktrees" || initialCategory === "staleWorktrees"
      ? "worktree"
      : initialCategory
        ? "branch"
        : "",
  );
  const [status, setStatus] = useState(
    initialCategory === "merged" || initialCategory === "worktrees"
      ? "merged"
      : initialCategory === "stale"
        ? "staleOrDeleted"
        : initialCategory === "staleWorktrees"
          ? "stale"
          : "",
  );
  const [reports, setReports] = useState<Record<string, Report | undefined>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [review, setReview] = useState<Item[]>();
  const [results, setResults] = useState<Record<string, ItemOutcome[]>>({});
  const [busy, setBusy] = useState(false);
  const [time, setTime] = useState(now);

  const analyze = useCallback(async (repos: string[], fetch: boolean) => {
    setReports((current) => ({
      ...current,
      ...Object.fromEntries(repos.map((repo) => [repo, undefined])),
    }));
    await Promise.all(
      repos.map(async (repo) => {
        let value: Report;
        try {
          value = { data: await api.analyzeBranches(repo, fetch) };
        } catch (error) {
          value = { error: errorMessage(error) };
        }
        setReports((current) => ({ ...current, [repo]: value }));
        setTime(now());
      }),
    );
  }, []);
  useEffect(() => {
    void Promise.resolve().then(() => analyze(paths, true));
  }, [analyze, paths]);

  const labels = uniqueLabels(paths);
  const items: Item[] = [];
  for (const repo of paths) {
    const report = reports[repo];
    if (!report || !("data" in report)) continue;
    for (const branch of report.data.branches) {
      const category = categorizeBranch(branch, time, staleDays);
      items.push({
        repo,
        kind: "branch",
        value: branch,
        category,
        eligible: category !== "protected",
      });
    }
    for (const worktree of report.data.worktrees) {
      if (worktree.isMain) continue;
      const state = worktreeState(worktree, time, staleDays);
      items.push({
        repo,
        kind: "worktree",
        value: worktree,
        category: state.category,
        reason: state.label,
        eligible: state.selectable,
      });
    }
  }
  const search = query.trim().toLowerCase();
  const visible = items.filter((item) => {
    if (type && type !== item.kind) return false;
    if (search && !`${item.repo}\n${nameOf(item)}`.toLowerCase().includes(search)) return false;
    if (status === "staleOrDeleted")
      return item.category === "stale" || item.category === "remoteDeleted";
    return status
      ? item.category === status
      : item.category !== "active" && item.category !== "protected";
  });
  const selectable = visible.filter((item) => item.eligible);
  const targets = selectable.filter((item) => selected.has(idOf(item)));
  const loading = paths.filter((repo) => !reports[repo]).length;
  const setSelection = (ids: string[], checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const apply = async (approved: Item[]) => {
    setReview(undefined);
    setBusy(true);
    const repos = [...new Set(approved.map((item) => item.repo))];
    try {
      await Promise.all(
        repos.map(async (repo) => {
          const outcomes: ItemOutcome[] = [];
          for (const kind of ["branch", "worktree"] as const) {
            for (const allowUnmerged of [false, true]) {
              const names = approved
                .filter(
                  (item) =>
                    item.repo === repo &&
                    item.kind === kind &&
                    (item.category !== "merged") === allowUnmerged,
                )
                .map(nameOf);
              if (!names.length) continue;
              try {
                const result =
                  kind === "branch"
                    ? await api.deleteBranches(repo, names, allowUnmerged)
                    : await api.removeWorktrees(repo, names, false, allowUnmerged);
                recordAction(
                  repo,
                  kind === "branch" ? "Delete branches" : "Remove worktrees",
                  summarizeItems(result.items),
                  result.commands,
                );
                outcomes.push(...result.items);
              } catch (error) {
                outcomes.push(
                  ...names.map((item) => ({
                    item,
                    status: "failed" as const,
                    message: errorMessage(error),
                  })),
                );
              }
            }
          }
          setResults((current) => ({ ...current, [repo]: outcomes }));
        }),
      );
      setSelection(approved.map(idOf), false);
      await analyze(repos, false);
      onChanged(repos);
    } finally {
      setBusy(false);
    }
  };

  const reviewBranches = review?.filter((item) => item.kind === "branch") ?? [];
  const reviewWorktrees = review?.filter((item) => item.kind === "worktree") ?? [];
  const atRisk = reviewBranches.filter((item) => item.category !== "merged").length;
  const reviewLabel = [
    reviewBranches.length ? `Delete ${plural(reviewBranches.length, "branch", "branches")}` : "",
    reviewWorktrees.length
      ? `${reviewBranches.length ? "remove" : "Remove"} ${plural(reviewWorktrees.length, "worktree")}`
      : "",
  ]
    .filter(Boolean)
    .join(" and ");
  const rows = (shown: Item[]) =>
    shown.map((item) => {
      const id = idOf(item);
      const reason =
        item.kind === "branch" ? describeBranch(item.value, item.category) : item.reason;
      return (
        <tr key={id} className={selected.has(id) ? "selected" : undefined}>
          <td>
            {item.eligible && (
              <input
                type="checkbox"
                aria-label={
                  item.kind === "branch"
                    ? `Select branch ${item.value.name} in ${labels.get(item.repo)}`
                    : `Select worktree ${item.value.path}`
                }
                checked={selected.has(id)}
                onChange={(event) => setSelection([id], event.target.checked)}
              />
            )}
          </td>
          <td>
            {item.kind === "branch" && onOpenBranch ? (
              <button
                className="file-button"
                onClick={() => onOpenBranch(item.repo, item.value.name)}
              >
                <code>{item.value.name}</code>
              </button>
            ) : (
              <code title={nameOf(item)}>
                {item.kind === "worktree" ? basename(item.value.path) : item.value.name}
              </code>
            )}
            <div className="muted">
              {item.kind === "branch" ? "Local branch" : "Linked worktree"}
            </div>
          </td>
          <td title={item.repo}>{labels.get(item.repo)}</td>
          <td>
            <span className={`status-pill category-${item.category}`}>{statusLabel(item)}</span>
            <div className="muted">{reason}</div>
          </td>
          <td className="muted">
            {item.value.lastCommitUnix !== null && formatAge(time, item.value.lastCommitUnix)}
          </td>
        </tr>
      );
    });

  return (
    <section className="list-panel cleanup-panel" aria-label="Branches and worktrees">
      <CleanupToolbar
        selected={targets.length}
        busy={busy}
        onAnalyze={() => {
          if (!loading) {
            setSelected(new Set());
            void analyze(paths, fetchFirst);
          }
        }}
        analyzeDisabled={loading > 0}
        reviewLabel={`Review ${plural(targets.length, "item")}…`}
        onClear={() => setSelected(new Set())}
        onReview={() => setReview(targets)}
      >
        <input
          type="search"
          aria-label="Search cleanup candidates"
          placeholder="Find item or repository"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label="Item type"
          value={type}
          onChange={(event) => setType(event.target.value)}
        >
          <option value="">Any item type</option>
          <option value="branch">Branches</option>
          <option value="worktree">Worktrees</option>
        </select>
        <select
          aria-label="Cleanup status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">Candidates</option>
          <option value="staleOrDeleted">Stale or remote deleted</option>
          {BRANCH_CATEGORIES.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </CleanupToolbar>
      <div className="list-context">
        <span role="status">
          {loading
            ? `Analyzed ${paths.length - loading} of ${paths.length} repositories…`
            : `${plural(selectable.length, "candidate")} across ${plural(new Set(selectable.map((item) => item.repo)).size, "repository", "repositories")}`}
        </span>
        <details className="toolbar-menu">
          <summary>Analysis options</summary>
          <div className="toolbar-menu-content">
            <label>
              <input
                type="checkbox"
                checked={fetchFirst}
                onChange={(event) => setFetchFirst(event.target.checked)}
              />{" "}
              Fetch before analyzing
            </label>
            <label>
              Stale after{" "}
              <input
                type="number"
                min={1}
                className="days"
                aria-label="Stale after days"
                value={staleDays}
                onChange={(event) => setStaleDays(Math.max(1, Number(event.target.value) || 1))}
              />{" "}
              days
            </label>
            <label>
              <input
                type="checkbox"
                checked={grouped}
                onChange={(event) => setGrouped(event.target.checked)}
              />{" "}
              Group by repository
            </label>
          </div>
        </details>
      </div>
      {paths.map((repo) => {
        const report = reports[repo];
        return report && "error" in report ? (
          <p key={repo} className="list-message error">
            {labels.get(repo)} · {report.error}
          </p>
        ) : report?.data.warnings.length ? (
          <details key={repo} className="list-message">
            <summary>
              {labels.get(repo)} · {plural(report.data.warnings.length, "warning")}
            </summary>
            {report.data.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </details>
        ) : null;
      })}
      {Object.entries(results).map(([repo, outcomes]) => (
        <ul className="cleanup-results" key={repo}>
          {outcomes.map((result, index) => (
            <li key={index} className={`outcome-${result.status}`}>
              {result.item} · {result.message}
            </li>
          ))}
        </ul>
      ))}
      {grouped ? (
        <div className="list-table-scroll">
          {paths.map((repo) => {
            const owned = visible.filter((item) => item.repo === repo);
            if (!owned.length) return null;
            const branches = owned.filter((item) => item.kind === "branch");
            const worktrees = owned.filter((item) => item.kind === "worktree");
            return (
              <section key={repo} className="grouped-cleanup">
                <h3>
                  <TriStateCheckbox
                    label={`Select candidates in ${labels.get(repo)}`}
                    names={owned.filter((item) => item.eligible).map(idOf)}
                    isSelected={(id) => selected.has(id)}
                    onSetSelected={setSelection}
                  />{" "}
                  {labels.get(repo)}
                </h3>
                {branches.length > 0 && (
                  <BranchTree
                    repoName={basename(repo)}
                    entries={branches.map(({ value, category }) => ({ branch: value, category }))}
                    nowUnix={time}
                    isSelected={(name) =>
                      branches.some((item) => item.value.name === name && selected.has(idOf(item)))
                    }
                    onSetSelected={(names, checked) =>
                      setSelection(
                        branches.filter((item) => names.includes(item.value.name)).map(idOf),
                        checked,
                      )
                    }
                    onOpenBranch={onOpenBranch && ((branch) => onOpenBranch(repo, branch))}
                  />
                )}
                {worktrees.length > 0 && (
                  <table>
                    <tbody>{rows(worktrees)}</tbody>
                  </table>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="list-table-scroll">
          <table className="cleanup-table">
            <colgroup>
              <col className="selection-column" />
              <col style={{ width: "30%" }} />
              <col style={{ width: "24%" }} />
              <col />
              <col style={{ width: "110px" }} />
            </colgroup>
            <thead>
              <tr>
                <th>
                  <TriStateCheckbox
                    label="Select all matching cleanup candidates"
                    names={selectable.map(idOf)}
                    isSelected={(id) => selected.has(id)}
                    onSetSelected={setSelection}
                  />
                </th>
                <th>Item</th>
                <th>Repository</th>
                <th>Why it’s here</th>
                <th>Last commit</th>
              </tr>
            </thead>
            <tbody>{rows(visible)}</tbody>
          </table>
        </div>
      )}
      {!loading && visible.length === 0 && (
        <p className="list-message muted">No items match these filters.</p>
      )}
      {review && (
        <ReviewDialog
          title="Review branch and worktree cleanup"
          summary={`${plural(review.length, "item")} across ${plural(new Set(review.map((item) => item.repo)).size, "repository", "repositories")}`}
          confirmLabel={reviewLabel}
          danger
          onClose={() => setReview(undefined)}
          onConfirm={() => void apply(review)}
        >
          {atRisk > 0 && (
            <p className="review-warning">
              <strong>
                {plural(atRisk, "branch", "branches")} with commits outside{" "}
                {atRisk === 1 ? "its merge target" : "their merge targets"}
              </strong>
              <br />
              Save any commits you need before deleting the local branch references.
            </p>
          )}
          {reviewBranches.length > 0 && (
            <section>
              <h3>Delete local branches</h3>
              <ul className="review-targets">
                {reviewBranches.map((item) => (
                  <li key={idOf(item)}>
                    <code>{item.value.name}</code>
                    <div className="muted">
                      {item.repo} · {describeBranch(item.value, item.category)}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {reviewWorktrees.length > 0 && (
            <section>
              <h3>Remove linked worktrees</h3>
              <ul className="review-targets">
                {reviewWorktrees.map((item) => (
                  <li key={idOf(item)}>
                    <code>{item.value.path}</code>
                    <div className="muted">
                      {item.value.branch ? `Keep branch ${item.value.branch}` : item.reason}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </ReviewDialog>
      )}
    </section>
  );
}
