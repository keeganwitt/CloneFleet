import { useState } from "react";
import type { FileDiff } from "../types";

export type DiffLineKind = "header" | "hunk" | "add" | "delete" | "context" | "note";

export function classifyDiffLine(line: string, inHunk: boolean): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (!inHunk) return "header";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "delete";
  if (line.startsWith("\\")) return "note";
  return "context";
}

export function classifyPatch(patch: string): [line: string, kind: DiffLineKind][] {
  let inHunk = false;
  return patch
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff --git ")) inHunk = false;
      const kind = classifyDiffLine(line, inHunk);
      if (kind === "hunk") inHunk = true;
      return [line, kind];
    });
}

export function DiffView({ patch, truncated }: { patch: string; truncated: boolean }) {
  if (!patch.trim()) return <p className="muted">No textual changes.</p>;
  return (
    <>
      <pre className="diff" aria-label="Diff">
        {classifyPatch(patch)
          .filter(([line, kind]) => kind !== "header" || line.startsWith("Binary files"))
          .map(([line, kind], index) => (
            <div key={index} className={`diff-line diff-${kind}`}>
              {line || " "}
            </div>
          ))}
      </pre>
      {truncated && <p className="muted">Diff truncated; it is too large to show in full.</p>}
    </>
  );
}

export function changeCounts(file: Pick<FileDiff, "additions" | "deletions">): string {
  if (file.additions === null || file.deletions === null) return "binary";
  return `+${file.additions} −${file.deletions}`;
}

export function FileDiffList({ files }: { files: FileDiff[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(files.length <= 5 ? files.map((f) => f.path) : []),
  );
  if (files.length === 0) return <p className="muted">No file changes.</p>;
  const setFile = (path: string, isOpen: boolean) =>
    setOpen((current) => {
      if (current.has(path) === isOpen) return current;
      const next = new Set(current);
      if (isOpen) next.add(path);
      else next.delete(path);
      return next;
    });
  return (
    <div className="file-diffs">
      {files.length > 1 && (
        <div className="toolbar">
          <button
            className="link"
            disabled={open.size === files.length}
            onClick={() => setOpen(new Set(files.map((f) => f.path)))}
          >
            Expand all
          </button>
          <button className="link" disabled={open.size === 0} onClick={() => setOpen(new Set())}>
            Collapse all
          </button>
        </div>
      )}
      {files.map((file) => (
        <details
          key={file.path}
          className="file-diff"
          open={open.has(file.path)}
          onToggle={(event) => setFile(file.path, event.currentTarget.open)}
        >
          <summary>
            <code>{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</code>
            <span className="muted">{changeCounts(file)}</span>
          </summary>
          <DiffView patch={file.patch} truncated={file.truncated} />
        </details>
      ))}
    </div>
  );
}
