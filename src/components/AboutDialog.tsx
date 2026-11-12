import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { api } from "../api";
import { REPOSITORY_URL, fetchLatestRelease, isNewer, type LatestRelease } from "../version";

type Check =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "current" }
  | { status: "available"; release: LatestRelease }
  | { status: "error"; message: string };

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const [version, setVersion] = useState<string>();
  const [check, setCheck] = useState<Check>({ status: "idle" });

  useEffect(() => {
    getVersion().then(setVersion, () => setVersion("unknown"));
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const checkForUpdates = async () => {
    if (!version) return;
    setCheck({ status: "checking" });
    try {
      const release = await fetchLatestRelease();
      setCheck(
        isNewer(release.version, version)
          ? { status: "available", release }
          : { status: "current" },
      );
    } catch (error) {
      setCheck({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal about" role="dialog" aria-modal="true" aria-label="About CloneFleet">
        <h2>CloneFleet</h2>
        <p>
          Version <strong>{version ?? "…"}</strong>
        </p>
        <p className="muted">Run git maintenance across many repositories at once.</p>
        <div className="toolbar">
          <button disabled={!version || check.status === "checking"} onClick={checkForUpdates}>
            {check.status === "checking" ? "Checking…" : "Check for updates"}
          </button>
          <button className="link" onClick={() => void api.openWeb(REPOSITORY_URL)}>
            Project page
          </button>
        </div>
        <div role="status">
          {check.status === "current" && (
            <p className="outcome-succeeded">You're running the latest version.</p>
          )}
          {check.status === "available" && (
            <p>
              Version <strong>{check.release.version}</strong> is available.{" "}
              <button onClick={() => void api.openWeb(check.release.url)}>Download</button>
            </p>
          )}
          {check.status === "error" && <p className="error">{check.message}</p>}
        </div>
        <div className="toolbar">
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
