use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use base64::prelude::*;
use serde::{Deserialize, Serialize};
use thiserror::Error;

type HmacSha256 = Hmac<Sha256>;

#[derive(Error, Debug, PartialEq, Eq)]
pub enum AuthError {
    #[error("No active doctor session found. Please log in.")]
    Unauthenticated,

    #[error("Doctor session has expired. Please log in again.")]
    SessionExpired,

    #[error("Forbidden: Access denied for clinic '{attempted_clinic}'. Active session belongs to clinic '{session_clinic}'.")]
    CrossClinicForbidden {
        attempted_clinic: String,
        session_clinic: String,
    },

    #[error("Forbidden: Doctor does not have required role '{required_role}'.")]
    InsufficientRole { required_role: String },

    #[error("Invalid token format or claims: {0}")]
    InvalidToken(String),

    #[error("Token signature verification failed: cryptographic signature mismatch.")]
    SignatureVerificationFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionContext {
    pub doctor_id: String,
    pub clinic_id: String,
    pub doctor_email: String,
    pub doctor_name: String,
    pub role: String,
    pub expires_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
struct JwtHeader {
    alg: String,
    typ: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JwtPayload {
    sub: String,
    email: String,
    #[serde(rename = "fullName")]
    full_name: Option<String>,
    #[serde(rename = "type")]
    token_type: Option<String>,
    iss: Option<String>,
    aud: Option<String>,
    exp: Option<i64>,
}

pub struct SessionManager {
    jwt_secret: Vec<u8>,
    current_session: RwLock<Option<SessionContext>>,
}

impl SessionManager {
    pub fn new(jwt_secret: &[u8]) -> Self {
        Self {
            jwt_secret: jwt_secret.to_vec(),
            current_session: RwLock::new(None),
        }
    }

    /// Secure secret provisioning: requires JWT_ACCESS_SECRET in production release builds,
    /// allows local dev fallback strictly in debug builds.
    pub fn with_default_secret() -> Self {
        #[cfg(not(debug_assertions))]
        {
            let secret = std::env::var("JWT_ACCESS_SECRET").expect(
                "FATAL: JWT_ACCESS_SECRET environment variable is required in production desktop release builds and must not be empty.",
            );
            if secret.trim().len() < 32 || secret.contains("dev_jwt_secret") {
                panic!("FATAL: JWT_ACCESS_SECRET must be at least 32 characters and cannot use default dev secret in production release builds.");
            }
            Self::new(secret.as_bytes())
        }
        #[cfg(debug_assertions)]
        {
            let secret = std::env::var("JWT_ACCESS_SECRET").unwrap_or_else(|_| {
                "dev_jwt_secret_change_in_production_min_32_bytes_long!!".to_string()
            });
            Self::new(secret.as_bytes())
        }
    }

    /// Verifies JWT cryptographic signature and standard claims (iss, aud, exp, type)
    pub fn verify_jwt(&self, token: &str) -> Result<JwtPayload, AuthError> {
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() != 3 {
            return Err(AuthError::InvalidToken(
                "JWT must contain exactly three period-separated segments".to_string(),
            ));
        }

        let header_b64 = parts[0];
        let payload_b64 = parts[1];
        let signature_b64 = parts[2];

        // 1. Verify header algorithm
        let header_bytes = BASE64_URL_SAFE_NO_PAD
            .decode(header_b64)
            .map_err(|e| AuthError::InvalidToken(format!("Invalid header base64: {e}")))?;
        let header: JwtHeader = serde_json::from_slice(&header_bytes)
            .map_err(|e| AuthError::InvalidToken(format!("Invalid header JSON: {e}")))?;

        if header.alg != "HS256" {
            return Err(AuthError::InvalidToken(format!(
                "Unsupported JWT algorithm: expected HS256, got {}",
                header.alg
            )));
        }

        // 2. Cryptographic signature check using constant-time comparison
        let signing_input = format!("{header_b64}.{payload_b64}");
        let mut mac = HmacSha256::new_from_slice(&self.jwt_secret)
            .map_err(|e| AuthError::InvalidToken(format!("HMAC initialization error: {e}")))?;
        mac.update(signing_input.as_bytes());

        let signature_bytes = BASE64_URL_SAFE_NO_PAD
            .decode(signature_b64)
            .map_err(|e| AuthError::InvalidToken(format!("Invalid signature base64: {e}")))?;

        mac.verify_slice(&signature_bytes)
            .map_err(|_| AuthError::SignatureVerificationFailed)?;

        // 3. Decode and validate payload claims
        let payload_bytes = BASE64_URL_SAFE_NO_PAD
            .decode(payload_b64)
            .map_err(|e| AuthError::InvalidToken(format!("Invalid payload base64: {e}")))?;
        let payload: JwtPayload = serde_json::from_slice(&payload_bytes)
            .map_err(|e| AuthError::InvalidToken(format!("Invalid payload JSON: {e}")))?;

        // Validate token type
        if let Some(ref t) = payload.token_type {
            if t != "access" {
                return Err(AuthError::InvalidToken(format!(
                    "Invalid token type: expected 'access', got '{t}'"
                )));
            }
        }

        // Validate issuer if present: accepts 'cliniqo-backend' (backend default) or 'cliniqo-auth'
        if let Some(ref iss) = payload.iss {
            if iss != "cliniqo-backend" && iss != "cliniqo-auth" {
                return Err(AuthError::InvalidToken(format!(
                    "Untrusted issuer: expected 'cliniqo-backend' or 'cliniqo-auth', got '{iss}'"
                )));
            }
        }

        // Validate audience if present
        if let Some(ref aud) = payload.aud {
            if aud != "cliniqo-client" {
                return Err(AuthError::InvalidToken(format!(
                    "Untrusted audience: expected 'cliniqo-client', got '{aud}'"
                )));
            }
        }

        // Validate expiration
        let now_sec = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        if let Some(exp) = payload.exp {
            if exp <= now_sec {
                return Err(AuthError::SessionExpired);
            }
        }

        Ok(payload)
    }

    /// Establishes an authenticated session after cryptographically verifying token and claims.
    pub fn login(
        &self,
        token: &str,
        clinic_id: &str,
        role: &str,
    ) -> Result<SessionContext, AuthError> {
        let payload = self.verify_jwt(token)?;

        let expires_at = payload.exp.unwrap_or_else(|| {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            now + 900 // Default 15 minutes
        });

        let context = SessionContext {
            doctor_id: payload.sub,
            clinic_id: clinic_id.to_string(),
            doctor_email: payload.email,
            doctor_name: payload.full_name.unwrap_or_else(|| "Doctor".to_string()),
            role: role.to_uppercase(),
            expires_at,
        };

        let mut lock = self.current_session.write().unwrap();
        *lock = Some(context.clone());

        log::info!(
            "Desktop session established for doctor '{}' in clinic '{}' with role '{}'",
            context.doctor_id,
            context.clinic_id,
            context.role
        );

        Ok(context)
    }

    /// Invalidates the active desktop session upon logout
    pub fn logout(&self) {
        let mut lock = self.current_session.write().unwrap();
        *lock = None;
        log::info!("Desktop session invalidated.");
    }

    /// Returns the current session context if valid and unexpired
    pub fn get_session(&self) -> Option<SessionContext> {
        let lock = self.current_session.read().unwrap();
        if let Some(ref session) = *lock {
            let now_sec = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;

            if session.expires_at > now_sec {
                return Some(session.clone());
            }
        }
        None
    }

    /// Validates that an active, non-expired session exists and matches the expected clinic tenancy.
    pub fn validate_session(&self, required_clinic_id: Option<&str>) -> Result<SessionContext, AuthError> {
        let lock = self.current_session.read().unwrap();
        match *lock {
            None => Err(AuthError::Unauthenticated),
            Some(ref session) => {
                let now_sec = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;

                if session.expires_at <= now_sec {
                    drop(lock);
                    self.logout();
                    return Err(AuthError::SessionExpired);
                }

                if let Some(expected_clinic) = required_clinic_id {
                    if session.clinic_id != expected_clinic {
                        return Err(AuthError::CrossClinicForbidden {
                            attempted_clinic: expected_clinic.to_string(),
                            session_clinic: session.clinic_id.clone(),
                        });
                    }
                }

                Ok(session.clone())
            }
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub fn generate_test_jwt(
        secret: &[u8],
        sub: &str,
        email: &str,
        expires_in_secs: i64,
    ) -> String {
        let header = r#"{"alg":"HS256","typ":"JWT"}"#;
        let header_b64 = BASE64_URL_SAFE_NO_PAD.encode(header.as_bytes());

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        let payload = format!(
            r#"{{"sub":"{sub}","email":"{email}","fullName":"Dr. Test","status":"ACTIVE","type":"access","iss":"cliniqo-auth","aud":"cliniqo-client","exp":{}}}"#,
            now + expires_in_secs
        );
        let payload_b64 = BASE64_URL_SAFE_NO_PAD.encode(payload.as_bytes());

        let signing_input = format!("{header_b64}.{payload_b64}");
        let mut mac = HmacSha256::new_from_slice(secret).unwrap();
        mac.update(signing_input.as_bytes());
        let signature = mac.finalize().into_bytes();
        let sig_b64 = BASE64_URL_SAFE_NO_PAD.encode(&signature);

        format!("{signing_input}.{sig_b64}")
    }

    #[test]
    fn test_valid_jwt_and_session_lifecycle() {
        let secret = b"my_super_secret_test_key_for_cliniqo_desktop";
        let manager = SessionManager::new(secret);

        let token = generate_test_jwt(secret, "doc_123", "dr.patel@clinic.com", 3600);
        let session = manager.login(&token, "clinic_001", "DOCTOR").expect("login succeeds");

        assert_eq!(session.doctor_id, "doc_123");
        assert_eq!(session.clinic_id, "clinic_001");
        assert_eq!(session.role, "DOCTOR");

        // Validate session
        let validated = manager.validate_session(Some("clinic_001")).expect("validation succeeds");
        assert_eq!(validated.doctor_id, "doc_123");

        // Logout
        manager.logout();
        assert_eq!(manager.validate_session(None), Err(AuthError::Unauthenticated));
    }

    #[test]
    fn test_tampered_or_invalid_signature_rejected() {
        let secret = b"my_super_secret_test_key_for_cliniqo_desktop";
        let wrong_secret = b"wrong_secret_key_attacking_system";
        let manager = SessionManager::new(secret);

        let malicious_token = generate_test_jwt(wrong_secret, "attacker_doc", "attacker@evil.com", 3600);
        let result = manager.login(&malicious_token, "clinic_001", "DOCTOR");
        assert_eq!(result, Err(AuthError::SignatureVerificationFailed));
    }

    #[test]
    fn test_expired_token_rejected() {
        let secret = b"my_super_secret_test_key_for_cliniqo_desktop";
        let manager = SessionManager::new(secret);

        let expired_token = generate_test_jwt(secret, "doc_123", "doc@clinic.com", -100);
        let result = manager.login(&expired_token, "clinic_001", "DOCTOR");
        assert_eq!(result, Err(AuthError::SessionExpired));
    }

    #[test]
    fn test_cross_clinic_access_forbidden() {
        let secret = b"my_super_secret_test_key_for_cliniqo_desktop";
        let manager = SessionManager::new(secret);

        let token = generate_test_jwt(secret, "doc_123", "doc@clinic.com", 3600);
        manager.login(&token, "clinic_A", "DOCTOR").unwrap();

        // Attempt to access clinic_B
        let result = manager.validate_session(Some("clinic_B"));
        assert_eq!(
            result,
            Err(AuthError::CrossClinicForbidden {
                attempted_clinic: "clinic_B".to_string(),
                session_clinic: "clinic_A".to_string(),
            })
        );
    }
}
