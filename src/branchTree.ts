export interface TreeFolder<T> {
  kind: "folder";
  name: string;
  path: string;
  children: TreeNode<T>[];
}

export interface TreeLeaf<T> {
  kind: "leaf";
  name: string;
  item: T;
}

export type TreeNode<T> = TreeFolder<T> | TreeLeaf<T>;

export function buildTree<T>(items: T[], nameOf: (item: T) => string): TreeNode<T>[] {
  const root: TreeFolder<T> = { kind: "folder", name: "", path: "", children: [] };
  for (const item of items) {
    const segments = nameOf(item).split("/");
    let folder = root;
    for (const segment of segments.slice(0, -1)) {
      const path = folder.path ? `${folder.path}/${segment}` : segment;
      let next = folder.children.find(
        (child): child is TreeFolder<T> => child.kind === "folder" && child.name === segment,
      );
      if (!next) {
        next = { kind: "folder", name: segment, path, children: [] };
        folder.children.push(next);
      }
      folder = next;
    }
    folder.children.push({ kind: "leaf", name: segments[segments.length - 1], item });
  }
  sortTree(root);
  return root.children;
}

function sortTree<T>(folder: TreeFolder<T>) {
  folder.children.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1,
  );
  for (const child of folder.children) {
    if (child.kind === "folder") sortTree(child);
  }
}

export function leaves<T>(node: TreeNode<T>): T[] {
  return node.kind === "leaf" ? [node.item] : node.children.flatMap(leaves);
}
