import { useEffect, useState } from "react";
import { api } from "../api";
import { categorizeBranch, describeBranch, formatAge, type BranchCategory } from "../cleanup";
import { basename } from "../format";
import type {
  BranchDiff,
  BranchInfo,
  BranchSettings,
  FileChange,
  FileDiff,
  RepoSummary,
} from "../types";
import { useNow } from "../useNow";
import { ChangesPanel } from "./ChangesPanel";
import { DiffView, FileDiffList, changeCounts } from "./DiffView";

export type DetailTab = "changes" | "branches" | "mainBranches";

const TABS: [DetailTab, string][] = [
  ["changes", "Changes"],
  ["branches", "Branches"],
  ["mainBranches", "Main branches"],
];

const STALE_DAYS = 90;

type Loadable<T> =
  { status: "loading" } | { status: "error"; error: string } | { status: "loaded"; value: T };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function useLoad<T>(load: () => Promise<T>, deps: unknown[]): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    load().then(
      (value) => !cancelled && setState({ status: "loaded", value }),
      (error) => !cancelled && setState({ status: "error", error: errorMessage(error) }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

interface Props {
  path: string;
  summary: RepoSummary | undefined;
  tab: DetailTab;
  branch?: string;
  onTabChange: (tab: DetailTab) => void;
  onBranchChange: (branch: string | undefined) => void;
  onClose: () => void;
  onSettingsSaved: () => void;
}

export function RepoDetailPanel(props: Props) {
  const name = basename(props.path);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  return (
    <aside className="detail-panel" role="dialog" aria-label={`Details for ${name}`}>
      <div className="toolbar">
        <h2 title={props.path}>{name}</h2>
        <button className="link" onClick={props.onClose} aria-label="Close details">
          ×
        </button>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map(([tab, label]) => (
          <button
            key={tab}
            role="tab"
            aria-selected={props.tab === tab}
            className={props.tab === tab ? "tab active" : "tab"}
            onClick={() => props.onTabChange(tab)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="detail-body" role="tabpanel">
        {props.tab === "changes" && <ChangesTab path={props.path} summary={props.summary} />}
        {props.tab === "branches" && (
          <BranchesTab
            path={props.path}
            summary={props.summary}
            branch={props.branch}
            onBranchChange={props.onBranchChange}
          />
        )}
        {props.tab === "mainBranches" && (
          <MainBranchesTab
            path={props.path}
            summary={props.summary}
            onSaved={props.onSettingsSaved}
          />
        )}
      </div>
    </aside>
  );
}

function ChangesTab({ path, summary }: { path: string; summary: RepoSummary | undefined }) {
  const [selected, setSelected] = useState<FileChange>();
  return (
    <div className="split">
      <ChangesPanel path={path} summary={summary} selected={selected} onSelect={setSelected} />
      {selected ? (
        <WorkingFileDiff key={selected.path} path={path} change={selected} summary={summary} />
      ) : (
        <p className="muted">Select a file to see its changes.</p>
      )}
    </div>
  );
}

function WorkingFileDiff({
  path,
  change,
  summary,
}: {
  path: string;
  change: FileChange;
  summary: RepoSummary | undefined;
}) {
  const diff = useLoad<FileDiff>(
    () => api.workingFileDiff(path, change.path, change.kind === "untracked"),
    [path, change.path, change.kind, summary],
  );
  if (diff.status === "loading") return <p className="muted">Loading diff…</p>;
  if (diff.status === "error") return <p className="error">{diff.error}</p>;
  return (
    <div>
      <p className="muted">
        <code>{change.path}</code> {changeCounts(diff.value)}
      </p>
      <DiffView patch={diff.value.patch} truncated={diff.value.truncated} />
    </div>
  );
}

interface BranchesTabProps {
  path: string;
  summary: RepoSummary | undefined;
  branch: string | undefined;
  onBranchChange: (branch: string | undefined) => void;
}

function BranchesTab({ path, summary, branch, onBranchChange }: BranchesTabProps) {
  const now = useNow();
  const report = useLoad(
    () => api.analyzeBranches(path, false),
    [path, summary?.mainBranches.join()],
  );
  if (report.status === "loading") return <p className="muted">Analyzing branches…</p>;
  if (report.status === "error") return <p className="error">{report.error}</p>;

  const entries: [BranchInfo, BranchCategory][] = report.value.branches.map((b) => [
    b,
    categorizeBranch(b, now, STALE_DAYS),
  ]);
  return (
    <div className="split">
      <ul className="branch-list" aria-label="Branches">
        {entries.map(([info, category]) => (
          <li key={info.name} className={branch === info.name ? "selected" : undefined}>
            <button
              className="file-button"
              aria-pressed={branch === info.name}
              onClick={() => onBranchChange(info.name)}
            >
              <code>{info.name}</code>
            </button>
            <span className={`category-${category}`}>{describeBranch(info, category)}</span>
            <span className="muted">{formatAge(now, info.lastCommitUnix)}</span>
          </li>
        ))}
      </ul>
      {branch ? (
        <BranchDiffView key={branch} path={path} branch={branch} now={now} />
      ) : (
        <p className="muted">Select a branch to see its commits and changes.</p>
      )}
    </div>
  );
}

function BranchDiffView({ path, branch, now }: { path: string; branch: string; now: number }) {
  const diff = useLoad<BranchDiff>(() => api.branchDiff(path, branch), [path, branch]);
  if (diff.status === "loading") return <p className="muted">Loading {branch}…</p>;
  if (diff.status === "error") return <p className="error">{diff.error}</p>;
  const { base, commits, commitsTruncated, files } = diff.value;
  return (
    <div>
      <h3>
        <code>{branch}</code> compared with <code>{base}</code>
      </h3>
      <h4>
        {commits.length === 0
          ? "No commits that aren't already on the base"
          : `${commits.length}${commitsTruncated ? "+" : ""} commit${commits.length === 1 ? "" : "s"} not on ${base}`}
      </h4>
      {commits.length > 0 && (
        <ul className="commit-list">
          {commits.map((commit) => (
            <li key={commit.sha}>
              <code>{commit.sha.slice(0, 8)}</code> {commit.subject}{" "}
              <span className="muted">
                {commit.author}, {formatAge(now, commit.dateUnix)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h4>
        {files.length} file{files.length === 1 ? "" : "s"} changed since it branched from {base}
      </h4>
      <FileDiffList files={files} />
    </div>
  );
}

interface MainBranchesTabProps {
  path: string;
  summary: RepoSummary | undefined;
  onSaved: () => void;
}

function MainBranchesTab({ path, summary, onSaved }: MainBranchesTabProps) {
  const loaded = useLoad(
    () => Promise.all([api.getBranchSettings(path), api.listBranchNames(path)]),
    [path],
  );
  if (loaded.status === "loading") return <p className="muted">Loading branches…</p>;
  if (loaded.status === "error") return <p className="error">{loaded.error}</p>;
  const [settings, names] = loaded.value;
  return (
    <MainBranchesForm
      key={JSON.stringify(settings)}
      path={path}
      initial={settings}
      names={names}
      remoteDefault={summary && !summary.defaultOverridden ? summary.defaultBranch : null}
      onSaved={onSaved}
    />
  );
}

interface FormProps {
  path: string;
  initial: BranchSettings;
  names: string[];
  remoteDefault: string | null;
  onSaved: () => void;
}

function MainBranchesForm({ path, initial, names, remoteDefault, onSaved }: FormProps) {
  const [primary, setPrimary] = useState(initial.primary ?? "");
  const [additional, setAdditional] = useState<ReadonlySet<string>>(new Set(initial.additional));
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState<string>();
  const shown = names.filter(
    (n) => n !== primary && n.toLowerCase().includes(filter.toLowerCase()),
  );

  const save = async () => {
    const settings: BranchSettings = {
      primary: primary || null,
      additional: names.filter((n) => additional.has(n) && n !== primary),
    };
    try {
      await api.setBranchSettings(path, settings);
      setStatus("Saved");
      onSaved();
    } catch (error) {
      setStatus(errorMessage(error));
    }
  };

  return (
    <div className="main-branches">
      <p className="muted">
        The primary branch is used by Checkout default branch, Pull, and Rebase fork. All main
        branches are protected from deletion, and branches merged into any of them count as merged.
      </p>
      <label>
        Primary branch
        <select
          aria-label="Primary branch"
          value={primary}
          onChange={(e) => setPrimary(e.target.value)}
        >
          <option value="">Remote default{remoteDefault ? ` (${remoteDefault})` : ""}</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <h4>Additional main branches</h4>
      <input
        type="search"
        aria-label="Filter branches"
        placeholder="Filter branches"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <ul className="branch-checklist">
        {shown.map((n) => (
          <li key={n}>
            <label>
              <input
                type="checkbox"
                checked={additional.has(n)}
                onChange={() =>
                  setAdditional((current) => {
                    const next = new Set(current);
                    if (!next.delete(n)) next.add(n);
                    return next;
                  })
                }
              />
              <code>{n}</code>
            </label>
          </li>
        ))}
      </ul>
      <div className="toolbar">
        <button onClick={save}>Save</button>
        <button
          className="link"
          onClick={() => {
            setPrimary("");
            setAdditional(new Set());
          }}
        >
          Reset to remote default
        </button>
        {status && (
          <span className="muted" role="status">
            {status}
          </span>
        )}
      </div>
    </div>
  );
}
