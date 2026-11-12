import { invoke } from "@tauri-apps/api/core";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import type {
  Action,
  ActionResult,
  BranchReport,
  CleanupResult,
  FileChange,
  RepoSummary,
  UnpushedReport,
} from "./types";

export const api = {
  listRepos: () => invoke<string[]>("list_repos"),
  addDirectory: (path: string) => invoke<string[]>("add_directory", { path }),
  removeRepos: (paths: string[]) => invoke<string[]>("remove_repos", { paths }),
  repoSummary: (path: string) => invoke<RepoSummary>("repo_summary", { path }),
  runAction: (path: string, action: Action) => invoke<ActionResult>("run_action", { path, action }),
  listChanges: (path: string) => invoke<FileChange[]>("list_changes", { path }),
  analyzeBranches: (path: string, fetch: boolean) =>
    invoke<BranchReport>("analyze_branches", { path, fetch }),
  deleteBranches: (path: string, branches: string[], allowUnmerged: boolean) =>
    invoke<CleanupResult>("delete_branches", { path, branches, allowUnmerged }),
  removeWorktrees: (path: string, worktrees: string[], deleteBranches: boolean) =>
    invoke<CleanupResult>("remove_worktrees", { path, worktrees, deleteBranches }),
  analyzeUnpushed: (path: string, fetch: boolean) =>
    invoke<UnpushedReport>("analyze_unpushed", { path, fetch }),
  dropStashes: (path: string, stashes: string[]) =>
    invoke<CleanupResult>("drop_stashes", { path, stashes }),
  confirmDestructive: (message: string, okLabel: string) =>
    confirm(message, { title: "Confirm", kind: "warning", okLabel, cancelLabel: "Cancel" }),
  pickDirectories: async (): Promise<string[]> => {
    const picked = await open({ directory: true, multiple: true });
    if (picked === null) return [];
    return Array.isArray(picked) ? picked : [picked];
  },
};
