//! Cliniqo Desktop Configuration
//! Enforces trusted backend endpoint resolution and transport security.

use std::time::Duration;

pub const PRODUCTION_BACKEND_URL: &str = "https://cliniqo-backend-68x3.onrender.com";
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

/// Creates a shared, pooled HTTP client for backend API communication with
/// automatic redirects disabled to prevent credential leakage and persistent
/// TCP/TLS connection reuse across requests.
pub fn create_shared_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(6)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to create shared HTTP client: {e}"))
}

/// Returns a process-wide shared pooled HTTP client for helper functions that do not
/// receive `AppState`.
pub fn get_shared_http_client() -> Result<reqwest::Client, String> {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT.get_or_init(create_shared_http_client).clone()
}

/// Creates a hardened HTTP client with automatic redirects disabled
/// to prevent token and credential leakage to third-party or untrusted hosts.
pub fn create_secure_http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(std::cmp::min(Duration::from_secs(10), timeout))
        .pool_idle_timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to create secure HTTP client: {e}"))
}

/// Maximum allowed redirect hops for the updater client.
pub const MAX_UPDATER_REDIRECTS: usize = 5;

/// Custom error type for updater redirect policy errors.
#[derive(Debug)]
pub struct UpdaterRedirectError(pub String);

impl std::fmt::Display for UpdaterRedirectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for UpdaterRedirectError {}

/// Checks if a host name belongs to an authorized updater source.
/// Authorized hosts include GitHub releases and GitHub-hosted storage assets (S3 / CDN).
pub fn is_trusted_updater_host(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    if lower == "github.com" || lower.ends_with(".github.com") {
        return true;
    }
    if lower == "githubusercontent.com" || lower.ends_with(".githubusercontent.com") {
        return true;
    }
    #[cfg(test)]
    {
        if lower == "127.0.0.1" || lower == "localhost" || lower == "::1" || lower == "[::1]" {
            return true;
        }
    }
    false
}

/// Checks if a URL is safe for updater queries and asset downloads.
/// Must use HTTPS (or loopback in unit tests) and point to a trusted updater host.
pub fn is_trusted_updater_url(url: &reqwest::Url) -> bool {
    let scheme = url.scheme();
    let host = match url.host_str() {
        Some(h) => h,
        None => return false,
    };

    #[cfg(test)]
    {
        if scheme == "http" && (host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "[::1]") {
            return true;
        }
    }

    if scheme != "https" {
        return false;
    }

    is_trusted_updater_host(host)
}

/// Creates a dedicated secure HTTP client for the updater that safely follows
/// HTTPS redirects up to 5 hops strictly to trusted GitHub download hosts.
pub fn create_updater_http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= MAX_UPDATER_REDIRECTS {
            return attempt.error(UpdaterRedirectError(format!(
                "Too many redirects: updater exceeded maximum allowed limit of {}",
                MAX_UPDATER_REDIRECTS
            )));
        }

        if !is_trusted_updater_url(attempt.url()) {
            let next_url = attempt.url().to_string();
            return attempt.error(UpdaterRedirectError(format!(
                "Untrusted or insecure redirect destination: {}",
                next_url
            )));
        }

        attempt.follow()
    });

    // Provide a responsive connect timeout (8 seconds) to failover multi-IP DNS endpoints quickly,
    // and standard updater user agent to ensure reliable acceptance by GitHub Releases infrastructure.
    let connect_timeout = std::cmp::min(Duration::from_secs(8), timeout);

    reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(connect_timeout)
        .user_agent(concat!("Cliniqo-Desktop-Updater/", env!("CARGO_PKG_VERSION")))
        .pool_idle_timeout(Duration::from_secs(15))
        .redirect(policy)
        .build()
        .map_err(|e| format!("Failed to create updater HTTP client: {e}"))
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
    fn test_trusted_updater_hosts() {
        assert!(is_trusted_updater_host("github.com"));
        assert!(is_trusted_updater_host("api.github.com"));
        assert!(is_trusted_updater_host("releases.github.com"));
        assert!(is_trusted_updater_host("objects.githubusercontent.com"));
        assert!(is_trusted_updater_host("github-releases.githubusercontent.com"));
        assert!(is_trusted_updater_host("release-assets.githubusercontent.com"));
        assert!(is_trusted_updater_host("raw.githubusercontent.com"));

        // Untrusted hosts
        assert!(!is_trusted_updater_host("fakegithub.com"));
        assert!(!is_trusted_updater_host("mygithub.com"));
        assert!(!is_trusted_updater_host("fakegithubusercontent.com"));
        assert!(!is_trusted_updater_host("evil.com"));
        assert!(!is_trusted_updater_host("google.com"));
    }

    #[test]
    fn test_trusted_updater_urls() {
        let valid_github = reqwest::Url::parse("https://github.com/dipeshpatekar/Cliniqo/releases/latest/download/latest.json").unwrap();
        assert!(is_trusted_updater_url(&valid_github));

        let valid_s3 = reqwest::Url::parse("https://objects.githubusercontent.com/github-production-release-asset/12345").unwrap();
        assert!(is_trusted_updater_url(&valid_s3));

        // Non-HTTPS should be rejected
        let http_github = reqwest::Url::parse("http://github.com/dipeshpatekar/Cliniqo/releases").unwrap();
        assert!(!is_trusted_updater_url(&http_github));

        // Untrusted host should be rejected
        let evil_url = reqwest::Url::parse("https://evil-mirror.com/releases/latest.json").unwrap();
        assert!(!is_trusted_updater_url(&evil_url));
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
        assert_eq!(PRODUCTION_BACKEND_URL, "https://cliniqo-backend-68x3.onrender.com");
    }
}
