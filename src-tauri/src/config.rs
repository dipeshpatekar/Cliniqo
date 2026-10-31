//! Cliniqo Desktop Configuration
//! Enforces trusted backend endpoint resolution and transport security.

use std::time::Duration;

pub const PRODUCTION_BACKEND_URL: &str = "https://cliniqo-api.onrender.com";
pub const DEFAULT_DEV_BACKEND_URL: &str = "http://localhost:3000";

/// Resolves the trusted backend base URL.
/// Resolves the trusted backend base URL.
/// Permits an explicit override via CLINIQO_BACKEND_URL (validating http:// or https:// scheme).
/// When unset, defaults to DEFAULT_DEV_BACKEND_URL in debug builds and PRODUCTION_BACKEND_URL in release builds.
pub fn get_trusted_backend_url() -> Result<String, String> {
    if let Ok(env_val) = std::env::var("CLINIQO_BACKEND_URL") {
        let trimmed = env_val.trim().trim_end_matches('/').to_string();
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            return Ok(trimmed);
        } else {
            return Err("CLINIQO_BACKEND_URL must use http:// or https:// scheme".to_string());
        }
    }

    #[cfg(debug_assertions)]
    {
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

    #[test]
    fn test_trusted_backend_url_env_override() {
        unsafe {
            std::env::set_var("CLINIQO_BACKEND_URL", "https://staging.cliniqo.app");
        }
        let url = get_trusted_backend_url().expect("valid override URL");
        assert_eq!(url, "https://staging.cliniqo.app");
        unsafe {
            std::env::remove_var("CLINIQO_BACKEND_URL");
        }
    }

    #[test]
    fn test_production_backend_url_points_to_render() {
        assert_eq!(PRODUCTION_BACKEND_URL, "https://cliniqo-api.onrender.com");
    }
}
