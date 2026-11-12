import { invoke } from "@tauri-apps/api/core";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import type {
  Action,
  AppSettings,
  GitInfo,
  SettingsView,
  ActionResult,
  BranchDiff,
  BranchReport,
  BranchSettings,
  CleanupResult,
  FileChange,
  FileDiff,
  RemoteCheck,
  RemoteInfo,
  RepoHealth,
  RepoSummary,
  UnpushedReport,
  WorkspaceView,
} from "./types";

export const api = {
  getSettings: () => invoke<SettingsView>("get_settings"),
  setSettings: (settings: AppSettings) => invoke<SettingsView>("set_settings", { settings }),
  checkGit: (path: string) => invoke<GitInfo>("check_git", { path }),
  pickFile: async (): Promise<string | null> => {
    const picked = await open({ directory: false, multiple: false });
    return typeof picked === "string" ? picked : null;
  },
  loadWorkspace: () => invoke<WorkspaceView>("load_workspace"),
  openDirectories: (paths: string[]) => invoke<WorkspaceView>("open_directories", { paths }),
  openRecent: (roots: string[]) => invoke<WorkspaceView>("open_recent", { roots }),
  clearRecent: () => invoke<WorkspaceView>("clear_recent"),
  addDirectories: (paths: string[]) => invoke<WorkspaceView>("add_directories", { paths }),
  removeDirectory: (path: string) => invoke<WorkspaceView>("remove_directory", { path }),
  rescanWorkspace: () => invoke<WorkspaceView>("rescan_workspace"),
  removeRepos: (paths: string[]) => invoke<WorkspaceView>("remove_repos", { paths }),
  restoreExcluded: () => invoke<WorkspaceView>("restore_excluded"),
  repoSummary: (path: string) => invoke<RepoSummary>("repo_summary", { path }),
  runAction: (path: string, action: Action, runId?: number) =>
    invoke<ActionResult>("run_action", { path, action, runId: runId ?? null }),
  cancelRun: (runId: number) => invoke<void>("cancel_run", { runId }),
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
  listBranchNames: (path: string) => invoke<string[]>("list_branch_names", { path }),
  getBranchSettings: (path: string) => invoke<BranchSettings>("get_branch_settings", { path }),
  setBranchSettings: (path: string, settings: BranchSettings) =>
    invoke<void>("set_branch_settings", { path, settings }),
  listRemotes: (path: string) => invoke<RemoteInfo[]>("list_remotes", { path }),
  checkRemotes: (path: string) => invoke<RemoteCheck[]>("check_remotes", { path }),
  repoHealth: (path: string, staleDays: number) =>
    invoke<RepoHealth>("repo_health", { path, staleDays }),
  branchDiff: (path: string, branch: string, base?: string) =>
    invoke<BranchDiff>("branch_diff", { path, branch, base: base ?? null }),
  workingFileDiff: (path: string, file: string, untracked: boolean) =>
    invoke<FileDiff>("working_file_diff", { path, file, untracked }),
  saveTextFile: async (defaultName: string, contents: string): Promise<boolean> => {
    const path = await save({ defaultPath: defaultName });
    if (!path) return false;
    await invoke<void>("save_text_file", { path, contents });
    return true;
  },
  confirmDestructive: (message: string, okLabel: string) =>
    confirm(message, { title: "Confirm", kind: "warning", okLabel, cancelLabel: "Cancel" }),
  pickDirectories: async (): Promise<string[]> => {
    const picked = await open({ directory: true, multiple: true });
    if (picked === null) return [];
    return Array.isArray(picked) ? picked : [picked];
  },
};
