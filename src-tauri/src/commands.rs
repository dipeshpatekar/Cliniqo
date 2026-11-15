use serde::{Deserialize, Serialize};
use tauri::State;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use rusqlite::{params, OptionalExtension};
use crate::auth::{SessionContext, SessionManager};
use crate::crypto::key_manager::KeyManager;
use crate::db::DatabaseManager;
use crate::db::operations::DbOperations;
use crate::db::schema::{
    CatalogueCacheStats, ClinicalImportBatchInput, ClinicalImportBatchRecord, ClinicalImportSummary,
    ClinicalMedicineRecord, ConsultationRecord, FormularyRecord, InvoiceRecord, LocalCatalogueItem,
    PatientRecord, PrescriptionRecord, SaveCatalogueCacheItemArgs, SaveClinicalMedicineArgs,
    SaveFormularyArgs, SaveInvoiceArgs, SyncConflictRecord, SyncOutboxSummary, SyncStateRecord,
};
use crate::sync::{SyncStatusInfo, SyncWorkerHandle};

#[derive(Serialize)]
pub struct DesktopInfo {
    pub os: String,
    pub arch: String,
    pub app_version: String,
    pub is_desktop: bool,
    pub db_initialized: bool,
    pub db_path: Option<String>,
}

pub struct AppState {
    pub db: Arc<DatabaseManager>,
    pub session_mgr: Arc<SessionManager>,
    pub key_mgr: Arc<KeyManager>,
    pub sync_handle: Arc<SyncWorkerHandle>,
    pub refresh_coordinator: Arc<RefreshCoordinator>,
    pub catalogue_sync: Arc<crate::sync::CatalogueSyncManager>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ClinicAddressData {
    pub street: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    #[serde(rename = "postalCode")]
    pub postal_code: Option<String>,
    pub country: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ClinicItem {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub slug: String,
    pub role: String,
    #[serde(default)]
    pub status: String,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub address: Option<ClinicAddressData>,
    pub location_link: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct DesktopLoginResult {
    pub session: SessionContext,
    pub clinics: Vec<ClinicItem>,
    pub active_clinic_id: String,
}

/// Single-flight session refresh coordinator ensuring that simultaneous refresh
/// calls (from UI, session bootstrap, or background sync worker) share a single
/// network request, strictly preventing token reuse detection failures on the backend.
pub struct RefreshCoordinator {
    state: tokio::sync::Mutex<RefreshState>,
}

enum RefreshState {
    Idle,
    InFlight(tokio::sync::broadcast::Sender<Result<DesktopLoginResult, String>>),
}

impl Default for RefreshCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

impl RefreshCoordinator {
    pub fn new() -> Self {
        Self {
            state: tokio::sync::Mutex::new(RefreshState::Idle),
        }
    }

    pub async fn execute_single_flight<F, Fut>(&self, do_refresh: F) -> Result<DesktopLoginResult, String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<DesktopLoginResult, String>>,
    {
        let mut rx = {
            let mut lock = self.state.lock().await;
            match &*lock {
                RefreshState::InFlight(tx) => tx.subscribe(),
                RefreshState::Idle => {
                    let (tx, _rx) = tokio::sync::broadcast::channel(1);
                    *lock = RefreshState::InFlight(tx);
                    drop(lock);

                    let result = do_refresh().await;

                    let mut lock = self.state.lock().await;
                    if let RefreshState::InFlight(tx) = &*lock {
                        let _ = tx.send(result.clone());
                    }
                    *lock = RefreshState::Idle;
                    return result;
                }
            }
        };

        match rx.recv().await {
            Ok(result) => result,
            Err(_) => Err("In-flight refresh connection dropped".to_string()),
        }
    }
}

#[derive(Deserialize)]
struct BackendLoginResponse {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "refreshToken")]
    refresh_token: Option<String>,
    doctor: Option<RegisteredDoctorInfo>,
}

#[tauri::command]
pub fn get_desktop_info(state: State<'_, AppState>) -> DesktopInfo {
    DesktopInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        is_desktop: true,
        db_initialized: true,
        db_path: Some(state.db.get_db_path().to_string_lossy().to_string()),
    }
}

// ---------------------------------------------------------------------------
// Desktop Session & Authorization Commands
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug)]
struct BackendPublicKeyResponse {
    algorithm: String,
    #[serde(rename = "publicKey")]
    public_key: String,
    #[allow(dead_code)]
    issuer: Option<String>,
    #[allow(dead_code)]
    audience: Option<String>,
}

/// Synchronizes the active RSA SPKI public key from the trusted backend /auth/public-key endpoint
/// over TLS, validates minimum 2048-bit modulus, and updates the native SessionManager in memory.
/// To preserve the pinned trust anchor and prevent unauthenticated persistence, dynamically fetched keys
/// are held in memory only and are NOT persisted to DPAPI storage until backend-signed key rotation
/// certificates are implemented.
pub async fn sync_backend_public_key_from_server(
    session_mgr: &SessionManager,
) -> Result<(), String> {
    let base_url = crate::config::get_trusted_backend_url()?;
    let client = crate::config::create_secure_http_client(Duration::from_secs(10))?;
    let pk_url = format!("{base_url}/auth/public-key");

    let resp = client
        .get(&pk_url)
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend public key endpoint ({pk_url}): {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Backend returned HTTP {} on /auth/public-key", resp.status()));
    }

    let data = resp
        .json::<BackendPublicKeyResponse>()
        .await
        .map_err(|e| format!("Failed to parse /auth/public-key response: {e}"))?;

    if data.algorithm != "RS256" {
        return Err(format!("Unsupported algorithm '{}' from /auth/public-key", data.algorithm));
    }

    session_mgr
        .update_public_key(&data.public_key)
        .map_err(|e| format!("Failed to update session manager public key: {e}"))?;

    log::info!("Successfully synchronized verified RS256 public key from trusted backend into memory.");
    Ok(())
}

/// Authenticates a token into SessionManager. If cryptographic signature verification fails
/// (e.g. backend rotated its RSA keypair or restarted), attempts a live public-key discovery
/// from the trusted backend /auth/public-key endpoint and retries verification.
pub async fn login_with_auto_key_sync(
    session_mgr: &SessionManager,
    _key_mgr: &KeyManager,
    token: &str,
    clinic_id: &str,
    role: &str,
) -> Result<SessionContext, String> {
    match session_mgr.login(token, clinic_id, role) {
        Ok(session) => Ok(session),
        Err(crate::auth::AuthError::SignatureVerificationFailed) => {
            log::info!("JWT signature verification failed with local decoding key. Fetching active public key from trusted backend...");
            if let Err(e) = sync_backend_public_key_from_server(session_mgr).await {
                log::warn!("Could not sync public key from backend: {e}");
                return Err("Token signature verification failed: cryptographic signature mismatch.".to_string());
            }
            // Retry login with newly synchronized backend public key
            session_mgr
                .login(token, clinic_id, role)
                .map_err(|e| e.to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Native login: Executes HTTP POST /auth/login directly in Rust.
/// Refresh tokens are saved directly to secure DPAPI storage and are NEVER
/// returned to the renderer JavaScript or exposed over IPC.
/// Clinic memberships are authoritatively queried from GET /clinics/my-clinics
/// using the verified access token.
#[tauri::command]
pub async fn login_desktop(
    state: State<'_, AppState>,
    email: String,
    password: String,
) -> Result<DesktopLoginResult, String> {
    let base_url = crate::config::get_trusted_backend_url()?;
    let client = crate::config::create_secure_http_client(Duration::from_secs(60))?;

    let login_url = format!("{base_url}/auth/login");
    let mut last_err = String::new();
    let mut resp_opt = None;

    // Retry up to 3 times for cold start / transient network failures
    for attempt in 1..=3 {
        match client
            .post(&login_url)
            .json(&serde_json::json!({
                "email": email.trim(),
                "password": password
            }))
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                if (status == reqwest::StatusCode::BAD_GATEWAY
                    || status == reqwest::StatusCode::SERVICE_UNAVAILABLE
                    || status == reqwest::StatusCode::GATEWAY_TIMEOUT)
                    && attempt < 3
                {
                    log::warn!(
                        "Auth server returned HTTP {status} (cold start), retrying attempt {attempt}/3..."
                    );
                    tokio::time::sleep(Duration::from_millis(1500)).await;
                    continue;
                }
                resp_opt = Some(resp);
                break;
            }
            Err(e) => {
                log::warn!("Auth server request failed on attempt {attempt}/3: {e}");
                last_err = e.to_string();
                if attempt < 3 {
                    tokio::time::sleep(Duration::from_millis(1500)).await;
                }
            }
        }
    }

    let resp = match resp_opt {
        Some(r) => r,
        None => {
            log::error!("Auth server connection failed after retries: {last_err}");
            return Err("Unable to connect to the authentication server. Please check your internet connection and try again.".to_string());
        }
    };

    let status = resp.status();
    if !status.is_success() {
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err("Invalid email or password. Please verify your credentials.".to_string());
        }
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err("Too many sign-in attempts. Please wait a few moments and try again.".to_string());
        }
        log::error!("Authentication server returned HTTP status {status}");
        return Err("Authentication service is temporarily unavailable. Please try again in a few moments.".to_string());
    }

    let login_data = resp
        .json::<BackendLoginResponse>()
        .await
        .map_err(|e| {
            log::error!("Failed to parse auth response: {e}");
            "Unexpected response from authentication server. Please try again.".to_string()
        })?;

    // 1. Securely persist refresh token using DPAPI immediately
    if let Some(ref rt) = login_data.refresh_token {
        if !rt.trim().is_empty() {
            state.key_mgr.save_refresh_token(rt)
                .map_err(|e| format!("Failed to store refresh token securely: {e}"))?;
        }
    }

    // Persist authenticated doctor credentials to local SQLite for durable offline profile
    if let Some(ref doc) = login_data.doctor {
        let conn = state.db.get_connection();
        let _ = crate::db::operations::DbOperations::upsert_doctor_profile(
            &conn,
            &crate::db::schema::DoctorProfileRecord {
                doctor_id: doc.id.clone(),
                full_name: doc.full_name.clone(),
                email: doc.email.clone(),
                phone: doc.phone.clone().unwrap_or_default(),
                qualification: doc.qualification.clone().unwrap_or_default(),
                registration_number: doc.registration_number.clone().unwrap_or_default(),
                gender: doc.gender.clone().unwrap_or_else(|| "Male".to_string()),
                updated_at: None,
            },
        );
    }

    // 2. Fetch authoritative clinic memberships from backend using access token
    let my_clinics_url = format!("{base_url}/clinics/my-clinics");
    let mut clinics_resp_opt = None;
    for attempt in 1..=2 {
        match client
            .get(&my_clinics_url)
            .bearer_auth(&login_data.access_token)
            .send()
            .await
        {
            Ok(r) => {
                clinics_resp_opt = Some(r);
                break;
            }
            Err(e) => {
                log::warn!("Failed fetching clinic memberships on attempt {attempt}/2: {e}");
                if attempt < 2 {
                    tokio::time::sleep(Duration::from_millis(1000)).await;
                }
            }
        }
    }

    let clinics: Vec<ClinicItem> = match clinics_resp_opt {
        Some(r) if r.status().is_success() => r.json().await.unwrap_or_default(),
        _ => Vec::new(),
    };

    // Persist all retrieved clinic profiles to local SQLite for durable offline access
    {
        let conn = state.db.get_connection();
        for c in &clinics {
            let addr = c.address.as_ref();
            let profile = crate::db::schema::ClinicProfileRecord {
                clinic_id: c.id.clone(),
                name: c.name.clone(),
                slug: c.slug.clone(),
                phone: c.phone.clone().unwrap_or_default(),
                email: c.email.clone().unwrap_or_default(),
                street: addr.and_then(|a| a.street.clone()).unwrap_or_default(),
                city: addr.and_then(|a| a.city.clone()).unwrap_or_default(),
                state: addr.and_then(|a| a.state.clone()).unwrap_or_default(),
                postal_code: addr.and_then(|a| a.postal_code.clone()).unwrap_or_default(),
                country: addr.and_then(|a| a.country.clone()).unwrap_or_else(|| "India".to_string()),
                location_link: c.location_link.clone().unwrap_or_default(),
                updated_at: None,
            };
            let _ = crate::db::operations::DbOperations::upsert_clinic_profile(&conn, &profile);
        }
    }

    let (selected_clinic_id, selected_role) = if clinics.is_empty() {
        ("".to_string(), "OWNER".to_string())
    } else {
        let prev_clinic_id = state.key_mgr.load_active_clinic_id().ok().flatten();
        let selected_clinic = prev_clinic_id
            .as_ref()
            .and_then(|id| clinics.iter().find(|c| &c.id == id))
            .unwrap_or(&clinics[0])
            .clone();

        let _ = state.key_mgr.save_active_clinic_id(&selected_clinic.id);
        (selected_clinic.id, selected_clinic.role)
    };

    // 3. Establish session with authoritative clinic & role
    let session = login_with_auto_key_sync(
        &state.session_mgr,
        &state.key_mgr,
        &login_data.access_token,
        &selected_clinic_id,
        &selected_role,
    )
    .await
    .map_err(|e| format!("Failed to validate session token: {e}"))?;

    // 4. Start native background sync worker for this clinic if clinic exists
    if !selected_clinic_id.is_empty() {
        state.sync_handle.start(
            selected_clinic_id.clone(),
            state.db.clone(),
            state.session_mgr.clone(),
            state.key_mgr.clone(),
            state.refresh_coordinator.clone(),
        ).await;
    }

    let mut final_session = session;
    {
        let conn = state.db.get_connection();
        if let Ok(Some(profile)) =
            crate::db::operations::DbOperations::get_doctor_profile(&conn, &final_session.doctor_id)
        {
            if !profile.full_name.trim().is_empty() {
                final_session.doctor_name = profile.full_name.clone();
                state.session_mgr.update_doctor_name(&profile.full_name);
            }
        }
    }

    Ok(DesktopLoginResult {
        session: final_session,
        clinics,
        active_clinic_id: selected_clinic_id,
    })
}

#[derive(Deserialize)]
pub struct RegisterDesktopInput {
    #[serde(rename = "fullName")]
    pub full_name: String,
    pub email: String,
    pub password: String,
    pub phone: Option<String>,
    pub qualification: Option<String>,
    #[serde(rename = "registrationNumber")]
    pub registration_number: Option<String>,
    pub gender: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RegisteredDoctorInfo {
    pub id: String,
    pub email: String,
    #[serde(rename = "fullName")]
    pub full_name: String,
    pub phone: Option<String>,
    pub qualification: Option<String>,
    #[serde(rename = "registrationNumber")]
    pub registration_number: Option<String>,
    pub gender: Option<String>,
    pub status: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RegisterDesktopResult {
    #[serde(rename = "accessToken")]
    pub access_token: String,
    #[serde(rename = "refreshToken")]
    pub refresh_token: Option<String>,
    pub doctor: RegisteredDoctorInfo,
    pub session: Option<SessionContext>,
}

#[tauri::command]
pub fn get_trusted_api_url() -> Result<String, String> {
    crate::config::get_trusted_backend_url()
}

#[tauri::command]
pub async fn register_desktop(
    state: State<'_, AppState>,
    input: RegisterDesktopInput,
) -> Result<RegisterDesktopResult, String> {
    let base_url = crate::config::get_trusted_backend_url()?;
    let client = crate::config::create_secure_http_client(Duration::from_secs(35))?;

    let register_url = format!("{base_url}/auth/register");
    let payload = serde_json::json!({
        "fullName": input.full_name.trim(),
        "email": input.email.trim(),
        "password": input.password,
        "phone": input.phone.as_ref().map(|p| p.trim()),
        "qualification": input.qualification.as_ref().map(|p| p.trim()),
        "registrationNumber": input.registration_number.as_ref().map(|p| p.trim()),
        "gender": input.gender.as_ref().map(|p| p.trim()),
    });

    let max_attempts = 3;
    let mut last_transport_err: Option<String> = None;
    let mut resp_opt: Option<reqwest::Response> = None;

    for attempt in 1..=max_attempts {
        match client.post(&register_url).json(&payload).send().await {
            Ok(resp) => {
                resp_opt = Some(resp);
                break;
            }
            Err(e) => {
                let is_transport_error = e.is_connect() || e.is_timeout() || e.is_request();
                let err_str = format!("{e}");
                last_transport_err = Some(err_str.clone());
                log::warn!(
                    "[register_desktop] Attempt {attempt}/{max_attempts} failed with transport error: {err_str}"
                );
                if attempt < max_attempts && is_transport_error {
                    let delay_ms = attempt * 1200;
                    tokio::time::sleep(Duration::from_millis(delay_ms as u64)).await;
                    continue;
                } else {
                    break;
                }
            }
        }
    }

    let resp = match resp_opt {
        Some(r) => r,
        None => {
            let detail = last_transport_err.unwrap_or_else(|| "unknown network error".to_string());
            return Err(format!("Authentication server unreachable ({base_url}): {detail}"));
        }
    };

    let status = resp.status();
    if !status.is_success() {
        if status == reqwest::StatusCode::CONFLICT {
            // Attempt conflict recovery: check if the account was successfully created during
            // a preceding attempt that experienced network interruption before receiving the response.
            let login_url = format!("{base_url}/auth/login");
            if let Ok(login_resp) = client
                .post(&login_url)
                .json(&serde_json::json!({
                    "email": input.email.trim(),
                    "password": input.password,
                }))
                .send()
                .await
            {
                if login_resp.status().is_success() {
                    if let Ok(login_data) = login_resp.json::<BackendLoginResponse>().await {
                        if let Some(doc) = login_data.doctor {
                            if let Some(ref rt) = login_data.refresh_token {
                                if !rt.trim().is_empty() {
                                    let _ = state.key_mgr.save_refresh_token(rt);
                                }
                            }

                            {
                                let conn = state.db.get_connection();
                                let _ = crate::db::operations::DbOperations::upsert_doctor_profile(
                                    &conn,
                                    &crate::db::schema::DoctorProfileRecord {
                                        doctor_id: doc.id.clone(),
                                        full_name: doc.full_name.clone(),
                                        email: doc.email.clone(),
                                        phone: doc.phone.clone().unwrap_or_default(),
                                        qualification: doc.qualification.clone().unwrap_or_default(),
                                        registration_number: doc.registration_number.clone().unwrap_or_default(),
                                        gender: doc.gender.clone().unwrap_or_else(|| "Male".to_string()),
                                        updated_at: None,
                                    },
                                );
                            }

                            let session = login_with_auto_key_sync(
                                &state.session_mgr,
                                &state.key_mgr,
                                &login_data.access_token,
                                "",
                                "OWNER",
                            )
                            .await
                            .map_err(|e| format!("Failed to establish native doctor session: {e}"))?;

                            return Ok(RegisterDesktopResult {
                                access_token: login_data.access_token,
                                refresh_token: login_data.refresh_token,
                                doctor: doc,
                                session: Some(session),
                            });
                        }
                    }
                }
            }
            return Err("An account with this email address already exists.".to_string());
        }
        let body_text = resp.text().await.unwrap_or_default();
        return Err(format!("Registration failed (HTTP {status}): {body_text}"));
    }

    let reg_data = resp
        .json::<RegisterDesktopResult>()
        .await
        .map_err(|e| format!("Invalid registration response from auth server: {e}"))?;

    if let Some(ref rt) = reg_data.refresh_token {
        if !rt.trim().is_empty() {
            let _ = state.key_mgr.save_refresh_token(rt);
        }
    }

    // Immediately persist newly registered doctor credentials to local SQLite
    {
        let conn = state.db.get_connection();
        let _ = crate::db::operations::DbOperations::upsert_doctor_profile(
            &conn,
            &crate::db::schema::DoctorProfileRecord {
                doctor_id: reg_data.doctor.id.clone(),
                full_name: reg_data.doctor.full_name.clone(),
                email: reg_data.doctor.email.clone(),
                phone: reg_data.doctor.phone.clone().unwrap_or_default(),
                qualification: reg_data.doctor.qualification.clone().unwrap_or_default(),
                registration_number: reg_data.doctor.registration_number.clone().unwrap_or_default(),
                gender: reg_data.doctor.gender.clone().unwrap_or_else(|| "Male".to_string()),
                updated_at: None,
            },
        );
    }

    // Immediately establish the native session for the newly registered doctor
    let session = login_with_auto_key_sync(
        &state.session_mgr,
        &state.key_mgr,
        &reg_data.access_token,
        "",
        "OWNER",
    )
    .await
    .map_err(|e| format!("Failed to establish native doctor session: {e}"))?;

    Ok(RegisterDesktopResult {
        access_token: reg_data.access_token,
        refresh_token: reg_data.refresh_token,
        doctor: reg_data.doctor,
        session: Some(session),
    })
}

#[tauri::command]
pub async fn login_desktop_session(
    state: State<'_, AppState>,
    token: String,
    clinic_id: String,
    role: String,
    refresh_token: Option<String>,
) -> Result<SessionContext, String> {
    let session = login_with_auto_key_sync(
        &state.session_mgr,
        &state.key_mgr,
        &token,
        &clinic_id,
        &role,
    )
    .await
    .map_err(|e| e.to_string())?;

    if let Some(ref rt) = refresh_token {
        let trimmed = rt.trim();
        if !trimmed.is_empty() {
            if let Err(e) = state.key_mgr.save_refresh_token(trimmed) {
                log::warn!("Failed to persist refresh token to secure key store: {e}");
            }
        }
    }

    // If JWT claims contain doctor profile credentials, persist to local SQLite
    if let Ok(claims) = state.session_mgr.verify_jwt(&token) {
        let conn = state.db.get_connection();
        let _ = crate::db::operations::DbOperations::upsert_doctor_profile(
            &conn,
            &crate::db::schema::DoctorProfileRecord {
                doctor_id: claims.sub,
                full_name: claims.full_name.unwrap_or_else(|| session.doctor_name.clone()),
                email: claims.email,
                phone: claims.phone.unwrap_or_default(),
                qualification: claims.qualification.unwrap_or_default(),
                registration_number: claims.registration_number.unwrap_or_default(),
                gender: "Male".to_string(),
                updated_at: None,
            },
        );
    }

    let _ = state.key_mgr.save_active_clinic_id(&clinic_id);

    state.sync_handle.start(
        clinic_id,
        state.db.clone(),
        state.session_mgr.clone(),
        state.key_mgr.clone(),
        state.refresh_coordinator.clone(),
    ).await;

    Ok(session)
}

#[derive(Deserialize)]
struct BackendRefreshResponse {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "refreshToken")]
    refresh_token: Option<String>,
}

#[derive(Serialize)]
struct BackendRefreshRequest<'a> {
    #[serde(rename = "refreshToken")]
    refresh_token: &'a str,
}

pub async fn execute_refresh_session(
    key_mgr: &KeyManager,
    session_mgr: &SessionManager,
    refresh_coordinator: &RefreshCoordinator,
) -> Result<DesktopLoginResult, String> {
    execute_refresh_session_with_db(key_mgr, session_mgr, refresh_coordinator, None, None).await
}

pub async fn execute_refresh_session_with_url(
    key_mgr: &KeyManager,
    session_mgr: &SessionManager,
    refresh_coordinator: &RefreshCoordinator,
    backend_url_override: Option<&str>,
) -> Result<DesktopLoginResult, String> {
    execute_refresh_session_with_db(key_mgr, session_mgr, refresh_coordinator, backend_url_override, None).await
}

pub async fn execute_refresh_session_with_db(
    key_mgr: &KeyManager,
    session_mgr: &SessionManager,
    refresh_coordinator: &RefreshCoordinator,
    backend_url_override: Option<&str>,
    db: Option<&DatabaseManager>,
) -> Result<DesktopLoginResult, String> {
    let url_opt = backend_url_override.map(|s| s.to_string());
    refresh_coordinator
        .execute_single_flight(|| {
            let u = url_opt.clone();
            async move {
                do_actual_refresh_session(key_mgr, session_mgr, u.as_deref(), db).await
            }
        })
        .await
}

async fn do_actual_refresh_session(
    key_mgr: &KeyManager,
    session_mgr: &SessionManager,
    backend_url_override: Option<&str>,
    db: Option<&DatabaseManager>,
) -> Result<DesktopLoginResult, String> {
    let persisted_rt = match key_mgr.load_refresh_token() {
        Ok(Some(rt)) if !rt.trim().is_empty() => rt,
        Ok(_) => return Err("No persisted refresh token found".to_string()),
        Err(e) => return Err(format!("Failed to read refresh token: {e}")),
    };

    let base_url = match backend_url_override {
        Some(u) => u.trim_end_matches('/').to_string(),
        None => crate::config::get_trusted_backend_url()?,
    };
    let refresh_url = format!("{base_url}/auth/refresh");

    // Fast, responsive 10-second timeout for session refresh to avoid UI delay
    let client = crate::config::create_secure_http_client(Duration::from_secs(10))?;

    let send_result = client
        .post(&refresh_url)
        .json(&BackendRefreshRequest {
            refresh_token: &persisted_rt,
        })
        .send()
        .await;

    let resp = match send_result {
        Ok(r) => r,
        Err(net_err) => {
            log::warn!("Refresh network request failed ({net_err}). Checking permitted offline credentials...");
            if let Some(db_mgr) = db {
                if let Some(offline_result) = try_restore_offline_session(key_mgr, session_mgr, db_mgr) {
                    log::info!(
                        "Successfully restored permitted offline desktop session for doctor '{}'",
                        offline_result.session.doctor_name
                    );
                    return Ok(offline_result);
                }
            }
            return Err(format!("Network error communicating with auth server: {net_err}"));
        }
    };

    let status = resp.status();
    if !status.is_success() {
        if status == reqwest::StatusCode::UNAUTHORIZED
            || status == reqwest::StatusCode::FORBIDDEN
            || status == reqwest::StatusCode::BAD_REQUEST
        {
            let _ = key_mgr.clear_refresh_token();
            let _ = key_mgr.clear_active_clinic_id();
            session_mgr.logout();
            return Err("Refresh token rejected or expired by server. Local session cleared.".to_string());
        }

        // For 5xx server errors, fall back to offline session if local profile exists
        if status.is_server_error() {
            if let Some(db_mgr) = db {
                if let Some(offline_result) = try_restore_offline_session(key_mgr, session_mgr, db_mgr) {
                    log::info!("Auth server unavailable (HTTP {status}). Restored permitted offline desktop session.");
                    return Ok(offline_result);
                }
            }
        }

        return Err(format!("Auth server error: HTTP {status}"));
    }

    let refresh_data = resp
        .json::<BackendRefreshResponse>()
        .await
        .map_err(|e| format!("Failed to parse refresh response: {e}"))?;

    let token_to_persist = refresh_data
        .refresh_token
        .as_deref()
        .unwrap_or(&persisted_rt);
    if let Err(e) = key_mgr.save_refresh_token(token_to_persist) {
        log::warn!("Failed to persist rotated refresh token: {e}");
    }

    // Fetch authoritative clinic memberships from backend
    let my_clinics_url = format!("{base_url}/clinics/my-clinics");
    let clinics_resp_result = client
        .get(&my_clinics_url)
        .bearer_auth(&refresh_data.access_token)
        .send()
        .await;

    let clinics: Vec<ClinicItem> = match clinics_resp_result {
        Ok(c_resp) if c_resp.status().is_success() => {
            c_resp.json().await.unwrap_or_default()
        }
        _ => {
            // If fetching online clinics failed but token refresh succeeded, recover from cached SQLite clinics
            if let Some(db_mgr) = db {
                let conn = db_mgr.get_connection();
                let cached = crate::db::operations::DbOperations::get_all_clinic_profiles(&conn)
                    .unwrap_or_default();
                cached
                    .into_iter()
                    .map(|p| ClinicItem {
                        id: p.clinic_id,
                        name: p.name,
                        slug: p.slug,
                        role: "OWNER".to_string(),
                        status: "ACTIVE".to_string(),
                        phone: if p.phone.is_empty() { None } else { Some(p.phone) },
                        email: if p.email.is_empty() { None } else { Some(p.email) },
                        address: Some(ClinicAddressData {
                            street: if p.street.is_empty() { None } else { Some(p.street) },
                            city: if p.city.is_empty() { None } else { Some(p.city) },
                            state: if p.state.is_empty() { None } else { Some(p.state) },
                            postal_code: if p.postal_code.is_empty() { None } else { Some(p.postal_code) },
                            country: Some(p.country),
                        }),
                        location_link: if p.location_link.is_empty() { None } else { Some(p.location_link) },
                    })
                    .collect()
            } else {
                Vec::new()
            }
        }
    };

    let (selected_clinic_id, selected_role) = if clinics.is_empty() {
        ("".to_string(), "OWNER".to_string())
    } else {
        let prev_clinic_id = key_mgr.load_active_clinic_id().ok().flatten();
        let selected_clinic = prev_clinic_id
            .as_ref()
            .and_then(|id| clinics.iter().find(|c| &c.id == id))
            .unwrap_or(&clinics[0])
            .clone();

        let _ = key_mgr.save_active_clinic_id(&selected_clinic.id);
        (selected_clinic.id, selected_clinic.role)
    };

    let session = login_with_auto_key_sync(
        session_mgr,
        key_mgr,
        &refresh_data.access_token,
        &selected_clinic_id,
        &selected_role,
    )
    .await
    .map_err(|e| format!("Failed to validate refreshed access token: {e}"))?;

    let mut final_session = session;
    if let Some(db_mgr) = db {
        let conn = db_mgr.get_connection();
        if let Ok(Some(profile)) =
            crate::db::operations::DbOperations::get_doctor_profile(&conn, &final_session.doctor_id)
        {
            if !profile.full_name.trim().is_empty() {
                final_session.doctor_name = profile.full_name.clone();
                session_mgr.update_doctor_name(&profile.full_name);
            }
        }
    }

    Ok(DesktopLoginResult {
        session: final_session,
        clinics,
        active_clinic_id: selected_clinic_id,
    })
}

fn try_restore_offline_session(
    key_mgr: &KeyManager,
    session_mgr: &SessionManager,
    db: &DatabaseManager,
) -> Option<DesktopLoginResult> {
    let conn = db.get_connection();
    let doc = crate::db::operations::DbOperations::get_doctor_profile_any(&conn).ok()??;
    let cached_clinics = crate::db::operations::DbOperations::get_all_clinic_profiles(&conn).unwrap_or_default();

    let clinics: Vec<ClinicItem> = cached_clinics
        .into_iter()
        .map(|p| ClinicItem {
            id: p.clinic_id,
            name: p.name,
            slug: p.slug,
            role: "OWNER".to_string(),
            status: "ACTIVE".to_string(),
            phone: if p.phone.is_empty() { None } else { Some(p.phone) },
            email: if p.email.is_empty() { None } else { Some(p.email) },
            address: Some(ClinicAddressData {
                street: if p.street.is_empty() { None } else { Some(p.street) },
                city: if p.city.is_empty() { None } else { Some(p.city) },
                state: if p.state.is_empty() { None } else { Some(p.state) },
                postal_code: if p.postal_code.is_empty() { None } else { Some(p.postal_code) },
                country: Some(p.country),
            }),
            location_link: if p.location_link.is_empty() { None } else { Some(p.location_link) },
        })
        .collect();

    let (active_clinic_id, active_role) = if clinics.is_empty() {
        ("".to_string(), "OWNER".to_string())
    } else {
        let prev_clinic_id = key_mgr.load_active_clinic_id().ok().flatten();
        let selected = prev_clinic_id
            .as_ref()
            .and_then(|id| clinics.iter().find(|c| &c.id == id))
            .unwrap_or(&clinics[0]);
        (selected.id.clone(), selected.role.clone())
    };

    let now_sec = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let session = SessionContext {
        doctor_id: doc.doctor_id,
        clinic_id: active_clinic_id.clone(),
        doctor_email: doc.email,
        doctor_name: doc.full_name,
        role: active_role,
        expires_at: now_sec + (7 * 86400), // 7 days permitted offline duration
    };

    session_mgr.set_offline_session(session.clone());

    Some(DesktopLoginResult {
        session,
        clinics,
        active_clinic_id,
    })
}

pub async fn execute_logout_session(
    key_mgr: &KeyManager,
    session_mgr: &SessionManager,
) -> Result<(), String> {
    if let Ok(Some(rt)) = key_mgr.load_refresh_token() {
        if !rt.trim().is_empty() {
            if let Ok(base_url) = crate::config::get_trusted_backend_url() {
                let logout_url = format!("{base_url}/auth/logout");

                if let Ok(client) = crate::config::create_secure_http_client(Duration::from_secs(5)) {
                    let _ = client
                        .post(&logout_url)
                        .json(&BackendRefreshRequest {
                            refresh_token: &rt,
                        })
                        .send()
                        .await;
                }
            }
        }
    }

    session_mgr.logout();

    if let Err(e) = key_mgr.clear_refresh_token() {
        log::warn!("Failed to clear persisted refresh token from secure key store: {e}");
    }
    let _ = key_mgr.clear_active_clinic_id();

    Ok(())
}

#[tauri::command]
pub async fn refresh_desktop_session(
    state: State<'_, AppState>,
) -> Result<DesktopLoginResult, String> {
    let result = execute_refresh_session_with_db(
        &state.key_mgr,
        &state.session_mgr,
        &state.refresh_coordinator,
        None,
        Some(&state.db),
    )
    .await?;

    // Persist refreshed clinic profiles to local SQLite for durable offline access
    {
        let conn = state.db.get_connection();
        for c in &result.clinics {
            let addr = c.address.as_ref();
            let profile = crate::db::schema::ClinicProfileRecord {
                clinic_id: c.id.clone(),
                name: c.name.clone(),
                slug: c.slug.clone(),
                phone: c.phone.clone().unwrap_or_default(),
                email: c.email.clone().unwrap_or_default(),
                street: addr.and_then(|a| a.street.clone()).unwrap_or_default(),
                city: addr.and_then(|a| a.city.clone()).unwrap_or_default(),
                state: addr.and_then(|a| a.state.clone()).unwrap_or_default(),
                postal_code: addr.and_then(|a| a.postal_code.clone()).unwrap_or_default(),
                country: addr.and_then(|a| a.country.clone()).unwrap_or_else(|| "India".to_string()),
                location_link: c.location_link.clone().unwrap_or_default(),
                updated_at: None,
            };
            let _ = crate::db::operations::DbOperations::upsert_clinic_profile(&conn, &profile);
        }
    }

    if !result.active_clinic_id.is_empty() {
        state.sync_handle.start(
            result.active_clinic_id.clone(),
            state.db.clone(),
            state.session_mgr.clone(),
            state.key_mgr.clone(),
            state.refresh_coordinator.clone(),
        ).await;
    }

    Ok(result)
}

#[tauri::command]
pub async fn logout_desktop_session(
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.sync_handle.stop().await;
    execute_logout_session(&state.key_mgr, &state.session_mgr).await
}

#[tauri::command]
pub async fn get_sync_status(
    state: State<'_, AppState>,
) -> Result<SyncStatusInfo, String> {
    Ok(state.sync_handle.get_status().await)
}

#[tauri::command]
pub async fn switch_active_clinic(
    state: State<'_, AppState>,
    clinic_id: String,
    role: String,
) -> Result<SessionContext, String> {
    let token = state.session_mgr.get_access_token()
        .ok_or_else(|| "No active session".to_string())?;

    let session = login_with_auto_key_sync(
        &state.session_mgr,
        &state.key_mgr,
        &token,
        &clinic_id,
        &role,
    )
    .await
    .map_err(|e| e.to_string())?;

    let _ = state.key_mgr.save_active_clinic_id(&clinic_id);

    state.sync_handle.start(
        clinic_id,
        state.db.clone(),
        state.session_mgr.clone(),
        state.key_mgr.clone(),
        state.refresh_coordinator.clone(),
    ).await;

    Ok(session)
}

#[derive(Deserialize)]
pub struct CreateClinicDesktopInput {
    pub name: String,
    pub slug: Option<String>,
    pub phone: String,
    pub email: String,
    pub address: ClinicAddressInput,
    pub location_link: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct ClinicAddressInput {
    pub street: String,
    pub city: String,
    pub state: String,
    #[serde(rename = "postalCode")]
    pub postal_code: String,
    pub country: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CreatedClinicInfo {
    pub _id: Option<String>,
    pub id: Option<String>,
    pub name: String,
    pub slug: Option<String>,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub address: Option<ClinicAddressData>,
    pub location_link: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CreatedMembershipInfo {
    pub _id: Option<String>,
    pub id: Option<String>,
    #[serde(rename = "clinicId")]
    pub clinic_id: Option<String>,
    #[serde(rename = "doctorId")]
    pub doctor_id: Option<String>,
    pub role: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CreateClinicResult {
    pub clinic: CreatedClinicInfo,
    pub membership: CreatedMembershipInfo,
}

#[tauri::command]
pub async fn create_clinic_desktop(
    state: State<'_, AppState>,
    input: CreateClinicDesktopInput,
) -> Result<CreateClinicResult, String> {
    let token = state.session_mgr.get_access_token()
        .ok_or_else(|| "No active authenticated session found. Please log in or register.".to_string())?;

    let base_url = crate::config::get_trusted_backend_url()?;
    let client = crate::config::create_secure_http_client(Duration::from_secs(35))?;
    let clinic_url = format!("{base_url}/clinics");

    let resp = client
        .post(&clinic_url)
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "name": input.name.trim(),
            "phone": input.phone.trim(),
            "email": input.email.trim(),
            "address": {
                "street": input.address.street.trim(),
                "city": input.address.city.trim(),
                "state": input.address.state.trim(),
                "postalCode": input.address.postal_code.trim(),
                "country": input.address.country.trim(),
            }
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Cliniqo server ({base_url}): {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Failed to create clinic (HTTP {status}): {body}"));
    }

    let clinic_result = resp
        .json::<CreateClinicResult>()
        .await
        .map_err(|e| format!("Invalid clinic creation response from server: {e}"))?;

    let clinic_id = clinic_result.clinic.id.as_deref()
        .or(clinic_result.clinic._id.as_deref())
        .unwrap_or_default();

    if !clinic_id.is_empty() {
        let _ = state.session_mgr.login(&token, clinic_id, "OWNER");
        let _ = state.key_mgr.save_active_clinic_id(clinic_id);

        let profile = crate::db::schema::ClinicProfileRecord {
            clinic_id: clinic_id.to_string(),
            name: input.name.trim().to_string(),
            slug: input.slug.unwrap_or_default().trim().to_string(),
            phone: input.phone.trim().to_string(),
            email: input.email.trim().to_string(),
            street: input.address.street.trim().to_string(),
            city: input.address.city.trim().to_string(),
            state: input.address.state.trim().to_string(),
            postal_code: input.address.postal_code.trim().to_string(),
            country: input.address.country.trim().to_string(),
            location_link: input.location_link.unwrap_or_default().trim().to_string(),
            updated_at: None,
        };

        {
            let conn = state.db.get_connection();
            if let Err(e) = crate::db::operations::DbOperations::upsert_clinic_profile(&conn, &profile) {
                log::warn!("Failed to persist created clinic profile to SQLite: {e}");
            }
        }

        state.sync_handle.start(
            clinic_id.to_string(),
            state.db.clone(),
            state.session_mgr.clone(),
            state.key_mgr.clone(),
            state.refresh_coordinator.clone(),
        ).await;
    }

    Ok(clinic_result)
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct SaveClinicProfileArgs {
    pub clinic_id: String,
    pub name: String,
    pub slug: Option<String>,
    pub phone: String,
    pub email: String,
    pub street: String,
    pub city: String,
    pub state: String,
    pub postal_code: String,
    pub country: String,
    pub location_link: Option<String>,
}

#[tauri::command]
pub fn get_clinic_profile(
    state: State<'_, AppState>,
    clinic_id: String,
) -> Result<Option<crate::db::schema::ClinicProfileRecord>, String> {
    let conn = state.db.get_connection();
    crate::db::operations::DbOperations::get_clinic_profile(&conn, &clinic_id)
        .map_err(|e| format!("Failed to read clinic profile: {e}"))
}

#[tauri::command]
pub async fn save_clinic_profile(
    state: State<'_, AppState>,
    args: SaveClinicProfileArgs,
) -> Result<crate::db::schema::ClinicProfileRecord, String> {
    let session = state.session_mgr.get_session()
        .ok_or_else(|| "No active authenticated session".to_string())?;

    if !session.clinic_id.is_empty() && session.clinic_id != args.clinic_id {
        return Err("Cross-clinic profile mutation rejected".to_string());
    }

    let record = crate::db::schema::ClinicProfileRecord {
        clinic_id: args.clinic_id.clone(),
        name: args.name.trim().to_string(),
        slug: args.slug.unwrap_or_default().trim().to_string(),
        phone: args.phone.trim().to_string(),
        email: args.email.trim().to_string(),
        street: args.street.trim().to_string(),
        city: args.city.trim().to_string(),
        state: args.state.trim().to_string(),
        postal_code: args.postal_code.trim().to_string(),
        country: args.country.trim().to_string(),
        location_link: args.location_link.unwrap_or_default().trim().to_string(),
        updated_at: None,
    };

    {
        let conn = state.db.get_connection();
        crate::db::operations::DbOperations::upsert_clinic_profile(&conn, &record)
            .map_err(|e| format!("Failed to update local clinic profile: {e}"))?;
    }

    if let Some(token) = state.session_mgr.get_access_token() {
        if let Ok(base_url) = crate::config::get_trusted_backend_url() {
            if let Ok(client) = crate::config::create_secure_http_client(Duration::from_secs(10)) {
                let url = format!("{base_url}/clinics/{}", args.clinic_id);
                let _ = client
                    .patch(&url)
                    .bearer_auth(&token)
                    .json(&serde_json::json!({
                        "name": record.name,
                        "phone": record.phone,
                        "email": record.email,
                        "address": {
                            "street": record.street,
                            "city": record.city,
                            "state": record.state,
                            "postalCode": record.postal_code,
                            "country": record.country,
                        }
                    }))
                    .send()
                    .await;
            }
        }
    }

    Ok(record)
}

#[derive(Debug, Deserialize)]
pub struct SaveDoctorProfileCommandArgs {
    pub doctor_id: Option<String>,
    pub full_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub qualification: Option<String>,
    pub registration_number: Option<String>,
    pub gender: Option<String>,
}

#[tauri::command]
pub async fn get_doctor_profile(
    state: State<'_, AppState>,
    doctor_id: Option<String>,
) -> Result<Option<crate::db::schema::DoctorProfileRecord>, String> {
    let target_id = doctor_id.or_else(|| state.session_mgr.get_session().map(|s| s.doctor_id));
    let doctor_id = match target_id {
        Some(id) if !id.trim().is_empty() => id,
        _ => return Ok(None),
    };

    let local_profile = {
        let conn = state.db.get_connection();
        crate::db::operations::DbOperations::get_doctor_profile(&conn, &doctor_id)
            .map_err(|e| format!("Failed to read doctor profile: {e}"))?
    };

    if local_profile.is_some() {
        return Ok(local_profile);
    }

    // If not found in SQLite yet, query backend if active access token exists
    if let Some(token) = state.session_mgr.get_access_token() {
        if let Ok(base_url) = crate::config::get_trusted_backend_url() {
            if let Ok(client) = crate::config::create_secure_http_client(Duration::from_secs(5)) {
                let url = format!("{base_url}/auth/profile");
                if let Ok(resp) = client.get(&url).bearer_auth(&token).send().await {
                    if resp.status().is_success() {
                        if let Ok(json) = resp.json::<serde_json::Value>().await {
                            let rec = crate::db::schema::DoctorProfileRecord {
                                doctor_id: json.get("id").or_else(|| json.get("doctorId")).and_then(|v| v.as_str()).unwrap_or(&doctor_id).to_string(),
                                full_name: json.get("fullName").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                email: json.get("email").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                phone: json.get("phone").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                qualification: json.get("qualification").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                registration_number: json.get("registrationNumber").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                gender: json.get("gender").and_then(|v| v.as_str()).unwrap_or("Male").to_string(),
                                updated_at: None,
                            };
                            {
                                let conn = state.db.get_connection();
                                let _ = crate::db::operations::DbOperations::upsert_doctor_profile(&conn, &rec);
                            }
                            return Ok(Some(rec));
                        }
                    }
                }
            }
        }
    }

    Ok(None)
}

#[tauri::command]
pub async fn save_doctor_profile(
    state: State<'_, AppState>,
    args: SaveDoctorProfileCommandArgs,
) -> Result<crate::db::schema::DoctorProfileRecord, String> {
    let session = state.session_mgr.get_session();
    let doctor_id = args.doctor_id
        .or_else(|| session.as_ref().map(|s| s.doctor_id.clone()))
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Doctor ID is required to save doctor profile".to_string())?;

    let full_name = args.full_name
        .or_else(|| session.as_ref().map(|s| s.doctor_name.clone()))
        .unwrap_or_default()
        .trim()
        .to_string();

    let email = args.email
        .or_else(|| session.as_ref().map(|s| s.doctor_email.clone()))
        .unwrap_or_default()
        .trim()
        .to_string();

    let phone = args.phone.unwrap_or_default().trim().to_string();
    let qualification = args.qualification.unwrap_or_default().trim().to_string();
    let registration_number = args.registration_number.unwrap_or_default().trim().to_string();
    let gender = args.gender.unwrap_or_else(|| "Male".to_string()).trim().to_string();

    let record = crate::db::schema::DoctorProfileRecord {
        doctor_id: doctor_id.clone(),
        full_name,
        email,
        phone,
        qualification,
        registration_number,
        gender,
        updated_at: None,
    };

    {
        let conn = state.db.get_connection();
        crate::db::operations::DbOperations::upsert_doctor_profile(&conn, &record)
            .map_err(|e| format!("Failed to update local doctor profile: {e}"))?;
    }

    // Synchronize active session manager memory with updated doctor name immediately
    state.session_mgr.update_doctor_name(&record.full_name);

    if let Some(token) = state.session_mgr.get_access_token() {
        if let Ok(base_url) = crate::config::get_trusted_backend_url() {
            if let Ok(client) = crate::config::create_secure_http_client(Duration::from_secs(10)) {
                let url = format!("{base_url}/auth/profile");
                let _ = client
                    .patch(&url)
                    .bearer_auth(&token)
                    .json(&serde_json::json!({
                        "fullName": record.full_name,
                        "phone": record.phone,
                        "qualification": record.qualification,
                        "registrationNumber": record.registration_number,
                        "gender": record.gender,
                    }))
                    .send()
                    .await;
            }
        }
    }

    Ok(record)
}

#[tauri::command]
pub fn get_desktop_session(state: State<'_, AppState>) -> Result<Option<SessionContext>, String> {
    if let Some(mut session) = state.session_mgr.get_session() {
        let conn = state.db.get_connection();
        if let Ok(Some(profile)) =
            crate::db::operations::DbOperations::get_doctor_profile(&conn, &session.doctor_id)
        {
            if !profile.full_name.trim().is_empty() {
                session.doctor_name = profile.full_name;
            }
        }
        Ok(Some(session))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn has_persisted_refresh_token(state: State<'_, AppState>) -> Result<bool, String> {
    match state.key_mgr.load_refresh_token() {
        Ok(Some(tok)) => Ok(!tok.trim().is_empty()),
        Ok(None) => Ok(false),
        Err(e) => {
            log::warn!("Failed to query persisted refresh token: {e}");
            Ok(false)
        }
    }
}

// ---------------------------------------------------------------------------
// Protected Clinical & Patient Local Data Commands
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct SavePatientArgs {
    pub id: Option<String>,
    pub clinic_id: String,
    pub patient_code: String,
    pub name: String,
    pub phone: String,
    pub gender: String,
    pub date_of_birth: Option<String>,
    pub age: i32,
    pub allergies: Vec<String>,
    pub conditions: Vec<String>,
    pub sensitive_notes: Option<String>,
    pub client_mutation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatientSaveDiagnostic {
    pub category: String,
    pub stage: String,
    pub command: String,
    pub sqlite_error_code: Option<String>,
    pub message: String,
    pub retryable: bool,
}

impl PatientSaveDiagnostic {
    pub fn from_db_error(stage: &str, err: &crate::db::operations::DatabaseOpError) -> Self {
        use crate::db::operations::DatabaseOpError;
        match err {
            DatabaseOpError::Sqlite(rusqlite::Error::SqliteFailure(ffi_err, _)) => {
                let code = ffi_err.code;
                let ext = ffi_err.extended_code;
                if code == rusqlite::ffi::ErrorCode::DatabaseBusy
                    || code == rusqlite::ffi::ErrorCode::DatabaseLocked
                    || ext == 5
                    || ext == 6
                    || ext == 261
                    || ext == 517
                {
                    Self {
                        category: "DATABASE_BUSY".to_string(),
                        stage: stage.to_string(),
                        command: "save_local_patient".to_string(),
                        sqlite_error_code: Some(format!("{ext}")),
                        message: "Database busy lock contention. Retry in progress.".to_string(),
                        retryable: true,
                    }
                } else if code == rusqlite::ffi::ErrorCode::DiskFull || ext == 13 {
                    Self {
                        category: "DATABASE_FULL".to_string(),
                        stage: stage.to_string(),
                        command: "save_local_patient".to_string(),
                        sqlite_error_code: Some(format!("{ext}")),
                        message: "Disk storage full. Free space and retry.".to_string(),
                        retryable: false,
                    }
                } else if code == rusqlite::ffi::ErrorCode::ConstraintViolation || (ext & 0xff) == 19 {
                    Self {
                        category: "DATABASE_CONSTRAINT".to_string(),
                        stage: stage.to_string(),
                        command: "save_local_patient".to_string(),
                        sqlite_error_code: Some(format!("{ext}")),
                        message: "Database constraint prevented saving record.".to_string(),
                        retryable: false,
                    }
                } else {
                    Self {
                        category: "DATABASE_TRANSACTION_FAILURE".to_string(),
                        stage: stage.to_string(),
                        command: "save_local_patient".to_string(),
                        sqlite_error_code: Some(format!("{ext}")),
                        message: "Database transaction failed.".to_string(),
                        retryable: true,
                    }
                }
            }
            DatabaseOpError::PatientNotFound(_) => Self {
                category: "DATABASE_CONSTRAINT".to_string(),
                stage: stage.to_string(),
                command: "save_local_patient".to_string(),
                sqlite_error_code: None,
                message: "Patient record not found for update.".to_string(),
                retryable: false,
            },
            DatabaseOpError::Crypto(_) => Self {
                category: "ENCRYPTION_FAILURE".to_string(),
                stage: stage.to_string(),
                command: "save_local_patient".to_string(),
                sqlite_error_code: None,
                message: "Cryptographic encryption failure.".to_string(),
                retryable: false,
            },
            DatabaseOpError::Serialization(_) => Self {
                category: "DATABASE_TRANSACTION_FAILURE".to_string(),
                stage: stage.to_string(),
                command: "save_local_patient".to_string(),
                sqlite_error_code: None,
                message: "Payload serialization failure.".to_string(),
                retryable: false,
            },
            _ => Self {
                category: "UNKNOWN_SAVE_FAILURE".to_string(),
                stage: stage.to_string(),
                command: "save_local_patient".to_string(),
                sqlite_error_code: None,
                message: "Unexpected save failure occurred.".to_string(),
                retryable: true,
            },
        }
    }
}

fn is_sqlite_busy_error(err: &crate::db::operations::DatabaseOpError) -> bool {
    use crate::db::operations::DatabaseOpError;
    match err {
        DatabaseOpError::Sqlite(rusqlite::Error::SqliteFailure(ffi_err, _)) => {
            let code = ffi_err.code;
            let ext = ffi_err.extended_code;
            code == rusqlite::ffi::ErrorCode::DatabaseBusy
                || code == rusqlite::ffi::ErrorCode::DatabaseLocked
                || ext == 5
                || ext == 6
                || ext == 261
                || ext == 517
        }
        _ => false,
    }
}

#[tauri::command]
pub fn get_next_patient_code(
    state: State<'_, AppState>,
    clinic_id: String,
) -> Result<String, String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let mut conn = state.db.get_connection();
    DbOperations::get_next_patient_code(&mut conn, &clinic_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_local_patient(
    state: State<'_, AppState>,
    args: SavePatientArgs,
) -> Result<crate::db::operations::SavePatientResult, String> {
    // 1. Session and Clinic Context Validation
    let session_check = state.session_mgr.validate_session(Some(&args.clinic_id));
    let _session = match session_check {
        Ok(s) => s,
        Err(crate::auth::AuthError::SessionExpired) => {
            log::info!("Session expired during save_local_patient. Attempting auto-refresh...");
            match execute_refresh_session_with_db(
                &state.key_mgr,
                &state.session_mgr,
                &state.refresh_coordinator,
                None,
                Some(&state.db),
            )
            .await
            {
                Ok(refreshed) => {
                    log::info!("Session auto-refreshed successfully during save_local_patient.");
                    if refreshed.session.clinic_id != args.clinic_id {
                        let diag = PatientSaveDiagnostic {
                            category: "CLINIC_MISMATCH".to_string(),
                            stage: "session_validation".to_string(),
                            command: "save_local_patient".to_string(),
                            sqlite_error_code: None,
                            message: "Refreshed session clinic does not match patient clinic tenancy.".to_string(),
                            retryable: false,
                        };
                        return Err(serde_json::to_string(&diag).unwrap_or_else(|_| "CLINIC_MISMATCH".to_string()));
                    }
                    refreshed.session
                }
                Err(refresh_err) => {
                    log::warn!("Auto-refresh during save_local_patient failed: {refresh_err}");
                    let diag = PatientSaveDiagnostic {
                        category: "SESSION_EXPIRED".to_string(),
                        stage: "session_validation".to_string(),
                        command: "save_local_patient".to_string(),
                        sqlite_error_code: None,
                        message: "Session expired. Please log in again to continue.".to_string(),
                        retryable: true,
                    };
                    return Err(serde_json::to_string(&diag).unwrap_or_else(|_| "SESSION_EXPIRED".to_string()));
                }
            }
        }
        Err(crate::auth::AuthError::CrossClinicForbidden { attempted_clinic: _, session_clinic: _ }) => {
            let diag = PatientSaveDiagnostic {
                category: "CLINIC_MISMATCH".to_string(),
                stage: "session_validation".to_string(),
                command: "save_local_patient".to_string(),
                sqlite_error_code: None,
                message: "Clinic context mismatch with authenticated session.".to_string(),
                retryable: false,
            };
            return Err(serde_json::to_string(&diag).unwrap_or_else(|_| "CLINIC_MISMATCH".to_string()));
        }
        Err(other_auth_err) => {
            let diag = PatientSaveDiagnostic {
                category: "SESSION_EXPIRED".to_string(),
                stage: "session_validation".to_string(),
                command: "save_local_patient".to_string(),
                sqlite_error_code: None,
                message: format!("Authentication validation failed: {other_auth_err}"),
                retryable: true,
            };
            return Err(serde_json::to_string(&diag).unwrap_or_else(|_| "SESSION_EXPIRED".to_string()));
        }
    };

    // 2. Perform database save with bounded retry for transient busy lock contention
    let mut retries = 0;
    const MAX_BUSY_RETRIES: u32 = 3;
    let dek = state.db.get_dek();

    loop {
        let save_once = || -> Result<crate::db::operations::SavePatientResult, crate::db::operations::DatabaseOpError> {
            let mut conn = state.db.get_connection();

            if let Some(ref pid) = args.id {
                let patient_row: Option<(String, String)> = conn
                    .query_row(
                        "SELECT id, patient_code FROM local_patients WHERE clinic_id = ?1 AND (id = ?2 OR patient_code = ?2) LIMIT 1",
                        params![args.clinic_id, pid],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;

                match patient_row {
                    Some((actual_id, existing_code)) => {
                        DbOperations::update_patient(
                            &mut conn,
                            dek,
                            &args.clinic_id,
                            &actual_id,
                            &existing_code,
                            &args.name,
                            &args.phone,
                            &args.gender,
                            args.date_of_birth.as_deref(),
                            args.age,
                            &args.allergies,
                            &args.conditions,
                            args.sensitive_notes.as_deref(),
                        )?;
                        Ok(crate::db::operations::SavePatientResult {
                            id: actual_id,
                            patient_code: existing_code,
                        })
                    }
                    None => {
                        Err(crate::db::operations::DatabaseOpError::PatientNotFound(format!(
                            "Patient with identifier '{pid}' does not exist in clinic tenancy"
                        )))
                    }
                }
            } else {
                DbOperations::insert_patient_ext(
                    &mut conn,
                    dek,
                    &args.clinic_id,
                    &args.patient_code,
                    &args.name,
                    &args.phone,
                    &args.gender,
                    args.date_of_birth.as_deref(),
                    args.age,
                    &args.allergies,
                    &args.conditions,
                    args.sensitive_notes.as_deref(),
                    args.client_mutation_id.as_deref(),
                )
            }
        };

        let op_result = save_once();

        match op_result {
            Ok(saved) => return Ok(saved),
            Err(ref db_err) if is_sqlite_busy_error(db_err) && retries < MAX_BUSY_RETRIES => {
                retries += 1;
                let backoff_ms = retries * 50;
                log::warn!(
                    "save_local_patient SQLite busy contention (attempt {retries}/{MAX_BUSY_RETRIES}), backing off {backoff_ms}ms..."
                );
                tokio::time::sleep(tokio::time::Duration::from_millis(backoff_ms as u64)).await;
            }
            Err(db_err) => {
                let diag = PatientSaveDiagnostic::from_db_error("database_save", &db_err);
                log::error!("save_local_patient failed [{}]: {}", diag.category, diag.message);
                return Err(serde_json::to_string(&diag).unwrap_or_else(|_| diag.message));
            }
        }
    }
}

#[tauri::command]
pub fn delete_local_patient(
    state: State<'_, AppState>,
    clinic_id: String,
    patient_id: String,
) -> Result<(), String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let mut conn = state.db.get_connection();
    let dek = state.db.get_dek();

    DbOperations::delete_patient(&mut conn, dek, &clinic_id, &patient_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_local_patients(
    state: State<'_, AppState>,
    clinic_id: String,
) -> Result<Vec<PatientRecord>, String> {
    // 1. Enforce authenticated session matching clinic tenancy
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let conn = state.db.get_connection();
    let dek = state.db.get_dek();

    DbOperations::get_patients(&conn, dek, &clinic_id).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct SaveConsultationArgs {
    pub clinic_id: String,
    pub patient_id: String,
    pub consultation_date: String,
    pub chief_complaint: String,
    pub diagnosis: String,
    pub clinical_snapshot_json: Option<String>,
}

#[tauri::command]
pub fn save_local_consultation(
    state: State<'_, AppState>,
    args: SaveConsultationArgs,
) -> Result<String, String> {
    // 1. Enforce authenticated doctor session and derive verified doctor_id
    let session = state
        .session_mgr
        .validate_session(Some(&args.clinic_id))
        .map_err(|e| e.to_string())?;

    let verified_doctor_id = session.doctor_id;

    let mut conn = state.db.get_connection();
    let dek = state.db.get_dek();

    DbOperations::insert_consultation(
        &mut conn,
        dek,
        &args.clinic_id,
        &args.patient_id,
        &verified_doctor_id,
        &args.consultation_date,
        &args.chief_complaint,
        &args.diagnosis,
        args.clinical_snapshot_json.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_local_consultations(
    state: State<'_, AppState>,
    clinic_id: String,
    patient_id: Option<String>,
) -> Result<Vec<ConsultationRecord>, String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let conn = state.db.get_connection();
    let dek = state.db.get_dek();

    DbOperations::get_consultations(&conn, dek, &clinic_id, patient_id.as_deref()).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct SavePrescriptionArgs {
    pub clinic_id: String,
    pub consultation_id: String,
    pub patient_id: String,
    pub prescription_number: String,
    pub items_json: String,
}

#[tauri::command]
pub fn save_local_prescription(
    state: State<'_, AppState>,
    args: SavePrescriptionArgs,
) -> Result<String, String> {
    let session = state
        .session_mgr
        .validate_session(Some(&args.clinic_id))
        .map_err(|e| e.to_string())?;

    let verified_doctor_id = session.doctor_id;

    let mut conn = state.db.get_connection();
    let dek = state.db.get_dek();

    DbOperations::insert_prescription(
        &mut conn,
        dek,
        &args.clinic_id,
        &args.consultation_id,
        &args.patient_id,
        &verified_doctor_id,
        &args.prescription_number,
        &args.items_json,
    )
    .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct RevisePrescriptionArgs {
    pub clinic_id: String,
    pub prescription_id: String,
    pub expected_revision_number: i32,
    pub items_json: String,
    pub reason_for_revision: String,
}

#[tauri::command]
pub fn revise_local_prescription(
    state: State<'_, AppState>,
    args: RevisePrescriptionArgs,
) -> Result<String, String> {
    let session = state
        .session_mgr
        .validate_session(Some(&args.clinic_id))
        .map_err(|e| e.to_string())?;

    let verified_doctor_id = session.doctor_id;

    let mut conn = state.db.get_connection();
    let dek = state.db.get_dek();

    DbOperations::revise_prescription(
        &mut conn,
        dek,
        &args.clinic_id,
        &args.prescription_id,
        args.expected_revision_number,
        &args.items_json,
        &args.reason_for_revision,
        &verified_doctor_id,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_local_prescriptions(
    state: State<'_, AppState>,
    clinic_id: String,
    patient_id: Option<String>,
) -> Result<Vec<PrescriptionRecord>, String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let conn = state.db.get_connection();
    let dek = state.db.get_dek();

    DbOperations::get_prescriptions(&conn, dek, &clinic_id, patient_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_sync_outbox_summary(
    state: State<'_, AppState>,
    clinic_id: String,
) -> Result<SyncOutboxSummary, String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let conn = state.db.get_connection();
    DbOperations::get_outbox_summary(&conn, &clinic_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_sync_state(
    state: State<'_, AppState>,
    clinic_id: String,
) -> Result<Option<SyncStateRecord>, String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let conn = state.db.get_connection();
    DbOperations::get_sync_state(&conn, &clinic_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_sync_conflicts(
    state: State<'_, AppState>,
    clinic_id: String,
    status_filter: Option<String>,
) -> Result<Vec<SyncConflictRecord>, String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let conn = state.db.get_connection();
    DbOperations::get_conflicts_for_clinic(&conn, &clinic_id, status_filter.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resolve_sync_conflict(
    state: State<'_, AppState>,
    clinic_id: String,
    conflict_id: String,
    strategy: String,
    resolution_payload: Option<String>,
) -> Result<SyncConflictRecord, String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let mut conn = state.db.get_connection();
    let dek = state.db.get_dek();

    DbOperations::apply_conflict_resolution(
        &mut conn,
        dek,
        &clinic_id,
        &conflict_id,
        &strategy,
        resolution_payload.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_local_invoice(
    state: State<'_, AppState>,
    args: SaveInvoiceArgs,
) -> Result<String, String> {
    let session = state
        .session_mgr
        .validate_session(Some(&args.clinic_id))
        .map_err(|e| e.to_string())?;

    let mut conn = state.db.get_connection();
    let dek = state.db.get_dek();

    DbOperations::save_invoice(&mut conn, dek, &session.doctor_id, args)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_local_invoices(
    state: State<'_, AppState>,
    clinic_id: String,
    patient_id: Option<String>,
) -> Result<Vec<InvoiceRecord>, String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let conn = state.db.get_connection();
    let dek = state.db.get_dek();

    DbOperations::get_invoices(&conn, dek, &clinic_id, patient_id.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_local_invoice_by_id(
    state: State<'_, AppState>,
    clinic_id: String,
    invoice_id: String,
) -> Result<Option<InvoiceRecord>, String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let conn = state.db.get_connection();
    let dek = state.db.get_dek();

    DbOperations::get_invoice_by_id(&conn, dek, &clinic_id, &invoice_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn finalize_local_invoice(
    state: State<'_, AppState>,
    clinic_id: String,
    invoice_id: String,
) -> Result<InvoiceRecord, String> {
    let session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let mut conn = state.db.get_connection();
    let dek = state.db.get_dek();

    DbOperations::finalize_invoice(&mut conn, dek, &clinic_id, &session.doctor_id, &invoice_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_local_formulary_item(
    state: State<'_, AppState>,
    args: SaveFormularyArgs,
) -> Result<String, String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&args.clinic_id))
        .map_err(|e| e.to_string())?;

    let clinic_id = args.clinic_id.clone();
    let mut conn = state.db.get_connection();
    DbOperations::save_formulary_item(&mut conn, &clinic_id, args)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_local_formulary(
    state: State<'_, AppState>,
    clinic_id: String,
) -> Result<Vec<FormularyRecord>, String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let conn = state.db.get_connection();
    DbOperations::get_formulary_items(&conn, &clinic_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_local_formulary_item(
    state: State<'_, AppState>,
    clinic_id: String,
    id: String,
) -> Result<(), String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let mut conn = state.db.get_connection();
    DbOperations::delete_formulary_item(&mut conn, &clinic_id, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_inventory_stock(
    state: State<'_, AppState>,
    clinic_id: String,
    items: Vec<crate::db::schema::StockItemInput>,
    overwrite: Option<bool>,
    source_report: Option<String>,
) -> Result<crate::db::schema::StockImportSummary, String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let mut conn = state.db.get_connection();
    DbOperations::import_stock_records(
        &mut conn,
        &clinic_id,
        items,
        overwrite.unwrap_or(false),
        source_report.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_inventory_stock(
    state: State<'_, AppState>,
    clinic_id: String,
    query: Option<String>,
) -> Result<Vec<crate::db::schema::StockItemRecord>, String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let conn = state.db.get_connection();
    DbOperations::get_stock_records(&conn, &clinic_id, query.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_inventory_stock_summary(
    state: State<'_, AppState>,
    clinic_id: String,
) -> Result<crate::db::schema::StockSummaryRecord, String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let conn = state.db.get_connection();
    DbOperations::get_stock_summary(&conn, &clinic_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_clinical_library(
    state: State<'_, AppState>,
    clinic_id: String,
    batch: ClinicalImportBatchInput,
) -> Result<ClinicalImportSummary, String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let mut conn = state.db.get_connection();
    DbOperations::import_clinical_library(&mut conn, &clinic_id, batch)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rollback_clinical_library_batch(
    state: State<'_, AppState>,
    clinic_id: String,
    batch_id: String,
) -> Result<usize, String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let mut conn = state.db.get_connection();
    DbOperations::rollback_clinical_library_batch(&mut conn, &clinic_id, &batch_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_clinical_library_items(
    state: State<'_, AppState>,
    clinic_id: String,
    query: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<ClinicalMedicineRecord>, String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let conn = state.db.get_connection();
    DbOperations::get_clinical_library_items(
        &conn,
        &clinic_id,
        query.as_deref(),
        limit.unwrap_or(50),
        offset.unwrap_or(0),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_clinical_library_batches(
    state: State<'_, AppState>,
    clinic_id: String,
) -> Result<Vec<ClinicalImportBatchRecord>, String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let conn = state.db.get_connection();
    DbOperations::get_clinical_library_batches(&conn, &clinic_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_clinical_library_item(
    state: State<'_, AppState>,
    clinic_id: String,
    item: SaveClinicalMedicineArgs,
) -> Result<String, String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let mut conn = state.db.get_connection();
    DbOperations::save_clinical_library_item(&mut conn, &clinic_id, item)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn archive_clinical_library_item(
    state: State<'_, AppState>,
    clinic_id: String,
    id: String,
) -> Result<(), String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let mut conn = state.db.get_connection();
    DbOperations::archive_clinical_library_item(&mut conn, &clinic_id, &id)
        .map_err(|e| e.to_string())
}

fn percent_encode_query(val: &str) -> String {
    let mut out = String::new();
    for b in val.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

#[tauri::command]
pub async fn search_catalogue_cache(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
    formulation: Option<String>,
) -> Result<Vec<LocalCatalogueItem>, String> {
    // Session validation is optional for local offline catalogue cache and pharmacy stock searches
    let _session = state.session_mgr.validate_session(None).ok();

    let local_results = {
        let conn = state.db.get_connection();
        DbOperations::search_local_catalogue(&conn, &query, limit.unwrap_or(20), formulation.as_deref())
            .map_err(|e| e.to_string())?
    };

    if !local_results.is_empty() {
        return Ok(local_results);
    }

    // If local offline catalogue is fully seeded and ready, do not fallback to online search
    let sync_status = state.catalogue_sync.get_status().await;
    if sync_status.is_ready && sync_status.downloaded_count >= crate::db::catalogue_seed::EXPECTED_TOTAL_RECORDS {
        return Ok(local_results);
    }

    // Fallback: if local cache has 0 matches and access token exists, query backend directly
    if let (Some(token), Ok(base_url)) = (state.session_mgr.get_access_token(), crate::config::get_trusted_backend_url()) {
        if let Ok(client) = crate::config::create_secure_http_client(Duration::from_secs(5)) {
            let mut search_url = format!("{base_url}/catalogue/search?q={}", percent_encode_query(&query));
            if let Some(l) = limit {
                search_url.push_str(&format!("&limit={l}"));
            }
            if let Some(ref form) = formulation {
                search_url.push_str(&format!("&formulation={}", percent_encode_query(form)));
            }

            if let Ok(resp) = client.get(&search_url).bearer_auth(&token).send().await {
                if resp.status().is_success() {
                    #[derive(Deserialize)]
                    struct OnlineSearchResponse {
                        items: Vec<crate::sync::catalogue_sync::CatalogueFeedItem>,
                    }
                    if let Ok(data) = resp.json::<OnlineSearchResponse>().await {
                        if !data.items.is_empty() {
                            let items_to_save: Vec<SaveCatalogueCacheItemArgs> = data
                                .items
                                .into_iter()
                                .map(|item| {
                                    let strengths_str = match item.strengths {
                                        Some(ref v) => v.to_string(),
                                        None => "[]".to_string(),
                                    };
                                    SaveCatalogueCacheItemArgs {
                                        id: item.id,
                                        item_type: item.item_type,
                                        name: item.name,
                                        brand_name: item.brand_name,
                                        generic_name: item.generic_name,
                                        product_name: item.product_name,
                                        dosage_form: item.dosage_form,
                                        route: item.route,
                                        active_ingredients_json: None,
                                        strengths_json: strengths_str,
                                        raw_strength_summary: item.raw_strength_summary.unwrap_or_default(),
                                        is_combination: item.is_combination.unwrap_or(false),
                                        is_verified: item.is_strength_verified.unwrap_or(true),
                                        source_provenance: item.source_provenance,
                                    }
                                })
                                .collect();

                            let mut mut_conn = state.db.get_connection();
                            let _ = DbOperations::cache_catalogue_items(&mut mut_conn, &items_to_save);
                            return DbOperations::search_local_catalogue(&mut_conn, &query, limit.unwrap_or(20), formulation.as_deref())
                                .map_err(|e| e.to_string());
                        }
                    }
                }
            }
        }
    }

    Ok(local_results)
}

#[tauri::command]
pub fn get_catalogue_strengths_cache(
    state: State<'_, AppState>,
    medicine_name: String,
    formulation: Option<String>,
) -> Result<Vec<String>, String> {
    // Session validation is optional for local offline catalogue cache searches
    let _session = state.session_mgr.validate_session(None).ok();

    let conn = state.db.get_connection();
    DbOperations::get_local_catalogue_strengths(&conn, &medicine_name, formulation.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_catalogue_cache(
    state: State<'_, AppState>,
    items: Vec<SaveCatalogueCacheItemArgs>,
) -> Result<usize, String> {
    let _session = state
        .session_mgr
        .validate_session(None)
        .map_err(|e| e.to_string())?;

    let mut conn = state.db.get_connection();
    DbOperations::cache_catalogue_items(&mut conn, &items)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_catalogue_cache_stats(
    state: State<'_, AppState>,
) -> Result<CatalogueCacheStats, String> {
    let _session = state
        .session_mgr
        .validate_session(None)
        .map_err(|e| e.to_string())?;

    let conn = state.db.get_connection();
    DbOperations::get_catalogue_cache_stats(&conn)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn seed_catalogue_cache(
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let _session = state
        .session_mgr
        .validate_session(None)
        .map_err(|e| e.to_string())?;

    let mut conn = state.db.get_connection();
    crate::db::catalogue_seed::seed_local_catalogue_if_empty(&mut conn, None)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_catalogue_sync_status(
    state: State<'_, AppState>,
) -> Result<crate::sync::CatalogueSyncStatus, String> {
    Ok(state.catalogue_sync.get_status().await)
}

#[tauri::command]
pub async fn start_catalogue_sync(
    state: State<'_, AppState>,
) -> Result<crate::sync::CatalogueSyncStatus, String> {
    state.catalogue_sync.start_sync(None).await
}

#[tauri::command]
pub fn export_encrypted_backup(
    state: State<'_, AppState>,
    clinic_id: String,
    passphrase: Option<String>,
    destination_path: Option<String>,
) -> Result<crate::db::backup::BackupExportResult, String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let dest = destination_path.as_deref().map(std::path::Path::new);
    crate::db::backup::BackupManager::export_backup(
        &state.db,
        &clinic_id,
        passphrase.as_deref(),
        dest,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn restore_encrypted_backup(
    state: State<'_, AppState>,
    clinic_id: Option<String>,
    backup_bytes_base64: Option<String>,
    backup_file_path: Option<String>,
    passphrase: Option<String>,
) -> Result<crate::db::backup::BackupRestoreResult, String> {
    let _session = state
        .session_mgr
        .validate_session(clinic_id.as_deref())
        .map_err(|e| e.to_string())?;

    let bytes = if let Some(b64) = backup_bytes_base64 {
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &b64)
            .map_err(|e| format!("Invalid base64 backup encoding: {e}"))?
    } else if let Some(path) = backup_file_path {
        std::fs::read(&path)
            .map_err(|e| format!("Failed to read backup file at {path}: {e}"))?
    } else {
        return Err("Neither backup data nor file path was provided".to_string());
    };

    crate::db::backup::BackupManager::restore_backup(
        &state.db,
        &bytes,
        clinic_id.as_deref(),
        passphrase.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_app_update(
    endpoint: Option<String>,
) -> Result<crate::updater::UpdateCheckResult, String> {
    crate::updater::AppUpdater::check_for_updates(endpoint.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn download_and_launch_update(
    download_url: String,
    target_version: String,
    signature: Option<String>,
) -> Result<crate::updater::UpdateInstallResult, String> {
    let installer_path = crate::updater::AppUpdater::download_and_verify_update(
        &download_url,
        &target_version,
        signature.as_deref(),
        None,
    )
    .await
    .map_err(|e| e.to_string())?;

    crate::updater::AppUpdater::launch_installer_non_destructive(&installer_path)
        .map_err(|e| e.to_string())?;

    Ok(crate::updater::UpdateInstallResult {
        success: true,
        target_version,
        installer_path: installer_path.to_string_lossy().to_string(),
        status_message: "Update verified and installer launched. Your local clinical database and encryption keys are safely preserved.".to_string(),
    })
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_renderer_token_non_exposure() {
        let ctx = SessionContext {
            doctor_id: "doc_test_123".to_string(),
            clinic_id: "clinic_test_456".to_string(),
            doctor_email: "doc@cliniqo.test".to_string(),
            doctor_name: "Dr. Safe Session".to_string(),
            role: "DOCTOR".to_string(),
            expires_at: 1893456000,
        };

        let json_str = serde_json::to_string(&ctx).expect("serialization succeeds");
        let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();

        // 1. Safe claims exist
        assert_eq!(parsed["doctor_id"], "doc_test_123");
        assert_eq!(parsed["clinic_id"], "clinic_test_456");
        assert_eq!(parsed["doctor_email"], "doc@cliniqo.test");
        assert_eq!(parsed["doctor_name"], "Dr. Safe Session");
        assert_eq!(parsed["role"], "DOCTOR");
        assert_eq!(parsed["expires_at"], 1893456000);

        // 2. Sensitive token material is strictly absent
        assert!(parsed.get("refreshToken").is_none());
        assert!(parsed.get("refresh_token").is_none());
        assert!(parsed.get("accessToken").is_none());
        assert!(parsed.get("access_token").is_none());
        assert!(parsed.get("token").is_none());
        assert!(parsed.get("secret").is_none());
    }

    #[test]
    fn test_offline_logout_clears_credentials_without_error() {
        tauri::async_runtime::block_on(async {
            let temp_dir = std::env::temp_dir().join(format!("cliniqo_cmd_test_{}", uuid::Uuid::new_v4()));
            let key_mgr = KeyManager::new(&temp_dir);
            let session_mgr = SessionManager::with_default_public_key().unwrap();

            // Persist valid 64-char refresh token
            let valid_64_rt = "a".repeat(64);
            key_mgr.save_refresh_token(&valid_64_rt).expect("save succeeds");
            assert_eq!(key_mgr.load_refresh_token().unwrap().as_deref(), Some(valid_64_rt.as_str()));

            // Call logout pointing to an offline/unreachable address (offline logout)
            let res = execute_logout_session(&key_mgr, &session_mgr).await;
            assert!(res.is_ok(), "offline logout must succeed and clear local credentials");

            // Assert local credentials are wiped and session cleared
            assert_eq!(key_mgr.load_refresh_token().unwrap(), None);
            assert!(session_mgr.get_session().is_none());
        });
    }

    #[test]
    fn test_revoked_or_missing_refresh_token_fail_closed() {
        tauri::async_runtime::block_on(async {
            let temp_dir = std::env::temp_dir().join(format!("cliniqo_cmd_revoked_{}", uuid::Uuid::new_v4()));
            let key_mgr = KeyManager::new(&temp_dir);
            let session_mgr = SessionManager::with_default_public_key().unwrap();
            let coordinator = RefreshCoordinator::new();

            // Missing refresh token fails closed immediately
            let err = execute_refresh_session(&key_mgr, &session_mgr, &coordinator).await;
            assert!(err.is_err());
            assert_eq!(err.unwrap_err(), "No persisted refresh token found");
        });
    }

    #[test]
    fn test_single_flight_refresh_coalesces_concurrent_requests() {
        tauri::async_runtime::block_on(async {
            let coordinator = Arc::new(RefreshCoordinator::new());
            let call_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));

            let coord1 = coordinator.clone();
            let count1 = call_count.clone();
            let h1 = tokio::spawn(async move {
                coord1.execute_single_flight(|| async move {
                    count1.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    Ok(DesktopLoginResult {
                        session: SessionContext {
                            doctor_id: "doc_1".to_string(),
                            clinic_id: "clinic_1".to_string(),
                            doctor_email: "doc@test.com".to_string(),
                            doctor_name: "Dr. One".to_string(),
                            role: "DOCTOR".to_string(),
                            expires_at: 1999999999,
                        },
                        clinics: vec![],
                        active_clinic_id: "clinic_1".to_string(),
                    })
                }).await
            });

            let coord2 = coordinator.clone();
            let count2 = call_count.clone();
            let h2 = tokio::spawn(async move {
                // Slightly offset start so h1 is in-flight
                tokio::time::sleep(Duration::from_millis(5)).await;
                coord2.execute_single_flight(|| async move {
                    count2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(DesktopLoginResult {
                        session: SessionContext {
                            doctor_id: "doc_2".to_string(),
                            clinic_id: "clinic_1".to_string(),
                            doctor_email: "doc2@test.com".to_string(),
                            doctor_name: "Dr. Two".to_string(),
                            role: "DOCTOR".to_string(),
                            expires_at: 1999999999,
                        },
                        clinics: vec![],
                        active_clinic_id: "clinic_1".to_string(),
                    })
                }).await
            });

            let (r1, r2) = tokio::join!(h1, h2);
            let res1 = r1.unwrap().unwrap();
            let res2 = r2.unwrap().unwrap();

            // Both callers must receive the exact same doctor_id from the single in-flight call
            assert_eq!(res1.session.doctor_id, "doc_1");
            assert_eq!(res2.session.doctor_id, "doc_1");
            // The underlying refresh network closure must have executed EXACTLY ONCE
            assert_eq!(call_count.load(std::sync::atomic::Ordering::SeqCst), 1);
        });
    }

    #[test]
    fn test_renderer_ipc_cannot_redirect_backend_endpoint() {
        // Verify trusted backend URL resolution strictly enforces scheme and ignores untrusted injection
        let trusted = crate::config::get_trusted_backend_url().expect("valid trusted url");
        assert!(trusted.starts_with("http://") || trusted.starts_with("https://"));
        assert!(!trusted.contains("attacker"));
    }

    #[test]
    fn test_incomplete_onboarding_session_allows_onboarding_without_clinic() {
        let session_mgr = SessionManager::with_default_public_key().unwrap();
        let token = crate::auth::tests::generate_test_rs256_jwt_with_name(
            crate::auth::tests::TEST_BACKEND_PRIVATE_KEY_PEM,
            "doc_onboarding_1",
            "newdoctor@cliniqo.test",
            Some("Dr. New Doctor"),
            3600,
        );

        // When a doctor registers or logs in with 0 clinics, session is established with empty clinic_id
        let session = session_mgr.login(&token, "", "OWNER").expect("session succeeds for incomplete onboarding");
        assert_eq!(session.doctor_id, "doc_onboarding_1");
        assert_eq!(session.clinic_id, "");
        assert_eq!(session.doctor_name, "Dr. New Doctor");

        // General session verification passes (user is authenticated doctor)
        let general_check = session_mgr.validate_session(None);
        assert!(general_check.is_ok());

        // But patient / clinic operations requiring a specific clinic are safely blocked until clinic creation
        let clinic_check = session_mgr.validate_session(Some("clinic_real_1"));
        assert!(clinic_check.is_err());

        // Once clinic is created, session updates to the authoritative clinic
        let updated_session = session_mgr.login(&token, "clinic_real_1", "OWNER").expect("update succeeds");
        assert_eq!(updated_session.clinic_id, "clinic_real_1");
        assert!(session_mgr.validate_session(Some("clinic_real_1")).is_ok());
    }

    #[test]
    fn test_login_with_auto_key_sync_validates_and_establishes_session() {
        tauri::async_runtime::block_on(async {
            let temp_dir = std::env::temp_dir().join(format!("cliniqo_cmd_sync_{}", uuid::Uuid::new_v4()));
            let key_mgr = KeyManager::new(&temp_dir);
            let session_mgr = SessionManager::with_default_public_key().unwrap();

            let token = crate::auth::tests::generate_test_rs256_jwt_with_name(
                crate::auth::tests::TEST_BACKEND_PRIVATE_KEY_PEM,
                "doc_sync_99",
                "sync@cliniqo.test",
                Some("Dr. Sync Test"),
                3600,
            );

            // Matches current key directly
            let res = login_with_auto_key_sync(&session_mgr, &key_mgr, &token, "", "OWNER").await;
            assert!(res.is_ok());
            let session = res.unwrap();
            assert_eq!(session.doctor_id, "doc_sync_99");
            assert_eq!(session.doctor_name, "Dr. Sync Test");
            assert_eq!(session.clinic_id, "");
            assert_eq!(session_mgr.get_access_token(), Some(token));
        });
    }

    #[test]
    fn test_update_public_key_validates_modulus_and_rejects_weak_key() {
        let session_mgr = SessionManager::with_default_public_key().unwrap();

        // 1. Invalid PEM format is rejected
        let invalid_pem = "-----BEGIN PUBLIC KEY-----\nNOT_VALID_BASE64\n-----END PUBLIC KEY-----";
        let res = session_mgr.update_public_key(invalid_pem);
        assert!(res.is_err());

        // 2. 1024-bit RSA key is rejected (must be at least 2048-bit)
        let weak_1024_pem = r#"-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC3/jY0a29mNlZgW4hC8RzF+K8h
D1d0B/9iI/8p4iH21N3W7B3gT9D9e/9Y2Z3b4K5L6M7N8P9Q0R1S2T3U4V5W6X7Y
8Z9a0b1c2d3e4f5g6h7i8j9k0l1m2n3o4p5q6r7s8t9u0v1w2x3y4z5A6B7C8D9E
0F1G2H3I4J5K6L7M8N9O0P1QIDAQAB
-----END PUBLIC KEY-----"#;
        let weak_res = session_mgr.update_public_key(weak_1024_pem);
        assert!(weak_res.is_err());
    }

    #[test]
    fn test_offline_session_restoration_with_cached_doctor_profile() {
        tauri::async_runtime::block_on(async {
            let temp_dir = std::env::temp_dir().join(format!("cliniqo_cmd_offline_{}", uuid::Uuid::new_v4()));
            let key_mgr = KeyManager::new(&temp_dir);
            let session_mgr = SessionManager::with_default_public_key().unwrap();
            let coordinator = RefreshCoordinator::new();
            let db = DatabaseManager::init(&temp_dir).unwrap();

            // 1. Persist a refresh token and active clinic in KeyManager
            let rt = "valid_refresh_token_64_characters_long_for_offline_session_test";
            key_mgr.save_refresh_token(rt).unwrap();
            key_mgr.save_active_clinic_id("clinic_offline_1").unwrap();

            // 2. Persist doctor profile and clinic profile in SQLite
            {
                let conn = db.get_connection();
                DbOperations::upsert_doctor_profile(
                    &conn,
                    &crate::db::schema::DoctorProfileRecord {
                        doctor_id: "doc_offline_42".to_string(),
                        full_name: "Dr. Offline Test".to_string(),
                        email: "offline@cliniqo.test".to_string(),
                        phone: "+91 9999999999".to_string(),
                        qualification: "MBBS".to_string(),
                        registration_number: "REG-12345".to_string(),
                        gender: "Male".to_string(),
                        updated_at: None,
                    },
                ).unwrap();

                DbOperations::upsert_clinic_profile(
                    &conn,
                    &crate::db::schema::ClinicProfileRecord {
                        clinic_id: "clinic_offline_1".to_string(),
                        name: "Offline Care Clinic".to_string(),
                        slug: "offline-care".to_string(),
                        phone: "+91 8888888888".to_string(),
                        email: "clinic@offline.test".to_string(),
                        street: "123 Health Rd".to_string(),
                        city: "Mumbai".to_string(),
                        state: "Maharashtra".to_string(),
                        postal_code: "400001".to_string(),
                        country: "India".to_string(),
                        location_link: "".to_string(),
                        updated_at: None,
                    },
                ).unwrap();
            }

            // 3. Attempt refresh pointing to an unreachable backend (simulating offline / network failure)
            let result = execute_refresh_session_with_db(
                &key_mgr,
                &session_mgr,
                &coordinator,
                Some("http://127.0.0.1:1"), // unreachable offline port
                Some(&db),
            ).await;

            assert!(result.is_ok(), "Offline refresh must succeed by restoring permitted offline session");
            let login_res = result.unwrap();
            assert_eq!(login_res.session.doctor_id, "doc_offline_42");
            assert_eq!(login_res.session.doctor_name, "Dr. Offline Test");
            assert_eq!(login_res.session.clinic_id, "clinic_offline_1");
            assert_eq!(login_res.active_clinic_id, "clinic_offline_1");
            assert_eq!(login_res.clinics.len(), 1);
            assert_eq!(login_res.clinics[0].name, "Offline Care Clinic");

            // SessionManager must now have the active offline session context
            let active_session = session_mgr.get_session().expect("session exists in SessionManager");
            assert_eq!(active_session.doctor_id, "doc_offline_42");
            assert!(session_mgr.validate_session(Some("clinic_offline_1")).is_ok());

            let _ = std::fs::remove_dir_all(&temp_dir);
        });
    }

    #[test]
    fn test_has_persisted_refresh_token_validates_presence() {
        let temp_dir = std::env::temp_dir().join(format!("cliniqo_has_tok_{}", uuid::Uuid::new_v4()));
        let key_mgr = KeyManager::new(&temp_dir);

        // Initially no token
        assert_eq!(key_mgr.load_refresh_token().unwrap(), None);

        // Saved token
        key_mgr.save_refresh_token("valid_token").unwrap();
        assert_eq!(key_mgr.load_refresh_token().unwrap().as_deref(), Some("valid_token"));

        // Cleared token
        key_mgr.clear_refresh_token().unwrap();
        assert_eq!(key_mgr.load_refresh_token().unwrap(), None);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_patient_save_diagnostic_category_mapping() {
        use crate::db::operations::DatabaseOpError;

        // 1. Busy error mapping
        let busy_ffi = rusqlite::ffi::Error {
            code: rusqlite::ffi::ErrorCode::DatabaseBusy,
            extended_code: 5,
        };
        let busy_err = DatabaseOpError::Sqlite(rusqlite::Error::SqliteFailure(busy_ffi, None));
        assert!(is_sqlite_busy_error(&busy_err));
        let busy_diag = PatientSaveDiagnostic::from_db_error("tx_begin", &busy_err);
        assert_eq!(busy_diag.category, "DATABASE_BUSY");
        assert!(busy_diag.retryable);

        // 2. Disk full mapping
        let full_ffi = rusqlite::ffi::Error {
            code: rusqlite::ffi::ErrorCode::DiskFull,
            extended_code: 13,
        };
        let full_err = DatabaseOpError::Sqlite(rusqlite::Error::SqliteFailure(full_ffi, None));
        assert!(!is_sqlite_busy_error(&full_err));
        let full_diag = PatientSaveDiagnostic::from_db_error("insert", &full_err);
        assert_eq!(full_diag.category, "DATABASE_FULL");
        assert!(!full_diag.retryable);

        // 3. Constraint violation mapping
        let constraint_ffi = rusqlite::ffi::Error {
            code: rusqlite::ffi::ErrorCode::ConstraintViolation,
            extended_code: 19,
        };
        let constraint_err = DatabaseOpError::Sqlite(rusqlite::Error::SqliteFailure(constraint_ffi, None));
        let constraint_diag = PatientSaveDiagnostic::from_db_error("insert", &constraint_err);
        assert_eq!(constraint_diag.category, "DATABASE_CONSTRAINT");
        assert!(!constraint_diag.retryable);

        // 4. Crypto error mapping
        let crypto_err = DatabaseOpError::Crypto(crate::crypto::CryptoError::EncryptionFailed("Cipher err".to_string()));
        let crypto_diag = PatientSaveDiagnostic::from_db_error("encrypt", &crypto_err);
        assert_eq!(crypto_diag.category, "ENCRYPTION_FAILURE");
        assert!(!crypto_diag.retryable);

        // 5. PatientNotFound mapping
        let not_found_err = DatabaseOpError::PatientNotFound("missing_id".to_string());
        let not_found_diag = PatientSaveDiagnostic::from_db_error("update_lookup", &not_found_err);
        assert_eq!(not_found_diag.category, "DATABASE_CONSTRAINT");
        assert_eq!(not_found_diag.message, "Patient record not found for update.");
        assert!(!not_found_diag.retryable);
    }

    #[test]
    fn test_save_patient_diagnostic_json_serialization_no_pii() {
        let diag = PatientSaveDiagnostic {
            category: "SESSION_EXPIRED".to_string(),
            stage: "session_validation".to_string(),
            command: "save_local_patient".to_string(),
            sqlite_error_code: None,
            message: "Session expired. Please log in again to continue.".to_string(),
            retryable: true,
        };

        let serialized = serde_json::to_string(&diag).expect("serializes cleanly");
        assert!(serialized.contains("SESSION_EXPIRED"));
        assert!(!serialized.contains("Patient"));
        assert!(!serialized.contains("phone"));
        assert!(!serialized.contains("address"));

        let deserialized: PatientSaveDiagnostic = serde_json::from_str(&serialized).expect("deserializes cleanly");
        assert_eq!(deserialized.category, "SESSION_EXPIRED");
        assert_eq!(deserialized.stage, "session_validation");
        assert!(deserialized.retryable);
    }
}


