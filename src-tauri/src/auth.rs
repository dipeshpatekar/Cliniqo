use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Dedicated immutable Root Trust Anchor RSA 2048-bit SPKI Public Key for Cliniqo desktop client.
/// This root public key is used EXCLUSIVELY to verify signed key-rotation certificates.
/// Its private signing counterpart is stored in offline cold storage/HSM and is NEVER
/// present in the backend application, Git repository, or desktop application binary.
pub const ROOT_TRUST_ANCHOR_PUBLIC_KEY_PEM: &str = r#"-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1SW3UvWWbkC78snaJIPH
f/Rlb+lOq8UIYpGazCg7i3St71g+WLLXhjExT//MgUaoTuEevc6ghomM2S4to6UR
OaRjnKnX+PZY3xr+N34MdqAXGrEcCH+bTpzp1QKY6mG9oDeMS3xmtg16yvbWiMdq
9WROFyemrlzgOybdpDlgNXUtwQJSibl0XK59Z1Q/dv/3Q+9hUE9rvbEN8hawAb3v
QaRjcGnJsVO39S1/czXL3OOXCg5SuupWkJrvIKeRkBS8oKBlj1FsRz8pyIF0AJXE
rsUP0IbNhum1SmkagfVh1FrgfqaziuZa6kq9hM+aKOmG+AOcXJN3dms9LTPMul5h
2QIDAQAB
-----END PUBLIC KEY-----"#;

/// Active production RSA 2048-bit SPKI Public Key for verifying access tokens issued by the backend on Render.
pub const PRODUCTION_BACKEND_PUBLIC_KEY_PEM: &str = r#"-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApVcqcizNZXUOhfP4beGp
BUzkAxbvgl6OOqQM4epZom2DlLZRf7rN8fIXKrWw3ILlwMaQ1WHJDRppIgSiKAY2
Ey8gW8ROxfTSRQFvGkZE0n9GV4+oObtKsFiEfk5LJGjCJPhPVvPSWh6SsO0T3Yr+
x3+5Ekyv8t7FVQdRGbDIbbUtbyLJJXQcvIg8A8/ODK0XfzGra09vx7f3or4r30fS
WACi/0DeP5mfuFh8DGGJYZG+aGzll4yhdrxY0BjFnYcTIF1QhESiaBDaiR9scnZJ
AKvFFzZzHBWkfJE8Ifiz2XF3VH34qtthiNetWVKiFCelaD9E2nAmm0ye+wIyFxkV
kwIDAQAB
-----END PUBLIC KEY-----"#;

/// Default RSA 2048-bit SPKI Public Key for local test fixtures and development.
pub const DEFAULT_DEV_BACKEND_PUBLIC_KEY_PEM: &str = r#"-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6H0/RnxIqA3027qq8Nxm
spcypXGFIAvnZsRQm6NM+aIldAdTN+Tc96HHCmk/Pq5PiB4zu1HBdtmtpZLP0cHy
oWwxT2OY2+9L6nR5xhQ3vF0B2lJbvi/y06g8+UV4IJ3QMXUn3KkWqqCSPLVjbCcd
t5fmmY8T7bJMNStJpYRWPLsU+PDkAlawH2moiL3Abg8o9TEAxU4u4f7WJwwEZOTj
0ZwlJk8omvcALnSH0ZZD3j2cMcRia7kb7Jj8niKkKwljYH7iWOkae1Lg7fA5Zi1a
XfXFNUdG/M39n8RiFlRT46iNzW0HbfoEavjK+eQmuTCtJId6DAfMlZGMiISZnF+S
qwIDAQAB
-----END PUBLIC KEY-----"#;

#[cfg(not(debug_assertions))]
pub const DEFAULT_BACKEND_PUBLIC_KEY_PEM: &str = PRODUCTION_BACKEND_PUBLIC_KEY_PEM;

#[cfg(debug_assertions)]
pub const DEFAULT_BACKEND_PUBLIC_KEY_PEM: &str = DEFAULT_DEV_BACKEND_PUBLIC_KEY_PEM;

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

    #[error("Unsupported token algorithm: expected RS256, got '{0}'.")]
    UnsupportedAlgorithm(String),

    #[error("Public key error: {0}")]
    PublicKeyError(String),

    #[error("Dynamic public key rotation is currently disabled: backend rotation certificate infrastructure is not yet active. Pinned trust anchor v1 is enforced fail-closed.")]
    DynamicRotationDisabled,

    #[error("Untrusted public key: {0}")]
    UntrustedPublicKey(String),

    #[error("Key rotation rollback rejected: key version {attempted_version} must be strictly greater than active version {current_version}.")]
    KeyRollbackRejected {
        attempted_version: u32,
        current_version: u32,
    },

    #[error("Insufficient RSA key strength: {0}")]
    InsufficientKeyStrength(String),
}

/// Validates that an RSA public key PEM has at least `min_bits` modulus strength (e.g. 2048 bits).
pub fn validate_rsa_key_strength(pem: &str, min_bits: usize) -> Result<(), AuthError> {
    use base64::prelude::*;

    let clean = pem
        .replace("-----BEGIN PUBLIC KEY-----", "")
        .replace("-----END PUBLIC KEY-----", "")
        .replace("\r", "")
        .replace("\n", "")
        .replace(' ', "");

    let der_bytes = BASE64_STANDARD
        .decode(&clean)
        .map_err(|e| AuthError::PublicKeyError(format!("Invalid Base64 in public key PEM: {e}")))?;

    // Minimum SPKI DER length for RSA 2048 is ~294 bytes (modulus is 256 bytes).
    // RSA 1024 SPKI is only 162 bytes.
    let min_der_bytes = (min_bits / 8) + 30; // 256 + 30 = 286
    if der_bytes.len() < min_der_bytes {
        return Err(AuthError::InsufficientKeyStrength(format!(
            "SPKI DER length {} is insufficient for {min_bits}-bit RSA",
            der_bytes.len()
        )));
    }

    // Locate BIT STRING (tag 0x03) in SPKI structure
    let mut bit_string_idx = None;
    for i in 0..der_bytes.len().saturating_sub(10) {
        if der_bytes[i] == 0x03 {
            bit_string_idx = Some(i);
            break;
        }
    }

    let bs_idx = bit_string_idx.ok_or_else(|| {
        AuthError::PublicKeyError("Malformed SPKI DER: missing BIT STRING payload".to_string())
    })?;

    // Inside BIT STRING, locate the modulus INTEGER (tag 0x02)
    let mut modulus_len = 0;
    for i in bs_idx..der_bytes.len().saturating_sub(4) {
        if der_bytes[i] == 0x02 {
            let len_byte = der_bytes[i + 1];
            if len_byte == 0x82 {
                modulus_len = ((der_bytes[i + 2] as usize) << 8) | (der_bytes[i + 3] as usize);
            } else if len_byte == 0x81 {
                modulus_len = der_bytes[i + 2] as usize;
            } else if (len_byte & 0x80) == 0 {
                modulus_len = len_byte as usize;
            }
            break;
        }
    }

    let min_modulus_bytes = min_bits / 8; // 256 bytes for 2048-bit
    if modulus_len < min_modulus_bytes {
        return Err(AuthError::InsufficientKeyStrength(format!(
            "RSA modulus length is {} bytes, required at least {min_modulus_bytes} bytes ({min_bits} bits)",
            modulus_len
        )));
    }

    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct KeyRotationCertificateClaims {
    pub iss: String,
    pub aud: String,
    pub sub: String,
    #[serde(rename = "keyVersion")]
    pub key_version: u32,
    #[serde(rename = "publicKeyPem")]
    pub public_key_pem: String,
    pub iat: i64,
    pub exp: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionContext {
    pub doctor_id: String,
    pub clinic_id: String,
    pub doctor_email: String,
    pub doctor_name: String,
    pub role: String,
    pub expires_at: i64,
    #[serde(default)]
    pub is_offline: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct JwtPayload {
    pub sub: String,
    pub email: String,
    #[serde(rename = "fullName")]
    pub full_name: Option<String>,
    pub phone: Option<String>,
    pub qualification: Option<String>,
    #[serde(rename = "registrationNumber")]
    pub registration_number: Option<String>,
    #[serde(rename = "type")]
    pub token_type: Option<String>,
    pub iss: Option<String>,
    pub aud: Option<String>,
    pub exp: Option<i64>,
    pub iat: Option<i64>,
}

pub struct SessionManager {
    decoding_key: RwLock<DecodingKey>,
    public_key_pem: RwLock<String>,
    key_version: RwLock<u32>,
    current_session: RwLock<Option<SessionContext>>,
    current_access_token: RwLock<Option<String>>,
}

impl SessionManager {
    /// Flag declaring whether dynamic key rotation from the backend is enabled.
    /// Currently false (disabled) because backend signed rotation certificate infrastructure is not yet active.
    pub const DYNAMIC_KEY_ROTATION_ENABLED: bool = false;

    /// Initializes SessionManager with a verified RSA SPKI public key PEM and default version 1
    pub fn new(public_key_pem: &str) -> Result<Self, AuthError> {
        Self::new_with_version(public_key_pem, 1)
    }

    /// Initializes SessionManager with an explicit key version and validates minimum 2048-bit key strength
    pub fn new_with_version(public_key_pem: &str, key_version: u32) -> Result<Self, AuthError> {
        validate_rsa_key_strength(public_key_pem, 2048)?;
        let decoding_key = DecodingKey::from_rsa_pem(public_key_pem.as_bytes())
            .map_err(|e| AuthError::PublicKeyError(format!("Invalid RSA public key PEM: {e}")))?;

        Ok(Self {
            decoding_key: RwLock::new(decoding_key),
            public_key_pem: RwLock::new(public_key_pem.to_string()),
            key_version: RwLock::new(key_version),
            current_session: RwLock::new(None),
            current_access_token: RwLock::new(None),
        })
    }

    /// Initializes with default pinned backend public key, allowing environment override strictly in debug/test
    pub fn with_default_public_key() -> Result<Self, AuthError> {
        #[cfg(debug_assertions)]
        {
            if let Ok(pem) = std::env::var("CLINIQO_BACKEND_PUBLIC_KEY") {
                if !pem.trim().is_empty() {
                    return Self::new(&pem);
                }
            }
        }
        Self::new(DEFAULT_BACKEND_PUBLIC_KEY_PEM)
    }

    fn read_lock<'a, T>(lock: &'a RwLock<T>, name: &str) -> std::sync::RwLockReadGuard<'a, T> {
        lock.read().unwrap_or_else(|e| {
            log::error!("SessionManager {name} RwLock read-poisoned; recovering.");
            e.into_inner()
        })
    }

    fn write_lock<'a, T>(lock: &'a RwLock<T>, name: &str) -> std::sync::RwLockWriteGuard<'a, T> {
        lock.write().unwrap_or_else(|e| {
            log::error!("SessionManager {name} RwLock write-poisoned; recovering.");
            e.into_inner()
        })
    }

    /// Returns the currently active public key PEM
    pub fn get_public_key_pem(&self) -> String {
        Self::read_lock(&self.public_key_pem, "public_key_pem").clone()
    }

    /// Returns the active public key version
    pub fn get_key_version(&self) -> u32 {
        *Self::read_lock(&self.key_version, "key_version")
    }

    /// Securely updates the active RSA decoding key from a verified RSA-2048 SPKI PEM
    pub fn update_public_key(&self, pem: &str) -> Result<(), AuthError> {
        let trimmed = pem.trim();
        validate_rsa_key_strength(trimmed, 2048)?;
        let new_key = DecodingKey::from_rsa_pem(trimmed.as_bytes())
            .map_err(|e| AuthError::PublicKeyError(format!("Invalid RSA public key PEM: {e}")))?;

        let mut key_lock = Self::write_lock(&self.decoding_key, "decoding_key");
        let mut pem_lock = Self::write_lock(&self.public_key_pem, "public_key_pem");
        *key_lock = new_key;
        *pem_lock = trimmed.to_string();

        log::info!("SessionManager: RSA decoding key updated from verified SPKI PEM.");
        Ok(())
    }

    /// Returns the root trust anchor PEM used exclusively for rotation certificate verification.
    /// In production release builds, environment overrides are strictly compiled out to prevent tampering.
    pub fn get_root_trust_anchor_pem() -> String {
        #[cfg(debug_assertions)]
        {
            if let Ok(pem) = std::env::var("CLINIQO_TRUST_ANCHOR_PUBLIC_KEY") {
                if !pem.trim().is_empty() {
                    return pem;
                }
            }
        }
        ROOT_TRUST_ANCHOR_PUBLIC_KEY_PEM.to_string()
    }

    /// Fails closed: unauthenticated public key rotation with raw PEM is strictly forbidden.
    /// Public keys must be rotated through `rotate_public_key_with_certificate`.
    pub fn rotate_public_key(&self, _new_pem: &str) -> Result<(), AuthError> {
        Err(AuthError::UntrustedPublicKey(
            "Unauthenticated public key rotation rejected: keys must be accompanied by a signed trust-anchor rotation certificate.".to_string(),
        ))
    }

    /// Securely rotates the backend RSA public key using a root trust-anchor signed rotation certificate.
    /// Validates issuer, audience, expiry, key rollback protection, and minimum 2048-bit RSA modulus.
    pub fn rotate_public_key_with_certificate(
        &self,
        cert_jwt: &str,
        force_enable_for_testing: bool,
    ) -> Result<u32, AuthError> {
        if !Self::DYNAMIC_KEY_ROTATION_ENABLED && !force_enable_for_testing {
            return Err(AuthError::DynamicRotationDisabled);
        }

        let trimmed = cert_jwt.trim();
        if trimmed.is_empty() {
            return Err(AuthError::InvalidToken("Rotation certificate is empty".to_string()));
        }

        let header = decode_header(trimmed)
            .map_err(|e| AuthError::InvalidToken(format!("Invalid certificate header: {e}")))?;
        if header.alg != Algorithm::RS256 {
            return Err(AuthError::UnsupportedAlgorithm(format!(
                "Expected RS256 for certificate, got {:?}",
                header.alg
            )));
        }

        // Verify certificate signature using immutable root trust anchor
        let anchor_pem = Self::get_root_trust_anchor_pem();
        let trust_anchor_key = DecodingKey::from_rsa_pem(anchor_pem.as_bytes())
            .map_err(|e| AuthError::PublicKeyError(format!("Invalid trust anchor key: {e}")))?;

        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&["cliniqo-trust-anchor"]);
        validation.set_audience(&["cliniqo-desktop"]);
        validation.validate_exp = true;
        validation.leeway = 0;

        let token_data = decode::<KeyRotationCertificateClaims>(trimmed, &trust_anchor_key, &validation)
            .map_err(|err| match err.kind() {
                jsonwebtoken::errors::ErrorKind::ExpiredSignature => AuthError::SessionExpired,
                jsonwebtoken::errors::ErrorKind::InvalidSignature => AuthError::SignatureVerificationFailed,
                _ => AuthError::InvalidToken(format!("Invalid rotation certificate: {err}")),
            })?;

        let claims = token_data.claims;

        if claims.sub != "backend-public-key" {
            return Err(AuthError::InvalidToken(format!(
                "Invalid certificate subject: expected 'backend-public-key', got '{}'",
                claims.sub
            )));
        }

        // Rollback / replay protection: new version must be strictly greater than active version
        let current_ver = self.get_key_version();
        if claims.key_version <= current_ver {
            return Err(AuthError::KeyRollbackRejected {
                attempted_version: claims.key_version,
                current_version: current_ver,
            });
        }

        // RSA key strength check: minimum 2048-bit modulus required
        validate_rsa_key_strength(&claims.public_key_pem, 2048)?;

        let new_key = DecodingKey::from_rsa_pem(claims.public_key_pem.as_bytes())
            .map_err(|e| AuthError::PublicKeyError(format!("Invalid RSA public key PEM in certificate: {e}")))?;

        let mut key_lock = Self::write_lock(&self.decoding_key, "decoding_key");
        let mut pem_lock = Self::write_lock(&self.public_key_pem, "public_key_pem");
        let mut ver_lock = Self::write_lock(&self.key_version, "key_version");

        *key_lock = new_key;
        *pem_lock = claims.public_key_pem;
        *ver_lock = claims.key_version;

        log::info!(
            "SessionManager: RSA public key rotated successfully to version {}.",
            claims.key_version
        );
        Ok(claims.key_version)
    }

    /// Verifies JWT cryptographic signature using RS256 only, rejecting algorithm substitution,
    /// expired tokens, invalid signatures, and unapproved issuer/audience claims.
    pub fn verify_jwt(&self, token: &str) -> Result<JwtPayload, AuthError> {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            return Err(AuthError::InvalidToken("Token is empty".to_string()));
        }

        // 1. Inspect header algorithm - strictly enforce RS256
        let header = match decode_header(trimmed) {
            Ok(h) => h,
            Err(e) => {
                let msg = e.to_string();
                if msg.to_lowercase().contains("algorithm") || msg.contains("variant") {
                    return Err(AuthError::UnsupportedAlgorithm(msg));
                }
                return Err(AuthError::InvalidToken(format!("Invalid JWT header: {e}")));
            }
        };

        if header.alg != Algorithm::RS256 {
            return Err(AuthError::UnsupportedAlgorithm(format!(
                "Expected RS256, got {:?}",
                header.alg
            )));
        }

        // 2. Cryptographic signature and standard claims validation
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&["cliniqo-backend", "cliniqo-auth"]);
        validation.set_audience(&["cliniqo-client"]);
        validation.validate_exp = true;
        validation.leeway = 0; // strict expiration

        let decoding_key = Self::read_lock(&self.decoding_key, "decoding_key");
        let token_data = decode::<JwtPayload>(trimmed, &decoding_key, &validation).map_err(|err| {
            match err.kind() {
                jsonwebtoken::errors::ErrorKind::ExpiredSignature => AuthError::SessionExpired,
                jsonwebtoken::errors::ErrorKind::InvalidSignature => {
                    AuthError::SignatureVerificationFailed
                }
                jsonwebtoken::errors::ErrorKind::InvalidAlgorithm => {
                    AuthError::UnsupportedAlgorithm("Invalid algorithm".to_string())
                }
                jsonwebtoken::errors::ErrorKind::InvalidIssuer => {
                    AuthError::InvalidToken(
                        "Untrusted issuer: must be 'cliniqo-backend' or 'cliniqo-auth'".to_string(),
                    )
                }
                jsonwebtoken::errors::ErrorKind::InvalidAudience => {
                    AuthError::InvalidToken(
                        "Untrusted audience: must be 'cliniqo-client'".to_string(),
                    )
                }
                _ => AuthError::InvalidToken(err.to_string()),
            }
        })?;

        let payload = token_data.claims;

        // 3. Validate required claims
        if payload.sub.trim().is_empty() {
            return Err(AuthError::InvalidToken(
                "Token subject ('sub') must not be empty".to_string(),
            ));
        }

        if payload.email.trim().is_empty() {
            return Err(AuthError::InvalidToken(
                "Token email must not be empty".to_string(),
            ));
        }

        match payload.token_type.as_deref() {
            Some("access") => (),
            Some(other) => {
                return Err(AuthError::InvalidToken(format!(
                    "Invalid token type: expected 'access', got '{other}'"
                )))
            }
            None => {
                return Err(AuthError::InvalidToken(
                    "Missing required token type claim: expected 'type: access'".to_string(),
                ))
            }
        }

        Ok(payload)
    }

    /// Establishes an authenticated session after cryptographically verifying RS256 token and claims.
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
            is_offline: false,
        };

        let mut lock = Self::write_lock(&self.current_session, "current_session");
        *lock = Some(context.clone());

        let mut token_lock = Self::write_lock(&self.current_access_token, "current_access_token");
        *token_lock = Some(token.to_string());

        log::info!(
            "Desktop session established for doctor '{}' in clinic '{}' with role '{}'",
            context.doctor_id,
            context.clinic_id,
            context.role
        );

        Ok(context)
    }

    /// Establishes a permitted offline session context when backend is unreachable but valid persisted credentials exist
    pub fn set_offline_session(&self, mut context: SessionContext) {
        context.is_offline = true;
        let mut lock = Self::write_lock(&self.current_session, "current_session");
        *lock = Some(context.clone());
        log::info!(
            "Permitted offline desktop session established for doctor '{}' in clinic '{}'",
            context.doctor_id,
            context.clinic_id
        );
    }

    /// Dynamically updates the doctor name in the active session context
    pub fn update_doctor_name(&self, new_name: &str) {
        let mut lock = Self::write_lock(&self.current_session, "current_session");
        if let Some(ref mut session) = *lock {
            session.doctor_name = new_name.trim().to_string();
        }
    }

    #[cfg(test)]
    pub fn set_test_session(&self, clinic_id: &str, doctor_id: &str, token: &str) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let context = SessionContext {
            doctor_id: doctor_id.to_string(),
            clinic_id: clinic_id.to_string(),
            doctor_email: "test@cliniqo.app".to_string(),
            doctor_name: "Test Doctor".to_string(),
            role: "DOCTOR".to_string(),
            expires_at: now + 3600,
            is_offline: false,
        };
        *Self::write_lock(&self.current_session, "current_session") = Some(context);
        *Self::write_lock(&self.current_access_token, "current_access_token") = Some(token.to_string());
    }

    /// Invalidates the active desktop session and securely zeroes the access token upon logout
    pub fn logout(&self) {
        let mut lock = Self::write_lock(&self.current_session, "current_session");
        *lock = None;
        let mut token_lock = Self::write_lock(&self.current_access_token, "current_access_token");
        if let Some(mut tok) = token_lock.take() {
            use zeroize::Zeroize;
            tok.zeroize();
        }
        log::info!("Desktop session invalidated.");
    }

    /// Returns the current access token for internal native Rust HTTP requests (never exposed over IPC)
    pub fn get_access_token(&self) -> Option<String> {
        let lock = Self::read_lock(&self.current_access_token, "current_access_token");
        lock.clone()
    }

    /// Returns the current session context if valid and unexpired or permitted offline
    pub fn get_session(&self) -> Option<SessionContext> {
        let lock = Self::read_lock(&self.current_session, "current_session");
        if let Some(ref session) = *lock {
            if session.is_offline {
                return Some(session.clone());
            }
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

    /// Validates that an active session exists and matches the expected clinic tenancy.
    /// Does not auto-logout on expired access token so that transparent refresh can proceed.
    pub fn validate_session(
        &self,
        required_clinic_id: Option<&str>,
    ) -> Result<SessionContext, AuthError> {
        let lock = Self::read_lock(&self.current_session, "current_session");
        match *lock {
            None => Err(AuthError::Unauthenticated),
            Some(ref session) => {
                let now_sec = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;

                if !session.is_offline && session.expires_at <= now_sec {
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
    use jsonwebtoken::{encode, EncodingKey, Header};

    pub const TEST_BACKEND_PRIVATE_KEY_PEM: &str = r#"-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDofT9GfEioDfTb
uqrw3GaylzKlcYUgC+dmxFCbo0z5oiV0B1M35Nz3occKaT8+rk+IHjO7UcF22a2l
ks/RwfKhbDFPY5jb70vqdHnGFDe8XQHaUlu+L/LTqDz5RXggndAxdSfcqRaqoJI8
tWNsJx23l+aZjxPtskw1K0mlhFY8uxT48OQCVrAfaaiIvcBuDyj1MQDFTi7h/tYn
DARk5OPRnCUmTyia9wAudIfRlkPePZwxxGJruRvsmPyeIqQrCWNgfuJY6Rp7UuDt
8DlmLVpd9cU1R0b8zf2fxGIWVFPjqI3NbQdt+gRq+Mr55Ca5MK0kh3oMB8yVkYyI
hJmcX5KrAgMBAAECggEAJAwjbvjfRRtg317qmUz7KW6zHh7jXswptW/z9aXUzhH7
j6mBGDYGoui1FWKrOTtKvpa8O6uZ/SUUPQtt6J6TUb8WSDJvpY5NbY1gwjspRy3+
lwzVB8CkfHfl+FpynVAK01hQdXDMQGmEMyCGyWKpQ2msihu6oczW7xmGokDKJEEr
8WiMDqu7gH8ONTPvXvaXp8gdXKJGihmdvMMFIFl0946ajp9Eh/+6UPKZyyRtO/e8
L0Sv9LYQE0qUMKs0rm8axrWjLCWc8WhB9fRwdCMiyQjL5AdKzTwkiI7DhN9t00dm
gb2c3vwk89vtCwY6RZxZp0DEIbokiO7SBU47zoeX5QKBgQD9x6MHIwgPKQ9SiOxx
7rxd4VK9dxwFJyGH9teroDM0iiOqUUJqtFULXjFXvUDkrDq1xKQPfLnEPihR4tQB
to6NUaLRkriul8HhNHgQDc6wLbnv+P2adIoZ0g06jJvuMuyvzJFJ2MJTo+D148WE
kLKKKk4ctWf7UVqCmpb72YcynwKBgQDqhe2Zxwnyq6Qli+AOK1SXcoy/Niu8AR/L
UCSUI6UXvf1rzIBJRnK8hxQYhInDmvEFkJ0wJPkmftitXubBJjkGwtQ1T0U3Uqz3
dK6bLa2CNxjHUhm15A7J3/KiLLiedTWbFjtSCyVtVep/8o2APVy2FxJ+l+45dp4U
ccHnQWSQdQKBgQCw8QasLTKrT1eNlkY1Ud0oH7hOvcNdnGD2qZbJ5RKOqVogoDOM
rls1Z+FDaYLbbXIp1gcFfVMQjr4SCfMDlsNhqO+662+0276kRK8Jknbvw5IGzTYV
APhg9GGg1vTJadw43orWUDl9k5+AEeVffnvddY2s2pa7VYej1CE9S/fFxQKBgQCB
IS77TgmfMXzXI5ZBlwAjx3HR0szv3pqYAs+xNZMwaG8CDP7R2dVREvswqMGGD2kI
TGEQYjtBQ/SgOTHLRfV+UIYxuCz/Uilksz10ugjgOuAM15rKeQDfjMx3GTKqJRVY
CDyvZu27ruPIgVACPUcwB7IqPBNyVmqiDSTb5TivBQKBgESTUQU1Y/rBMZ3HQ0tm
a/lFK4oTPtwl+XtXqQ46K9nzgssWzQEE1ehvZxK1bNIXxZK5h6QJ7EtTs+v7hN/c
vrZRAcVpuBARD2+eDI5oHc5BQ0CYOGKdda5KNz+VIU1mPYS6BA0cvZmTa/nHkV2w
gGFyMNydps1kewu3VAWSkgUH
-----END PRIVATE KEY-----"#;

    pub fn generate_test_rs256_jwt(
        private_key_pem: &str,
        sub: &str,
        email: &str,
        expires_in_secs: i64,
        iss: Option<&str>,
        aud: Option<&str>,
        token_type: Option<&str>,
    ) -> String {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        let payload = JwtPayload {
            sub: sub.to_string(),
            email: email.to_string(),
            full_name: Some("Dr. Test".to_string()),
            phone: None,
            qualification: None,
            registration_number: None,
            token_type: Some(token_type.unwrap_or("access").to_string()),
            iss: Some(iss.unwrap_or("cliniqo-backend").to_string()),
            aud: Some(aud.unwrap_or("cliniqo-client").to_string()),
            exp: Some(now + expires_in_secs),
            iat: Some(now),
        };

        let key = EncodingKey::from_rsa_pem(private_key_pem.as_bytes()).unwrap();
        encode(&Header::new(Algorithm::RS256), &payload, &key).unwrap()
    }

    pub fn generate_test_rs256_jwt_with_name(
        private_key_pem: &str,
        sub: &str,
        email: &str,
        full_name: Option<&str>,
        expires_in_secs: i64,
    ) -> String {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        let payload = JwtPayload {
            sub: sub.to_string(),
            email: email.to_string(),
            full_name: full_name.map(|s| s.to_string()),
            phone: None,
            qualification: None,
            registration_number: None,
            token_type: Some("access".to_string()),
            iss: Some("cliniqo-backend".to_string()),
            aud: Some("cliniqo-client".to_string()),
            exp: Some(now + expires_in_secs),
            iat: Some(now),
        };

        let key = EncodingKey::from_rsa_pem(private_key_pem.as_bytes()).unwrap();
        encode(&Header::new(Algorithm::RS256), &payload, &key).unwrap()
    }

    #[test]
    fn test_valid_rs256_jwt_and_session_lifecycle() {
        let manager = SessionManager::with_default_public_key().expect("init succeeds");

        let token = generate_test_rs256_jwt(
            TEST_BACKEND_PRIVATE_KEY_PEM,
            "doc_123",
            "dr.patel@clinic.com",
            3600,
            None,
            None,
            None,
        );

        let session = manager
            .login(&token, "clinic_001", "DOCTOR")
            .expect("login succeeds");

        assert_eq!(session.doctor_id, "doc_123");
        assert_eq!(session.clinic_id, "clinic_001");
        assert_eq!(session.role, "DOCTOR");

        // Validate session
        let validated = manager
            .validate_session(Some("clinic_001"))
            .expect("validation succeeds");
        assert_eq!(validated.doctor_id, "doc_123");

        // Logout
        manager.logout();
        assert_eq!(
            manager.validate_session(None),
            Err(AuthError::Unauthenticated)
        );
    }

    #[test]
    fn test_tampered_signature_rejected() {
        let manager = SessionManager::with_default_public_key().unwrap();
        let token = generate_test_rs256_jwt(
            TEST_BACKEND_PRIVATE_KEY_PEM,
            "doc_123",
            "dr.patel@clinic.com",
            3600,
            None,
            None,
            None,
        );

        // Tamper signature segment
        let mut parts: Vec<&str> = token.split('.').collect();
        let tampered_sig = "invalid_tampered_signature_bytes";
        parts[2] = tampered_sig;
        let tampered_token = parts.join(".");

        let result = manager.verify_jwt(&tampered_token);
        assert_eq!(result, Err(AuthError::SignatureVerificationFailed));
    }

    #[test]
    fn test_tampered_payload_rejected() {
        use base64::prelude::*;
        let manager = SessionManager::with_default_public_key().unwrap();
        let token = generate_test_rs256_jwt(
            TEST_BACKEND_PRIVATE_KEY_PEM,
            "doc_123",
            "dr.patel@clinic.com",
            3600,
            None,
            None,
            None,
        );

        let parts: Vec<&str> = token.split('.').collect();
        let tampered_payload = r#"{"sub":"doc_ATTACKER","email":"evil@clinic.com","type":"access","iss":"cliniqo-backend","aud":"cliniqo-client","exp":9999999999}"#;
        let tampered_payload_b64 = BASE64_URL_SAFE_NO_PAD.encode(tampered_payload.as_bytes());

        let tampered_token = format!("{}.{}.{}", parts[0], tampered_payload_b64, parts[2]);
        let result = manager.verify_jwt(&tampered_token);
        assert_eq!(result, Err(AuthError::SignatureVerificationFailed));
    }

    #[test]
    fn test_hs256_algorithm_confusion_rejected() {
        use base64::prelude::*;
        use hmac::{Hmac, Mac};
        use sha2::Sha256;

        let manager = SessionManager::with_default_public_key().unwrap();

        // Craft HS256 token attempting to use public key as HMAC secret
        let header_b64 = BASE64_URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#.as_bytes());
        let payload_b64 = BASE64_URL_SAFE_NO_PAD.encode(
            r#"{"sub":"doc_hacker","email":"hack@clinic.com","type":"access","iss":"cliniqo-backend","aud":"cliniqo-client","exp":9999999999}"#.as_bytes(),
        );

        let signing_input = format!("{header_b64}.{payload_b64}");
        let mut mac = Hmac::<Sha256>::new_from_slice(DEFAULT_BACKEND_PUBLIC_KEY_PEM.as_bytes()).unwrap();
        mac.update(signing_input.as_bytes());
        let sig = mac.finalize().into_bytes();
        let sig_b64 = BASE64_URL_SAFE_NO_PAD.encode(&sig);

        let malicious_hs256_token = format!("{signing_input}.{sig_b64}");

        let result = manager.verify_jwt(&malicious_hs256_token);
        assert!(matches!(result, Err(AuthError::UnsupportedAlgorithm(_))));
    }

    #[test]
    fn test_none_algorithm_rejected() {
        use base64::prelude::*;
        let manager = SessionManager::with_default_public_key().unwrap();

        let header_b64 = BASE64_URL_SAFE_NO_PAD.encode(r#"{"alg":"none","typ":"JWT"}"#.as_bytes());
        let payload_b64 = BASE64_URL_SAFE_NO_PAD.encode(
            r#"{"sub":"doc_none","email":"none@clinic.com","type":"access","iss":"cliniqo-backend","aud":"cliniqo-client","exp":9999999999}"#.as_bytes(),
        );
        let none_token = format!("{header_b64}.{payload_b64}.");

        let result = manager.verify_jwt(&none_token);
        assert!(matches!(result, Err(AuthError::UnsupportedAlgorithm(_))));
    }

    #[test]
    fn test_expired_token_rejected() {
        let manager = SessionManager::with_default_public_key().unwrap();
        let expired_token = generate_test_rs256_jwt(
            TEST_BACKEND_PRIVATE_KEY_PEM,
            "doc_123",
            "doc@clinic.com",
            -100, // Expired 100 seconds ago
            None,
            None,
            None,
        );

        let result = manager.login(&expired_token, "clinic_001", "DOCTOR");
        assert_eq!(result, Err(AuthError::SessionExpired));
    }

    #[test]
    fn test_wrong_issuer_rejected() {
        let manager = SessionManager::with_default_public_key().unwrap();
        let token = generate_test_rs256_jwt(
            TEST_BACKEND_PRIVATE_KEY_PEM,
            "doc_123",
            "doc@clinic.com",
            3600,
            Some("untrusted-issuer-idp"),
            None,
            None,
        );

        let result = manager.verify_jwt(&token);
        assert!(matches!(result, Err(AuthError::InvalidToken(_))));
    }

    #[test]
    fn test_wrong_audience_rejected() {
        let manager = SessionManager::with_default_public_key().unwrap();
        let token = generate_test_rs256_jwt(
            TEST_BACKEND_PRIVATE_KEY_PEM,
            "doc_123",
            "doc@clinic.com",
            3600,
            None,
            Some("wrong-audience-app"),
            None,
        );

        let result = manager.verify_jwt(&token);
        assert!(matches!(result, Err(AuthError::InvalidToken(_))));
    }

    #[test]
    fn test_invalid_token_type_rejected() {
        let manager = SessionManager::with_default_public_key().unwrap();
        let token = generate_test_rs256_jwt(
            TEST_BACKEND_PRIVATE_KEY_PEM,
            "doc_123",
            "doc@clinic.com",
            3600,
            None,
            None,
            Some("refresh"), // Refresh token cannot be used as access token
        );

        let result = manager.verify_jwt(&token);
        assert!(matches!(result, Err(AuthError::InvalidToken(_))));
    }

    #[test]
    fn test_empty_sub_or_email_rejected() {
        let manager = SessionManager::with_default_public_key().unwrap();
        let token = generate_test_rs256_jwt(
            TEST_BACKEND_PRIVATE_KEY_PEM,
            "",
            "doc@clinic.com",
            3600,
            None,
            None,
            None,
        );

        let result = manager.verify_jwt(&token);
        assert!(matches!(result, Err(AuthError::InvalidToken(_))));
    }

    #[test]
    fn test_cross_clinic_access_forbidden() {
        let manager = SessionManager::with_default_public_key().unwrap();
        let token = generate_test_rs256_jwt(
            TEST_BACKEND_PRIVATE_KEY_PEM,
            "doc_123",
            "doc@clinic.com",
            3600,
            None,
            None,
            None,
        );
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

    pub const TEST_ROTATION_PUBLIC_KEY_PEM: &str = r#"-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuxLIo7tPml16+70SoyyA
NUnU0RrhW9AaPsk9DsBDaw+vcp3uM2ogEz7KcMElcPyiaAPS3qO8ecD1lU/oa1KT
DsXpmZUkMRqIlb6hC4CLe0FDhEt6E5t7zDcV+AhukU5DibUztAB4czsIR00P2n4t
GulyhCH5hmpNElUO+1GZ5yfVuf8dwHxe3nWQzOdRifR90lYVHxCQmjmQ0ZBIv2uS
hrIAaeH6XkzFvtppl9AkoToGZAXyFnvjL2tMpEK75XnBNC6YkI+nyQpWgbUAb1iN
+JT+GMe8NG27OWcPOm2T8kyMYC51TuzeiJhq6bBx/QhJgHV7SxW0lo66aFSHl6Xv
lwIDAQAB
-----END PUBLIC KEY-----"#;

    pub const TEST_ROTATION_PRIVATE_KEY_PEM: &str = r#"-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC7Esiju0+aXXr7
vRKjLIA1SdTRGuFb0Bo+yT0OwENrD69yne4zaiATPspwwSVw/KJoA9Leo7x5wPWV
T+hrUpMOxemZlSQxGoiVvqELgIt7QUOES3oTm3vMNxX4CG6RTkOJtTO0AHhzOwhH
TQ/afi0a6XKEIfmGak0SVQ77UZnnJ9W5/x3AfF7edZDM51GJ9H3SVhUfEJCaOZDR
kEi/a5KGsgBp4fpeTMW+2mmX0CShOgZkBfIWe+Mva0ykQrvlecE0LpiQj6fJClaB
tQBvWI34lP4Yx7w0bbs5Zw86bZPyTIxgLnVO7N6ImGrpsHH9CEmAdXtLFbSWjrpo
VIeXpe+XAgMBAAECggEAMikAtGpCl2TuV3akey0w+VjhH+pht9EOYHxsCzsBOME9
bXGsT4vqqs5g0KfxZqDO2S4BSiJEJK9ZCh6hdrlu5fyqPLyRNjtjmSdCnkdq3vMq
a9wjEQPVR3YTxWxZXUvLby6vfNnNcjRHbXrbv92qMXeb9ZL4iZKSNNKq0DdamXCO
DEZk58zEPjZAFrO7p4LofX4ItV7/oXJiNTCIdIbvKJnZb8mP7gfaVNX1QGwH0jD/
0kbf3cXYaThlyZ6q66IPAGB9XSA9uqgwrkCSOKusImEtkVKYXYLMbb0nn1SAQNKr
JhUC6MYDdapq1CxUCWz4jGvh6RsAjbIrqVqQTlH6JQKBgQD5tf+ifzfg5HvfKQHp
7VWXDS96lFJi6dzwJkgi1Gk+l67saEbRUz+F8/r+p6ofWK7+fvWc2hu1RNRgfCUS
ZJAh7Zg8siwzxkFeAcuhYQra2xqB7CnLRVOb9vsGkD0uaYh1VbIzzIDXZvhhgYnp
QsoIXv9VkceMLdgKC8ZcrmeMuwKBgQC/yO6WRNWRrie5n9HR4iWImkTWS33wnMoK
OrPR2AzX6fTssSN40xzrWFVLkTIwWAKGxcwsaAEiNbh68mORL1D5dDU1Cu/DBAve
zVpCxKXteYQSW6fFnwLI4krbVCeWw0fFxLzZ+8p6PVBXZX8vmHABWGgTsEY3Qimx
R2u9l8gI1QKBgD2RyWEomv+BdqV0d/tUwHjJEH7Z2WJ4JTi1R64Gz5hWUBQMNgHg
09XUbXuinYizFhq79RVildhhCzhrA70APKWQ7qtwhwORC4cBTFMTGVkTEvsb3sY2
5sGa6RQaNmueK746jgDFmLMDuZRZG0b/Z88elThlBF2k5BK+Cn/JpNCHAoGAa4I1
zOL1Xd7kwffHZQKCy9q+7+oNxU3/LFDP8LhOKtMpy21ZVyfxNDSmS+Au5E7Ry78h
v1rmF8lJixJJol+F4vCzyvJAiW/BP7qZ+IfIBCF0Wd4rZGrI4teH4v9/2dHKcCDj
RMcTMAci/HsXGxU25GosnazZD6z1Nj21NejZ56kCgYAv624OoLnXM4kpW9rSaVSc
gqqrjV9qtjktU4CDkmNY7GDPBOo5z9qL3+TepXIq/hxkgBFgRQGE8WWrkwZMGqp4
5iZMpyJ5cSXCI0lI2FDMltN7E0rqyjnYxB1WjLCCbj777J61PAvhxxxD+5NXhZwN
qn0U2BeQ/F4+tVTIVQvmdw==
-----END PRIVATE KEY-----"#;

    pub const TEST_ROOT_ANCHOR_PUBLIC_KEY_PEM: &str = r#"-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA8dECPo/uss/CzetHAy+Q
kKzfYBWY//WmezqpuzxokiKkIArFC1xgMR228GXrpL8ILhwMYihN0Nl7nV8Jig9U
U85RymdeAC//4B86dF1hJe3eQiJzunshfhGC46/O6hjccrzmFy6MXVhHXZ8C0xfb
YUhwJDS3kcsrB5q9SdOd3D/rvX6dWu4/fBwcUKiH1TU1cGrMLRLN6kvsV42GDvmM
MoVN+NaNp/ZkF3NsIYNDyx+o1mLHH1xyVETcjx66DF2cCYPNRLG+ahDNQSQBu+bu
luyqIfADPHrollIGbrOsl/+5zucXQPat3TYUpbrVlnFmlQAHWWN8Djf3bJeXtevI
PwIDAQAB
-----END PUBLIC KEY-----"#;

    pub const TEST_ROOT_ANCHOR_PRIVATE_KEY_PEM: &str = r#"-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDx0QI+j+6yz8LN
60cDL5CQrN9gFZj/9aZ7Oqm7PGiSIqQgCsULXGAxHbbwZeukvwguHAxiKE3Q2Xud
XwmKD1RTzlHKZ14AL//gHzp0XWEl7d5CInO6eyF+EYLjr87qGNxyvOYXLoxdWEdd
nwLTF9thSHAkNLeRyysHmr1J053cP+u9fp1a7j98HBxQqIfVNTVwaswtEs3qS+xX
jYYO+YwyhU341o2n9mQXc2whg0PLH6jWYscfXHJURNyPHroMXZwJg81Esb5qEM1B
JAG75u6W7Koh8AM8euiWUgZus6yX/7nO5xdA9q3dNhSlutWWcWaVAAdZY3wON/ds
l5e168g/AgMBAAECggEAETZ4e22RZycEzdWWi3KCTtoPWG6RIn8g55qoZEyLgQN4
PVOm7QUZT8W2tOv8VxDGC0ox03bc+yXP98bBDhPDQ+fmyIqNFWRVSWXPqmLPPHzv
GjQLmtWS779dWsmz59P3NS+fDT1h/m7/PXnJIK+NDSKz4M/j1TvqBzOLj8rBbOD4
gfxYJ9OaHKgL0QFxidG7D/NRbgR1kCwLZ3AKdeaU37EqKIs6bU9GWPa23B4djLum
oEU7yKGkTJDiadRi/n8CPA57xqBYQTU1Ape+vS38n/jdlhXDD3iEKmxVvvJqSAhk
qLmqNG+pMiZafDp923sJLn6kqwMzEQVijwzv8MT84QKBgQD48JE8WtlOdC1WFM98
p4kwOO/Kow34rtlXjms0xUdBgSG+DNH9YrHrURtHv3S6Wyt54AsC4XBAUgkhadRE
Bc3GfU6V4OtYvozjjpmZbOovDCC39f5DALqLCgefRfhF7TJ8HamkVArUb6Pz37fP
mOLjP61IF0xLg/cj4RR1Du6DzwKBgQD4rLkEzEqdRl+vSt6qhqrR0JDTeqjT4WqX
qu1sBBxFaOUGTpwwiTijIGTGARdH0CRKZ6vHptLYmmV+TZTUJUrse4py+tgS8L6Q
bIgHkKKKpKvsFULZyw7N4k9VJOG/UswbAPVKM44VzYUkaxUSuS+mUMcvxj21cH3D
OQFaNCLgkQKBgFhLk2fx3TO7dz0aAoH3NmyZNUwNS25SLhqlFBdShbSRJbOv/mc+
M1cAnIl1OeTDY4dF1QH/jf3yWvS0Aari2Bq35UC51x/R7kzkDkzh2ao4Rf6ZzMZd
Is0gEJYIjkfXGtn092+ms3Sn6GIejqaeVpM9yatRQClktCrQsZ3XXvf3AoGACO6b
TrLP00pd0XwM928S36pwKUh0m/eyznPTR1f2c//Kiil0rsGfCSz2sa4EWg3937ZN
k0RIuoMBNkIvIFeek1P0qyCbdkKzdZiQYkUtsXEsw7QXzJ7gj0CbvOEwQqEEt8uX
A+1KIzpYl/BIt31zWrP4E505RjUeL07y33yT7CECgYAlmJcprhK3xLsHSeWyZOH/
VXu7DbY+Ly8oLHmCEnPCMujKeNdlrFmCBH5AaBGVMJ3ycTf4ZY74AjHpXS2l4x7B
kkMhJnvbfgmEpI3qBm08cEXcFbfMoq8B/N1jzv/C9QDxq6QZgdJ5XpUNujn6b6gy
X/UV/m48xfWP1CbIRNQNnw==
-----END PRIVATE KEY-----"#;

    pub const TEST_RSA_1024_PUBKEY: &str = r#"-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDXntEUlIbC5cuCuCUf8VYCDfRS
T3hekm0XS7FminNIflwhv/xFRbGtN9RdFGWbOZx87J1yecSiqPhBx0+19bu/0M1A
2mz9Ghm2qvM7iW328QfG/OX3un6PskLRTv9iS2UV90361ihcofdRU7/p5Ved3biw
+Sr6YTuuo/MBlRd/GQIDAQAB
-----END PUBLIC KEY-----"#;

    pub fn generate_test_rotation_cert(
        signer_private_key: &str,
        key_version: u32,
        new_public_key_pem: &str,
        expires_in_secs: i64,
    ) -> String {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        let payload = KeyRotationCertificateClaims {
            iss: "cliniqo-trust-anchor".to_string(),
            aud: "cliniqo-desktop".to_string(),
            sub: "backend-public-key".to_string(),
            key_version,
            public_key_pem: new_public_key_pem.to_string(),
            iat: now,
            exp: now + expires_in_secs,
        };

        let key = EncodingKey::from_rsa_pem(signer_private_key.as_bytes()).unwrap();
        encode(&Header::new(Algorithm::RS256), &payload, &key).unwrap()
    }

    #[test]
    fn test_public_key_rotation_lifecycle() {
        unsafe {
            std::env::set_var("CLINIQO_TRUST_ANCHOR_PUBLIC_KEY", TEST_ROOT_ANCHOR_PUBLIC_KEY_PEM);
        }
        let manager = SessionManager::with_default_public_key().unwrap();

        // 1. Raw unauthenticated PEM rotation fails closed
        let invalid_pem = "-----BEGIN PUBLIC KEY-----\ngarbage_bytes\n-----END PUBLIC KEY-----";
        let rot_err = manager.rotate_public_key(invalid_pem);
        assert!(matches!(rot_err, Err(AuthError::UntrustedPublicKey(_))));

        // 2. Dynamic rotation is disabled by default fail-closed
        let cert = generate_test_rotation_cert(
            TEST_ROOT_ANCHOR_PRIVATE_KEY_PEM,
            2,
            TEST_ROTATION_PUBLIC_KEY_PEM,
            3600,
        );
        let dyn_err = manager.rotate_public_key_with_certificate(&cert, false);
        assert_eq!(dyn_err, Err(AuthError::DynamicRotationDisabled));

        // 3. When forced for testing, valid certificate signed by root anchor rotates public key to version 2
        let new_ver = manager
            .rotate_public_key_with_certificate(&cert, true)
            .expect("rotation succeeds with valid certificate");
        assert_eq!(new_ver, 2);
        assert_eq!(manager.get_key_version(), 2);
        assert_eq!(manager.get_public_key_pem(), TEST_ROTATION_PUBLIC_KEY_PEM);

        // 4. Verify token signed by the new key pair succeeds
        let token_v2 = generate_test_rs256_jwt(
            TEST_ROTATION_PRIVATE_KEY_PEM,
            "doc_123",
            "doc@clinic.com",
            3600,
            None,
            None,
            None,
        );
        assert!(manager.verify_jwt(&token_v2).is_ok());

        // 5. Tokens signed by the old key pair now fail verification
        let token_v1 = generate_test_rs256_jwt(
            TEST_BACKEND_PRIVATE_KEY_PEM,
            "doc_123",
            "doc@clinic.com",
            3600,
            None,
            None,
            None,
        );
        assert_eq!(
            manager.verify_jwt(&token_v1),
            Err(AuthError::SignatureVerificationFailed)
        );

        // 6. Rollback / replay rejection: certificate with version <= current (2 <= 2) is rejected
        let rollback_cert = generate_test_rotation_cert(
            TEST_ROOT_ANCHOR_PRIVATE_KEY_PEM,
            2,
            DEFAULT_BACKEND_PUBLIC_KEY_PEM,
            3600,
        );
        let rollback_err = manager.rotate_public_key_with_certificate(&rollback_cert, true);
        assert_eq!(
            rollback_err,
            Err(AuthError::KeyRollbackRejected {
                attempted_version: 2,
                current_version: 2
            })
        );

        // 7. Key strength check: certificate containing weak 1024-bit RSA key is rejected
        let weak_cert = generate_test_rotation_cert(
            TEST_ROOT_ANCHOR_PRIVATE_KEY_PEM,
            3,
            TEST_RSA_1024_PUBKEY,
            3600,
        );
        let weak_err = manager.rotate_public_key_with_certificate(&weak_cert, true);
        assert!(matches!(
            weak_err,
            Err(AuthError::InsufficientKeyStrength(_))
        ));
    }

    #[test]
    fn test_compromised_jwt_signing_key_cannot_sign_rotation_cert() {
        unsafe {
            std::env::set_var("CLINIQO_TRUST_ANCHOR_PUBLIC_KEY", TEST_ROOT_ANCHOR_PUBLIC_KEY_PEM);
        }
        let manager = SessionManager::with_default_public_key().unwrap();

        // Attacker attempts to use backend access-token private key to forge a rotation cert
        let forged_cert = generate_test_rotation_cert(
            TEST_BACKEND_PRIVATE_KEY_PEM,
            2,
            TEST_ROTATION_PUBLIC_KEY_PEM,
            3600,
        );

        let result = manager.rotate_public_key_with_certificate(&forged_cert, true);
        assert_eq!(result, Err(AuthError::SignatureVerificationFailed));
    }

    #[test]
    fn test_expired_rotation_certificate_rejected() {
        unsafe {
            std::env::set_var("CLINIQO_TRUST_ANCHOR_PUBLIC_KEY", TEST_ROOT_ANCHOR_PUBLIC_KEY_PEM);
        }
        let manager = SessionManager::with_default_public_key().unwrap();

        let expired_cert = generate_test_rotation_cert(
            TEST_ROOT_ANCHOR_PRIVATE_KEY_PEM,
            2,
            TEST_ROTATION_PUBLIC_KEY_PEM,
            -100, // Expired 100 seconds ago
        );

        let result = manager.rotate_public_key_with_certificate(&expired_cert, true);
        assert_eq!(result, Err(AuthError::SessionExpired));
    }

    #[test]
    fn test_missing_token_type_claim_rejected() {
        let manager = SessionManager::with_default_public_key().unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        let payload = JwtPayload {
            sub: "doc_123".to_string(),
            email: "doc@clinic.com".to_string(),
            full_name: Some("Dr. Test".to_string()),
            phone: None,
            qualification: None,
            registration_number: None,
            token_type: None, // Missing token_type claim
            iss: Some("cliniqo-backend".to_string()),
            aud: Some("cliniqo-client".to_string()),
            exp: Some(now + 3600),
            iat: Some(now),
        };

        let key = EncodingKey::from_rsa_pem(TEST_BACKEND_PRIVATE_KEY_PEM.as_bytes()).unwrap();
        let token = encode(&Header::new(Algorithm::RS256), &payload, &key).unwrap();

        let result = manager.verify_jwt(&token);
        assert!(matches!(result, Err(AuthError::InvalidToken(_))));
    }

    #[test]
    fn test_doctor_a_logout_then_doctor_b_login_isolates_session() {
        let manager = SessionManager::with_default_public_key().unwrap();

        // 1. Doctor A logs in
        let token_a = generate_test_rs256_jwt_with_name(
            TEST_BACKEND_PRIVATE_KEY_PEM,
            "doc_A",
            "doctorA@clinic.com",
            Some("Dr. Doctor A"),
            3600,
        );
        manager.login(&token_a, "clinic_A", "DOCTOR").unwrap();
        let session_a = manager.validate_session(Some("clinic_A")).unwrap();
        assert_eq!(session_a.doctor_id, "doc_A");
        assert_eq!(session_a.doctor_name, "Dr. Doctor A");
        assert_eq!(session_a.clinic_id, "clinic_A");

        // 2. Doctor A logs out
        manager.logout();
        assert_eq!(
            manager.validate_session(Some("clinic_A")),
            Err(AuthError::Unauthenticated)
        );
        assert_eq!(manager.get_session(), None);

        // 3. Doctor B logs in with their own clinic
        let token_b = generate_test_rs256_jwt_with_name(
            TEST_BACKEND_PRIVATE_KEY_PEM,
            "doc_B",
            "doctorB@clinic.com",
            Some("Dr. Doctor B"),
            3600,
        );
        manager.login(&token_b, "clinic_B", "DOCTOR").unwrap();
        let session_b = manager.validate_session(Some("clinic_B")).unwrap();
        assert_eq!(session_b.doctor_id, "doc_B");
        assert_eq!(session_b.doctor_name, "Dr. Doctor B");
        assert_eq!(session_b.clinic_id, "clinic_B");

        // 4. Doctor B cannot access clinic A (tenant isolation)
        let cross_res = manager.validate_session(Some("clinic_A"));
        assert_eq!(
            cross_res,
            Err(AuthError::CrossClinicForbidden {
                attempted_clinic: "clinic_A".to_string(),
                session_clinic: "clinic_B".to_string(),
            })
        );
    }

    #[test]
    fn test_missing_or_expired_session_blocks_validation() {
        let manager = SessionManager::with_default_public_key().unwrap();

        // 1. Unauthenticated state blocks finalization
        let unauth_err = manager.validate_session(Some("clinic_001"));
        assert_eq!(unauth_err, Err(AuthError::Unauthenticated));
        assert_eq!(
            unauth_err.unwrap_err().to_string(),
            "No active doctor session found. Please log in."
        );

        // 2. Expired session blocks finalization
        let expired_token = generate_test_rs256_jwt_with_name(
            TEST_BACKEND_PRIVATE_KEY_PEM,
            "doc_exp",
            "exp@clinic.com",
            Some("Dr. Expired"),
            -10, // Expired 10 seconds ago
        );
        // Login with expired token is rejected during JWT verification
        let login_err = manager.login(&expired_token, "clinic_001", "DOCTOR");
        assert_eq!(login_err, Err(AuthError::SessionExpired));
        assert_eq!(
            login_err.unwrap_err().to_string(),
            "Doctor session has expired. Please log in again."
        );
    }

    #[test]
    fn test_authenticated_doctor_can_validate_prescription_session() {
        let manager = SessionManager::with_default_public_key().unwrap();
        let token = generate_test_rs256_jwt_with_name(
            TEST_BACKEND_PRIVATE_KEY_PEM,
            "doc_real_456",
            "aarti@sharmaclinic.in",
            Some("Dr. Aarti Sharma"),
            3600,
        );

        manager.login(&token, "clinic_sharma_01", "OWNER").unwrap();
        let validated = manager.validate_session(Some("clinic_sharma_01")).unwrap();

        // Must bind prescription strictly to verified session identity
        assert_eq!(validated.doctor_id, "doc_real_456");
        assert_eq!(validated.doctor_name, "Dr. Aarti Sharma");
        assert_eq!(validated.clinic_id, "clinic_sharma_01");
        assert_eq!(validated.role, "OWNER");
    }

    #[test]
    fn test_production_backend_public_key_strength() {
        assert!(validate_rsa_key_strength(PRODUCTION_BACKEND_PUBLIC_KEY_PEM, 2048).is_ok());
        let decoding_key = DecodingKey::from_rsa_pem(PRODUCTION_BACKEND_PUBLIC_KEY_PEM.as_bytes());
        assert!(decoding_key.is_ok(), "Production backend public key must be valid SPKI PEM");
    }

    #[test]
    fn test_expired_session_does_not_clear_session_context() {
        let manager = SessionManager::with_default_public_key().unwrap();
        let token = generate_test_rs256_jwt_with_name(
            TEST_BACKEND_PRIVATE_KEY_PEM,
            "doc_test_123",
            "doc@clinic.com",
            Some("Dr. Test"),
            1, // Valid for 1 second
        );

        manager.login(&token, "clinic_001", "DOCTOR").unwrap();
        // Artificially expire the session timestamp in memory
        {
            let mut lock = manager.current_session.write().unwrap();
            if let Some(ref mut session) = *lock {
                session.expires_at = 100; // Far in past
            }
        }

        // validate_session fails with SessionExpired
        let err = manager.validate_session(Some("clinic_001"));
        assert_eq!(err, Err(AuthError::SessionExpired));

        // CRITICAL: SessionContext must NOT be wiped so background refresh can use it
        let session_after = manager.current_session.read().unwrap();
        assert!(session_after.is_some(), "SessionContext must be preserved for token refresh");
        assert_eq!(session_after.as_ref().unwrap().doctor_id, "doc_test_123");
    }

    #[test]
    fn test_offline_session_validates_regardless_of_timestamp() {
        let manager = SessionManager::with_default_public_key().unwrap();
        let offline_context = SessionContext {
            doctor_id: "doc_offline_1".to_string(),
            clinic_id: "clinic_local".to_string(),
            doctor_email: "offline@clinic.com".to_string(),
            doctor_name: "Dr. Offline".to_string(),
            role: "DOCTOR".to_string(),
            expires_at: 100, // Past timestamp
            is_offline: true,
        };

        manager.set_offline_session(offline_context);

        // Validation must succeed because is_offline = true
        let validated = manager.validate_session(Some("clinic_local")).expect("offline session validates");
        assert_eq!(validated.doctor_id, "doc_offline_1");
        assert!(validated.is_offline);

        let retrieved = manager.get_session().expect("offline session is returned");
        assert_eq!(retrieved.doctor_id, "doc_offline_1");
    }
}

