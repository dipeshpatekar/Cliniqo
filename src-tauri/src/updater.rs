use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::config::create_secure_http_client;

pub const DEFAULT_UPDATE_ENDPOINT: &str =
    "https://github.com/dipeshpatekar/Cliniqo/releases/latest/download/latest.json";

pub const UPDATER_PUBLIC_KEY: &str =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDZDMzU3QzgxMjg4MzNEOEMKUldTTVBZTW9nWHcxYkNMb3lxZlV2V0kvZ2NWVFBVTzZKZFVvQXVqR3ptRmNsRVY3Q0dVYUJGbHcK";

#[derive(Error, Debug)]
pub enum UpdaterError {
    #[error("HTTP client initialization error: {0}")]
    ClientInit(String),

    #[error("Network error while checking updates: {0}")]
    Network(#[from] reqwest::Error),

    #[error("I/O error during update: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON parsing error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Insecure update URL: updates must be delivered exclusively over HTTPS")]
    InsecureUrl,

    #[error("Update verification failed: {0}")]
    VerificationFailed(String),

    #[error("No update target found for platform: {0}")]
    UnsupportedPlatform(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatePlatformInfo {
    pub signature: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateManifest {
    pub version: String,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
    pub platforms: HashMap<String, UpdatePlatformInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateCheckResult {
    pub available: bool,
    pub current_version: String,
    pub target_version: Option<String>,
    pub release_notes: Option<String>,
    pub pub_date: Option<String>,
    pub download_url: Option<String>,
    pub signature: Option<String>,
    pub endpoint: String,
    pub checked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInstallResult {
    pub success: bool,
    pub target_version: String,
    pub installer_path: String,
    pub status_message: String,
}

pub struct AppUpdater;

impl AppUpdater {
    /// Compares two semver strings (e.g. "1.0.1" vs "1.0.0").
    /// Returns true if target is strictly newer than current.
    pub fn is_newer_version(current: &str, target: &str) -> bool {
        let parse_semver = |v: &str| -> Vec<u64> {
            v.trim_start_matches('v')
                .split('.')
                .filter_map(|s| s.split('-').next().and_then(|n| n.parse::<u64>().ok()))
                .collect()
        };

        let curr_parts = parse_semver(current);
        let target_parts = parse_semver(target);

        for (t, c) in target_parts.iter().zip(curr_parts.iter()) {
            if t > c {
                return true;
            }
            if t < c {
                return false;
            }
        }

        target_parts.len() > curr_parts.len()
    }

    /// Resolves canonical platform identifier for updater targets.
    pub fn current_platform_target() -> &'static str {
        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        return "windows-x86_64";

        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        return "darwin-aarch64";

        #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
        return "darwin-x86_64";

        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        return "linux-x86_64";

        #[cfg(not(any(
            all(target_os = "windows", target_arch = "x86_64"),
            all(target_os = "macos", target_arch = "aarch64"),
            all(target_os = "macos", target_arch = "x86_64"),
            all(target_os = "linux", target_arch = "x86_64"),
        )))]
        return "unknown";
    }

    /// Queries the update endpoint over secure HTTPS and determines update availability.
    pub async fn check_for_updates(
        custom_endpoint: Option<&str>,
    ) -> Result<UpdateCheckResult, UpdaterError> {
        let endpoint = custom_endpoint.unwrap_or(DEFAULT_UPDATE_ENDPOINT);

        if !endpoint.starts_with("https://") {
            return Err(UpdaterError::InsecureUrl);
        }

        let current_version = env!("CARGO_PKG_VERSION").to_string();
        let client = create_secure_http_client(Duration::from_secs(15)).map_err(UpdaterError::ClientInit)?;

        let resp = client.get(endpoint).send().await?;
        if !resp.status().is_success() {
            log::info!("Update check endpoint returned status: {}", resp.status());
            return Ok(UpdateCheckResult {
                available: false,
                current_version,
                target_version: None,
                release_notes: None,
                pub_date: None,
                download_url: None,
                signature: None,
                endpoint: endpoint.to_string(),
                checked_at: chrono::Utc::now().to_rfc3339(),
            });
        }

        let manifest: UpdateManifest = resp.json().await?;
        let is_available = Self::is_newer_version(&current_version, &manifest.version);
        let platform = Self::current_platform_target();
        let platform_info = manifest.platforms.get(platform);

        let (download_url, signature) = if let Some(info) = platform_info {
            (Some(info.url.clone()), Some(info.signature.clone()))
        } else {
            (None, None)
        };

        Ok(UpdateCheckResult {
            available: is_available && download_url.is_some(),
            current_version,
            target_version: if is_available { Some(manifest.version) } else { None },
            release_notes: manifest.notes,
            pub_date: manifest.pub_date,
            download_url,
            signature,
            endpoint: endpoint.to_string(),
            checked_at: chrono::Utc::now().to_rfc3339(),
        })
    }

    /// Downloads the signed update binary over HTTPS into a secure temporary location.
    pub async fn download_update_package(
        download_url: &str,
        target_version: &str,
    ) -> Result<PathBuf, UpdaterError> {
        if !download_url.starts_with("https://") {
            return Err(UpdaterError::InsecureUrl);
        }

        let client = create_secure_http_client(Duration::from_secs(60)).map_err(UpdaterError::ClientInit)?;
        let resp = client.get(download_url).send().await?;

        if !resp.status().is_success() {
            return Err(UpdaterError::VerificationFailed(format!(
                "Failed to download update package: HTTP {}",
                resp.status()
            )));
        }

        let bytes = resp.bytes().await?;
        let temp_dir = std::env::temp_dir().join("cliniqo_updates");
        fs::create_dir_all(&temp_dir)?;

        let filename = if cfg!(target_os = "windows") {
            format!("Cliniqo-Setup-{}-x64.exe", target_version)
        } else {
            format!("Cliniqo-Update-{}.tar.gz", target_version)
        };

        let target_file = temp_dir.join(filename);
        fs::write(&target_file, &bytes)?;

        log::info!("Update package downloaded successfully to: {:?}", target_file);
        Ok(target_file)
    }

    /// Prepares and executes the NSIS upgrade installer while preserving existing local SQLite data and DPAPI keys.
    pub fn launch_installer_non_destructive(installer_path: &PathBuf) -> Result<(), UpdaterError> {
        if !installer_path.exists() {
            return Err(UpdaterError::VerificationFailed(
                "Installer file does not exist at specified path".to_string(),
            ));
        }

        // On Windows, the NSIS perMachine installer installs to Program Files,
        // leaving %LOCALAPPDATA%\com.cliniqo.desktop (SQLite DB and DPAPI keys) untouched.
        #[cfg(target_os = "windows")]
        {
            use std::process::Command;
            Command::new(installer_path)
                .spawn()
                .map_err(|e| UpdaterError::Io(e))?;
        }

        log::info!("Installer launched: {:?}", installer_path);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version_comparison_logic() {
        assert!(AppUpdater::is_newer_version("1.0.0", "1.0.1"));
        assert!(AppUpdater::is_newer_version("1.0.0", "1.1.0"));
        assert!(AppUpdater::is_newer_version("1.0.0", "2.0.0"));
        assert!(AppUpdater::is_newer_version("v1.0.0", "v1.0.1"));
        assert!(!AppUpdater::is_newer_version("1.0.1", "1.0.0"));
        assert!(!AppUpdater::is_newer_version("1.0.0", "1.0.0"));
        assert!(!AppUpdater::is_newer_version("2.0.0", "1.9.9"));
    }

    #[test]
    fn test_insecure_update_urls_rejected() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let res = AppUpdater::check_for_updates(Some("http://insecure-domain.com/update.json")).await;
            assert!(matches!(res, Err(UpdaterError::InsecureUrl)));

            let dl_res = AppUpdater::download_update_package("http://insecure-domain.com/pkg.exe", "1.0.1").await;
            assert!(matches!(dl_res, Err(UpdaterError::InsecureUrl)));
        });
    }

    #[test]
    fn test_manifest_parsing_with_platform_matching() {
        let manifest_json = r#"{
            "version": "1.0.1",
            "notes": "Emergency security patches and performance fixes.",
            "pub_date": "2026-11-09T18:00:00Z",
            "platforms": {
                "windows-x86_64": {
                    "signature": "mock_sig_win",
                    "url": "https://github.com/dipeshpatekar/Cliniqo/releases/download/v1.0.1/Cliniqo-Setup.exe"
                },
                "darwin-aarch64": {
                    "signature": "mock_sig_mac",
                    "url": "https://github.com/dipeshpatekar/Cliniqo/releases/download/v1.0.1/Cliniqo.app.tar.gz"
                }
            }
        }"#;

        let manifest: UpdateManifest = serde_json::from_str(manifest_json).unwrap();
        assert_eq!(manifest.version, "1.0.1");
        assert_eq!(manifest.notes, Some("Emergency security patches and performance fixes.".to_string()));

        let win_info = manifest.platforms.get("windows-x86_64").unwrap();
        assert_eq!(win_info.signature, "mock_sig_win");
        assert!(win_info.url.starts_with("https://"));
    }
}
