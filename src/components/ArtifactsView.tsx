import { useEffect, useRef, useState } from "react";
import { recordAction, summarizeItems } from "../activityLog";
import { api } from "../api";
import {
  ARTIFACT_TIERS,
  DEFAULT_TIERS,
  formatBytes,
  isPreselected,
  relativeTo,
  tierLabel,
} from "../artifacts";
import { formatAge } from "../cleanup";
import { basename } from "../format";
import type { ArtifactScan } from "../useArtifactScan";
import type { Artifact, ArtifactReport, ArtifactTier, ItemOutcome } from "../types";
import { TriStateCheckbox } from "./BranchTree";

interface Props {
  paths: string[];
  scans: Record<string, ArtifactScan>;
  onRescan: (paths: string[]) => Promise<void>;
}

const TIER_ORDER = ARTIFACT_TIERS.map((t) => t.value);

const key = (repo: string, path: string) => `${repo}\n${path}`;

function splitKey(itemKey: string): [string, string] {
  const index = itemKey.indexOf("\n");
  return [itemKey.slice(0, index), itemKey.slice(index + 1)];
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const currentUnixTime = () => Math.floor(Date.now() / 1000);

function sortArtifacts(artifacts: Artifact[]): Artifact[] {
  return [...artifacts].sort(
    (a, b) =>
      TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.path.localeCompare(b.path),
  );
}

export function ArtifactsView({ paths, scans, onRescan }: Props) {
  const [shown, setShown] = useState<ReadonlySet<ArtifactTier>>(new Set(DEFAULT_TIERS));
  const [unusedDays, setUnusedDays] = useState(90);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [results, setResults] = useState<Record<string, ItemOutcome[]>>({});
  const [busy, setBusy] = useState(false);
  const [hideEmpty, setHideEmpty] = useState(true);
  const [moveToTrash, setMoveToTrash] = useState(false);
  const [nowUnix, setNowUnix] = useState(currentUnixTime);
  const preselected = useRef(new WeakSet<ArtifactReport>());
  const unusedDaysRef = useRef(unusedDays);
  useEffect(() => {
    unusedDaysRef.current = unusedDays;
  }, [unusedDays]);

  useEffect(() => {
    const fresh = paths.flatMap((repo) => {
      const scan = scans[repo];
      if (scan?.status !== "loaded" || preselected.current.has(scan.report)) return [];
      preselected.current.add(scan.report);
      return [[repo, scan.report] as const];
    });
    if (fresh.length === 0) return;
    const now = currentUnixTime();
    setNowUnix(now);
    setSelected((current) => {
      const refreshed = new Set(fresh.map(([repo]) => repo));
      const next = new Set([...current].filter((k) => !refreshed.has(splitKey(k)[0])));
      for (const [repo, report] of fresh) {
        report.artifacts
          .filter((artifact) => isPreselected(artifact, now, unusedDaysRef.current))
          .forEach((artifact) => next.add(key(repo, artifact.path)));
      }
      return next;
    });
  }, [paths, scans]);

  const visible = new Map<string, Artifact[]>();
  for (const repo of paths) {
    const scan = scans[repo];
    if (scan?.status !== "loaded") continue;
    visible.set(repo, sortArtifacts(scan.report.artifacts.filter((a) => shown.has(a.tier))));
  }
  const visibleByKey = new Map<string, Artifact>();
  for (const [repo, artifacts] of visible) {
    for (const artifact of artifacts) visibleByKey.set(key(repo, artifact.path), artifact);
  }
  const targets = [...selected].filter((k) => visibleByKey.has(k));
  const targetArtifacts = targets.map((k) => visibleByKey.get(k)!);
  const targetBytes = targetArtifacts.reduce((total, a) => total + a.bytes, 0);
  const emptyRepos = new Set(
    paths.filter((repo) => {
      const scan = scans[repo];
      return (
        scan?.status === "loaded" &&
        scan.report.warnings.length === 0 &&
        visible.get(repo)?.length === 0 &&
        !results[repo]?.length
      );
    }),
  );

  const setSelection = (repo: string, artifactPaths: string[], select: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const path of artifactPaths) {
        if (select) next.add(key(repo, path));
        else next.delete(key(repo, path));
      }
      return next;
    });

  const toggleTier = (tier: ArtifactTier) =>
    setShown((current) => {
      const next = new Set(current);
      if (!next.delete(tier)) next.add(tier);
      return next;
    });

  const deleteSelected = async () => {
    const groups = new Map<string, string[]>();
    for (const itemKey of targets) {
      const [repo, path] = splitKey(itemKey);
      groups.set(repo, [...(groups.get(repo) ?? []), path]);
    }
    const reinstall = targetArtifacts.filter((a) => a.tier === "reinstall").length;
    const unreproducible = targetArtifacts.filter((a) => a.tier === "unreproducible").length;
    const what =
      `${plural(targets.length, "directory", "directories")} (${formatBytes(targetBytes)}) ` +
      `in ${plural(groups.size, "repository", "repositories")}`;
    let message = moveToTrash
      ? `Move ${what} to the Trash? The space is freed when the Trash is emptied.`
      : `Permanently delete ${what}? Nothing goes to the Trash.`;
    const subject = (count: number) => (targets.length === 1 ? "It" : `${count} of them`);
    if (reinstall > 0) {
      message +=
        `\n\n${subject(reinstall)} will need reinstalling before the project builds again, ` +
        "for example with npm install or gradle build.";
    }
    if (unreproducible > 0) {
      message +=
        `\n\n${subject(unreproducible)} may not be reproducible: ` +
        "virtualenvs can hold packages installed by hand.";
    }
    const confirmLabel = moveToTrash ? "Move to Trash" : "Delete directories";
    if (!(await api.confirmDestructive(message, confirmLabel))) return;

    setBusy(true);
    const tiers = [...shown];
    const removal = moveToTrash ? "trash" : "delete";
    try {
      await Promise.all(
        [...groups].map(async ([repo, artifactPaths]) => {
          let outcomes: ItemOutcome[];
          try {
            const result = await api.deleteArtifacts(repo, artifactPaths, tiers, removal);
            recordAction(
              repo,
              moveToTrash
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
      await onRescan([...groups.keys()]);
    } finally {
      setBusy(false);
    }
  };

  const scanning = paths.some((repo) => scans[repo]?.status === "loading");

  return (
    <div className="cleanup">
      <div className="toolbar">
        <h2>Build &amp; dependency cleanup</h2>
        <button disabled={busy || scanning} onClick={() => onRescan(paths)}>
          Rescan
        </button>
      </div>

      <div className="toolbar">
        <span className="muted">Show:</span>
        {ARTIFACT_TIERS.map((tier) => (
          <label key={tier.value}>
            <input
              type="checkbox"
              aria-describedby={`tier-hint-${tier.value}`}
              checked={shown.has(tier.value)}
              onChange={() => toggleTier(tier.value)}
            />
            {tier.label}
          </label>
        ))}
        <label>
          <input
            type="checkbox"
            checked={hideEmpty}
            onChange={(event) => setHideEmpty(event.target.checked)}
          />
          Hide repositories with nothing to clean up
        </label>
      </div>

      <ul className="muted hint tier-hints">
        {ARTIFACT_TIERS.map((tier) => (
          <li key={tier.value} id={`tier-hint-${tier.value}`}>
            <strong>{tier.label}:</strong> {tier.hint}
          </li>
        ))}
      </ul>

      <div className="toolbar">
        <span className="muted preselect-days">
          Build output unchanged for
          <input
            type="number"
            min={1}
            className="days"
            aria-label="Preselect after days"
            value={unusedDays}
            onChange={(event) => setUnusedDays(Math.max(1, Number(event.target.value) || 1))}
          />
          days is preselected. Only directories git ignores entirely are listed.
        </span>
      </div>

      <div className="toolbar">
        <button disabled={busy || targets.length === 0} onClick={deleteSelected}>
          {moveToTrash ? "Move" : "Delete"} {plural(targets.length, "directory", "directories")}
          {moveToTrash && " to the Trash"}
          {targets.length > 0 && ` (${formatBytes(targetBytes)})`}
        </button>
        <label>
          <input
            type="checkbox"
            checked={moveToTrash}
            onChange={(event) => setMoveToTrash(event.target.checked)}
          />
          Move to Trash instead of deleting
        </label>
      </div>

      {hideEmpty && emptyRepos.size > 0 && (
        <p className="muted">
          {emptyRepos.size} {emptyRepos.size === 1 ? "repository has" : "repositories have"} nothing
          to clean up in the selected categories.
        </p>
      )}
      {paths
        .filter((repo) => !hideEmpty || !emptyRepos.has(repo))
        .map((repo) => (
          <RepoArtifacts
            key={repo}
            repo={repo}
            scan={scans[repo]}
            artifacts={visible.get(repo) ?? []}
            results={results[repo]}
            nowUnix={nowUnix}
            isSelected={(path) => selected.has(key(repo, path))}
            onSetSelected={(artifactPaths, select) => setSelection(repo, artifactPaths, select)}
          />
        ))}
    </div>
  );
}

interface SectionProps {
  repo: string;
  scan: ArtifactScan | undefined;
  artifacts: Artifact[];
  results: ItemOutcome[] | undefined;
  nowUnix: number;
  isSelected: (path: string) => boolean;
  onSetSelected: (paths: string[], selected: boolean) => void;
}

function location(repo: string, artifact: Artifact): string {
  const relative = relativeTo(artifact.worktree, artifact.path);
  return artifact.worktree === repo ? relative : `${basename(artifact.worktree)}: ${relative}`;
}

function RepoArtifacts(props: SectionProps) {
  const { repo, scan, artifacts, results, nowUnix } = props;
  const name = basename(repo);
  const total = artifacts.reduce((sum, a) => sum + a.bytes, 0);

  let body;
  if (!scan || scan.status === "loading") {
    body = <p className="muted">Scanning…</p>;
  } else if (scan.status === "error") {
    body = <p className="error">{scan.error}</p>;
  } else {
    body = (
      <>
        {scan.report.warnings.map((warning) => (
          <p key={warning} className="outcome-skipped">
            {warning}
          </p>
        ))}
        {artifacts.length === 0 ? (
          <p className="muted">No directories in the selected categories.</p>
        ) : (
          <table>
            <tbody>
              {artifacts.map((artifact) => (
                <tr key={artifact.path}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${artifact.path}`}
                      checked={props.isSelected(artifact.path)}
                      onChange={() =>
                        props.onSetSelected([artifact.path], !props.isSelected(artifact.path))
                      }
                    />
                  </td>
                  <td>
                    <code title={artifact.path}>{location(repo, artifact)}</code>
                  </td>
                  <td>{artifact.kind}</td>
                  <td className="muted">{tierLabel(artifact.tier)}</td>
                  <td title={plural(artifact.files, "file")}>
                    {formatBytes(artifact.bytes)}
                    {artifact.sharedBytes > 0 && (
                      <span
                        className="muted"
                        title="Hard-linked files are shared with another location, so deleting them frees no space"
                      >
                        {" "}
                        + {formatBytes(artifact.sharedBytes)} shared
                      </span>
                    )}
                  </td>
                  <td className="muted">
                    {artifact.modifiedUnix !== null && formatAge(nowUnix, artifact.modifiedUnix)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </>
    );
  }

  return (
    <section className="cleanup-repo">
      <h3 className="tree-row">
        <TriStateCheckbox
          label={`Select all shown directories in ${name}`}
          names={artifacts.map((a) => a.path)}
          isSelected={props.isSelected}
          onSetSelected={props.onSetSelected}
        />
        {name}
        <span className="muted category-counts">
          {scan?.status === "loaded" &&
            (artifacts.length > 0
              ? `${plural(artifacts.length, "directory", "directories")} · ${formatBytes(total)}`
              : "Nothing to clean up")}
        </span>
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
