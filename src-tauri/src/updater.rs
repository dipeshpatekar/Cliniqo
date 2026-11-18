use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::config::{create_updater_http_client, is_trusted_updater_url};

pub const DEFAULT_UPDATE_ENDPOINT: &str =
    "https://github.com/dipeshpatekar/Cliniqo/releases/latest/download/latest.json";

pub const UPDATER_PUBLIC_KEY: &str =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDZDMzU3QzgxMjg4MzNEOEMKUldTTVBZTW9nWHcxYkNMb3lxZlV2V0kvZ2NWVFBVTzZKZFVvQXVqR3ptRmNsRVY3Q0dVYUJGbHcK";

#[derive(Error, Debug)]
pub enum UpdaterError {
    #[error("HTTP client initialization error: {0}")]
    ClientInit(String),

    #[error("Network error while checking updates: {0}")]
    Network(String),

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

fn describe_reqwest_error(err: &reqwest::Error, url: &str) -> String {
    let mut details = if err.is_timeout() {
        format!("Connection timed out while contacting {url}. Please verify your network connection.")
    } else if err.is_connect() {
        format!("Failed to connect to {url}. Please check your internet connection or firewall.")
    } else if err.is_redirect() {
        format!("Redirect error for {url}: {err}")
    } else {
        format!("Network error sending request to {url}: {err}")
    };

    let mut curr = std::error::Error::source(err);
    while let Some(src) = curr {
        details.push_str(&format!(" (caused by: {})", src));
        curr = src.source();
    }
    details
}

impl From<reqwest::Error> for UpdaterError {
    fn from(err: reqwest::Error) -> Self {
        UpdaterError::Network(describe_reqwest_error(&err, "update endpoint"))
    }
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

    /// Parses the configured Minisign public key.
    pub fn get_public_key() -> Result<PublicKey, UpdaterError> {
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(UPDATER_PUBLIC_KEY)
            .map_err(|e| UpdaterError::VerificationFailed(format!("Invalid public key base64: {}", e)))?;
        let key_str = String::from_utf8(decoded)
            .map_err(|e| UpdaterError::VerificationFailed(format!("Invalid public key utf8: {}", e)))?;
        PublicKey::decode(&key_str)
            .map_err(|e| UpdaterError::VerificationFailed(format!("Failed to parse Minisign public key: {:?}", e)))
    }

    /// Cryptographically verifies the downloaded package bytes against the Minisign signature.
    /// Supports raw Minisign signatures, base64-encoded Minisign signatures (standard in Tauri .sig files and manifests),
    /// and pre-hashed Minisign signatures.
    pub fn verify_installer_signature(bytes: &[u8], signature_str: &str) -> Result<(), UpdaterError> {
        let trimmed = signature_str.trim();
        if trimmed.is_empty() {
            return Err(UpdaterError::VerificationFailed(
                "Signature is missing or empty. Unsigned updates are strictly rejected.".to_string(),
            ));
        }

        // Tauri .sig files and latest.json manifests contain the base64-encoded multi-line Minisign signature.
        // Support both base64-encoded and raw multi-line strings.
        let resolved_sig_str = if trimmed.starts_with("untrusted comment:") {
            trimmed.to_string()
        } else if let Ok(decoded_bytes) = base64::engine::general_purpose::STANDARD.decode(trimmed) {
            match String::from_utf8(decoded_bytes) {
                Ok(s) if s.starts_with("untrusted comment:") => s,
                _ => trimmed.to_string(),
            }
        } else {
            trimmed.to_string()
        };

        let signature = Signature::decode(&resolved_sig_str).map_err(|e| {
            UpdaterError::VerificationFailed(format!("Invalid Minisign signature format: {:?}", e))
        })?;

        let public_key = Self::get_public_key()?;
        public_key
            .verify(bytes, &signature, true)
            .map_err(|e| UpdaterError::VerificationFailed(format!("Cryptographic signature verification failed: {:?}", e)))
    }

    /// Queries the update endpoint over secure HTTPS and determines update availability.
    pub async fn check_for_updates(
        custom_endpoint: Option<&str>,
    ) -> Result<UpdateCheckResult, UpdaterError> {
        Self::check_for_updates_with_version(custom_endpoint, None).await
    }

    /// Queries the update endpoint and determines update availability against a specified or current version.
    pub async fn check_for_updates_with_version(
        custom_endpoint: Option<&str>,
        version_override: Option<&str>,
    ) -> Result<UpdateCheckResult, UpdaterError> {
        let endpoint = custom_endpoint.unwrap_or(DEFAULT_UPDATE_ENDPOINT);

        let parsed_url = reqwest::Url::parse(endpoint)
            .map_err(|e| UpdaterError::VerificationFailed(format!("Invalid update URL: {e}")))?;

        #[cfg(test)]
        if !((parsed_url.scheme() == "http" || parsed_url.scheme() == "https")
            && (parsed_url.host_str() == Some("127.0.0.1") || parsed_url.host_str() == Some("localhost")))
        {
            if parsed_url.scheme() != "https" {
                return Err(UpdaterError::InsecureUrl);
            }
        }
        #[cfg(not(test))]
        if parsed_url.scheme() != "https" {
            return Err(UpdaterError::InsecureUrl);
        }

        if !is_trusted_updater_url(&parsed_url) {
            return Err(UpdaterError::VerificationFailed(format!(
                "Untrusted update endpoint host: {}",
                parsed_url.host_str().unwrap_or("unknown")
            )));
        }

        let current_version = version_override
            .map(|s| s.to_string())
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
        let client = create_updater_http_client(Duration::from_secs(35)).map_err(UpdaterError::ClientInit)?;

        // Send request with 1 retry on transient connection/timeout errors
        let mut last_error: Option<reqwest::Error> = None;
        let mut response: Option<reqwest::Response> = None;

        for attempt in 1..=2 {
            match client.get(endpoint).send().await {
                Ok(resp) => {
                    response = Some(resp);
                    break;
                }
                Err(err) => {
                    log::warn!(
                        "Update check attempt {}/2 for {} failed: {}",
                        attempt,
                        endpoint,
                        err
                    );
                    if attempt < 2 && (err.is_timeout() || err.is_connect()) {
                        tokio::time::sleep(Duration::from_millis(1000)).await;
                    }
                    last_error = Some(err);
                }
            }
        }

        let resp = match response {
            Some(r) => r,
            None => {
                let err = last_error.expect("last_error must be set on failure");
                return Err(UpdaterError::Network(describe_reqwest_error(&err, endpoint)));
            }
        };

        if !resp.status().is_success() {
            log::warn!("Update check endpoint returned non-success status: {}", resp.status());
            return Err(UpdaterError::VerificationFailed(format!(
                "Failed to retrieve update manifest: server returned HTTP {}",
                resp.status()
            )));
        }

        let body_text = resp
            .text()
            .await
            .map_err(|e| UpdaterError::Network(describe_reqwest_error(&e, endpoint)))?;

        let manifest: UpdateManifest = serde_json::from_str(&body_text)?;
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

    /// Resolves and securely verifies the update against the manifest and signature before downloading and staging.
    /// Returns the verified installer PathBuf.
    pub async fn download_and_verify_update(
        download_url: &str,
        target_version: &str,
        signature: Option<&str>,
        custom_endpoint: Option<&str>,
    ) -> Result<PathBuf, UpdaterError> {
        let parsed_url = reqwest::Url::parse(download_url)
            .map_err(|e| UpdaterError::VerificationFailed(format!("Invalid download URL: {e}")))?;

        #[cfg(test)]
        if !((parsed_url.scheme() == "http" || parsed_url.scheme() == "https")
            && (parsed_url.host_str() == Some("127.0.0.1") || parsed_url.host_str() == Some("localhost")))
        {
            if parsed_url.scheme() != "https" {
                return Err(UpdaterError::InsecureUrl);
            }
        }
        #[cfg(not(test))]
        if parsed_url.scheme() != "https" {
            return Err(UpdaterError::InsecureUrl);
        }

        if !is_trusted_updater_url(&parsed_url) {
            return Err(UpdaterError::VerificationFailed(format!(
                "Untrusted download URL host: {}",
                parsed_url.host_str().unwrap_or("unknown")
            )));
        }

        // 1. If signature was not directly provided, verify against the latest manifest at the official/trusted endpoint
        let expected_signature = if let Some(sig) = signature {
            sig.to_string()
        } else {
            let check = Self::check_for_updates(custom_endpoint).await?;
            if let Some(target_ver) = &check.target_version {
                if target_ver != target_version {
                    return Err(UpdaterError::VerificationFailed(format!(
                        "Target version '{}' does not match manifest version '{}'",
                        target_version, target_ver
                    )));
                }
            }
            if let Some(url) = &check.download_url {
                if url != download_url {
                    return Err(UpdaterError::VerificationFailed(format!(
                        "Download URL '{}' does not match verified manifest download URL '{}'",
                        download_url, url
                    )));
                }
            }
            check.signature.ok_or_else(|| {
                UpdaterError::VerificationFailed(
                    "Verified update manifest does not contain a signature for this platform".to_string(),
                )
            })?
        };

        // 2. Download package bytes using dedicated updater HTTP client with redirect support
        let client = create_updater_http_client(Duration::from_secs(180)).map_err(UpdaterError::ClientInit)?;
        let resp = client.get(download_url).send().await?;

        if !resp.status().is_success() {
            return Err(UpdaterError::VerificationFailed(format!(
                "Failed to download update package: HTTP {}",
                resp.status()
            )));
        }

        let bytes = resp.bytes().await?;

        // 3. Cryptographically verify signature with Minisign before writing to disk
        Self::verify_installer_signature(&bytes, &expected_signature)?;

        // 4. Write verified package to secure temp directory
        let temp_dir = std::env::temp_dir().join("cliniqo_updates");
        fs::create_dir_all(&temp_dir)?;

        let filename = if cfg!(target_os = "windows") {
            format!("Cliniqo-Setup-{}-x64.exe", target_version)
        } else {
            format!("Cliniqo-Update-{}.tar.gz", target_version)
        };

        let target_file = temp_dir.join(filename);
        fs::write(&target_file, &bytes)?;

        log::info!("Verified update package staged securely to: {:?}", target_file);
        Ok(target_file)
    }

    /// Downloads the update binary and verifies cryptographic signature before staging.
    pub async fn download_update_package(
        download_url: &str,
        target_version: &str,
    ) -> Result<PathBuf, UpdaterError> {
        Self::download_and_verify_update(download_url, target_version, None, None).await
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
    fn test_parse_public_key() {
        let pk = AppUpdater::get_public_key();
        assert!(pk.is_ok(), "Failed to get public key: {:?}", pk.err());
    }

    #[test]
    fn test_rejects_empty_or_missing_signature() {
        let dummy_bytes = b"MZ\x90\x00\x03\x00\x00\x00TestInstallerBinaryBytes";
        let res = AppUpdater::verify_installer_signature(dummy_bytes, "");
        assert!(matches!(res, Err(UpdaterError::VerificationFailed(_))));

        let res_ws = AppUpdater::verify_installer_signature(dummy_bytes, "   \n\t ");
        assert!(matches!(res_ws, Err(UpdaterError::VerificationFailed(_))));
    }

    #[test]
    fn test_rejects_invalid_signature_format() {
        let dummy_bytes = b"MZ\x90\x00\x03\x00\x00\x00TestInstallerBinaryBytes";
        let res = AppUpdater::verify_installer_signature(dummy_bytes, "not-a-valid-minisign-signature");
        assert!(matches!(res, Err(UpdaterError::VerificationFailed(_))));
    }

    #[test]
    fn test_rejects_tampered_binary_or_mismatched_signature() {
        let dummy_bytes = b"MZ\x90\x00\x03\x00\x00\x00TamperedInstallerBinaryBytes";
        // A syntactically valid Minisign signature for another payload/key
        let mock_sig = "untrusted comment: signature from minisign secret key\n\
RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\n\
trusted comment: timestamp:1633700835\tfile:test\n\
wLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==";

        let res = AppUpdater::verify_installer_signature(dummy_bytes, mock_sig);
        assert!(matches!(res, Err(UpdaterError::VerificationFailed(_))));

        // Base64-wrapped format (as produced by Tauri's signer and stored in latest.json)
        let b64_sig = base64::engine::general_purpose::STANDARD.encode(mock_sig);
        let res_b64 = AppUpdater::verify_installer_signature(dummy_bytes, &b64_sig);
        // It parses successfully and fails on cryptographic verification (because dummy_bytes don't match the key),
        // NOT on "Invalid Minisign signature format".
        match res_b64 {
            Err(UpdaterError::VerificationFailed(msg)) => {
                assert!(
                    msg.contains("Cryptographic signature verification failed"),
                    "Expected cryptographic verification error, got: {}",
                    msg
                );
            }
            other => panic!("Expected VerificationFailed, got {:?}", other),
        }
    }

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

    use std::sync::Arc;

    async fn setup_mock_updater_server<F>(handler: F) -> (String, tokio::task::JoinHandle<()>)
    where
        F: Fn(&str, &str) -> (u16, Vec<(&'static str, String)>, Vec<u8>) + Send + Sync + 'static,
    {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handler = Arc::new(handler);

        let server_handle = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let h = handler.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = [0u8; 8192];
                    if let Ok(n) = stream.read(&mut buf).await {
                        let req_str = String::from_utf8_lossy(&buf[..n]);
                        let (method, path) = if let Some(first_line) = req_str.lines().next() {
                            let parts: Vec<&str> = first_line.split_whitespace().collect();
                            (parts.first().copied().unwrap_or(""), parts.get(1).copied().unwrap_or(""))
                        } else {
                            ("", "")
                        };

                        let (status, headers, body) = h(method, path);
                        let status_text = match status {
                            200 => "200 OK",
                            301 => "301 Moved Permanently",
                            302 => "302 Found",
                            404 => "404 Not Found",
                            500 => "500 Internal Server Error",
                            _ => "400 Bad Request",
                        };

                        let mut resp_str = format!(
                            "HTTP/1.1 {}\r\nContent-Length: {}\r\nConnection: close\r\n",
                            status_text,
                            body.len()
                        );
                        for (k, v) in headers {
                            resp_str.push_str(&format!("{}: {}\r\n", k, v));
                        }
                        resp_str.push_str("\r\n");

                        let mut resp_bytes = resp_str.into_bytes();
                        resp_bytes.extend_from_slice(&body);
                        let _ = stream.write_all(&resp_bytes).await;
                    }
                });
            }
        });

        (format!("http://{}", addr), server_handle)
    }

    #[tokio::test]
    async fn test_check_for_updates_follows_302_redirect_and_detects_v1_0_2_from_v1_0_1() {
        let (mock_url, server_handle) = setup_mock_updater_server(|_method, path| {
            if path == "/releases/latest/download/latest.json" {
                // Simulate GitHub 302 redirect to tagged release asset
                (
                    302,
                    vec![("Location", "/releases/download/v1.0.2/latest.json".to_string())],
                    Vec::new(),
                )
            } else if path == "/releases/download/v1.0.2/latest.json" {
                let platform = AppUpdater::current_platform_target();
                let manifest = serde_json::json!({
                    "version": "1.0.2",
                    "notes": "v1.0.2 release with vital fixes",
                    "pub_date": "2026-11-17T00:00:00Z",
                    "platforms": {
                        platform: {
                            "signature": "mock_sig_102",
                            "url": "https://github.com/dipeshpatekar/Cliniqo/releases/download/v1.0.2/Cliniqo_1.0.2_x64-setup.exe"
                        }
                    }
                });
                (
                    200,
                    vec![("Content-Type", "application/json".to_string())],
                    manifest.to_string().into_bytes(),
                )
            } else {
                (404, Vec::new(), b"Not Found".to_vec())
            }
        }).await;

        let endpoint = format!("{}/releases/latest/download/latest.json", mock_url);
        let result = AppUpdater::check_for_updates_with_version(Some(&endpoint), Some("1.0.1"))
            .await
            .expect("Update check should succeed over 302 redirect");

        assert_eq!(result.current_version, "1.0.1");
        assert_eq!(result.target_version, Some("1.0.2".to_string()));
        assert!(result.available, "Update should be flagged available");
        assert_eq!(
            result.download_url,
            Some("https://github.com/dipeshpatekar/Cliniqo/releases/download/v1.0.2/Cliniqo_1.0.2_x64-setup.exe".to_string())
        );
        assert_eq!(result.release_notes, Some("v1.0.2 release with vital fixes".to_string()));

        server_handle.abort();
    }

    #[tokio::test]
    async fn test_check_for_updates_fails_on_server_error_and_never_reports_up_to_date() {
        // Test 404
        let (mock_url_404, server_handle_404) = setup_mock_updater_server(|_method, _path| {
            (404, Vec::new(), b"Not Found".to_vec())
        }).await;

        let res_404 = AppUpdater::check_for_updates_with_version(
            Some(&format!("{}/latest.json", mock_url_404)),
            Some("1.0.1"),
        ).await;

        match res_404 {
            Err(UpdaterError::VerificationFailed(msg)) => {
                assert!(msg.contains("404"), "Expected HTTP 404 in error message, got: {msg}");
            }
            Ok(res) => panic!("Expected error on HTTP 404, but got Ok with available={}", res.available),
            Err(other) => panic!("Expected VerificationFailed, got {:?}", other),
        }
        server_handle_404.abort();

        // Test 500
        let (mock_url_500, server_handle_500) = setup_mock_updater_server(|_method, _path| {
            (500, Vec::new(), b"Internal Server Error".to_vec())
        }).await;

        let res_500 = AppUpdater::check_for_updates_with_version(
            Some(&format!("{}/latest.json", mock_url_500)),
            Some("1.0.1"),
        ).await;

        match res_500 {
            Err(UpdaterError::VerificationFailed(msg)) => {
                assert!(msg.contains("500"), "Expected HTTP 500 in error message, got: {msg}");
            }
            Ok(res) => panic!("Expected error on HTTP 500, but got Ok with available={}", res.available),
            Err(other) => panic!("Expected VerificationFailed, got {:?}", other),
        }
        server_handle_500.abort();
    }

    #[tokio::test]
    async fn test_check_for_updates_fails_on_invalid_json() {
        let (mock_url, server_handle) = setup_mock_updater_server(|_method, _path| {
            (200, vec![("Content-Type", "application/json".to_string())], b"<html>Not JSON</html>".to_vec())
        }).await;

        let res = AppUpdater::check_for_updates_with_version(
            Some(&format!("{}/latest.json", mock_url)),
            Some("1.0.1"),
        ).await;

        assert!(res.is_err(), "Invalid JSON payload must produce an error and never report up to date");
        server_handle.abort();
    }

    #[tokio::test]
    async fn test_updater_redirect_rejects_untrusted_destination() {
        let (mock_url, server_handle) = setup_mock_updater_server(|_method, _path| {
            (
                302,
                vec![("Location", "https://malicious-domain.com/latest.json".to_string())],
                Vec::new(),
            )
        }).await;

        let res = AppUpdater::check_for_updates(Some(&format!("{}/latest.json", mock_url))).await;
        assert!(res.is_err(), "Redirect to untrusted host must be rejected");

        server_handle.abort();
    }

    #[tokio::test]
    async fn test_updater_redirect_rejects_redirect_loop_over_5_hops() {
        let (mock_url, server_handle) = setup_mock_updater_server(|_method, path| {
            let next_hop = match path {
                "/hop1" => "/hop2",
                "/hop2" => "/hop3",
                "/hop3" => "/hop4",
                "/hop4" => "/hop5",
                "/hop5" => "/hop6",
                "/hop6" => "/hop7",
                _ => "/done",
            };
            (302, vec![("Location", next_hop.to_string())], Vec::new())
        }).await;

        let client = create_updater_http_client(Duration::from_secs(5)).expect("client created");
        let res = client.get(&format!("{}/hop1", mock_url)).send().await;

        assert!(res.is_err(), "Redirect chain exceeding 5 hops must fail");
        let err_str = res.err().unwrap().to_string();
        assert!(
            err_str.contains("Too many redirects") || err_str.contains("redirect"),
            "Expected redirect error, got: {err_str}"
        );

        server_handle.abort();
    }

    #[tokio::test]
    async fn test_download_and_verify_update_follows_302_redirect_and_verifies_signature() {
        let (mock_url, server_handle) = setup_mock_updater_server(|_method, path| {
            if path == "/download/installer.exe" {
                (302, vec![("Location", "/cdn/installer.exe".to_string())], Vec::new())
            } else if path == "/cdn/installer.exe" {
                (200, vec![("Content-Type", "application/octet-stream".to_string())], b"MZTestInstallerBinaryPayload".to_vec())
            } else {
                (404, Vec::new(), b"Not Found".to_vec())
            }
        }).await;

        // An invalid signature must be rejected after downloading over 302 redirect
        let res = AppUpdater::download_and_verify_update(
            &format!("{}/download/installer.exe", mock_url),
            "1.0.2",
            Some("invalid_minisign_signature"),
            None,
        ).await;

        match res {
            Err(UpdaterError::VerificationFailed(msg)) => {
                assert!(
                    msg.contains("signature"),
                    "Expected signature verification failure after download, got: {msg}"
                );
            }
            Ok(path) => panic!("Expected signature verification error, but got Ok({:?})", path),
            Err(other) => panic!("Expected VerificationFailed, got {:?}", other),
        }

        server_handle.abort();
    }

    #[tokio::test]
    async fn test_check_for_updates_network_failure_diagnostics_and_never_reports_up_to_date() {
        // Query an unreachable local port to test network failure handling
        let unreachable_url = "http://127.0.0.1:59999/latest.json";
        let res = AppUpdater::check_for_updates_with_version(Some(unreachable_url), Some("1.0.4")).await;

        match res {
            Err(UpdaterError::Network(err_msg)) => {
                assert!(
                    err_msg.contains("Failed to connect") || err_msg.contains("Network error") || err_msg.contains("connection"),
                    "Expected diagnostic network connection failure, got: {err_msg}"
                );
            }
            Ok(val) => panic!("Failed network request must never return Ok or report up-to-date, got: {:?}", val),
            Err(other) => panic!("Expected UpdaterError::Network, got: {:?}", other),
        }
    }
}
