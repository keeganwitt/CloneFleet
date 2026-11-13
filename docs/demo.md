# Demo home

`pnpm demo` starts CloneFleet on a folder of made-up repositories instead of your real ones. We use it for screenshots and marketing material, and it's also a quick way to try a change against every state the app knows how to show.

```sh
pnpm demo                                   # tauri dev on a fresh demo home
pnpm demo --dir ~/tmp/clonefleet-demo       # somewhere other than the system temp folder
pnpm demo --app /Applications/CloneFleet.app/Contents/MacOS/CloneFleet   # a built app
```

Each run rewrites the demo home, so commit ages and fetch times are relative to now. Rerun the command to reset it, along with anything you changed in the demo.

## What's in it

The repositories come from `src-tauri/src/demo.rs`, which builds them with your installed git:

| Repository                 | Shows                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `services/api-gateway`     | 3 commits behind upstream                                                                                                                        |
| `services/billing-service` | uncommitted changes, an untracked file, and a stash                                                                                              |
| `services/auth-service`    | on `feature/oauth-refresh` with commits that were never pushed                                                                                   |
| `services/search-indexer`  | diverged from upstream                                                                                                                           |
| `services/notifications`   | stopped partway through a rebase with a conflict                                                                                                 |
| `libraries/design-system`  | merged, squash-merged, remote-deleted, stale (7 months), and active branches, plus linked worktrees for a merged branch and a stale unmerged one |
| `libraries/shared-utils`   | clean and just fetched, with ignored `dist`, `node_modules`, and `.venv` directories to clean up                                                 |
| `libraries/analytics-sdk`  | a fork (`origin` is `dana/analytics-sdk`, `upstream` is `acme/analytics-sdk`) whose upstream has 2 new commits, for **Rebase fork on upstream**  |
| `tools/infra-terraform`    | clean, but last fetched 3 days ago, with an ignored `.terraform` directory                                                                       |
| `tools/legacy-portal`      | a remote that can't be reached; run **Fetch all** to see the failure card                                                                        |
| `tools/dotfiles`           | a local-only repository with no remote                                                                                                           |

The tests in `demo.rs` build the demo home and check each of these states with the same code the dashboard uses. If a change stops the demo from showing one, `cargo test` fails, so update the demo along with the feature.

## How the remotes work

Every remote is a bare repository under `remotes/` in the demo home. Git treats a local bare repository like any server, so fetch, pull, push, ahead and behind counts, and merge detection all behave normally.

The remotes are configured with GitHub-style URLs such as `https://github.com/acme/api-gateway.git`. The demo's git configuration rewrites them with `url.<base>.insteadOf`, so git talks to the local copy while CloneFleet shows the GitHub address on the Remotes page and in the **Web** button. `https://git.legacy.example/` is rewritten to a closed local port, which is how `legacy-portal` fails to connect.

An HTTP redirect (a **Moved** remote) can't be simulated without a web server, so the demo doesn't show one.

## How it stays away from your real data

The launcher sets these variables for CloneFleet and every git command it runs:

| Variable                | Points at                                                           |
| ----------------------- | ------------------------------------------------------------------- |
| `CLONEFLEET_CONFIG_DIR` | `config/` in the demo home (directories, recent sets, settings)     |
| `GIT_CONFIG_GLOBAL`     | the demo's `gitconfig` (author, URL rewrites, no hooks, no signing) |
| `GIT_CONFIG_NOSYSTEM`   | `1`, so system-wide git settings don't apply                        |

Your own git configuration (hooks, signing, URL rewrites) doesn't affect the demo, and nothing the demo does touches your real settings. `HOME` isn't overridden, because `tauri dev` passes it on to Cargo and pnpm, which would then look for their caches in the demo home.

The demo refuses to write into a non-empty folder unless an earlier demo created it (it leaves a `.clonefleet-demo` marker), so a mistyped `--dir` can't wipe real files.

To write a demo home without launching the app:

```sh
cargo run --manifest-path src-tauri/Cargo.toml --example demo_home -- /tmp/clonefleet-demo          # VAR=value lines
cargo run --manifest-path src-tauri/Cargo.toml --example demo_home -- /tmp/clonefleet-demo --json   # a JSON object
```

## Updating the README screenshots

1. Run `pnpm demo` and resize the window to 1400 × 860 points. Leave the theme on System, or switch it in Settings for a dark capture.
2. Capture each screen. On macOS, `screencapture -o -l <window id> docs/screenshots/<name>.png` captures just the window (Screen Recording permission is required), or press ⇧⌘4, then Space, then ⌥-click the window.

| File                                        | Screen                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `docs/screenshots/overview.png`             | **Overview**, right after launch                                                        |
| `docs/screenshots/repositories.png`         | **Repositories**, with `api-gateway`, `billing-service`, and `design-system` selected   |
| `docs/screenshots/cleanup.png`              | **Branch cleanup**                                                                      |
| `docs/screenshots/branch-diff.png`          | **Branch cleanup**, then click `eslint-9` to open its details on the **Branches** tab   |
| `docs/screenshots/remotes.png`              | **Remotes** after **Check all remotes**                                                 |
| `docs/screenshots/disk-cleanup.png`         | **Disk cleanup** with **Needs reinstalling** and **May not be reproducible** also shown |
| `docs/screenshots/disk-cleanup-deleted.png` | The same, after **Delete 1 directory** removes the preselected `dist`                   |
