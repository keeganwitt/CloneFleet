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
        {classifyPatch(patch).map(([line, kind], index) => (
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
  if (files.length === 0) return <p className="muted">No file changes.</p>;
  return (
    <div className="file-diffs">
      {files.map((file) => (
        <details key={file.path} className="file-diff" open={files.length <= 5}>
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
