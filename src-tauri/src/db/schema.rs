use serde::{Deserialize, Serialize};

pub const CREATE_MIGRATIONS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    checksum TEXT NOT NULL
);
"#;

pub const MIGRATION_V1_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS local_patients (
    id TEXT PRIMARY KEY,
    server_id TEXT NULL,
    clinic_id TEXT NOT NULL,
    patient_code TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    gender TEXT NOT NULL,
    date_of_birth TEXT NULL,
    age INTEGER NOT NULL,
    allergies_json TEXT NOT NULL DEFAULT '[]',
    conditions_json TEXT NOT NULL DEFAULT '[]',
    encrypted_pii_payload BLOB NULL,
    nonce BLOB NULL,
    sync_status TEXT NOT NULL DEFAULT 'PENDING',
    server_version INTEGER NOT NULL DEFAULT 1,
    local_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_patients_clinic ON local_patients(clinic_id);
CREATE INDEX IF NOT EXISTS idx_patients_sync_status ON local_patients(sync_status);

CREATE TABLE IF NOT EXISTS local_consultations (
    id TEXT PRIMARY KEY,
    server_id TEXT NULL,
    clinic_id TEXT NOT NULL,
    patient_id TEXT NOT NULL,
    doctor_id TEXT NOT NULL,
    consultation_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    chief_complaint TEXT NOT NULL,
    diagnosis TEXT NOT NULL,
    encrypted_clinical_snapshot BLOB NULL,
    nonce BLOB NULL,
    sync_status TEXT NOT NULL DEFAULT 'PENDING',
    server_version INTEGER NOT NULL DEFAULT 1,
    local_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_consultations_clinic ON local_consultations(clinic_id);
CREATE INDEX IF NOT EXISTS idx_consultations_patient ON local_consultations(patient_id);
CREATE INDEX IF NOT EXISTS idx_consultations_sync_status ON local_consultations(sync_status);

CREATE TABLE IF NOT EXISTS local_prescriptions (
    id TEXT PRIMARY KEY,
    server_id TEXT NULL,
    clinic_id TEXT NOT NULL,
    consultation_id TEXT NOT NULL,
    patient_id TEXT NOT NULL,
    doctor_id TEXT NOT NULL,
    prescription_number TEXT NOT NULL,
    revision_number INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    encrypted_items BLOB NULL,
    nonce BLOB NULL,
    sync_status TEXT NOT NULL DEFAULT 'PENDING',
    server_version INTEGER NOT NULL DEFAULT 1,
    local_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_prescriptions_clinic ON local_prescriptions(clinic_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_consultation ON local_prescriptions(consultation_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_sync_status ON local_prescriptions(sync_status);

CREATE TABLE IF NOT EXISTS local_sync_outbox (
    id TEXT PRIMARY KEY,
    clinic_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'PENDING',
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    synced_at TIMESTAMP NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_sync_status ON local_sync_outbox(sync_status, created_at);

CREATE TABLE IF NOT EXISTS local_sync_conflicts (
    id TEXT PRIMARY KEY,
    outbox_id TEXT NOT NULL REFERENCES local_sync_outbox(id),
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    server_version INTEGER NOT NULL,
    client_version INTEGER NOT NULL,
    server_payload TEXT NOT NULL,
    client_payload TEXT NOT NULL,
    conflict_reason TEXT NOT NULL,
    resolved_at TIMESTAMP NULL,
    resolution_strategy TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"#;

/// Migration V2: Eliminates all plaintext patient demographics, consultation clinical details,
/// and outbox mutation payloads. Everything is stored as AES-256-GCM encrypted BLOBs with 96-bit nonces.
pub const MIGRATION_V2_SQL: &str = r#"
-- 1. Encrypted Patients Table (Zero Plaintext Demographics)
CREATE TABLE IF NOT EXISTS local_patients_v2 (
    id TEXT PRIMARY KEY,
    server_id TEXT NULL,
    clinic_id TEXT NOT NULL,
    patient_code TEXT NOT NULL,
    encrypted_demographics BLOB NOT NULL,
    nonce BLOB NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'PENDING',
    server_version INTEGER NOT NULL DEFAULT 1,
    local_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_patients_v2_clinic ON local_patients_v2(clinic_id);
CREATE INDEX IF NOT EXISTS idx_patients_v2_code ON local_patients_v2(clinic_id, patient_code);
CREATE INDEX IF NOT EXISTS idx_patients_v2_sync ON local_patients_v2(sync_status);

-- 2. Encrypted Consultations Table (Zero Plaintext Diagnosis/Complaints)
CREATE TABLE IF NOT EXISTS local_consultations_v2 (
    id TEXT PRIMARY KEY,
    server_id TEXT NULL,
    clinic_id TEXT NOT NULL,
    patient_id TEXT NOT NULL,
    doctor_id TEXT NOT NULL,
    consultation_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    encrypted_clinical_data BLOB NOT NULL,
    nonce BLOB NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'PENDING',
    server_version INTEGER NOT NULL DEFAULT 1,
    local_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_consultations_v2_clinic ON local_consultations_v2(clinic_id);
CREATE INDEX IF NOT EXISTS idx_consultations_v2_patient ON local_consultations_v2(patient_id);
CREATE INDEX IF NOT EXISTS idx_consultations_v2_sync ON local_consultations_v2(sync_status);

-- 3. Encrypted Prescriptions Table
CREATE TABLE IF NOT EXISTS local_prescriptions_v2 (
    id TEXT PRIMARY KEY,
    server_id TEXT NULL,
    clinic_id TEXT NOT NULL,
    consultation_id TEXT NOT NULL,
    patient_id TEXT NOT NULL,
    doctor_id TEXT NOT NULL,
    prescription_number TEXT NOT NULL,
    revision_number INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    encrypted_items BLOB NOT NULL,
    nonce BLOB NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'PENDING',
    server_version INTEGER NOT NULL DEFAULT 1,
    local_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_prescriptions_v2_clinic ON local_prescriptions_v2(clinic_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_v2_consultation ON local_prescriptions_v2(consultation_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_v2_sync ON local_prescriptions_v2(sync_status);

-- 4. Encrypted Outbox Table (Zero Plaintext Mutation Payloads)
CREATE TABLE IF NOT EXISTS local_sync_outbox_v2 (
    id TEXT PRIMARY KEY,
    clinic_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    encrypted_payload BLOB NOT NULL,
    nonce BLOB NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'PENDING',
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    synced_at TIMESTAMP NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_v2_sync ON local_sync_outbox_v2(sync_status, created_at);
"#;

#[derive(Debug, Serialize, Deserialize)]
pub struct PatientDemographics {
    pub name: String,
    pub phone: String,
    pub gender: String,
    pub date_of_birth: Option<String>,
    pub age: i32,
    pub allergies: Vec<String>,
    pub conditions: Vec<String>,
    pub sensitive_notes: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ClinicalData {
    pub chief_complaint: String,
    pub diagnosis: String,
    pub clinical_snapshot_json: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PatientRecord {
    pub id: String,
    pub server_id: Option<String>,
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
    pub sync_status: String,
    pub server_version: i32,
    pub local_version: i32,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ConsultationRecord {
    pub id: String,
    pub server_id: Option<String>,
    pub clinic_id: String,
    pub patient_id: String,
    pub doctor_id: String,
    pub consultation_date: String,
    pub status: String,
    pub chief_complaint: String,
    pub diagnosis: String,
    pub clinical_snapshot_json: Option<String>,
    pub sync_status: String,
    pub server_version: i32,
    pub local_version: i32,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PrescriptionRecord {
    pub id: String,
    pub server_id: Option<String>,
    pub clinic_id: String,
    pub consultation_id: String,
    pub patient_id: String,
    pub doctor_id: String,
    pub prescription_number: String,
    pub revision_number: i32,
    pub status: String,
    pub items_json: Option<String>,
    pub sync_status: String,
    pub server_version: i32,
    pub local_version: i32,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SyncOutboxSummary {
    pub pending_count: i64,
    pub in_flight_count: i64,
    pub synced_count: i64,
    pub conflict_count: i64,
    pub failed_count: i64,
}
