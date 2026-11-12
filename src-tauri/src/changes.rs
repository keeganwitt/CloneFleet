use serde::Serialize;

use crate::git::{Git, GitError};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Conflicted,
    Untracked,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub original_path: Option<String>,
    pub kind: ChangeKind,
    pub staged: bool,
    pub unstaged: bool,
}

fn kind_from_xy(xy: &str) -> ChangeKind {
    let mut codes = xy.chars();
    let index = codes.next().unwrap_or('.');
    let worktree = codes.next().unwrap_or('.');
    let either = |code| index == code || worktree == code;
    if either('R') {
        ChangeKind::Renamed
    } else if either('C') {
        ChangeKind::Copied
    } else if either('A') {
        ChangeKind::Added
    } else if either('D') {
        ChangeKind::Deleted
    } else if either('T') {
        ChangeKind::TypeChanged
    } else {
        ChangeKind::Modified
    }
}

fn tracked_change(xy: &str, path: &str, original_path: Option<String>) -> FileChange {
    FileChange {
        path: path.to_string(),
        original_path,
        kind: kind_from_xy(xy),
        staged: !xy.starts_with('.'),
        unstaged: !xy.ends_with('.'),
    }
}

pub fn parse_changes(output: &str) -> Vec<FileChange> {
    let mut changes = Vec::new();
    let mut entries = output.split('\0').filter(|e| !e.is_empty());
    while let Some(entry) = entries.next() {
        match entry.as_bytes().first() {
            Some(b'1') => {
                let fields: Vec<&str> = entry.splitn(9, ' ').collect();
                if let [_, xy, .., path] = fields[..] {
                    changes.push(tracked_change(xy, path, None));
                }
            }
            Some(b'2') => {
                let fields: Vec<&str> = entry.splitn(10, ' ').collect();
                let original = entries.next().map(str::to_string);
                if let [_, xy, .., path] = fields[..] {
                    changes.push(tracked_change(xy, path, original));
                }
            }
            Some(b'u') => {
                let fields: Vec<&str> = entry.splitn(11, ' ').collect();
                if let Some(path) = fields.get(10) {
                    changes.push(FileChange {
                        path: path.to_string(),
                        original_path: None,
                        kind: ChangeKind::Conflicted,
                        staged: false,
                        unstaged: true,
                    });
                }
            }
            Some(b'?') => {
                if let Some(path) = entry.strip_prefix("? ") {
                    changes.push(FileChange {
                        path: path.to_string(),
                        original_path: None,
                        kind: ChangeKind::Untracked,
                        staged: false,
                        unstaged: true,
                    });
                }
            }
            _ => {}
        }
    }
    changes
}

pub async fn list_changes(git: &mut Git) -> Result<Vec<FileChange>, GitError> {
    let output = git
        .run_ok(&["status", "--porcelain=v2", "-z", "--untracked-files=normal"])
        .await?;
    Ok(parse_changes(&output))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::test_support::Fixture;

    fn change(path: &str, kind: ChangeKind, staged: bool, unstaged: bool) -> FileChange {
        FileChange {
            path: path.into(),
            original_path: None,
            kind,
            staged,
            unstaged,
        }
    }

    #[test]
    fn parses_every_entry_type() {
        let output = "1 .M N... 100644 100644 100644 aaa aaa src/with space.rs\0\
1 A. N... 000000 100644 100644 000 bbb new.rs\0\
1 MD N... 100644 100644 000000 ccc ddd both.rs\0\
2 R. N... 100644 100644 100644 eee eee R100 renamed.rs\0original.rs\0\
u UU N... 100644 100644 100644 100644 f g h conflict.rs\0\
? scratch/\0\
! ignored.log\0";
        assert_eq!(
            parse_changes(output),
            vec![
                change("src/with space.rs", ChangeKind::Modified, false, true),
                change("new.rs", ChangeKind::Added, true, false),
                change("both.rs", ChangeKind::Deleted, true, true),
                FileChange {
                    original_path: Some("original.rs".into()),
                    ..change("renamed.rs", ChangeKind::Renamed, true, false)
                },
                change("conflict.rs", ChangeKind::Conflicted, false, true),
                change("scratch/", ChangeKind::Untracked, false, true),
            ]
        );
    }

    #[tokio::test]
    async fn lists_changes_in_a_real_repository() {
        let fixture = Fixture::new();
        fs::write(fixture.work.join("README.md"), "changed\n").unwrap();
        fs::write(fixture.work.join("with space.txt"), "x").unwrap();
        fixture.git(&fixture.work, &["mv", "README.md", "RENAMED.md"]);

        let changes = list_changes(&mut Git::new(&fixture.work)).await.unwrap();
        assert_eq!(
            changes,
            vec![
                FileChange {
                    original_path: Some("README.md".into()),
                    ..change("RENAMED.md", ChangeKind::Renamed, true, true)
                },
                change("with space.txt", ChangeKind::Untracked, false, true),
            ]
        );
    }
}
