import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppSettings, GitInfo, SettingsView, Theme } from "../types";

const THEMES: [Theme, string][] = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

interface Props {
  view: SettingsView;
  onSave: (settings: AppSettings) => Promise<unknown>;
  onClose: () => void;
}

export function SettingsDialog({ view, onSave, onClose }: Props) {
  const [custom, setCustom] = useState(view.settings.gitPath !== null);
  const [gitPath, setGitPath] = useState(view.settings.gitPath ?? "");
  const [theme, setTheme] = useState<Theme>(view.settings.theme);
  const [reopenLast, setReopenLast] = useState(view.settings.reopenLast);
  const [rememberRecent, setRememberRecent] = useState(view.settings.rememberRecent);
  const [check, setCheck] = useState<GitInfo>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const test = async () => setCheck(await api.checkGit(gitPath));
  const browse = async () => {
    const picked = await api.pickFile();
    if (picked) {
      setGitPath(picked);
      setCheck(undefined);
    }
  };
  const save = async () => {
    try {
      await onSave({
        gitPath: custom && gitPath.trim() ? gitPath.trim() : null,
        theme,
        reopenLast,
        rememberRecent,
      });
      onClose();
    } catch (failure) {
      setError(String(failure));
    }
  };

  const active = view.activeGit;
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Settings">
        <h2>Settings</h2>
        <fieldset>
          <legend>Git</legend>
          <label>
            <input type="radio" name="git" checked={!custom} onChange={() => setCustom(false)} />
            Detect automatically
            <span className="muted">{view.detectedGit ?? "(not found)"}</span>
          </label>
          <label>
            <input type="radio" name="git" checked={custom} onChange={() => setCustom(true)} />
            Use a specific git
          </label>
          {custom && (
            <div className="toolbar">
              <input
                type="text"
                aria-label="Git location"
                placeholder="/path/to/git"
                value={gitPath}
                onChange={(event) => {
                  setGitPath(event.target.value);
                  setCheck(undefined);
                }}
              />
              <button onClick={browse}>Browse…</button>
              <button disabled={!gitPath.trim()} onClick={test}>
                Test
              </button>
            </div>
          )}
          {custom && check && (
            <p className={check.error ? "error" : "outcome-succeeded"} role="status">
              {check.error ?? check.version}
            </p>
          )}
          <p className="muted">
            In use: {active.path ?? "none"}
            {active.version ? ` (${active.version})` : ""}
          </p>
          {active.error && <p className="error">{active.error}</p>}
        </fieldset>
        <fieldset>
          <legend>Workspace</legend>
          <label>
            <input
              type="checkbox"
              checked={reopenLast}
              onChange={(event) => setReopenLast(event.target.checked)}
            />
            Reopen last directories at launch
          </label>
          <label>
            <input
              type="checkbox"
              checked={rememberRecent}
              onChange={(event) => setRememberRecent(event.target.checked)}
            />
            Remember recent directories
          </label>
          {!rememberRecent && view.settings.rememberRecent && (
            <p className="muted">Saving clears the current recent list.</p>
          )}
        </fieldset>
        <fieldset>
          <legend>Theme</legend>
          <div className="toolbar" role="radiogroup" aria-label="Theme">
            {THEMES.map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="theme"
                  checked={theme === value}
                  onChange={() => setTheme(value)}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="toolbar">
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
