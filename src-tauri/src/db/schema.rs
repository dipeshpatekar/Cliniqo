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

/// Migration V3: Introduces local synchronization state tracking (sequence, push/pull timestamps)
/// and extends local sync conflicts with explicit status and resolution payload.
pub const MIGRATION_V3_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS local_sync_state (
    clinic_id TEXT PRIMARY KEY,
    last_pulled_seq INTEGER NOT NULL DEFAULT 0,
    last_pulled_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_pushed_at TIMESTAMP NULL,
    in_sync BOOLEAN NOT NULL DEFAULT 1
);
"#;

/// Migration V4: Introduces encrypted local invoices and clinical medicine formulary catalogue.
pub const MIGRATION_V4_SQL: &str = r#"
-- 1. Encrypted Local Invoices Table
CREATE TABLE IF NOT EXISTS local_invoices_v2 (
    id TEXT PRIMARY KEY,
    server_id TEXT NULL,
    clinic_id TEXT NOT NULL,
    patient_id TEXT NOT NULL,
    consultation_id TEXT NULL,
    invoice_number TEXT NOT NULL,
    invoice_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    payment_status TEXT NOT NULL DEFAULT 'UNPAID',
    subtotal_paise INTEGER NOT NULL,
    discount_paise INTEGER NOT NULL DEFAULT 0,
    tax_rate_percent REAL NOT NULL DEFAULT 0.0,
    tax_paise INTEGER NOT NULL DEFAULT 0,
    total_paise INTEGER NOT NULL,
    encrypted_billing_data BLOB NOT NULL,
    nonce BLOB NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'PENDING',
    server_version INTEGER NOT NULL DEFAULT 1,
    local_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_invoices_v2_clinic ON local_invoices_v2(clinic_id);
CREATE INDEX IF NOT EXISTS idx_invoices_v2_patient ON local_invoices_v2(clinic_id, patient_id);
CREATE INDEX IF NOT EXISTS idx_invoices_v2_consultation ON local_invoices_v2(clinic_id, consultation_id);
CREATE INDEX IF NOT EXISTS idx_invoices_v2_number ON local_invoices_v2(clinic_id, invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_v2_sync ON local_invoices_v2(sync_status);

-- 2. Local Clinical Formulary Table
CREATE TABLE IF NOT EXISTS local_formulary_v2 (
    id TEXT PRIMARY KEY,
    server_id TEXT NULL,
    clinic_id TEXT NOT NULL,
    name TEXT NOT NULL,
    active_ingredient TEXT NULL,
    formulation TEXT NOT NULL,
    strength TEXT NOT NULL,
    default_dose TEXT NULL,
    default_route TEXT NULL,
    default_frequency TEXT NULL,
    default_duration TEXT NULL,
    default_instructions TEXT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_formulary_v2_clinic ON local_formulary_v2(clinic_id);
CREATE INDEX IF NOT EXISTS idx_formulary_v2_name ON local_formulary_v2(clinic_id, name);
CREATE INDEX IF NOT EXISTS idx_formulary_v2_formulation ON local_formulary_v2(clinic_id, formulation);
"#;

/// Migration V5: Introduces offline reference catalogue cache for CDCI medicines and search acceleration.
pub const MIGRATION_V5_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS local_catalogue_cache_v1 (
    id TEXT PRIMARY KEY,
    item_type TEXT NOT NULL,
    name TEXT NOT NULL,
    brand_name TEXT NULL,
    generic_name TEXT NULL,
    product_name TEXT NULL,
    dosage_form TEXT NULL,
    route TEXT NULL,
    active_ingredients_json TEXT NULL,
    strengths_json TEXT NOT NULL,
    raw_strength_summary TEXT NOT NULL DEFAULT '',
    is_combination INTEGER NOT NULL DEFAULT 0,
    is_verified INTEGER NOT NULL DEFAULT 1,
    source_provenance TEXT NOT NULL DEFAULT 'CDCI_NRCES_INDIA',
    cached_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cat_cache_name ON local_catalogue_cache_v1(name);
CREATE INDEX IF NOT EXISTS idx_cat_cache_brand ON local_catalogue_cache_v1(brand_name);
CREATE INDEX IF NOT EXISTS idx_cat_cache_generic ON local_catalogue_cache_v1(generic_name);
CREATE INDEX IF NOT EXISTS idx_cat_cache_product ON local_catalogue_cache_v1(product_name);
CREATE INDEX IF NOT EXISTS idx_cat_cache_form ON local_catalogue_cache_v1(dosage_form);

CREATE TABLE IF NOT EXISTS catalogue_sync_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"#;

/// Migration V6: Introduces local clinic profile persistence for durable offline profile settings and tenancy details.
pub const MIGRATION_V6_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS local_clinic_profile (
    clinic_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    street TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT '',
    postal_code TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT 'India',
    location_link TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"#;

/// Migration V7: CDCI catalogue ProductMaster standalone backfill & reconciliation (104,367 records).
pub const MIGRATION_V7_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS idx_cat_cache_product ON local_catalogue_cache_v1(product_name);
"#;

/// Migration V8: Introduces local doctor profile persistence for durable credentials (qualification, registration_number, mobile, gender).
pub const MIGRATION_V8_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS local_doctor_profile (
    doctor_id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    qualification TEXT NOT NULL DEFAULT '',
    registration_number TEXT NOT NULL DEFAULT '',
    gender TEXT NOT NULL DEFAULT 'Male',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"#;

/// Migration V9: Introduces local inventory stock tracking for physical clinic supplies & pharmacy stock.
pub const MIGRATION_V9_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS local_inventory_stock_v1 (
    id TEXT PRIMARY KEY,
    clinic_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    quantity REAL NOT NULL DEFAULT 0,
    value REAL NULL,
    batch_number TEXT NULL,
    source_report TEXT NOT NULL DEFAULT 'STOCK REPORT (18-10-26)',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inventory_stock_clinic ON local_inventory_stock_v1(clinic_id);
CREATE INDEX IF NOT EXISTS idx_inventory_stock_product ON local_inventory_stock_v1(clinic_id, product_name);
"#;

/// Migration V10: Introduces local clinical library and import batch tracking for doctor/clinic-imported medicine records.
pub const MIGRATION_V10_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS local_import_batches_v1 (
    id TEXT PRIMARY KEY,
    clinic_id TEXT NOT NULL,
    doctor_id TEXT NULL,
    file_name TEXT NOT NULL,
    total_rows INTEGER NOT NULL DEFAULT 0,
    valid_rows INTEGER NOT NULL DEFAULT 0,
    invalid_rows INTEGER NOT NULL DEFAULT 0,
    imported_rows INTEGER NOT NULL DEFAULT 0,
    skipped_rows INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'COMPLETED',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    rolled_back_at TIMESTAMP NULL
);

CREATE INDEX IF NOT EXISTS idx_import_batches_clinic ON local_import_batches_v1(clinic_id, created_at);

CREATE TABLE IF NOT EXISTS local_clinical_library_v1 (
    id TEXT PRIMARY KEY,
    server_id TEXT NULL,
    clinic_id TEXT NOT NULL,
    batch_id TEXT NULL REFERENCES local_import_batches_v1(id),
    name TEXT NOT NULL,
    generic_name TEXT NULL,
    brand_name TEXT NULL,
    composition TEXT NULL,
    strength TEXT NOT NULL DEFAULT '',
    formulation TEXT NOT NULL DEFAULT 'Tablet',
    dosage_form TEXT NULL,
    route TEXT NULL,
    manufacturer TEXT NULL,
    category TEXT NULL,
    pack_size TEXT NULL,
    mrp REAL NULL,
    storage_instructions TEXT NULL,
    default_dosage TEXT NULL,
    default_frequency TEXT NULL,
    default_duration TEXT NULL,
    default_instructions TEXT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    sync_status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_clinical_lib_clinic ON local_clinical_library_v1(clinic_id);
CREATE INDEX IF NOT EXISTS idx_clinical_lib_name ON local_clinical_library_v1(clinic_id, name);
CREATE INDEX IF NOT EXISTS idx_clinical_lib_generic ON local_clinical_library_v1(clinic_id, generic_name);
CREATE INDEX IF NOT EXISTS idx_clinical_lib_batch ON local_clinical_library_v1(batch_id);
"#;

/// Migration V11: Purges legacy CDCI reference tables and sync metadata following complete CDCI dataset removal.
pub const MIGRATION_V11_SQL: &str = r#"
DROP TABLE IF EXISTS local_catalogue_cache_v1;
DROP TABLE IF EXISTS local_catalogue_sync_state_v1;
"#;

/// Migration V12: Sequential patient ID counters per clinic (format AAA-0001 ... ZZZ-9999).
pub const MIGRATION_V12_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS local_seq_counters (
    clinic_id TEXT NOT NULL,
    sequence_name TEXT NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (clinic_id, sequence_name)
);
"#;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DoctorProfileRecord {
    pub doctor_id: String,
    pub full_name: String,
    pub email: String,
    pub phone: String,
    pub qualification: String,
    pub registration_number: String,
    pub gender: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveDoctorProfileArgs {
    pub doctor_id: String,
    pub full_name: String,
    pub email: String,
    pub phone: Option<String>,
    pub qualification: Option<String>,
    pub registration_number: Option<String>,
    pub gender: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClinicProfileRecord {
    pub clinic_id: String,
    pub name: String,
    pub slug: String,
    pub phone: String,
    pub email: String,
    pub street: String,
    pub city: String,
    pub state: String,
    pub postal_code: String,
    pub country: String,
    pub location_link: String,
    pub updated_at: Option<String>,
}


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
    #[serde(default)]
    pub last_visit: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ConflictStatus {
    Open,
    Resolved,
    Dismissed,
}

impl ConflictStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConflictStatus::Open => "OPEN",
            ConflictStatus::Resolved => "RESOLVED",
            ConflictStatus::Dismissed => "DISMISSED",
        }
    }

    pub fn from_str(s: &str) -> Result<Self, String> {
        match s.to_uppercase().as_str() {
            "OPEN" => Ok(ConflictStatus::Open),
            "RESOLVED" => Ok(ConflictStatus::Resolved),
            "DISMISSED" => Ok(ConflictStatus::Dismissed),
            _ => Err(format!("Unknown conflict status: '{s}'")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncStateRecord {
    pub clinic_id: String,
    pub last_pulled_seq: i64,
    pub last_pulled_at: String,
    pub last_pushed_at: Option<String>,
    pub in_sync: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncConflictRecord {
    pub id: String,
    pub outbox_id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub server_version: i32,
    pub client_version: i32,
    pub server_payload: String,
    pub client_payload: String,
    pub conflict_reason: String,
    pub resolution_payload: Option<String>,
    pub status: String,
    pub resolved_at: Option<String>,
    pub resolution_strategy: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecryptedOutboxItem {
    pub id: String,
    pub clinic_id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub action: String,
    pub idempotency_key: String,
    pub client_version: i64,
    pub server_id: Option<String>,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncFeedChangeItem {
    pub seq: i64,
    #[serde(rename = "entityType")]
    pub entity_type: String,
    #[serde(rename = "entityId")]
    pub entity_id: String,
    #[serde(rename = "clientEntityId")]
    pub client_entity_id: Option<String>,
    pub action: String,
    pub version: i64,
    pub payload: serde_json::Value,
    #[serde(rename = "committedAt")]
    pub committed_at: String,
    #[serde(rename = "actorDoctorId")]
    pub actor_doctor_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InvoiceItem {
    pub description: String,
    pub quantity: i64,
    pub unit_price_paise: i64,
    pub total_paise: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedBillingData {
    pub items: Vec<InvoiceItem>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvoiceRecord {
    pub id: String,
    pub server_id: Option<String>,
    pub clinic_id: String,
    pub patient_id: String,
    pub consultation_id: Option<String>,
    pub invoice_number: String,
    pub invoice_date: String,
    pub status: String,
    pub payment_status: String,
    pub items: Vec<InvoiceItem>,
    pub subtotal_paise: i64,
    pub discount_paise: i64,
    pub tax_rate_percent: f64,
    pub tax_paise: i64,
    pub total_paise: i64,
    pub notes: Option<String>,
    pub sync_status: String,
    pub server_version: i32,
    pub local_version: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveInvoiceArgs {
    pub id: Option<String>,
    pub clinic_id: String,
    pub patient_id: String,
    pub consultation_id: Option<String>,
    pub invoice_number: String,
    pub invoice_date: String,
    pub status: Option<String>,
    pub payment_status: Option<String>,
    pub items: Vec<InvoiceItem>,
    pub discount_paise: Option<i64>,
    pub tax_rate_percent: Option<f64>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormularyRecord {
    pub id: String,
    pub server_id: Option<String>,
    pub clinic_id: String,
    pub name: String,
    pub active_ingredient: Option<String>,
    pub formulation: String,
    pub strength: String,
    #[serde(rename = "default_dosage", alias = "default_dose")]
    pub default_dose: Option<String>,
    pub default_route: Option<String>,
    pub default_frequency: Option<String>,
    pub default_duration: Option<String>,
    pub default_instructions: Option<String>,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveFormularyArgs {
    pub id: Option<String>,
    pub clinic_id: String,
    pub name: String,
    pub active_ingredient: Option<String>,
    pub formulation: String,
    #[serde(default)]
    pub strength: String,
    #[serde(default, alias = "default_dosage")]
    pub default_dose: Option<String>,
    pub default_route: Option<String>,
    pub default_frequency: Option<String>,
    pub default_duration: Option<String>,
    pub default_instructions: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalCatalogueStrength {
    pub ingredient: Option<String>,
    pub raw_strength: String,
    pub value: Option<f64>,
    pub unit: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalCatalogueItem {
    pub id: String,
    pub item_type: String, // "BRAND" | "GENERIC"
    pub name: String,
    pub brand_name: Option<String>,
    pub generic_name: Option<String>,
    pub product_name: Option<String>,
    pub dosage_form: Option<String>,
    pub route: Option<String>,
    pub active_ingredients_json: Option<String>,
    pub strengths_json: String,
    pub raw_strength_summary: String,
    pub is_combination: bool,
    pub is_verified: bool,
    pub source_provenance: String,
    pub cached_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveCatalogueCacheItemArgs {
    pub id: String,
    pub item_type: String,
    pub name: String,
    pub brand_name: Option<String>,
    pub generic_name: Option<String>,
    pub product_name: Option<String>,
    pub dosage_form: Option<String>,
    pub route: Option<String>,
    pub active_ingredients_json: Option<String>,
    pub strengths_json: String,
    pub raw_strength_summary: String,
    pub is_combination: bool,
    pub is_verified: bool,
    pub source_provenance: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueCacheStats {
    pub total_items: i64,
    pub brand_count: i64,
    pub generic_count: i64,
    pub verified_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StockItemInput {
    pub product_name: String,
    pub unit: String,
    pub company: String,
    pub quantity: f64,
    pub value: Option<f64>,
    pub batch_number: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StockItemRecord {
    pub id: String,
    pub clinic_id: String,
    pub product_name: String,
    pub unit: String,
    pub company: String,
    pub quantity: f64,
    pub value: Option<f64>,
    pub batch_number: Option<String>,
    pub source_report: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StockImportSummary {
    pub total_records: usize,
    pub successful: usize,
    pub skipped: usize,
    pub failed: usize,
    pub total_quantity: f64,
    pub total_value: f64,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StockSummaryRecord {
    pub total_products: usize,
    pub total_quantity: f64,
    pub total_value: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClinicalImportItemInput {
    pub name: String,
    pub generic_name: Option<String>,
    pub brand_name: Option<String>,
    pub composition: Option<String>,
    pub strength: String,
    pub formulation: String,
    pub dosage_form: Option<String>,
    pub route: Option<String>,
    pub manufacturer: Option<String>,
    pub category: Option<String>,
    pub pack_size: Option<String>,
    pub mrp: Option<f64>,
    pub storage_instructions: Option<String>,
    pub default_dosage: Option<String>,
    pub default_frequency: Option<String>,
    pub default_duration: Option<String>,
    pub default_instructions: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClinicalImportBatchInput {
    pub clinic_id: String,
    pub doctor_id: Option<String>,
    pub file_name: String,
    pub items: Vec<ClinicalImportItemInput>,
    pub total_rows: usize,
    pub invalid_rows: usize,
    pub allow_update: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClinicalImportSummary {
    pub batch_id: String,
    pub file_name: String,
    pub total_rows: usize,
    pub valid_rows: usize,
    pub invalid_rows: usize,
    pub imported_rows: usize,
    pub skipped_rows: usize,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClinicalImportBatchRecord {
    pub id: String,
    pub clinic_id: String,
    pub doctor_id: Option<String>,
    pub file_name: String,
    pub total_rows: i64,
    pub valid_rows: i64,
    pub invalid_rows: i64,
    pub imported_rows: i64,
    pub skipped_rows: i64,
    pub status: String,
    pub created_at: String,
    pub rolled_back_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClinicalMedicineRecord {
    pub id: String,
    pub server_id: Option<String>,
    pub clinic_id: String,
    pub batch_id: Option<String>,
    pub name: String,
    pub generic_name: Option<String>,
    pub brand_name: Option<String>,
    pub composition: Option<String>,
    pub strength: String,
    pub formulation: String,
    pub dosage_form: Option<String>,
    pub route: Option<String>,
    pub manufacturer: Option<String>,
    pub category: Option<String>,
    pub pack_size: Option<String>,
    pub mrp: Option<f64>,
    pub storage_instructions: Option<String>,
    pub default_dosage: Option<String>,
    pub default_frequency: Option<String>,
    pub default_duration: Option<String>,
    pub default_instructions: Option<String>,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveClinicalMedicineArgs {
    pub id: Option<String>,
    pub clinic_id: String,
    pub name: String,
    pub generic_name: Option<String>,
    pub brand_name: Option<String>,
    pub composition: Option<String>,
    pub strength: String,
    pub formulation: String,
    pub dosage_form: Option<String>,
    pub route: Option<String>,
    pub manufacturer: Option<String>,
    pub category: Option<String>,
    pub pack_size: Option<String>,
    pub mrp: Option<f64>,
    pub storage_instructions: Option<String>,
    pub default_dosage: Option<String>,
    pub default_frequency: Option<String>,
    pub default_duration: Option<String>,
    pub default_instructions: Option<String>,
}




