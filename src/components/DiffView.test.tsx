import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DiffView, FileDiffList, changeCounts, classifyDiffLine } from "./DiffView";

const patch = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 same
-old
+new
\\ No newline at end of file
`;

describe("classifyDiffLine", () => {
  it("treats ---/+++ before the first hunk as headers", () => {
    expect(classifyDiffLine("--- a/x", false)).toBe("header");
    expect(classifyDiffLine("+++ b/x", false)).toBe("header");
    expect(classifyDiffLine("@@ -1 +1 @@", false)).toBe("hunk");
    expect(classifyDiffLine("+++ added line starting with plus", true)).toBe("add");
    expect(classifyDiffLine("-x", true)).toBe("delete");
    expect(classifyDiffLine(" x", true)).toBe("context");
    expect(classifyDiffLine("\\ No newline at end of file", true)).toBe("note");
  });
});

describe("DiffView", () => {
  it("colors each line by kind and notes truncation", () => {
    render(<DiffView patch={patch} truncated />);
    const lines = within(screen.getByLabelText("Diff")).getAllByText(/./);
    const kinds = lines.map((line) => line.className.replace("diff-line diff-", ""));
    expect(kinds).toEqual(["hunk", "context", "delete", "add", "note"]);
    expect(screen.getByText(/Diff truncated/)).toBeInTheDocument();
  });

  it("keeps binary notices from the file header", () => {
    render(
      <DiffView
        patch={"diff --git a/x.png b/x.png\nindex 1..2\nBinary files a/x.png and b/x.png differ\n"}
        truncated={false}
      />,
    );
    expect(screen.getByText("Binary files a/x.png and b/x.png differ")).toBeInTheDocument();
    expect(screen.queryByText(/^index /)).not.toBeInTheDocument();
  });

  it("handles empty patches", () => {
    render(<DiffView patch="" truncated={false} />);
    expect(screen.getByText("No textual changes.")).toBeInTheDocument();
  });
});

describe("FileDiffList", () => {
  it("lists files with change counts and renames", () => {
    render(
      <FileDiffList
        files={[
          {
            path: "new.rs",
            oldPath: "old.rs",
            additions: 1,
            deletions: 2,
            patch,
            truncated: false,
          },
          {
            path: "logo.png",
            oldPath: null,
            additions: null,
            deletions: null,
            patch: "",
            truncated: false,
          },
        ]}
      />,
    );
    expect(screen.getByText("old.rs → new.rs")).toBeInTheDocument();
    expect(screen.getByText("+1 −2")).toBeInTheDocument();
    expect(screen.getByText("binary")).toBeInTheDocument();
    expect(changeCounts({ additions: 0, deletions: 0 })).toBe("+0 −0");
  });
});
