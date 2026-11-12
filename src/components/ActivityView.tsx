import { useState } from "react";
import { clearLog, entryFailed, formatLog, matchesLogSearch, useActivityLog } from "../activityLog";
import { api } from "../api";
import { basename } from "../format";

const MAX_SHOWN = 500;

export function ActivityView({ onClose }: { onClose: () => void }) {
  const entries = useActivityLog();
  const [search, setSearch] = useState("");
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [notice, setNotice] = useState<string>();
  const shown = entries.filter(
    (entry) => (!failuresOnly || entryFailed(entry)) && matchesLogSearch(entry, search),
  );

  const saveLog = async () => {
    try {
      if (await api.saveTextFile("clonefleet-activity.log", formatLog(shown))) {
        setNotice(`Saved ${shown.length} entr${shown.length === 1 ? "y" : "ies"}`);
      }
    } catch (error) {
      setNotice(String(error));
    }
  };

  return (
    <div className="cleanup">
      <div className="toolbar">
        <button onClick={onClose}>← Back</button>
        <h2>Activity</h2>
        <button disabled={shown.length === 0} onClick={saveLog}>
          Save log…
        </button>
        <button className="link" disabled={entries.length === 0} onClick={clearLog}>
          Clear
        </button>
      </div>
      <p className="muted">
        Every action CloneFleet ran during this session. Expand one to see its git commands.
      </p>
      <div className="toolbar">
        <input
          type="search"
          aria-label="Search activity"
          placeholder="Search repository, command, or output"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <label>
          <input
            type="checkbox"
            checked={failuresOnly}
            onChange={(event) => setFailuresOnly(event.target.checked)}
          />
          Failures only
        </label>
        <span className="muted">
          {shown.length} of {entries.length}
        </span>
      </div>
      {notice && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
      {shown.length === 0 ? (
        <p className="empty muted">
          {entries.length === 0 ? "Nothing has run yet." : "No entries match."}
        </p>
      ) : (
        <ol className="activity-log" aria-label="Activity log">
          {shown.slice(0, MAX_SHOWN).map((entry) => (
            <li key={entry.id}>
              <details>
                <summary>
                  <span className="muted">{new Date(entry.timeMs).toLocaleTimeString()}</span>
                  <strong title={entry.repo}>{basename(entry.repo)}</strong>
                  <span>{entry.label}</span>
                  <span className={`outcome-${entry.status}`}>{entry.message}</span>
                </summary>
                {entry.commands.length === 0 ? (
                  <p className="muted">No git commands ran.</p>
                ) : (
                  <ol className="command-log">
                    {entry.commands.map((command, index) => (
                      <li key={index}>
                        <code>git {command.args.join(" ")}</code>
                        <span className="exit-code">exit {command.exitCode ?? "signal"}</span>
                        {command.stdout.trim() && <pre>{command.stdout.trim()}</pre>}
                        {command.stderr.trim() && (
                          <pre className="muted">{command.stderr.trim()}</pre>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </details>
            </li>
          ))}
        </ol>
      )}
      {shown.length > MAX_SHOWN && (
        <p className="muted">Showing the newest {MAX_SHOWN}; save the log to see everything.</p>
      )}
    </div>
  );
}
