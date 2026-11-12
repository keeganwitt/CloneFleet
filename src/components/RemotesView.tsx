import { useEffect, useState } from "react";
import { api } from "../api";
import { basename } from "../format";
import {
  findAndReplace,
  httpsToSsh,
  planUrlChanges,
  sshToHttps,
  type RemoteRow,
  type UrlChange,
  type UrlTransform,
} from "../remoteUrls";
import type { Action, RemoteCheck, RemoteInfo, RemoteStatus } from "../types";

const STATUS_LABELS: Record<RemoteStatus, string> = {
  ok: "OK",
  redirected: "Moved",
  notFound: "Not found",
  authenticationRequired: "Authentication required",
  unreachable: "Unreachable",
  error: "Error",
};

const STATUS_CLASSES: Record<RemoteStatus, string> = {
  ok: "outcome-succeeded",
  redirected: "outcome-skipped",
  notFound: "outcome-failed",
  authenticationRequired: "outcome-failed",
  unreachable: "outcome-skipped",
  error: "outcome-failed",
};

type Mode = "replace" | "toSsh" | "toHttps";

interface Props {
  paths: string[];
  onClose: () => void;
  runJobs: (jobs: [string, Action][]) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadRemotes(paths: string[]): Promise<Record<string, RemoteInfo[]>> {
  const entries = await Promise.all(
    paths.map(async (path) => [path, await api.listRemotes(path).catch(() => [])] as const),
  );
  return Object.fromEntries(entries);
}

export function RemotesView({ paths, onClose, runJobs }: Props) {
  const [remotes, setRemotes] = useState<Record<string, RemoteInfo[]>>();
  const [checks, setChecks] = useState<Record<string, RemoteCheck[] | string>>({});
  const [checking, setChecking] = useState(0);
  const [mode, setMode] = useState<Mode>("replace");
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadRemotes(paths).then((loaded) => !cancelled && setRemotes(loaded));
    return () => {
      cancelled = true;
    };
  }, [paths]);

  const rows: RemoteRow[] = remotes
    ? paths.flatMap((repo) =>
        (remotes[repo] ?? []).map((r) => ({ repo, remote: r.name, url: r.fetchUrl })),
      )
    : [];
  const checkFor = (row: RemoteRow) => {
    const result = checks[row.repo];
    return typeof result === "string" ? undefined : result?.find((c) => c.name === row.remote);
  };
  const redirects: UrlChange[] = rows.flatMap((row) => {
    const check = checkFor(row);
    return check?.status === "redirected" && check.redirectUrl
      ? [{ ...row, newUrl: check.redirectUrl }]
      : [];
  });
  const transform: UrlTransform =
    mode === "toSsh" ? httpsToSsh : mode === "toHttps" ? sshToHttps : findAndReplace(find, replace);
  const planned = planUrlChanges(rows, transform);

  const checkAll = async () => {
    setChecking(paths.length);
    await Promise.all(
      paths.map((repo) =>
        api
          .checkRemotes(repo)
          .then(
            (result) => setChecks((current) => ({ ...current, [repo]: result })),
            (error) => setChecks((current) => ({ ...current, [repo]: errorMessage(error) })),
          )
          .finally(() => setChecking((n) => n - 1)),
      ),
    );
  };

  const apply = async (changes: UrlChange[], description: string) => {
    const message =
      `${description}\n\n` +
      changes
        .slice(0, 10)
        .map((c) => `• ${basename(c.repo)} ${c.remote}: ${c.newUrl}`)
        .join("\n") +
      (changes.length > 10 ? `\n• …and ${changes.length - 10} more` : "");
    if (!(await api.confirmDestructive(message, "Update URLs"))) return;
    setBusy(true);
    try {
      await runJobs(
        changes.map((c): [string, Action] => [
          c.repo,
          { type: "setRemoteUrl", remote: c.remote, url: c.newUrl },
        ]),
      );
      const changedRepos = [...new Set(changes.map((c) => c.repo))];
      const reloaded = await loadRemotes(changedRepos);
      setRemotes((current) => ({ ...current, ...reloaded }));
      setChecks((current) => {
        const next = { ...current };
        for (const repo of changedRepos) delete next[repo];
        return next;
      });
      setNotice(`Updated ${changes.length} remote URL${changes.length === 1 ? "" : "s"}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cleanup">
      <div className="toolbar">
        <button onClick={onClose}>← Back</button>
        <h2>Remotes</h2>
        <button disabled={checking > 0 || !remotes} onClick={checkAll}>
          {checking > 0 ? `Checking… ${checking} left` : "Check all remotes"}
        </button>
        {redirects.length > 0 && (
          <button
            disabled={busy}
            onClick={() =>
              apply(redirects, `Update ${redirects.length} moved remotes to their new URLs?`)
            }
          >
            Update {redirects.length} moved
          </button>
        )}
      </div>
      <p className="muted">
        Checking contacts each remote with <code>git ls-remote</code>. Moved means the host
        redirected to a new URL, which usually follows a repository or organization rename.
      </p>

      <fieldset className="url-editor">
        <legend>Change URLs in bulk</legend>
        <div className="toolbar" role="radiogroup" aria-label="Change type">
          {(
            [
              ["replace", "Find and replace"],
              ["toSsh", "HTTPS → SSH"],
              ["toHttps", "SSH → HTTPS"],
            ] as [Mode, string][]
          ).map(([value, label]) => (
            <label key={value}>
              <input
                type="radio"
                name="url-mode"
                checked={mode === value}
                onChange={() => setMode(value)}
              />
              {label}
            </label>
          ))}
        </div>
        {mode === "replace" && (
          <div className="toolbar">
            <input
              type="text"
              aria-label="Find"
              placeholder="github.com/old-org/"
              value={find}
              onChange={(e) => setFind(e.target.value)}
            />
            <input
              type="text"
              aria-label="Replace with"
              placeholder="github.com/new-org/"
              value={replace}
              onChange={(e) => setReplace(e.target.value)}
            />
          </div>
        )}
        {planned.length > 0 ? (
          <>
            <ul className="change-list" aria-label="Planned URL changes">
              {planned.map((c) => (
                <li key={`${c.repo}:${c.remote}`}>
                  <strong>{basename(c.repo)}</strong> <code>{c.remote}</code>
                  <span className="muted">{c.url}</span> → <code>{c.newUrl}</code>
                </li>
              ))}
            </ul>
            <button
              disabled={busy}
              onClick={() =>
                apply(
                  planned,
                  `Change ${planned.length} remote URL${planned.length === 1 ? "" : "s"}?`,
                )
              }
            >
              Apply {planned.length} change{planned.length === 1 ? "" : "s"}
            </button>
          </>
        ) : (
          <p className="muted">
            {mode === "replace" && !find ? "Enter text to find." : "No URLs would change."}
          </p>
        )}
      </fieldset>

      {notice && (
        <p className="outcome-succeeded" role="status">
          {notice}
        </p>
      )}

      {!remotes ? (
        <p className="muted">Loading remotes…</p>
      ) : (
        <table className="repo-table">
          <colgroup>
            <col style={{ width: "24%" }} />
            <col style={{ width: "12%" }} />
            <col />
            <col style={{ width: "26%" }} />
          </colgroup>
          <thead>
            <tr>
              <th>Repository</th>
              <th>Remote</th>
              <th>URL</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const check = checkFor(row);
              const failed = checks[row.repo];
              return (
                <tr key={`${row.repo}:${row.remote}`}>
                  <td title={row.repo}>{basename(row.repo)}</td>
                  <td>
                    <code>{row.remote}</code>
                  </td>
                  <td>
                    <code>{row.url}</code>
                  </td>
                  <td>
                    {typeof failed === "string" ? (
                      <span className="error">{failed}</span>
                    ) : check ? (
                      <>
                        <span
                          className={STATUS_CLASSES[check.status]}
                          title={check.message ?? undefined}
                        >
                          {STATUS_LABELS[check.status]}
                        </span>
                        {check.redirectUrl && (
                          <div className="muted">
                            now <code>{check.redirectUrl}</code>
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="muted">Not checked</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {remotes && rows.length === 0 && <p className="muted">No remotes configured.</p>}
    </div>
  );
}
