# CloneFleet

A cross-platform desktop app for running routine git maintenance across many repositories at once.

## Features

- **Add repositories** by picking a directory. It is scanned up to four levels deep; linked worktrees, submodules, hidden directories, and common build/dependency directories are skipped.
- **Search and filter** the repository list by name, path, or branch, by working tree state, and by upstream sync state.
- **Checkout the default branch.** Repositories with uncommitted changes to tracked files are skipped and reported, with per-repository options to stash (never unstashed automatically) or commit those changes.
- **Inspect changes**: expand a repository to list its modified, staged, conflicted, and untracked files.
- **Fetch** every remote with `--prune` without touching working trees.
- **Pull** with `--ff-only`, regardless of `pull.rebase` or autostash settings.
- **Check the default branch**: refreshes `origin/HEAD` (`git remote set-head --auto`), detects when the remote renamed its default branch (for example `master` to `main`), and offers to rename the local branch and point it at the new upstream.
- **Rebase forks** onto `upstream/<default>`:
  - Only runs on a clean default branch, and aborts on conflicts so nothing changes.
  - Afterwards it offers to push to `origin`. Force pushes are confirmed and use `--force-with-lease` pinned to the commit seen during the rebase.
- **Branch cleanup:**
  - Finds merged branches using three kinds of evidence: ancestry (merge commits and fast-forwards), patch equivalence (rebase merges), and squash detection.
  - Flags branches whose remote branch was deleted, and branches with no commits newer than a configurable threshold.
  - Shows branches as a tree grouped by `/`, with folder-level selection.
  - Compares against `upstream/<default>` when an `upstream` remote exists, so fork branches merged upstream are recognized.
- **Unpushed work and stashes**: per repository, lists branches with commits that exist on no remote (noting ones whose changes were already merged), uncommitted changes in any worktree, and stashes, which can be dropped after confirmation.
- **Worktree cleanup:** removes clean worktrees whose branch is merged, optionally deleting the branch, and prunes worktrees whose directory no longer exists.

## Safety rules

- Nothing is pushed without a prompt.
- Every git command an action runs is recorded and viewable per repository.
- Repositories in the middle of a rebase, merge, cherry-pick, revert, or bisect are skipped.
- Bulk actions apply only to selected repositories that are visible under the current filters.
- The default branch, the checked-out branch, and branches checked out in other worktrees are never deleted.
- Only local branches are deleted. Deletion is re-verified at the time it runs, and deleting an unmerged branch requires explicit confirmation. Deleted branch SHAs are reported so they can be recreated.
- Worktrees with uncommitted or untracked files, locked worktrees, and the main worktree are never removed.

## Requirements

- git 2.28 or newer on `PATH`. The app uses your git installation, so your credential helpers, SSH configuration, and hooks apply.
- For development: Rust (stable), Node.js 22+, pnpm (`corepack enable` installs the pinned version), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

## Development

```sh
pnpm install
pnpm tauri dev
```

| Task             | Command                                                                           |
| ---------------- | --------------------------------------------------------------------------------- |
| Frontend tests   | `pnpm test`                                                                       |
| Rust tests       | `cargo test --manifest-path src-tauri/Cargo.toml`                                 |
| Lint             | `pnpm lint` and `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets` |
| Format           | `pnpm format` and `cargo fmt --manifest-path src-tauri/Cargo.toml`                |
| Production build | `pnpm tauri build`                                                                |

Rust tests create temporary repositories with local bare remotes, so they need `git` but no network access. Tauri requires the `dist` directory to exist at compile time, so run `pnpm build` once before running Rust tests or clippy on a fresh clone.

CI runs on GitHub Actions (`.github/workflows/ci.yml`): frontend lint, format, tests, and build on Linux, and Rust clippy and tests on Linux, macOS, and Windows.

## License

[MIT](LICENSE)
