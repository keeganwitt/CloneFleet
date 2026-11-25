import { useState } from "react";
import { recordAction, summarizeItems } from "../activityLog";
import { api } from "../api";
import { ARTIFACT_TIERS, formatBytes, relativeTo, tierLabel } from "../artifacts";
import { formatAge } from "../cleanup";
import { basename, uniqueLabels } from "../format";
import type { ArtifactScan } from "../useArtifactScan";
import { useNow } from "../useNow";
import type { Artifact, ArtifactTier, ItemOutcome } from "../types";
import { TriStateCheckbox } from "./BranchTree";
import { CleanupToolbar } from "./CleanupToolbar";
import { ReviewDialog } from "./ReviewDialog";

interface Props {
  paths: string[];
  scans: Record<string, ArtifactScan>;
  onRescan: (paths: string[]) => Promise<void>;
}

type Target = { repo: string; artifact: Artifact };
const idOf = ({ repo, artifact }: Target) => JSON.stringify([repo, artifact.path]);
const directories = (count: number) => `${count} ${count === 1 ? "directory" : "directories"}`;

export function ArtifactsView({ paths, scans, onRescan }: Props) {
  const [query, setQuery] = useState("");
  const [tier, setTier] = useState<ArtifactTier | "">("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [results, setResults] = useState<Record<string, ItemOutcome[]>>({});
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<Target[]>();
  const [removal, setRemoval] = useState<"trash" | "delete">("trash");
  const nowUnix = useNow();

  const labels = uniqueLabels(paths);
  const search = query.trim().toLowerCase();
  const visible = paths.flatMap((repo) => {
    const scan = scans[repo];
    if (scan?.status !== "loaded") return [];
    return scan.report.artifacts
      .filter(
        (artifact) =>
          (!tier || artifact.tier === tier) &&
          (!search || `${repo}\n${artifact.path}`.toLowerCase().includes(search)),
      )
      .map((artifact) => ({ repo, artifact }));
  });
  const targets = visible.filter((target) => selected.has(idOf(target)));
  const targetBytes = targets.reduce((sum, { artifact }) => sum + artifact.bytes, 0);
  const scanning = paths.filter((repo) => !scans[repo] || scans[repo].status === "loading").length;

  const setSelection = (ids: string[], checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const apply = async (approved: Target[]) => {
    setReview(undefined);
    setBusy(true);
    const repos = [...new Set(approved.map((target) => target.repo))];
    try {
      await Promise.all(
        repos.map(async (repo) => {
          const items = approved
            .filter((target) => target.repo === repo)
            .map((target) => target.artifact);
          const artifactPaths = items.map((item) => item.path);
          let outcomes: ItemOutcome[];
          try {
            const result = await api.deleteArtifacts(
              repo,
              artifactPaths,
              [...new Set(items.map((item) => item.tier))],
              removal,
            );
            recordAction(
              repo,
              removal === "trash"
                ? "Move build and dependency directories to the Trash"
                : "Delete build and dependency directories",
              summarizeItems(result.items),
              result.commands,
            );
            outcomes = result.items;
          } catch (error) {
            outcomes = artifactPaths.map((item) => ({
              item,
              status: "failed",
              message: String(error),
            }));
          }
          setResults((current) => ({ ...current, [repo]: outcomes }));
        }),
      );
      setSelection(approved.map(idOf), false);
      await onRescan(repos);
    } finally {
      setBusy(false);
    }
  };

  const warningTiers = ARTIFACT_TIERS.filter(
    ({ value }) =>
      value !== "buildOutput" && review?.some(({ artifact }) => artifact.tier === value),
  );
  return (
    <section className="list-panel cleanup-panel" aria-label="Disk space">
      <CleanupToolbar
        selected={targets.length}
        selectionDetail={formatBytes(targetBytes)}
        busy={busy}
        analyzeDisabled={scanning > 0}
        onAnalyze={() => {
          setSelected(new Set());
          void onRescan(paths);
        }}
        reviewLabel={`Review ${directories(targets.length)}…`}
        onClear={() => setSelected(new Set())}
        onReview={() => {
          setRemoval("trash");
          setReview(targets);
        }}
      >
        <input
          type="search"
          aria-label="Search cleanup directories"
          placeholder="Find directory or repository"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label="Directory type"
          value={tier}
          onChange={(event) => setTier(event.target.value as ArtifactTier | "")}
        >
          <option value="">Any directory type</option>
          {ARTIFACT_TIERS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </CleanupToolbar>
      <div className="list-context">
        <span role="status">
          {scanning
            ? `Analyzed ${paths.length - scanning} of ${paths.length} repositories…`
            : `${formatBytes(visible.reduce((sum, { artifact }) => sum + artifact.bytes, 0))} across ${directories(visible.length)}`}
        </span>
        <details className="toolbar-menu">
          <summary>Directory types</summary>
          <div className="toolbar-menu-content directory-type-help">
            {ARTIFACT_TIERS.map(({ value, label, hint }) => (
              <p key={value}>
                <strong>{label}</strong>
                <br />
                {hint}
              </p>
            ))}
          </div>
        </details>
      </div>
      {paths.flatMap((repo) => {
        const scan = scans[repo];
        if (scan?.status === "error")
          return [
            <p key={repo} className="list-message error">
              {labels.get(repo)} · {scan.error}
            </p>,
          ];
        return scan?.status === "loaded"
          ? scan.report.warnings.map((warning) => (
              <p className="list-message outcome-skipped" key={`${repo}:${warning}`}>
                {labels.get(repo)} · {warning}
              </p>
            ))
          : [];
      })}
      {Object.entries(results).map(([repo, outcomes]) => (
        <ul className="cleanup-results" key={repo}>
          {outcomes.map((result, index) => (
            <li className={`outcome-${result.status}`} key={index}>
              {result.message}
            </li>
          ))}
        </ul>
      ))}
      <div className="list-table-scroll">
        <table className="cleanup-table">
          <colgroup>
            <col className="selection-column" />
            <col style={{ width: "23%" }} />
            <col style={{ width: "24%" }} />
            <col />
            <col style={{ width: "116px" }} />
            <col style={{ width: "112px" }} />
          </colgroup>
          <thead>
            <tr>
              <th>
                <TriStateCheckbox
                  label="Select all matching directories"
                  names={visible.map(idOf)}
                  isSelected={(id) => selected.has(id)}
                  onSetSelected={setSelection}
                />
              </th>
              <th>Directory</th>
              <th>Repository</th>
              <th>Type</th>
              <th>Last modified</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((target) => {
              const { repo, artifact } = target;
              const id = idOf(target);
              const relative = relativeTo(artifact.worktree, artifact.path);
              return (
                <tr key={id} className={selected.has(id) ? "selected" : undefined}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${artifact.path}`}
                      checked={selected.has(id)}
                      onChange={(event) => setSelection([id], event.target.checked)}
                    />
                  </td>
                  <td>
                    <code title={artifact.path}>{relative}</code>
                    {artifact.worktree !== repo && (
                      <div className="muted">Worktree · {basename(artifact.worktree)}</div>
                    )}
                  </td>
                  <td title={repo}>{labels.get(repo)}</td>
                  <td>
                    <span className="status-pill">{tierLabel(artifact.tier)}</span>
                    <div className="muted">{artifact.kind}</div>
                  </td>
                  <td className="muted">
                    {artifact.modifiedUnix !== null && formatAge(nowUnix, artifact.modifiedUnix)}
                  </td>
                  <td>
                    {formatBytes(artifact.bytes)}
                    {artifact.sharedBytes > 0 && (
                      <div
                        className="muted"
                        title="Hard-linked files are shared with another location"
                      >
                        {formatBytes(artifact.sharedBytes)} shared
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!scanning && visible.length === 0 && (
        <p className="list-message muted">No directories match these filters.</p>
      )}
      {review && (
        <ReviewDialog
          title="Review disk cleanup"
          summary={`${directories(review.length)} · ${formatBytes(review.reduce((sum, { artifact }) => sum + artifact.bytes, 0))}`}
          confirmLabel={
            removal === "trash"
              ? `Move ${directories(review.length)} to Trash`
              : `Delete ${directories(review.length)} permanently`
          }
          danger
          onConfirm={() => void apply(review)}
          onClose={() => setReview(undefined)}
        >
          <fieldset className="removal-method">
            <legend>Removal method</legend>
            <label>
              <input
                type="radio"
                name="removal"
                checked={removal === "trash"}
                onChange={() => setRemoval("trash")}
              />{" "}
              Move to Trash
            </label>
            <p className="muted">Space is reclaimed when you empty the Trash.</p>
            <label>
              <input
                type="radio"
                name="removal"
                checked={removal === "delete"}
                onChange={() => setRemoval("delete")}
              />{" "}
              Delete permanently
            </label>
          </fieldset>
          {warningTiers.length > 0 && (
            <div className="review-warning">
              {warningTiers.map(({ value, label, hint }) => (
                <p key={value}>
                  <strong>{label}</strong> · {hint}
                </p>
              ))}
            </div>
          )}
          <h3>Directories</h3>
          <ul className="review-targets">
            {review.map((target) => (
              <li key={idOf(target)}>
                <div className="review-item">
                  <code>{target.artifact.path}</code>
                  <span className="status-pill">{formatBytes(target.artifact.bytes)}</span>
                </div>
                <div className="muted">
                  {target.repo} · {tierLabel(target.artifact.tier)}
                </div>
              </li>
            ))}
          </ul>
        </ReviewDialog>
      )}
    </section>
  );
}
