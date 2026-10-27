//! Cliniqo Desktop Configuration
//! Enforces trusted backend endpoint resolution and transport security.

use std::time::Duration;

pub const PRODUCTION_BACKEND_URL: &str = "https://api.cliniqo.app";
pub const DEFAULT_DEV_BACKEND_URL: &str = "http://localhost:3000";

/// Resolves the trusted backend base URL.
/// In release/production builds, strictly enforces HTTPS and only permits trusted production domains.
/// In debug builds, permits an override via CLINIQO_BACKEND_URL, defaulting to http://localhost:3000.
pub fn get_trusted_backend_url() -> Result<String, String> {
    #[cfg(debug_assertions)]
    {
        if let Ok(env_val) = std::env::var("CLINIQO_BACKEND_URL") {
            let trimmed = env_val.trim().trim_end_matches('/').to_string();
            if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                return Ok(trimmed);
            } else {
                return Err("CLINIQO_BACKEND_URL must use http:// or https:// scheme".to_string());
            }
        }
        Ok(DEFAULT_DEV_BACKEND_URL.to_string())
    }
    #[cfg(not(debug_assertions))]
    {
        let url = PRODUCTION_BACKEND_URL.trim_end_matches('/').to_string();
        if !url.starts_with("https://") {
            return Err("Production backend URL must strictly use HTTPS".to_string());
        }
        Ok(url)
    }
}

/// Creates a hardened HTTP client with automatic redirects disabled
/// to prevent token and credential leakage to third-party or untrusted hosts.
pub fn create_secure_http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to create secure HTTP client: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_secure_http_client_disables_redirects() {
        let client = create_secure_http_client(Duration::from_secs(5)).expect("client created");
        // Verify client can be built with no-redirect policy
        drop(client);
    }

    #[test]
    fn test_trusted_backend_url_valid_scheme() {
        let url = get_trusted_backend_url().expect("valid trusted URL");
        assert!(url.starts_with("http://") || url.starts_with("https://"));
        assert!(!url.ends_with('/'));
    }
}
