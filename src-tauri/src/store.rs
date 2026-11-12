use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::app_settings::AppSettings;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct BranchSettings {
    pub primary: Option<String>,
    pub additional: Vec<String>,
}

impl BranchSettings {
    pub fn is_empty(&self) -> bool {
        self.primary.is_none() && self.additional.is_empty()
    }

    pub fn main_branches(&self, primary: &str) -> Vec<String> {
        let mut mains = vec![primary.to_string()];
        for branch in &self.additional {
            if !mains.contains(branch) {
                mains.push(branch.clone());
            }
        }
        mains
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub roots: Vec<PathBuf>,
    pub excluded: BTreeSet<PathBuf>,
    pub recent: Vec<Vec<PathBuf>>,
    pub branch_settings: BTreeMap<PathBuf, BranchSettings>,
    pub settings: AppSettings,
}

impl Config {
    pub fn load(path: &Path) -> io::Result<Self> {
        match fs::read_to_string(path) {
            Ok(contents) => serde_json::from_str(&contents)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e),
        }
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temp = path.with_extension("json.tmp");
        fs::write(&temp, serde_json::to_string_pretty(self)?)?;
        fs::rename(temp, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_branches_put_the_primary_first_without_duplicates() {
        let settings = BranchSettings {
            primary: None,
            additional: vec!["2.x".into(), "main".into(), "dev".into()],
        };
        assert_eq!(settings.main_branches("main"), vec!["main", "2.x", "dev"]);
        assert!(!settings.is_empty());
        assert!(BranchSettings::default().is_empty());
    }

    #[test]
    fn missing_file_loads_as_empty_config() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            Config::load(&dir.path().join("config.json")).unwrap(),
            Config::default()
        );
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/config.json");
        let config = Config {
            roots: vec![PathBuf::from("/b"), PathBuf::from("/a")],
            excluded: [PathBuf::from("/a/x")].into(),
            recent: vec![vec![PathBuf::from("/c")]],
            branch_settings: [(
                PathBuf::from("/a/x"),
                BranchSettings {
                    primary: Some("dev".into()),
                    additional: vec!["2.x".into()],
                },
            )]
            .into(),
            settings: AppSettings {
                git_path: Some(PathBuf::from("/opt/git")),
                theme: crate::app_settings::Theme::Dark,
                reopen_last: false,
                remember_recent: false,
            },
        };
        config.save(&path).unwrap();
        assert_eq!(Config::load(&path).unwrap(), config);
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn tolerates_unknown_fields_and_rejects_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, r#"{"roots":["/x"],"unknown":1}"#).unwrap();
        assert_eq!(
            Config::load(&path).unwrap().roots,
            vec![PathBuf::from("/x")]
        );
        fs::write(&path, "not json").unwrap();
        assert_eq!(
            Config::load(&path).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
}
