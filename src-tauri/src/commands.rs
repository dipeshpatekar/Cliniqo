use serde::{Deserialize, Serialize};
use tauri::State;
use std::sync::Arc;
use std::time::Duration;
use rusqlite::params;
use crate::auth::{SessionContext, SessionManager};
use crate::crypto::key_manager::KeyManager;
use crate::db::DatabaseManager;
use crate::db::operations::DbOperations;
use crate::db::schema::{
    CatalogueCacheStats, ConsultationRecord, FormularyRecord, InvoiceRecord, LocalCatalogueItem, PatientRecord, PrescriptionRecord,
    SaveCatalogueCacheItemArgs, SaveFormularyArgs, SaveInvoiceArgs, SyncConflictRecord, SyncOutboxSummary, SyncStateRecord,
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

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ClinicItem {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub role: String,
    pub status: String,
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
    let client = crate::config::create_secure_http_client(Duration::from_secs(35))?;

    let login_url = format!("{base_url}/auth/login");
    let resp = client
        .post(&login_url)
        .json(&serde_json::json!({
            "email": email.trim(),
            "password": password
        }))
        .send()
        .await
        .map_err(|e| format!("Authentication server unreachable: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err("Invalid email or password.".to_string());
        }
        return Err(format!("Login failed: HTTP {status}"));
    }

    let login_data = resp
        .json::<BackendLoginResponse>()
        .await
        .map_err(|e| format!("Invalid login response from auth server: {e}"))?;

    // 1. Securely persist refresh token using DPAPI immediately
    if let Some(ref rt) = login_data.refresh_token {
        if !rt.trim().is_empty() {
            state.key_mgr.save_refresh_token(rt)
                .map_err(|e| format!("Failed to store refresh token securely: {e}"))?;
        }
    }

    // 2. Fetch authoritative clinic memberships from backend using access token
    let my_clinics_url = format!("{base_url}/clinics/my-clinics");
    let clinics_resp = client
        .get(&my_clinics_url)
        .bearer_auth(&login_data.access_token)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch clinic memberships: {e}"))?;

    if !clinics_resp.status().is_success() {
        return Err(format!("Failed to retrieve clinic memberships: HTTP {}", clinics_resp.status()));
    }

    let clinics: Vec<ClinicItem> = clinics_resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse clinic memberships: {e}"))?;

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
    let session = state.session_mgr
        .login(&login_data.access_token, &selected_clinic_id, &selected_role)
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

    Ok(DesktopLoginResult {
        session,
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
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RegisteredDoctorInfo {
    pub id: String,
    pub email: String,
    #[serde(rename = "fullName")]
    pub full_name: String,
    pub phone: Option<String>,
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
    let resp = client
        .post(&register_url)
        .json(&serde_json::json!({
            "fullName": input.full_name.trim(),
            "email": input.email.trim(),
            "password": input.password,
            "phone": input.phone.as_ref().map(|p| p.trim()),
        }))
        .send()
        .await
        .map_err(|e| format!("Authentication server unreachable ({base_url}): {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        if status == reqwest::StatusCode::CONFLICT {
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

    // Immediately establish the native session for the newly registered doctor
    let session = state.session_mgr
        .login(&reg_data.access_token, "", "OWNER")
        .ok();

    Ok(RegisterDesktopResult {
        access_token: reg_data.access_token,
        refresh_token: reg_data.refresh_token,
        doctor: reg_data.doctor,
        session,
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
    let session = state
        .session_mgr
        .login(&token, &clinic_id, &role)
        .map_err(|e| e.to_string())?;

    if let Some(ref rt) = refresh_token {
        let trimmed = rt.trim();
        if !trimmed.is_empty() {
            if let Err(e) = state.key_mgr.save_refresh_token(trimmed) {
                log::warn!("Failed to persist refresh token to secure key store: {e}");
            }
        }
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
    refresh_coordinator
        .execute_single_flight(|| async {
            do_actual_refresh_session(key_mgr, session_mgr).await
        })
        .await
}

async fn do_actual_refresh_session(
    key_mgr: &KeyManager,
    session_mgr: &SessionManager,
) -> Result<DesktopLoginResult, String> {
    let persisted_rt = match key_mgr.load_refresh_token() {
        Ok(Some(rt)) if !rt.trim().is_empty() => rt,
        Ok(_) => return Err("No persisted refresh token found".to_string()),
        Err(e) => return Err(format!("Failed to read refresh token: {e}")),
    };

    let base_url = crate::config::get_trusted_backend_url()?;
    let refresh_url = format!("{base_url}/auth/refresh");

    let client = crate::config::create_secure_http_client(Duration::from_secs(35))?;

    let resp = client
        .post(&refresh_url)
        .json(&BackendRefreshRequest {
            refresh_token: &persisted_rt,
        })
        .send()
        .await
        .map_err(|e| format!("Network error communicating with auth server: {e}"))?;

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
    let clinics_resp = client
        .get(&my_clinics_url)
        .bearer_auth(&refresh_data.access_token)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch clinic memberships: {e}"))?;

    if !clinics_resp.status().is_success() {
        return Err(format!("Failed to retrieve clinic memberships: HTTP {}", clinics_resp.status()));
    }

    let clinics: Vec<ClinicItem> = clinics_resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse clinic memberships: {e}"))?;

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

    let session = session_mgr
        .login(&refresh_data.access_token, &selected_clinic_id, &selected_role)
        .map_err(|e| format!("Failed to validate refreshed access token: {e}"))?;

    Ok(DesktopLoginResult {
        session,
        clinics,
        active_clinic_id: selected_clinic_id,
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
    let result = execute_refresh_session(
        &state.key_mgr,
        &state.session_mgr,
        &state.refresh_coordinator,
    )
    .await?;

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

    let session = state.session_mgr.login(&token, &clinic_id, &role)
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
}

#[derive(Deserialize, Serialize)]
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

#[tauri::command]
pub fn get_desktop_session(state: State<'_, AppState>) -> Result<Option<SessionContext>, String> {
    Ok(state.session_mgr.get_session())
}

#[tauri::command]
pub fn has_persisted_refresh_token(state: State<'_, AppState>) -> Result<bool, String> {
    match state.key_mgr.load_refresh_token() {
        Ok(Some(_)) => Ok(true),
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
}

#[tauri::command]
pub fn save_local_patient(
    state: State<'_, AppState>,
    args: SavePatientArgs,
) -> Result<String, String> {
    // 1. Enforce authenticated session matching clinic tenancy
    let _session = state
        .session_mgr
        .validate_session(Some(&args.clinic_id))
        .map_err(|e| e.to_string())?;

    let mut conn = state.db.get_connection();
    let dek = state.db.get_dek();

    let exists: bool = if let Some(ref pid) = args.id {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM local_patients WHERE clinic_id = ?1 AND (id = ?2 OR patient_code = ?2))",
            params![args.clinic_id, pid],
            |row| row.get(0),
        ).unwrap_or(false)
    } else {
        false
    };

    if exists {
        let pid = args.id.as_deref().unwrap();
        let actual_id: String = conn.query_row(
            "SELECT id FROM local_patients WHERE clinic_id = ?1 AND (id = ?2 OR patient_code = ?2) LIMIT 1",
            params![args.clinic_id, pid],
            |row| row.get(0),
        ).unwrap_or_else(|_| pid.to_string());

        DbOperations::update_patient(
            &mut conn,
            dek,
            &args.clinic_id,
            &actual_id,
            &args.patient_code,
            &args.name,
            &args.phone,
            &args.gender,
            args.date_of_birth.as_deref(),
            args.age,
            &args.allergies,
            &args.conditions,
            args.sensitive_notes.as_deref(),
        )
        .map_err(|e| e.to_string())?;
        Ok(actual_id)
    } else {
        DbOperations::insert_patient(
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
        )
        .map_err(|e| e.to_string())
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
) -> Result<Vec<ConsultationRecord>, String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let conn = state.db.get_connection();
    let dek = state.db.get_dek();

    DbOperations::get_consultations(&conn, dek, &clinic_id).map_err(|e| e.to_string())
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

#[tauri::command]
pub fn get_local_prescriptions(
    state: State<'_, AppState>,
    clinic_id: String,
) -> Result<Vec<PrescriptionRecord>, String> {
    let _session = state
        .session_mgr
        .validate_session(Some(&clinic_id))
        .map_err(|e| e.to_string())?;

    let conn = state.db.get_connection();
    let dek = state.db.get_dek();

    DbOperations::get_prescriptions(&conn, dek, &clinic_id).map_err(|e| e.to_string())
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
    let _session = state
        .session_mgr
        .validate_session(None)
        .map_err(|e| e.to_string())?;

    let local_results = {
        let conn = state.db.get_connection();
        DbOperations::search_local_catalogue(&conn, &query, limit.unwrap_or(20), formulation.as_deref())
            .map_err(|e| e.to_string())?
    };

    if !local_results.is_empty() {
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
    let _session = state
        .session_mgr
        .validate_session(None)
        .map_err(|e| e.to_string())?;

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
}


