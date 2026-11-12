import { useState } from "react";
import { buildTree, leaves, type TreeNode } from "../branchTree";
import { describeBranch, formatAge, type BranchCategory } from "../cleanup";
import type { BranchInfo } from "../types";

export interface BranchEntry {
  branch: BranchInfo;
  category: BranchCategory;
}

interface Props {
  repoName: string;
  entries: BranchEntry[];
  nowUnix: number;
  isSelected: (name: string) => boolean;
  onSetSelected: (names: string[], selected: boolean) => void;
  onOpenBranch?: (name: string) => void;
}

interface TriStateProps {
  label: string;
  names: string[];
  isSelected: (name: string) => boolean;
  onSetSelected: (names: string[], selected: boolean) => void;
}

export function TriStateCheckbox({ label, names, isSelected, onSetSelected }: TriStateProps) {
  const selectedCount = names.filter(isSelected).length;
  const all = names.length > 0 && selectedCount === names.length;
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={all}
      disabled={names.length === 0}
      ref={(element) => {
        if (element) element.indeterminate = selectedCount > 0 && !all;
      }}
      onChange={() => onSetSelected(names, !all)}
    />
  );
}

export function selectableBranches(entries: BranchEntry[]): string[] {
  return entries.filter((e) => e.category !== "protected").map((e) => e.branch.name);
}

export function BranchTree({
  repoName,
  entries,
  nowUnix,
  isSelected,
  onSetSelected,
  onOpenBranch,
}: Props) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const tree = buildTree(entries, (entry) => entry.branch.name);
  const toggleFolder = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const renderNode = (node: TreeNode<BranchEntry>, depth: number) => {
    const indent = { paddingLeft: `${depth * 18}px` };
    if (node.kind === "leaf") {
      const { branch, category } = node.item;
      return (
        <li key={`leaf:${branch.name}`} role="treeitem" aria-label={branch.name}>
          <div className="tree-row" style={indent}>
            <span className="twisty" />
            {category === "protected" ? (
              <span className="checkbox-spacer" />
            ) : (
              <input
                type="checkbox"
                aria-label={`Select branch ${branch.name} in ${repoName}`}
                checked={isSelected(branch.name)}
                onChange={() => onSetSelected([branch.name], !isSelected(branch.name))}
              />
            )}
            {onOpenBranch ? (
              <button
                className="file-button"
                title={`Show commits and changes on ${branch.name}`}
                onClick={() => onOpenBranch(branch.name)}
              >
                <code>{node.name}</code>
              </button>
            ) : (
              <code title={branch.name}>{node.name}</code>
            )}
            <span className={`category-${category}`}>{describeBranch(branch, category)}</span>
            <span className="muted">{formatAge(nowUnix, branch.lastCommitUnix)}</span>
            <span className="muted subject" title={`${branch.author}: ${branch.subject}`}>
              {branch.subject}
            </span>
          </div>
        </li>
      );
    }
    const expanded = !collapsed.has(node.path);
    const contained = leaves(node);
    return (
      <li
        key={`folder:${node.path}`}
        role="treeitem"
        aria-expanded={expanded}
        aria-label={`${node.path}/`}
      >
        <div className="tree-row" style={indent}>
          <button
            className="twisty"
            aria-label={`${expanded ? "Collapse" : "Expand"} ${node.path}/`}
            onClick={() => toggleFolder(node.path)}
          >
            {expanded ? "▾" : "▸"}
          </button>
          <TriStateCheckbox
            label={`Select all in ${node.path}/ in ${repoName}`}
            names={selectableBranches(contained)}
            isSelected={isSelected}
            onSetSelected={onSetSelected}
          />
          <span className="folder-name">{node.name}/</span>
          <span className="muted">{contained.length}</span>
        </div>
        {expanded && (
          <ul role="group" className="tree">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <ul role="tree" aria-label={`Branches in ${repoName}`} className="tree">
      {tree.map((node) => renderNode(node, 0))}
    </ul>
  );
}
