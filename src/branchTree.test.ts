import { describe, expect, it } from "vitest";
import { buildTree, leaves, type TreeNode } from "./branchTree";

const names = (nodes: TreeNode<string>[]): unknown[] =>
  nodes.map((node) => (node.kind === "leaf" ? node.name : { [node.path]: names(node.children) }));

describe("buildTree", () => {
  it("groups by slash-separated segments with folders before leaves", () => {
    const tree = buildTree(
      ["zeta", "feature/login", "feature/api/v2", "alpha", "feature/api/v1", "bugfix/crash"],
      (name) => name,
    );
    expect(names(tree)).toEqual([
      { bugfix: ["crash"] },
      { feature: [{ "feature/api": ["v1", "v2"] }, "login"] },
      "alpha",
      "zeta",
    ]);
  });

  it("allows a branch and a folder with the same name", () => {
    expect(names(buildTree(["release", "release/1.0"], (n) => n))).toEqual([
      { release: ["1.0"] },
      "release",
    ]);
  });
});

describe("leaves", () => {
  it("collects every item beneath a node", () => {
    const [feature] = buildTree(["feature/a", "feature/b/c", "main"], (n) => n);
    expect(leaves(feature).sort()).toEqual(["feature/a", "feature/b/c"]);
  });
});
