use serde::{Deserialize, Serialize};
use tauri::State;
use std::sync::Arc;
use crate::auth::{SessionContext, SessionManager};
use crate::db::DatabaseManager;
use crate::db::operations::DbOperations;
use crate::db::schema::{
    ConsultationRecord, PatientRecord, PrescriptionRecord, SyncOutboxSummary,
};

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

#[tauri::command]
pub fn login_desktop_session(
    state: State<'_, AppState>,
    token: String,
    clinic_id: String,
    role: String,
) -> Result<SessionContext, String> {
    state
        .session_mgr
        .login(&token, &clinic_id, &role)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn logout_desktop_session(state: State<'_, AppState>) -> Result<(), String> {
    state.session_mgr.logout();
    Ok(())
}

#[tauri::command]
pub fn get_desktop_session(state: State<'_, AppState>) -> Result<Option<SessionContext>, String> {
    Ok(state.session_mgr.get_session())
}

// ---------------------------------------------------------------------------
// Protected Clinical & Patient Local Data Commands
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct SavePatientArgs {
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
