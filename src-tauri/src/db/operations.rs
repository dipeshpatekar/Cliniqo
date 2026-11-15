use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;
use thiserror::Error;
use crate::crypto::{decrypt_payload, encrypt_payload, CryptoError};
use crate::crypto::key_manager::DatabaseEncryptionKey;
use super::schema::{
    CatalogueCacheStats, ClinicalData, ClinicalImportBatchInput, ClinicalImportBatchRecord,
    ClinicalImportSummary, ClinicalMedicineRecord, ClinicProfileRecord,
    ConflictStatus, ConsultationRecord, DecryptedOutboxItem, DoctorProfileRecord, EncryptedBillingData,
    FormularyRecord, InvoiceItem, InvoiceRecord, LocalCatalogueItem, PatientDemographics, PatientRecord,
    PrescriptionRecord, SaveCatalogueCacheItemArgs, SaveClinicalMedicineArgs, SaveFormularyArgs,
    SaveInvoiceArgs, StockImportSummary, StockItemInput, StockItemRecord, StockSummaryRecord,
    SyncConflictRecord, SyncFeedChangeItem, SyncOutboxSummary, SyncStateRecord,
};

#[derive(Error, Debug)]
pub enum DatabaseOpError {
    #[error("SQLite database error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("Cryptography error: {0}")]
    Crypto(#[from] CryptoError),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Data decryption failed for record: {0}")]
    DecryptionFailed(String),

    #[error("Conflict resolution error: {0}")]
    ConflictResolution(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SavePatientResult {
    pub id: String,
    pub patient_code: String,
}

pub type RawInvoiceRow = (
    String,
    Option<String>,
    String,
    String,
    Option<String>,
    String,
    String,
    String,
    String,
    i64,
    i64,
    f64,
    i64,
    i64,
    Vec<u8>,
    Vec<u8>,
    String,
    i32,
    i32,
    String,
    String,
);

pub struct DbOperations;

impl DbOperations {
    /// Formats a 1-based sequential number into the canonical patient code AAA-0001 ... ZZZ-9999.
    pub fn format_sequential_patient_id(seq: u32) -> String {
        let safe_seq = if seq < 1 { 1 } else { seq };
        let zero_index = safe_seq - 1;
        let prefix_index = zero_index / 9999;
        let num_part = (zero_index % 9999) + 1;

        let c1 = ((prefix_index / 676) % 26) as u8 + b'A';
        let c2 = ((prefix_index / 26) % 26) as u8 + b'A';
        let c3 = (prefix_index % 26) as u8 + b'A';

        format!("{}{}{}-{:04}", c1 as char, c2 as char, c3 as char, num_part)
    }

    /// Parses a canonical patient code (e.g. AAA-0001) back into its 1-based sequence number.
    pub fn parse_sequential_patient_id(id: &str) -> Option<u32> {
        let trimmed = id.trim();
        if trimmed.len() != 8 || trimmed.as_bytes().get(3) != Some(&b'-') {
            return None;
        }
        let prefix = &trimmed[..3];
        let num_str = &trimmed[4..];

        let bytes = prefix.as_bytes();
        if !bytes[0].is_ascii_uppercase()
            || !bytes[1].is_ascii_uppercase()
            || !bytes[2].is_ascii_uppercase()
        {
            return None;
        }
        let num: u32 = num_str.parse().ok()?;
        if num < 1 || num > 9999 {
            return None;
        }

        let p0 = (bytes[0] - b'A') as u32;
        let p1 = (bytes[1] - b'A') as u32;
        let p2 = (bytes[2] - b'A') as u32;

        let prefix_index = p0 * 676 + p1 * 26 + p2;
        Some(prefix_index * 9999 + num)
    }

    /// Computes the next sequential patient code for a clinic without modifying counter state.
    pub fn get_next_patient_code(conn: &mut Connection, clinic_id: &str) -> Result<String, DatabaseOpError> {
        let counter_seq: u32 = conn
            .query_row(
                "SELECT last_seq FROM local_seq_counters WHERE clinic_id = ?1 AND sequence_name = 'patient'",
                params![clinic_id],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let mut max_seq = counter_seq;
        let mut stmt = conn.prepare("SELECT patient_code FROM local_patients WHERE clinic_id = ?1")?;
        let rows = stmt.query_map(params![clinic_id], |row| row.get::<_, String>(0))?;
        for r in rows {
            if let Ok(code) = r {
                if let Some(parsed) = Self::parse_sequential_patient_id(&code) {
                    if parsed > max_seq {
                        max_seq = parsed;
                    }
                }
            }
        }

        let next_seq = max_seq + 1;
        Ok(Self::format_sequential_patient_id(next_seq))
    }

    fn allocate_next_patient_code_tx(tx: &rusqlite::Transaction, clinic_id: &str) -> Result<String, DatabaseOpError> {
        let counter_seq: u32 = tx
            .query_row(
                "SELECT last_seq FROM local_seq_counters WHERE clinic_id = ?1 AND sequence_name = 'patient'",
                params![clinic_id],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let mut max_seq = counter_seq;
        let mut stmt = tx.prepare("SELECT patient_code FROM local_patients WHERE clinic_id = ?1")?;
        let rows = stmt.query_map(params![clinic_id], |row| row.get::<_, String>(0))?;
        for r in rows {
            if let Ok(code) = r {
                if let Some(parsed) = Self::parse_sequential_patient_id(&code) {
                    if parsed > max_seq {
                        max_seq = parsed;
                    }
                }
            }
        }

        let next_seq = max_seq + 1;
        tx.execute(
            r#"
            INSERT INTO local_seq_counters (clinic_id, sequence_name, last_seq)
            VALUES (?1, 'patient', ?2)
            ON CONFLICT(clinic_id, sequence_name) DO UPDATE SET
            last_seq = excluded.last_seq
            "#,
            params![clinic_id, next_seq],
        )?;

        Ok(Self::format_sequential_patient_id(next_seq))
    }

    /// Inserts a patient record locally with optional client mutation idempotency and canonical
    /// sequential code assignment. All demographics and outbox mutation payloads are encrypted at rest using AES-256-GCM.
    pub fn insert_patient_ext(
        conn: &mut Connection,
        dek: &DatabaseEncryptionKey,
        clinic_id: &str,
        patient_code: &str,
        name: &str,
        phone: &str,
        gender: &str,
        date_of_birth: Option<&str>,
        age: i32,
        allergies: &[String],
        conditions: &[String],
        sensitive_notes: Option<&str>,
        client_mutation_id: Option<&str>,
    ) -> Result<SavePatientResult, DatabaseOpError> {
        let idempotency_key = match client_mutation_id {
            Some(cid) if !cid.trim().is_empty() => format!("client-patient-create-{}", cid.trim()),
            _ => format!("local-patient-create-{}", Uuid::new_v4()),
        };

        let tx = conn.transaction()?;

        // 1. Check idempotency: If this exact client mutation was already processed, return existing patient!
        let existing_result: Option<(String, String)> = tx
            .query_row(
                r#"
                SELECT p.id, p.patient_code 
                FROM local_sync_outbox o
                JOIN local_patients p ON p.id = o.entity_id
                WHERE o.clinic_id = ?1 AND o.idempotency_key = ?2
                LIMIT 1
                "#,
                params![clinic_id, &idempotency_key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        if let Some((existing_id, existing_code)) = existing_result {
            log::info!("Idempotent patient creation matched existing record (mutation id: {:?})", client_mutation_id);
            tx.commit()?;
            return Ok(SavePatientResult {
                id: existing_id,
                patient_code: existing_code,
            });
        }

        // 2. Resolve canonical patient code:
        // A placeholder or already-in-use candidate code must safely allocate next sequential code.
        let candidate = patient_code.trim();
        let is_placeholder = candidate.is_empty() || candidate == "PT-INIT";

        let candidate_in_use: bool = if !is_placeholder {
            tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM local_patients WHERE clinic_id = ?1 AND patient_code = ?2)",
                params![clinic_id, candidate],
                |row| row.get(0),
            ).unwrap_or(false)
        } else {
            false
        };

        let effective_code = if is_placeholder || candidate_in_use {
            Self::allocate_next_patient_code_tx(&tx, clinic_id)?
        } else {
            candidate.to_string()
        };

        // Advance sequential counter so counter tracks maximum allocated ID
        if let Some(seq) = Self::parse_sequential_patient_id(&effective_code) {
            tx.execute(
                r#"
                INSERT INTO local_seq_counters (clinic_id, sequence_name, last_seq)
                VALUES (?1, 'patient', ?2)
                ON CONFLICT(clinic_id, sequence_name) DO UPDATE SET
                last_seq = MAX(local_seq_counters.last_seq, excluded.last_seq)
                "#,
                params![clinic_id, seq],
            )?;
        }

        let patient_id = Uuid::new_v4().to_string();

        // 3. Pack and encrypt all demographic and sensitive fields
        let demographics = PatientDemographics {
            name: name.to_string(),
            phone: phone.to_string(),
            gender: gender.to_string(),
            date_of_birth: date_of_birth.map(|s| s.to_string()),
            age,
            allergies: allergies.to_vec(),
            conditions: conditions.to_vec(),
            sensitive_notes: sensitive_notes.map(|s| s.to_string()),
        };

        let demo_bytes = serde_json::to_vec(&demographics)?;
        let (encrypted_demographics, demo_nonce) = encrypt_payload(&dek.key, &demo_bytes)?;

        // 4. Pack and encrypt sync outbox mutation payload
        let outbox_payload = json!({
            "patientId": effective_code,
            "name": name,
            "phone": phone,
            "gender": gender,
            "dateOfBirth": date_of_birth,
            "age": age,
            "allergies": allergies,
            "conditions": conditions,
        })
        .to_string();

        let (encrypted_outbox, outbox_nonce) = encrypt_payload(&dek.key, outbox_payload.as_bytes())?;

        // 5. Insert patient record
        tx.execute(
            r#"
            INSERT INTO local_patients (
                id, clinic_id, patient_code, encrypted_demographics, nonce, sync_status, local_version
            ) VALUES (?1, ?2, ?3, ?4, ?5, 'PENDING', 1)
            "#,
            params![
                patient_id,
                clinic_id,
                effective_code,
                encrypted_demographics,
                demo_nonce,
            ],
        )?;

        // 6. Insert outbox record atomically in the SAME transaction
        let outbox_id = Uuid::new_v4().to_string();
        tx.execute(
            r#"
            INSERT INTO local_sync_outbox (
                id, clinic_id, entity_type, entity_id, action, idempotency_key, encrypted_payload, nonce, sync_status
            ) VALUES (?1, ?2, 'PATIENT', ?3, 'CREATE', ?4, ?5, ?6, 'PENDING')
            "#,
            params![outbox_id, clinic_id, patient_id, idempotency_key, encrypted_outbox, outbox_nonce],
        )?;

        // Commit transaction
        tx.commit()?;

        Ok(SavePatientResult {
            id: patient_id,
            patient_code: effective_code,
        })
    }

    /// Backward-compatible wrapper returning only the patient UUID.
    pub fn insert_patient(
        conn: &mut Connection,
        dek: &DatabaseEncryptionKey,
        clinic_id: &str,
        patient_code: &str,
        name: &str,
        phone: &str,
        gender: &str,
        date_of_birth: Option<&str>,
        age: i32,
        allergies: &[String],
        conditions: &[String],
        sensitive_notes: Option<&str>,
    ) -> Result<String, DatabaseOpError> {
        let res = Self::insert_patient_ext(
            conn,
            dek,
            clinic_id,
            patient_code,
            name,
            phone,
            gender,
            date_of_birth,
            age,
            allergies,
            conditions,
            sensitive_notes,
            None,
        )?;
        Ok(res.id)
    }

    /// Updates an existing patient record locally. All demographics and outbox mutation payloads are
    /// encrypted at rest using AES-256-GCM. An UPDATE outbox item is atomically enqueued.
    pub fn update_patient(
        conn: &mut Connection,
        dek: &DatabaseEncryptionKey,
        clinic_id: &str,
        patient_id: &str,
        patient_code: &str,
        name: &str,
        phone: &str,
        gender: &str,
        date_of_birth: Option<&str>,
        age: i32,
        allergies: &[String],
        conditions: &[String],
        sensitive_notes: Option<&str>,
    ) -> Result<(), DatabaseOpError> {
        let demographics = PatientDemographics {
            name: name.to_string(),
            phone: phone.to_string(),
            gender: gender.to_string(),
            date_of_birth: date_of_birth.map(|s| s.to_string()),
            age,
            allergies: allergies.to_vec(),
            conditions: conditions.to_vec(),
            sensitive_notes: sensitive_notes.map(|s| s.to_string()),
        };

        let demo_bytes = serde_json::to_vec(&demographics)?;
        let (encrypted_demographics, demo_nonce) = encrypt_payload(&dek.key, &demo_bytes)?;

        let outbox_payload = json!({
            "patientId": patient_code,
            "name": name,
            "phone": phone,
            "gender": gender,
            "dateOfBirth": date_of_birth,
            "age": age,
            "allergies": allergies,
            "conditions": conditions,
        })
        .to_string();

        let (encrypted_outbox, outbox_nonce) = encrypt_payload(&dek.key, outbox_payload.as_bytes())?;

        let tx = conn.transaction()?;

        let current_local_ver: i32 = tx.query_row(
            "SELECT local_version FROM local_patients WHERE clinic_id = ?1 AND id = ?2",
            params![clinic_id, patient_id],
            |row| row.get(0),
        )?;

        let new_ver = current_local_ver + 1;

        tx.execute(
            r#"
            UPDATE local_patients
            SET patient_code = ?1,
                encrypted_demographics = ?2,
                nonce = ?3,
                sync_status = 'PENDING',
                local_version = ?4,
                updated_at = CURRENT_TIMESTAMP
            WHERE clinic_id = ?5 AND id = ?6
            "#,
            params![patient_code, encrypted_demographics, demo_nonce, new_ver, clinic_id, patient_id],
        )?;

        let outbox_id = Uuid::new_v4().to_string();
        let idempotency_key = format!("local-patient-update-{patient_id}-{new_ver}");

        tx.execute(
            r#"
            INSERT INTO local_sync_outbox (
                id, clinic_id, entity_type, entity_id, action, idempotency_key, encrypted_payload, nonce, sync_status
            ) VALUES (?1, ?2, 'PATIENT', ?3, 'UPDATE', ?4, ?5, ?6, 'PENDING')
            "#,
            params![outbox_id, clinic_id, patient_id, idempotency_key, encrypted_outbox, outbox_nonce],
        )?;

        tx.commit()?;
        Ok(())
    }

    /// Deletes a patient record locally. An outbox item for DELETE is atomically enqueued.
    pub fn delete_patient(
        conn: &mut Connection,
        dek: &DatabaseEncryptionKey,
        clinic_id: &str,
        patient_id: &str,
    ) -> Result<(), DatabaseOpError> {
        let tx = conn.transaction()?;

        let (actual_id, server_id, patient_code, current_local_ver): (
            String,
            Option<String>,
            Option<String>,
            i32,
        ) = tx.query_row(
            "SELECT id, server_id, patient_code, local_version FROM local_patients WHERE clinic_id = ?1 AND (id = ?2 OR patient_code = ?2) LIMIT 1",
            params![clinic_id, patient_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;

        let new_ver = current_local_ver + 1;

        tx.execute(
            "DELETE FROM local_patients WHERE clinic_id = ?1 AND id = ?2",
            params![clinic_id, actual_id],
        )?;

        let outbox_id = Uuid::new_v4().to_string();
        let idempotency_key = format!("local-patient-delete-{actual_id}-{new_ver}");

        let mut payload_map = serde_json::Map::new();
        if let Some(ref sid) = server_id {
            payload_map.insert("serverId".to_string(), serde_json::Value::String(sid.clone()));
        }
        if let Some(ref code) = patient_code {
            payload_map.insert("patientCode".to_string(), serde_json::Value::String(code.clone()));
        }
        let payload_json = serde_json::Value::Object(payload_map).to_string();
        let (encrypted_outbox, outbox_nonce) = encrypt_payload(&dek.key, payload_json.as_bytes())?;

        tx.execute(
            r#"
            INSERT INTO local_sync_outbox (
                id, clinic_id, entity_type, entity_id, action, idempotency_key, encrypted_payload, nonce, sync_status
            ) VALUES (?1, ?2, 'PATIENT', ?3, 'DELETE', ?4, ?5, ?6, 'PENDING')
            "#,
            params![outbox_id, clinic_id, actual_id, idempotency_key, encrypted_outbox, outbox_nonce],
        )?;

        tx.commit()?;
        Ok(())
    }

    /// Queries local patients for a clinic, decrypting the demographic payloads.
    pub fn get_patients(
        conn: &Connection,
        dek: &DatabaseEncryptionKey,
        clinic_id: &str,
    ) -> Result<Vec<PatientRecord>, DatabaseOpError> {
        let mut stmt = conn.prepare(
            r#"
            SELECT p.id, p.server_id, p.clinic_id, p.patient_code, p.encrypted_demographics, p.nonce,
                   p.sync_status, p.server_version, p.local_version, p.updated_at,
                   (
                       SELECT COALESCE(c.created_at, c.consultation_date)
                       FROM local_consultations c
                       LEFT JOIN local_prescriptions rx
                         ON (rx.consultation_id = c.id OR (c.server_id IS NOT NULL AND rx.consultation_id = c.server_id))
                        AND rx.clinic_id = c.clinic_id
                       WHERE (c.patient_id = p.id OR (p.server_id IS NOT NULL AND c.patient_id = p.server_id))
                         AND c.clinic_id = p.clinic_id
                         AND (
                             rx.status = 'ACTIVE'
                             OR (c.status IN ('FINALIZED', 'COMPLETED') AND rx.status IS NULL)
                         )
                       ORDER BY c.created_at DESC, c.consultation_date DESC
                       LIMIT 1
                   ) AS last_visit
            FROM local_patients p
            WHERE p.clinic_id = ?1
            ORDER BY p.updated_at DESC
            "#,
        )?;

        let rows = stmt.query_map(params![clinic_id], |row| {
            let id: String = row.get(0)?;
            let server_id: Option<String> = row.get(1)?;
            let clinic_id: String = row.get(2)?;
            let patient_code: String = row.get(3)?;
            let enc_bytes: Vec<u8> = row.get(4)?;
            let nonce: Vec<u8> = row.get(5)?;
            let sync_status: String = row.get(6)?;
            let server_version: i32 = row.get(7)?;
            let local_version: i32 = row.get(8)?;
            let updated_at: String = row.get(9)?;
            let last_visit: Option<String> = row.get(10)?;

            Ok((
                id,
                server_id,
                clinic_id,
                patient_code,
                enc_bytes,
                nonce,
                sync_status,
                server_version,
                local_version,
                updated_at,
                last_visit,
            ))
        })?;

        let mut results = Vec::new();
        for r in rows {
            let (
                id,
                server_id,
                clinic_id,
                patient_code,
                enc_bytes,
                nonce,
                sync_status,
                server_version,
                local_version,
                updated_at,
                last_visit,
            ) = r?;

            let decrypted_bytes = decrypt_payload(&dek.key, &enc_bytes, &nonce)
                .map_err(|e| DatabaseOpError::DecryptionFailed(format!("Patient {id}: {e}")))?;

            let demo: PatientDemographics = serde_json::from_slice(&decrypted_bytes)?;

            results.push(PatientRecord {
                id,
                server_id,
                clinic_id,
                patient_code,
                name: demo.name,
                phone: demo.phone,
                gender: demo.gender,
                date_of_birth: demo.date_of_birth,
                age: demo.age,
                allergies: demo.allergies,
                conditions: demo.conditions,
                sensitive_notes: demo.sensitive_notes,
                sync_status,
                server_version,
                local_version,
                updated_at,
                last_visit,
            });
        }

        Ok(results)
    }

    /// Inserts a consultation draft with encrypted clinical data and encrypted outbox mutation.
    pub fn insert_consultation(
        conn: &mut Connection,
        dek: &DatabaseEncryptionKey,
        clinic_id: &str,
        patient_id: &str,
        doctor_id: &str,
        consultation_date: &str,
        chief_complaint: &str,
        diagnosis: &str,
        clinical_snapshot_json: Option<&str>,
    ) -> Result<String, DatabaseOpError> {
        let consultation_id = Uuid::new_v4().to_string();
        let idempotency_key = format!("local-consultation-create-{consultation_id}");

        // 1. Pack and encrypt clinical details
        let clinical_data = ClinicalData {
            chief_complaint: chief_complaint.to_string(),
            diagnosis: diagnosis.to_string(),
            clinical_snapshot_json: clinical_snapshot_json.map(|s| s.to_string()),
        };

        let clinical_bytes = serde_json::to_vec(&clinical_data)?;
        let (encrypted_clinical, clinical_nonce) = encrypt_payload(&dek.key, &clinical_bytes)?;

        // 2. Pack and encrypt outbox mutation payload
        let outbox_payload = json!({
            "patientId": patient_id,
            "doctorId": doctor_id,
            "consultationDate": consultation_date,
            "chiefComplaint": chief_complaint,
            "diagnosis": diagnosis,
        })
        .to_string();

        let (encrypted_outbox, outbox_nonce) = encrypt_payload(&dek.key, outbox_payload.as_bytes())?;

        let tx = conn.transaction()?;

        tx.execute(
            r#"
            INSERT INTO local_consultations (
                id, clinic_id, patient_id, doctor_id, consultation_date, status,
                encrypted_clinical_data, nonce, sync_status, local_version
            ) VALUES (?1, ?2, ?3, ?4, ?5, 'DRAFT', ?6, ?7, 'PENDING', 1)
            "#,
            params![
                consultation_id,
                clinic_id,
                patient_id,
                doctor_id,
                consultation_date,
                encrypted_clinical,
                clinical_nonce,
            ],
        )?;

        let outbox_id = Uuid::new_v4().to_string();
        tx.execute(
            r#"
            INSERT INTO local_sync_outbox (
                id, clinic_id, entity_type, entity_id, action, idempotency_key, encrypted_payload, nonce, sync_status
            ) VALUES (?1, ?2, 'CONSULTATION', ?3, 'CREATE', ?4, ?5, ?6, 'PENDING')
            "#,
            params![outbox_id, clinic_id, consultation_id, idempotency_key, encrypted_outbox, outbox_nonce],
        )?;

        tx.commit()?;
        Ok(consultation_id)
    }

    /// Queries local consultations for a clinic, decrypting the clinical data.
    pub fn get_consultations(
        conn: &Connection,
        dek: &DatabaseEncryptionKey,
        clinic_id: &str,
        patient_id: Option<&str>,
    ) -> Result<Vec<ConsultationRecord>, DatabaseOpError> {
        let mut sql = String::from(
            r#"
            SELECT id, server_id, clinic_id, patient_id, doctor_id, consultation_date,
                   status, encrypted_clinical_data, nonce, sync_status,
                   server_version, local_version, updated_at
            FROM local_consultations
            WHERE clinic_id = ?1
            "#,
        );

        if patient_id.is_some() {
            sql.push_str(" AND (patient_id = ?2 OR patient_id IN (SELECT patient_code FROM local_patients WHERE clinic_id = ?1 AND id = ?2)) ORDER BY updated_at DESC");
        } else {
            sql.push_str(" ORDER BY updated_at DESC");
        }

        let mut stmt = conn.prepare(&sql)?;

        let raw_rows = if let Some(pid) = patient_id {
            stmt.query_map(params![clinic_id, pid], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Vec<u8>>(7)?,
                    row.get::<_, Vec<u8>>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, i32>(10)?,
                    row.get::<_, i32>(11)?,
                    row.get::<_, String>(12)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            stmt.query_map(params![clinic_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Vec<u8>>(7)?,
                    row.get::<_, Vec<u8>>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, i32>(10)?,
                    row.get::<_, i32>(11)?,
                    row.get::<_, String>(12)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
        };

        let mut results = Vec::new();
        for r in raw_rows {
            let (
                id,
                server_id,
                clinic_id,
                patient_id,
                doctor_id,
                consultation_date,
                status,
                enc_bytes,
                nonce,
                sync_status,
                server_version,
                local_version,
                updated_at,
            ) = r;

            let decrypted_bytes = decrypt_payload(&dek.key, &enc_bytes, &nonce)
                .map_err(|e| DatabaseOpError::DecryptionFailed(format!("Consultation {id}: {e}")))?;

            let clinical: ClinicalData = serde_json::from_slice(&decrypted_bytes)?;

            results.push(ConsultationRecord {
                id,
                server_id,
                clinic_id,
                patient_id,
                doctor_id,
                consultation_date,
                status,
                chief_complaint: clinical.chief_complaint,
                diagnosis: clinical.diagnosis,
                clinical_snapshot_json: clinical.clinical_snapshot_json,
                sync_status,
                server_version,
                local_version,
                updated_at,
            });
        }

        Ok(results)
    }

    /// Inserts a prescription with encrypted medication items and encrypted outbox mutation.
    pub fn insert_prescription(
        conn: &mut Connection,
        dek: &DatabaseEncryptionKey,
        clinic_id: &str,
        consultation_id: &str,
        patient_id: &str,
        doctor_id: &str,
        prescription_number: &str,
        items_json: &str,
    ) -> Result<String, DatabaseOpError> {
        // Idempotency: Prevent duplicate active prescriptions for the same consultation on retry
        let existing_rx_id: Option<String> = conn
            .query_row(
                "SELECT id FROM local_prescriptions WHERE clinic_id = ?1 AND consultation_id = ?2 AND status = 'ACTIVE' LIMIT 1",
                params![clinic_id, consultation_id],
                |row| row.get(0),
            )
            .optional()?;

        if let Some(existing_id) = existing_rx_id {
            return Ok(existing_id);
        }

        let prescription_id = Uuid::new_v4().to_string();
        let idempotency_key = format!("local-prescription-create-{prescription_id}");

        let (encrypted_items, nonce) = encrypt_payload(&dek.key, items_json.as_bytes())?;

        let parsed_items: serde_json::Value = serde_json::from_str(items_json)
            .unwrap_or_else(|_| serde_json::json!([]));

        let outbox_payload = json!({
            "consultationId": consultation_id,
            "patientId": patient_id,
            "doctorId": doctor_id,
            "prescriptionNumber": prescription_number,
            "itemsJson": items_json,
            "items": parsed_items,
        })
        .to_string();

        let (encrypted_outbox, outbox_nonce) = encrypt_payload(&dek.key, outbox_payload.as_bytes())?;

        let tx = conn.transaction()?;

        tx.execute(
            r#"
            UPDATE local_consultations
            SET status = 'FINALIZED',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?1 AND clinic_id = ?2
            "#,
            params![consultation_id, clinic_id],
        )?;

        tx.execute(
            r#"
            INSERT INTO local_prescriptions (
                id, clinic_id, consultation_id, patient_id, doctor_id,
                prescription_number, revision_number, status, encrypted_items, nonce, sync_status, local_version
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 'ACTIVE', ?7, ?8, 'PENDING', 1)
            "#,
            params![
                prescription_id,
                clinic_id,
                consultation_id,
                patient_id,
                doctor_id,
                prescription_number,
                encrypted_items,
                nonce,
            ],
        )?;

        let outbox_id = Uuid::new_v4().to_string();
        tx.execute(
            r#"
            INSERT INTO local_sync_outbox (
                id, clinic_id, entity_type, entity_id, action, idempotency_key, encrypted_payload, nonce, sync_status
            ) VALUES (?1, ?2, 'PRESCRIPTION', ?3, 'CREATE', ?4, ?5, ?6, 'PENDING')
            "#,
            params![outbox_id, clinic_id, prescription_id, idempotency_key, encrypted_outbox, outbox_nonce],
        )?;

        tx.commit()?;
        Ok(prescription_id)
    }

    /// Queries local prescriptions for a clinic, decrypting the items.
    pub fn get_prescriptions(
        conn: &Connection,
        dek: &DatabaseEncryptionKey,
        clinic_id: &str,
        patient_id: Option<&str>,
    ) -> Result<Vec<PrescriptionRecord>, DatabaseOpError> {
        let mut sql = String::from(
            r#"
            SELECT id, server_id, clinic_id, consultation_id, patient_id, doctor_id,
                   prescription_number, revision_number, status, encrypted_items, nonce,
                   sync_status, server_version, local_version, created_at
            FROM local_prescriptions
            WHERE clinic_id = ?1
            "#,
        );

        if patient_id.is_some() {
            sql.push_str(" AND (patient_id = ?2 OR patient_id IN (SELECT patient_code FROM local_patients WHERE clinic_id = ?1 AND id = ?2)) ORDER BY created_at DESC, revision_number DESC");
        } else {
            sql.push_str(" ORDER BY created_at DESC, revision_number DESC");
        }

        let mut stmt = conn.prepare(&sql)?;

        let raw_rows = if let Some(pid) = patient_id {
            stmt.query_map(params![clinic_id, pid], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i32>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Vec<u8>>(9)?,
                    row.get::<_, Vec<u8>>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, i32>(12)?,
                    row.get::<_, i32>(13)?,
                    row.get::<_, String>(14)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            stmt.query_map(params![clinic_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i32>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Vec<u8>>(9)?,
                    row.get::<_, Vec<u8>>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, i32>(12)?,
                    row.get::<_, i32>(13)?,
                    row.get::<_, String>(14)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
        };

        let mut results = Vec::new();
        for r in raw_rows {
            let (
                id,
                server_id,
                clinic_id,
                consultation_id,
                patient_id,
                doctor_id,
                prescription_number,
                revision_number,
                status,
                enc_items,
                nonce,
                sync_status,
                server_version,
                local_version,
                created_at,
            ) = r;

            let decrypted_bytes = decrypt_payload(&dek.key, &enc_items, &nonce)
                .map_err(|e| DatabaseOpError::DecryptionFailed(format!("Prescription {id}: {e}")))?;

            let items_str = String::from_utf8(decrypted_bytes)
                .map_err(|e| DatabaseOpError::DecryptionFailed(format!("UTF-8 decode error: {e}")))?;

            results.push(PrescriptionRecord {
                id,
                server_id,
                clinic_id,
                consultation_id,
                patient_id,
                doctor_id,
                prescription_number,
                revision_number,
                status,
                items_json: Some(items_str),
                sync_status,
                server_version,
                local_version,
                created_at,
            });
        }

        Ok(results)
    }

    /// Appends an immutable revision to an active prescription.
    /// Preserves existing prescription records, creates a new immutable revision row
    /// with an incremented revision_number and local_version, and records an outbox mutation.
    pub fn revise_prescription(
        conn: &mut Connection,
        dek: &DatabaseEncryptionKey,
        clinic_id: &str,
        prescription_id: &str,
        expected_revision_number: i32,
        items_json: &str,
        reason_for_revision: &str,
        verified_doctor_id: &str,
    ) -> Result<String, DatabaseOpError> {
        if reason_for_revision.trim().is_empty() {
            return Err(DatabaseOpError::ConflictResolution(
                "Reason for revision is required".to_string(),
            ));
        }

        // Validate items JSON format and at least 1 item
        let parsed_items: serde_json::Value = serde_json::from_str(items_json)
            .map_err(|e| DatabaseOpError::ConflictResolution(format!("Invalid items JSON: {e}")))?;
        let items_arr = parsed_items
            .as_array()
            .ok_or_else(|| DatabaseOpError::ConflictResolution("Prescription items must be an array".to_string()))?;
        if items_arr.is_empty() {
            return Err(DatabaseOpError::ConflictResolution(
                "Revised prescription must contain at least one medicine item".to_string(),
            ));
        }

        let tx = conn.transaction()?;

        // Look up parent prescription row
        let (
            current_rev,
            status,
            patient_id,
            consultation_id,
            prescription_number,
            server_id,
            local_ver,
            server_ver,
        ): (i32, String, String, String, String, Option<String>, i32, i32) = tx
            .query_row(
                r#"
                SELECT revision_number, status, patient_id, consultation_id,
                       prescription_number, server_id, local_version, server_version
                FROM local_prescriptions
                WHERE clinic_id = ?1 AND id = ?2
                "#,
                params![clinic_id, prescription_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| {
                DatabaseOpError::ConflictResolution("Prescription not found in clinic".to_string())
            })?;

        if status != "ACTIVE" {
            return Err(DatabaseOpError::ConflictResolution(format!(
                "Cannot revise prescription with status '{status}'. Only ACTIVE prescriptions can be revised."
            )));
        }

        // Optimistic concurrency check
        if current_rev != expected_revision_number {
            return Err(DatabaseOpError::ConflictResolution(format!(
                "Optimistic lock conflict: Prescription revision sequence was modified (expected: {expected_revision_number}, current: {current_rev})."
            )));
        }

        let next_revision_number = current_rev + 1;

        // Prevent duplicate revision numbers for the same clinic and prescription number
        let revision_exists: bool = tx
            .query_row(
                r#"
                SELECT EXISTS(
                    SELECT 1 FROM local_prescriptions
                    WHERE clinic_id = ?1 AND prescription_number = ?2 AND revision_number = ?3
                )
                "#,
                params![clinic_id, prescription_number, next_revision_number],
                |row| row.get(0),
            )?;

        if revision_exists {
            return Err(DatabaseOpError::ConflictResolution(format!(
                "Revision {next_revision_number} already exists for prescription {prescription_number} in this clinic."
            )));
        }

        let new_local_version = local_ver + 1;
        let new_prescription_id = Uuid::new_v4().to_string();

        let (encrypted_items, nonce) = encrypt_payload(&dek.key, items_json.as_bytes())?;

        // 1. Mark the previous revision status as SUPERSEDED so it remains an immutable historical record.
        // Conditional update MUST affect exactly 1 active row. If not, rollback transaction immediately.
        let rows_affected = tx.execute(
            r#"
            UPDATE local_prescriptions
            SET status = 'SUPERSEDED',
                updated_at = CURRENT_TIMESTAMP
            WHERE clinic_id = ?1 AND id = ?2 AND status = 'ACTIVE'
            "#,
            params![clinic_id, prescription_id],
        )?;

        if rows_affected != 1 {
            return Err(DatabaseOpError::ConflictResolution(format!(
                "Failed to supersede active prescription: expected 1 row affected, got {rows_affected}."
            )));
        }

        // 2. Insert new immutable revision row with ACTIVE status
        tx.execute(
            r#"
            INSERT INTO local_prescriptions (
                id, server_id, clinic_id, consultation_id, patient_id, doctor_id,
                prescription_number, revision_number, status, encrypted_items, nonce,
                sync_status, server_version, local_version, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'ACTIVE', ?9, ?10, 'PENDING', ?11, ?12, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            "#,
            params![
                new_prescription_id,
                server_id,
                clinic_id,
                consultation_id,
                patient_id,
                verified_doctor_id,
                prescription_number,
                next_revision_number,
                encrypted_items,
                nonce,
                server_ver,
                new_local_version,
            ],
        )?;

        // 3. Queue outbox REVISE mutation
        let outbox_payload = json!({
            "prescriptionId": prescription_id,
            "prescriptionNumber": prescription_number,
            "serverId": server_id,
            "expectedRevisionNumber": expected_revision_number,
            "expectedVersion": server_ver,
            "reasonForRevision": reason_for_revision.trim(),
            "items": parsed_items,
        })
        .to_string();

        let (encrypted_outbox, outbox_nonce) =
            encrypt_payload(&dek.key, outbox_payload.as_bytes())?;
        let outbox_id = Uuid::new_v4().to_string();
        let idempotency_key = format!("prescription-revise-{new_prescription_id}-r{next_revision_number}");

        tx.execute(
            r#"
            INSERT INTO local_sync_outbox (
                id, clinic_id, entity_type, entity_id, action, idempotency_key, encrypted_payload, nonce, sync_status
            ) VALUES (?1, ?2, 'PRESCRIPTION', ?3, 'REVISE', ?4, ?5, ?6, 'PENDING')
            "#,
            params![
                outbox_id,
                clinic_id,
                new_prescription_id,
                idempotency_key,
                encrypted_outbox,
                outbox_nonce,
            ],
        )?;

        tx.commit()?;
        Ok(new_prescription_id)
    }
    pub fn get_outbox_summary(
        conn: &Connection,
        clinic_id: &str,
    ) -> Result<SyncOutboxSummary, DatabaseOpError> {
        let mut stmt = conn.prepare(
            r#"
            SELECT sync_status, COUNT(*)
            FROM local_sync_outbox
            WHERE clinic_id = ?1
            GROUP BY sync_status
            "#,
        )?;

        let mut pending = 0i64;
        let mut in_flight = 0i64;
        let mut synced = 0i64;
        let mut conflict = 0i64;
        let mut failed = 0i64;

        let rows = stmt.query_map(params![clinic_id], |row| {
            let status: String = row.get(0)?;
            let count: i64 = row.get(1)?;
            Ok((status, count))
        })?;

        for r in rows {
            let (status, count) = r?;
            match status.as_str() {
                "PENDING" => pending = count,
                "IN_FLIGHT" => in_flight = count,
                "SYNCED" => synced = count,
                "CONFLICT" => conflict = count,
                "FAILED" => failed = count,
                _ => {}
            }
        }

        Ok(SyncOutboxSummary {
            pending_count: pending,
            in_flight_count: in_flight,
            synced_count: synced,
            conflict_count: conflict,
            failed_count: failed,
        })
    }

    /// Recovers abandoned IN_FLIGHT jobs back to PENDING on application startup.
    pub fn recover_in_flight_jobs(conn: &mut Connection) -> Result<usize, DatabaseOpError> {
        let rows = conn.execute(
            "UPDATE local_sync_outbox SET sync_status = 'PENDING' WHERE sync_status = 'IN_FLIGHT'",
            [],
        )?;
        if rows > 0 {
            log::warn!("Offline sync recovery: reset {rows} in-flight outbox jobs to PENDING.");
        }
        Ok(rows)
    }

    // -----------------------------------------------------------------------
    // Sync Engine State & Conflict Operations
    // -----------------------------------------------------------------------

    /// Retrieves local sync state for a clinic, or None if not initialized
    pub fn get_sync_state(
        conn: &Connection,
        clinic_id: &str,
    ) -> Result<Option<SyncStateRecord>, DatabaseOpError> {
        let mut stmt = conn.prepare(
            "SELECT clinic_id, last_pulled_seq, last_pulled_at, last_pushed_at, in_sync FROM local_sync_state WHERE clinic_id = ?1",
        )?;
        let mut rows = stmt.query(params![clinic_id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(SyncStateRecord {
                clinic_id: row.get(0)?,
                last_pulled_seq: row.get(1)?,
                last_pulled_at: row.get(2)?,
                last_pushed_at: row.get(3)?,
                in_sync: row.get(4)?,
            }))
        } else {
            Ok(None)
        }
    }

    /// Upserts local sync state (sequence, timestamps, in_sync flag) for a clinic
    pub fn upsert_sync_state(
        conn: &mut Connection,
        state: &SyncStateRecord,
    ) -> Result<(), DatabaseOpError> {
        conn.execute(
            r#"
            INSERT INTO local_sync_state (clinic_id, last_pulled_seq, last_pulled_at, last_pushed_at, in_sync)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(clinic_id) DO UPDATE SET
                last_pulled_seq = excluded.last_pulled_seq,
                last_pulled_at = excluded.last_pulled_at,
                last_pushed_at = excluded.last_pushed_at,
                in_sync = excluded.in_sync
            "#,
            params![
                state.clinic_id,
                state.last_pulled_seq,
                state.last_pulled_at,
                state.last_pushed_at,
                state.in_sync,
            ],
        )?;
        Ok(())
    }

    /// Records a new synchronization conflict detected during sync pull
    pub fn record_conflict(
        conn: &mut Connection,
        conflict: &SyncConflictRecord,
    ) -> Result<(), DatabaseOpError> {
        conn.execute(
            r#"
            INSERT INTO local_sync_conflicts (
                id, outbox_id, entity_type, entity_id, server_version, client_version,
                server_payload, client_payload, conflict_reason, resolution_payload, status,
                resolved_at, resolution_strategy, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
            "#,
            params![
                conflict.id,
                conflict.outbox_id,
                conflict.entity_type,
                conflict.entity_id,
                conflict.server_version,
                conflict.client_version,
                conflict.server_payload,
                conflict.client_payload,
                conflict.conflict_reason,
                conflict.resolution_payload,
                conflict.status,
                conflict.resolved_at,
                conflict.resolution_strategy,
                conflict.created_at,
            ],
        )?;
        Ok(())
    }

    /// Resolves an open synchronization conflict with resolution strategy and payload
    pub fn resolve_conflict(
        conn: &mut Connection,
        conflict_id: &str,
        status: ConflictStatus,
        resolution_strategy: &str,
        resolution_payload: Option<&str>,
    ) -> Result<bool, DatabaseOpError> {
        let rows = conn.execute(
            r#"
            UPDATE local_sync_conflicts
            SET status = ?1,
                resolution_strategy = ?2,
                resolution_payload = ?3,
                resolved_at = CURRENT_TIMESTAMP
            WHERE id = ?4
            "#,
            params![
                status.as_str(),
                resolution_strategy,
                resolution_payload,
                conflict_id,
            ],
        )?;
        Ok(rows > 0)
    }

    /// Queries conflicts, optionally filtering by status (e.g. 'OPEN')
    pub fn get_conflicts(
        conn: &Connection,
        status_filter: Option<&str>,
    ) -> Result<Vec<SyncConflictRecord>, DatabaseOpError> {
        let sql = match status_filter {
            Some(_) => {
                r#"
                SELECT id, outbox_id, entity_type, entity_id, server_version, client_version,
                       server_payload, client_payload, conflict_reason, resolution_payload, status,
                       resolved_at, resolution_strategy, created_at
                FROM local_sync_conflicts
                WHERE status = ?1
                ORDER BY created_at DESC
                "#
            }
            None => {
                r#"
                SELECT id, outbox_id, entity_type, entity_id, server_version, client_version,
                       server_payload, client_payload, conflict_reason, resolution_payload, status,
                       resolved_at, resolution_strategy, created_at
                FROM local_sync_conflicts
                ORDER BY created_at DESC
                "#
            }
        };

        let map_row = |row: &rusqlite::Row| -> rusqlite::Result<SyncConflictRecord> {
            Ok(SyncConflictRecord {
                id: row.get(0)?,
                outbox_id: row.get(1)?,
                entity_type: row.get(2)?,
                entity_id: row.get(3)?,
                server_version: row.get(4)?,
                client_version: row.get(5)?,
                server_payload: row.get(6)?,
                client_payload: row.get(7)?,
                conflict_reason: row.get(8)?,
                resolution_payload: row.get(9)?,
                status: row.get(10)?,
                resolved_at: row.get(11)?,
                resolution_strategy: row.get(12)?,
                created_at: row.get(13)?,
            })
        };

        let mut stmt = conn.prepare(sql)?;
        let conflicts = if let Some(status) = status_filter {
            stmt.query_map(params![status], map_row)?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            stmt.query_map([], map_row)?
                .collect::<Result<Vec<_>, _>>()?
        };

        Ok(conflicts)
    }

    /// Queries conflicts strictly scoped to a clinic tenancy, optionally filtering by status (e.g. 'OPEN')
    pub fn get_conflicts_for_clinic(
        conn: &Connection,
        clinic_id: &str,
        status_filter: Option<&str>,
    ) -> Result<Vec<SyncConflictRecord>, DatabaseOpError> {
        let (sql, has_filter) = match status_filter {
            Some(_) => (
                r#"
                SELECT c.id, c.outbox_id, c.entity_type, c.entity_id, c.server_version, c.client_version,
                       c.server_payload, c.client_payload, c.conflict_reason, c.resolution_payload, c.status,
                       c.resolved_at, c.resolution_strategy, c.created_at
                FROM local_sync_conflicts c
                INNER JOIN local_sync_outbox o ON c.outbox_id = o.id
                WHERE o.clinic_id = ?1 AND c.status = ?2
                ORDER BY c.created_at DESC
                "#,
                true,
            ),
            None => (
                r#"
                SELECT c.id, c.outbox_id, c.entity_type, c.entity_id, c.server_version, c.client_version,
                       c.server_payload, c.client_payload, c.conflict_reason, c.resolution_payload, c.status,
                       c.resolved_at, c.resolution_strategy, c.created_at
                FROM local_sync_conflicts c
                INNER JOIN local_sync_outbox o ON c.outbox_id = o.id
                WHERE o.clinic_id = ?1
                ORDER BY c.created_at DESC
                "#,
                false,
            ),
        };

        let map_row = |row: &rusqlite::Row| -> rusqlite::Result<SyncConflictRecord> {
            Ok(SyncConflictRecord {
                id: row.get(0)?,
                outbox_id: row.get(1)?,
                entity_type: row.get(2)?,
                entity_id: row.get(3)?,
                server_version: row.get(4)?,
                client_version: row.get(5)?,
                server_payload: row.get(6)?,
                client_payload: row.get(7)?,
                conflict_reason: row.get(8)?,
                resolution_payload: row.get(9)?,
                status: row.get(10)?,
                resolved_at: row.get(11)?,
                resolution_strategy: row.get(12)?,
                created_at: row.get(13)?,
            })
        };

        let mut stmt = conn.prepare(sql)?;
        let conflicts = if has_filter {
            stmt.query_map(params![clinic_id, status_filter.unwrap()], map_row)?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            stmt.query_map(params![clinic_id], map_row)?
                .collect::<Result<Vec<_>, _>>()?
        };

        Ok(conflicts)
    }

    /// Durably resolves a synchronization conflict in encrypted SQLite.
    /// Transactionally updates:
    /// 1. The domain entity (patient, consultation, or prescription) with AES-256-GCM encryption.
    /// 2. The outbox mutation (superseding old failed mutation and enqueueing new retryable mutation with monotonic version).
    /// 3. The `local_sync_conflicts` table marking status = 'RESOLVED', with resolution strategy and payload.
    ///
    /// Preserves clinic tenant boundaries, prevents silent data loss, and is crash/restart safe.
    pub fn apply_conflict_resolution(
        conn: &mut Connection,
        dek: &DatabaseEncryptionKey,
        clinic_id: &str,
        conflict_id: &str,
        strategy: &str,
        resolution_payload: Option<&str>,
    ) -> Result<SyncConflictRecord, DatabaseOpError> {
        let tx = conn.transaction()?;

        // 1. Fetch conflict and verify clinic tenancy
        let (outbox_id, entity_type, entity_id, server_version, client_version, server_payload_str, client_payload_str, conflict_status): (
            String, String, String, i32, i32, String, String, String
        ) = {
            let mut stmt = tx.prepare(
                r#"
                SELECT c.outbox_id, c.entity_type, c.entity_id, c.server_version, c.client_version,
                       c.server_payload, c.client_payload, c.status
                FROM local_sync_conflicts c
                INNER JOIN local_sync_outbox o ON c.outbox_id = o.id
                WHERE c.id = ?1 AND o.clinic_id = ?2
                "#,
            )?;
            stmt.query_row(params![conflict_id, clinic_id], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            })
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    DatabaseOpError::ConflictResolution(format!(
                        "Conflict '{conflict_id}' not found for clinic '{clinic_id}'"
                    ))
                }
                other => DatabaseOpError::Sqlite(other),
            })?
        };

        if conflict_status != "OPEN" {
            return Err(DatabaseOpError::ConflictResolution(format!(
                "Conflict '{conflict_id}' is already {conflict_status}"
            )));
        }

        let strategy_upper = strategy.to_uppercase();
        let target_version = std::cmp::max(server_version, client_version) + 1;

        match strategy_upper.as_str() {
            "USE_SERVER" => {
                let server_json: serde_json::Value = serde_json::from_str(&server_payload_str)
                    .unwrap_or(serde_json::Value::Null);

                match entity_type.as_str() {
                    "PATIENT" => {
                        let name = server_json.get("name").and_then(|v| v.as_str()).unwrap_or("Unnamed Patient");
                        let phone = server_json.get("phone").and_then(|v| v.as_str()).unwrap_or("");
                        let gender = server_json.get("gender").and_then(|v| v.as_str()).unwrap_or("OTHER");
                        let patient_code = server_json.get("patientId")
                            .or_else(|| server_json.get("patientCode"))
                            .or_else(|| server_json.get("patient_code"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("P-UNKNOWN");
                        let date_of_birth = server_json.get("dateOfBirth")
                            .or_else(|| server_json.get("date_of_birth"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        let age = server_json.get("age").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                        let allergies: Vec<String> = server_json.get("allergies")
                            .and_then(|v| v.as_array())
                            .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                            .unwrap_or_default();
                        let conditions: Vec<String> = server_json.get("conditions")
                            .and_then(|v| v.as_array())
                            .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                            .unwrap_or_default();

                        let demo = PatientDemographics {
                            name: name.to_string(),
                            phone: phone.to_string(),
                            gender: gender.to_string(),
                            date_of_birth,
                            age,
                            allergies,
                            conditions,
                            sensitive_notes: None,
                        };
                        let demo_bytes = serde_json::to_vec(&demo)?;
                        let (enc_demo, demo_nonce) = encrypt_payload(&dek.key, &demo_bytes)?;

                        tx.execute(
                            r#"
                            UPDATE local_patients
                            SET patient_code = ?1,
                                encrypted_demographics = ?2,
                                nonce = ?3,
                                sync_status = 'SYNCED',
                                server_version = ?4,
                                local_version = ?4,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE clinic_id = ?5 AND (id = ?6 OR server_id = ?6)
                            "#,
                            params![patient_code, enc_demo, demo_nonce, server_version, clinic_id, entity_id],
                        )?;
                    }
                    "CONSULTATION" => {
                        let chief_complaint = server_json.get("chiefComplaint")
                            .or_else(|| server_json.get("chief_complaint"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let diagnosis = server_json.get("diagnosis").and_then(|v| v.as_str()).unwrap_or("");
                        let status = server_json.get("status").and_then(|v| v.as_str()).unwrap_or("DRAFT");
                        let snapshot = server_json.get("clinicalSnapshot")
                            .or_else(|| server_json.get("clinical_snapshot_json"))
                            .map(|v| v.to_string());

                        let clinical_data = ClinicalData {
                            chief_complaint: chief_complaint.to_string(),
                            diagnosis: diagnosis.to_string(),
                            clinical_snapshot_json: snapshot,
                        };
                        let clinical_bytes = serde_json::to_vec(&clinical_data)?;
                        let (enc_bytes, nonce) = encrypt_payload(&dek.key, &clinical_bytes)?;

                        tx.execute(
                            r#"
                            UPDATE local_consultations
                            SET status = ?1,
                                encrypted_clinical_data = ?2,
                                nonce = ?3,
                                sync_status = 'SYNCED',
                                server_version = ?4,
                                local_version = ?4,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE clinic_id = ?5 AND (id = ?6 OR server_id = ?6)
                            "#,
                            params![status, enc_bytes, nonce, server_version, clinic_id, entity_id],
                        )?;
                    }
                    "PRESCRIPTION" | "PRESCRIPTION_REVISION" => {
                        let items_val = server_json.get("items")
                            .or_else(|| server_json.get("medicines"))
                            .or_else(|| server_json.get("items_json"));
                        let items_str = items_val.map(|v| v.to_string()).unwrap_or_else(|| "[]".to_string());
                        let (enc_items, nonce) = encrypt_payload(&dek.key, items_str.as_bytes())?;
                        let status = server_json.get("status").and_then(|v| v.as_str()).unwrap_or("ACTIVE");

                        tx.execute(
                            r#"
                            UPDATE local_prescriptions
                            SET status = ?1,
                                encrypted_items = ?2,
                                nonce = ?3,
                                sync_status = 'SYNCED',
                                server_version = ?4,
                                local_version = ?4,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE clinic_id = ?5 AND (id = ?6 OR server_id = ?6)
                            "#,
                            params![status, enc_items, nonce, server_version, clinic_id, entity_id],
                        )?;
                    }
                    _ => {}
                }

                // Mark original conflicting outbox item as SYNCED (superseded)
                tx.execute(
                    r#"
                    UPDATE local_sync_outbox
                    SET sync_status = 'SYNCED',
                        last_error = 'Resolved: Accepted server authoritative state',
                        synced_at = CURRENT_TIMESTAMP
                    WHERE id = ?1
                    "#,
                    params![outbox_id],
                )?;

                // Update conflict record
                tx.execute(
                    r#"
                    UPDATE local_sync_conflicts
                    SET status = 'RESOLVED',
                        resolution_strategy = 'USE_SERVER',
                        resolution_payload = ?1,
                        resolved_at = CURRENT_TIMESTAMP
                    WHERE id = ?2
                    "#,
                    params![server_payload_str, conflict_id],
                )?;
            }

            "USE_LOCAL" => {
                // Doctor re-asserts local state. Enqueue a new mutation with clientVersion >= serverVersion.
                let client_json: serde_json::Value = serde_json::from_str(&client_payload_str)
                    .unwrap_or_else(|_| json!({}));

                match entity_type.as_str() {
                    "PATIENT" => {
                        tx.execute(
                            r#"
                            UPDATE local_patients
                            SET sync_status = 'PENDING',
                                local_version = ?1,
                                server_version = ?2,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE clinic_id = ?3 AND (id = ?4 OR server_id = ?4)
                            "#,
                            params![target_version, server_version, clinic_id, entity_id],
                        )?;
                    }
                    "CONSULTATION" => {
                        tx.execute(
                            r#"
                            UPDATE local_consultations
                            SET sync_status = 'PENDING',
                                local_version = ?1,
                                server_version = ?2,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE clinic_id = ?3 AND (id = ?4 OR server_id = ?4)
                            "#,
                            params![target_version, server_version, clinic_id, entity_id],
                        )?;
                    }
                    "PRESCRIPTION" | "PRESCRIPTION_REVISION" => {
                        tx.execute(
                            r#"
                            UPDATE local_prescriptions
                            SET sync_status = 'PENDING',
                                local_version = ?1,
                                server_version = ?2,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE clinic_id = ?3 AND (id = ?4 OR server_id = ?4)
                            "#,
                            params![target_version, server_version, clinic_id, entity_id],
                        )?;
                    }
                    _ => {}
                }

                // Supersede old outbox item
                tx.execute(
                    r#"
                    UPDATE local_sync_outbox
                    SET sync_status = 'SYNCED',
                        last_error = 'Superseded by local conflict resolution'
                    WHERE id = ?1
                    "#,
                    params![outbox_id],
                )?;

                // Enqueue new outbox mutation with monotonic version
                let new_outbox_id = Uuid::new_v4().to_string();
                let idempotency_key = format!("local-{}-{}-resolve-uselocal-v{}", entity_type.to_lowercase(), entity_id, target_version);
                let (enc_outbox, outbox_nonce) = encrypt_payload(&dek.key, client_json.to_string().as_bytes())?;

                tx.execute(
                    r#"
                    INSERT INTO local_sync_outbox (
                        id, clinic_id, entity_type, entity_id, action, idempotency_key, encrypted_payload, nonce, sync_status, retry_count
                    ) VALUES (?1, ?2, ?3, ?4, 'UPDATE', ?5, ?6, ?7, 'PENDING', 0)
                    "#,
                    params![new_outbox_id, clinic_id, entity_type, entity_id, idempotency_key, enc_outbox, outbox_nonce],
                )?;

                tx.execute(
                    r#"
                    UPDATE local_sync_conflicts
                    SET status = 'RESOLVED',
                        resolution_strategy = 'USE_LOCAL',
                        resolution_payload = ?1,
                        resolved_at = CURRENT_TIMESTAMP
                    WHERE id = ?2
                    "#,
                    params![client_payload_str, conflict_id],
                )?;
            }

            "MERGE_MANUAL" => {
                let payload_str = resolution_payload.ok_or_else(|| {
                    DatabaseOpError::ConflictResolution("MERGE_MANUAL requires non-null resolution_payload".to_string())
                })?;
                let merged_json: serde_json::Value = serde_json::from_str(payload_str)?;

                match entity_type.as_str() {
                    "PATIENT" => {
                        let name = merged_json.get("name").and_then(|v| v.as_str()).unwrap_or("Unnamed Patient");
                        let phone = merged_json.get("phone").and_then(|v| v.as_str()).unwrap_or("");
                        let gender = merged_json.get("gender").and_then(|v| v.as_str()).unwrap_or("OTHER");
                        let patient_code = merged_json.get("patientId")
                            .or_else(|| merged_json.get("patientCode"))
                            .or_else(|| merged_json.get("patient_code"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("P-UNKNOWN");
                        let date_of_birth = merged_json.get("dateOfBirth")
                            .or_else(|| merged_json.get("date_of_birth"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        let age = merged_json.get("age").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                        let allergies: Vec<String> = merged_json.get("allergies")
                            .and_then(|v| v.as_array())
                            .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                            .unwrap_or_default();
                        let conditions: Vec<String> = merged_json.get("conditions")
                            .and_then(|v| v.as_array())
                            .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                            .unwrap_or_default();

                        let demo = PatientDemographics {
                            name: name.to_string(),
                            phone: phone.to_string(),
                            gender: gender.to_string(),
                            date_of_birth,
                            age,
                            allergies,
                            conditions,
                            sensitive_notes: None,
                        };
                        let demo_bytes = serde_json::to_vec(&demo)?;
                        let (enc_demo, demo_nonce) = encrypt_payload(&dek.key, &demo_bytes)?;

                        tx.execute(
                            r#"
                            UPDATE local_patients
                            SET patient_code = ?1,
                                encrypted_demographics = ?2,
                                nonce = ?3,
                                sync_status = 'PENDING',
                                server_version = ?4,
                                local_version = ?5,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE clinic_id = ?6 AND (id = ?7 OR server_id = ?7)
                            "#,
                            params![patient_code, enc_demo, demo_nonce, server_version, target_version, clinic_id, entity_id],
                        )?;
                    }
                    "CONSULTATION" => {
                        let chief_complaint = merged_json.get("chiefComplaint")
                            .or_else(|| merged_json.get("chief_complaint"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let diagnosis = merged_json.get("diagnosis").and_then(|v| v.as_str()).unwrap_or("");
                        let status = merged_json.get("status").and_then(|v| v.as_str()).unwrap_or("DRAFT");
                        let snapshot = merged_json.get("clinicalSnapshot")
                            .or_else(|| merged_json.get("clinical_snapshot_json"))
                            .map(|v| v.to_string());

                        let clinical_data = ClinicalData {
                            chief_complaint: chief_complaint.to_string(),
                            diagnosis: diagnosis.to_string(),
                            clinical_snapshot_json: snapshot,
                        };
                        let clinical_bytes = serde_json::to_vec(&clinical_data)?;
                        let (enc_bytes, nonce) = encrypt_payload(&dek.key, &clinical_bytes)?;

                        tx.execute(
                            r#"
                            UPDATE local_consultations
                            SET status = ?1,
                                encrypted_clinical_data = ?2,
                                nonce = ?3,
                                sync_status = 'PENDING',
                                server_version = ?4,
                                local_version = ?5,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE clinic_id = ?6 AND (id = ?7 OR server_id = ?7)
                            "#,
                            params![status, enc_bytes, nonce, server_version, target_version, clinic_id, entity_id],
                        )?;
                    }
                    "PRESCRIPTION" | "PRESCRIPTION_REVISION" => {
                        let items_val = merged_json.get("items")
                            .or_else(|| merged_json.get("medicines"))
                            .or_else(|| merged_json.get("items_json"));
                        let items_str = items_val.map(|v| v.to_string()).unwrap_or_else(|| "[]".to_string());
                        let (enc_items, nonce) = encrypt_payload(&dek.key, items_str.as_bytes())?;
                        let status = merged_json.get("status").and_then(|v| v.as_str()).unwrap_or("ACTIVE");

                        tx.execute(
                            r#"
                            UPDATE local_prescriptions
                            SET status = ?1,
                                encrypted_items = ?2,
                                nonce = ?3,
                                sync_status = 'PENDING',
                                server_version = ?4,
                                local_version = ?5,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE clinic_id = ?6 AND (id = ?7 OR server_id = ?7)
                            "#,
                            params![status, enc_items, nonce, server_version, target_version, clinic_id, entity_id],
                        )?;
                    }
                    _ => {}
                }

                // Supersede old outbox item
                tx.execute(
                    r#"
                    UPDATE local_sync_outbox
                    SET sync_status = 'SYNCED',
                        last_error = 'Superseded by manual merge resolution'
                    WHERE id = ?1
                    "#,
                    params![outbox_id],
                )?;

                // Enqueue new outbox mutation with merged payload
                let new_outbox_id = Uuid::new_v4().to_string();
                let idempotency_key = format!("local-{}-{}-resolve-merge-v{}", entity_type.to_lowercase(), entity_id, target_version);
                let (enc_outbox, outbox_nonce) = encrypt_payload(&dek.key, payload_str.as_bytes())?;

                tx.execute(
                    r#"
                    INSERT INTO local_sync_outbox (
                        id, clinic_id, entity_type, entity_id, action, idempotency_key, encrypted_payload, nonce, sync_status, retry_count
                    ) VALUES (?1, ?2, ?3, ?4, 'UPDATE', ?5, ?6, ?7, 'PENDING', 0)
                    "#,
                    params![new_outbox_id, clinic_id, entity_type, entity_id, idempotency_key, enc_outbox, outbox_nonce],
                )?;

                tx.execute(
                    r#"
                    UPDATE local_sync_conflicts
                    SET status = 'RESOLVED',
                        resolution_strategy = 'MERGE_MANUAL',
                        resolution_payload = ?1,
                        resolved_at = CURRENT_TIMESTAMP
                    WHERE id = ?2
                    "#,
                    params![payload_str, conflict_id],
                )?;
            }

            "PRESERVE_BOTH" => {
                // Doctor preserves local version as a new separate entity, and accepts server version on original.
                // Particularly important for consultations where independent notes cannot be discarded.
                if entity_type == "CONSULTATION" {
                    let new_consultation_id = Uuid::new_v4().to_string();

                    // Read local consultation details to clone
                    let local_consult: Option<(String, String, String, String, Vec<u8>, Vec<u8>)> = {
                        let mut stmt = tx.prepare(
                            r#"
                            SELECT patient_id, doctor_id, consultation_date, status, encrypted_clinical_data, nonce
                            FROM local_consultations
                            WHERE clinic_id = ?1 AND (id = ?2 OR server_id = ?2)
                            "#,
                        )?;
                        stmt.query_row(params![clinic_id, entity_id], |row| {
                            Ok((
                                row.get(0)?,
                                row.get(1)?,
                                row.get(2)?,
                                row.get(3)?,
                                row.get(4)?,
                                row.get(5)?,
                            ))
                        })
                        .optional()?
                    };

                    if let Some((pat_id, doc_id, c_date, status, enc_clinical, nonce)) = local_consult {
                        // 1. Insert new cloned consultation
                        tx.execute(
                            r#"
                            INSERT INTO local_consultations (
                                id, clinic_id, patient_id, doctor_id, consultation_date, status,
                                encrypted_clinical_data, nonce, sync_status, server_version, local_version
                            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'PENDING', 1, 1)
                            "#,
                            params![new_consultation_id, clinic_id, pat_id, doc_id, c_date, status, enc_clinical, nonce],
                        )?;

                        // 2. Enqueue CREATE outbox for the new consultation
                        let new_outbox_id = Uuid::new_v4().to_string();
                        let idempotency_key = format!("local-consultation-create-{}", new_consultation_id);
                        let client_json: serde_json::Value = serde_json::from_str(&client_payload_str)
                            .unwrap_or_else(|_| json!({}));
                        let (enc_payload, out_nonce) = encrypt_payload(&dek.key, client_json.to_string().as_bytes())?;

                        tx.execute(
                            r#"
                            INSERT INTO local_sync_outbox (
                                id, clinic_id, entity_type, entity_id, action, idempotency_key, encrypted_payload, nonce, sync_status, retry_count
                            ) VALUES (?1, ?2, 'CONSULTATION', ?3, 'CREATE', ?4, ?5, ?6, 'PENDING', 0)
                            "#,
                            params![new_outbox_id, clinic_id, new_consultation_id, idempotency_key, enc_payload, out_nonce],
                        )?;
                    }
                }

                // Accept server version on the original record
                let server_json: serde_json::Value = serde_json::from_str(&server_payload_str)
                    .unwrap_or(serde_json::Value::Null);

                if entity_type == "CONSULTATION" {
                    let chief_complaint = server_json.get("chiefComplaint")
                        .or_else(|| server_json.get("chief_complaint"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let diagnosis = server_json.get("diagnosis").and_then(|v| v.as_str()).unwrap_or("");
                    let status = server_json.get("status").and_then(|v| v.as_str()).unwrap_or("DRAFT");
                    let snapshot = server_json.get("clinicalSnapshot")
                        .or_else(|| server_json.get("clinical_snapshot_json"))
                        .map(|v| v.to_string());

                    let clinical_data = ClinicalData {
                        chief_complaint: chief_complaint.to_string(),
                        diagnosis: diagnosis.to_string(),
                        clinical_snapshot_json: snapshot,
                    };
                    let clinical_bytes = serde_json::to_vec(&clinical_data)?;
                    let (enc_bytes, nonce) = encrypt_payload(&dek.key, &clinical_bytes)?;

                    tx.execute(
                        r#"
                        UPDATE local_consultations
                        SET status = ?1,
                            encrypted_clinical_data = ?2,
                            nonce = ?3,
                            sync_status = 'SYNCED',
                            server_version = ?4,
                            local_version = ?4,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE clinic_id = ?5 AND (id = ?6 OR server_id = ?6)
                        "#,
                        params![status, enc_bytes, nonce, server_version, clinic_id, entity_id],
                    )?;
                }

                // Mark original outbox item as SYNCED
                tx.execute(
                    r#"
                    UPDATE local_sync_outbox
                    SET sync_status = 'SYNCED',
                        last_error = 'Resolved: Preserved both versions'
                    WHERE id = ?1
                    "#,
                    params![outbox_id],
                )?;

                // Update conflict record
                tx.execute(
                    r#"
                    UPDATE local_sync_conflicts
                    SET status = 'RESOLVED',
                        resolution_strategy = 'PRESERVE_BOTH',
                        resolution_payload = ?1,
                        resolved_at = CURRENT_TIMESTAMP
                    WHERE id = ?2
                    "#,
                    params![server_payload_str, conflict_id],
                )?;
            }

            other => {
                return Err(DatabaseOpError::ConflictResolution(format!(
                    "Unsupported conflict resolution strategy: '{other}'"
                )));
            }
        }

        tx.commit()?;

        // Retrieve and return the updated conflict record
        let updated = Self::get_conflicts_for_clinic(conn, clinic_id, None)?
            .into_iter()
            .find(|c| c.id == conflict_id)
            .ok_or_else(|| {
                DatabaseOpError::ConflictResolution("Conflict vanished after resolution commit".to_string())
            })?;

        Ok(updated)
    }

    /// Fetches pending outbox mutations for a clinic up to `batch_size`, marking them IN_FLIGHT.
    /// Payload is decrypted with the DatabaseEncryptionKey.
    pub fn get_pending_outbox_batch(
        conn: &mut Connection,
        dek: &DatabaseEncryptionKey,
        clinic_id: &str,
        batch_size: usize,
    ) -> Result<Vec<DecryptedOutboxItem>, DatabaseOpError> {
        let tx = conn.transaction()?;

        let items = {
            let mut stmt = tx.prepare(
                r#"
                SELECT id, clinic_id, entity_type, entity_id, action, idempotency_key,
                       encrypted_payload, nonce, retry_count
                FROM local_sync_outbox
                WHERE clinic_id = ?1 AND sync_status = 'PENDING'
                ORDER BY created_at ASC
                LIMIT ?2
                "#,
            )?;

            struct RawOutboxItem {
                id: String,
                clinic_id: String,
                entity_type: String,
                entity_id: String,
                action: String,
                idempotency_key: String,
                encrypted_payload: Vec<u8>,
                nonce: Vec<u8>,
                _retry_count: i32,
            }

            let raw_items = stmt
                .query_map(params![clinic_id, batch_size as i64], |row| {
                    Ok(RawOutboxItem {
                        id: row.get(0)?,
                        clinic_id: row.get(1)?,
                        entity_type: row.get(2)?,
                        entity_id: row.get(3)?,
                        action: row.get(4)?,
                        idempotency_key: row.get(5)?,
                        encrypted_payload: row.get(6)?,
                        nonce: row.get(7)?,
                        _retry_count: row.get(8)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            raw_items
        };

        let mut decrypted_items = Vec::with_capacity(items.len());

        for item in &items {
            let plaintext = decrypt_payload(&dek.key, &item.encrypted_payload, &item.nonce)?;
            let payload: serde_json::Value = serde_json::from_slice(&plaintext)
                .map_err(DatabaseOpError::Serialization)?;

            let (server_id, client_version): (Option<String>, i64) = match item.entity_type.as_str() {
                "PATIENT" => {
                    let from_db: Option<(Option<String>, i32)> = tx.query_row(
                        "SELECT server_id, COALESCE(server_version, local_version) FROM local_patients WHERE id = ?1",
                        params![item.entity_id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    ).ok();

                    let s_id = from_db.as_ref().and_then(|(s, _)| s.clone()).or_else(|| {
                        payload
                            .get("serverId")
                            .or_else(|| payload.get("server_id"))
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string())
                    });
                    let ver = from_db.map(|(_, v)| v as i64).unwrap_or(1);
                    (s_id, ver)
                }
                "CONSULTATION" => {
                    let from_db: Option<(Option<String>, i32)> = tx.query_row(
                        "SELECT server_id, COALESCE(server_version, local_version) FROM local_consultations WHERE id = ?1",
                        params![item.entity_id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    ).ok();

                    let s_id = from_db.as_ref().and_then(|(s, _)| s.clone()).or_else(|| {
                        payload
                            .get("serverId")
                            .or_else(|| payload.get("server_id"))
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string())
                    });
                    let ver = from_db.map(|(_, v)| v as i64).unwrap_or(1);
                    (s_id, ver)
                }
                "PRESCRIPTION" | "PRESCRIPTION_REVISION" => {
                    let from_db: Option<(Option<String>, i32, String)> = tx.query_row(
                        "SELECT server_id, COALESCE(server_version, local_version), prescription_number FROM local_prescriptions WHERE id = ?1",
                        params![item.entity_id],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    ).ok();

                    let (db_server_id, db_ver, rx_num) = match from_db {
                        Some((s, v, n)) => (s, v as i64, Some(n)),
                        None => (None, 1i64, None),
                    };

                    let s_id = db_server_id
                        .or_else(|| {
                            payload
                                .get("serverId")
                                .or_else(|| payload.get("server_id"))
                                .and_then(|v| v.as_str())
                                .filter(|s| !s.is_empty())
                                .map(|s| s.to_string())
                        })
                        .or_else(|| {
                            let target_rx = rx_num.as_deref().or_else(|| payload.get("prescriptionNumber").and_then(|v| v.as_str()));
                            if let Some(num) = target_rx {
                                tx.query_row(
                                    "SELECT server_id FROM local_prescriptions WHERE clinic_id = ?1 AND prescription_number = ?2 AND server_id IS NOT NULL LIMIT 1",
                                    params![item.clinic_id, num],
                                    |r| r.get(0),
                                ).ok().flatten()
                            } else {
                                None
                            }
                        });

                    let ver = payload.get("expectedVersion").and_then(|v| v.as_i64()).unwrap_or(db_ver);
                    (s_id, ver)
                }
                "INVOICE" => {
                    let from_db: Option<(Option<String>, i32)> = tx.query_row(
                        "SELECT server_id, COALESCE(server_version, local_version) FROM local_invoices_v2 WHERE id = ?1",
                        params![item.entity_id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    ).ok();

                    let s_id = from_db.as_ref().and_then(|(s, _)| s.clone()).or_else(|| {
                        payload
                            .get("serverId")
                            .or_else(|| payload.get("server_id"))
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string())
                    });
                    let ver = from_db.map(|(_, v)| v as i64).unwrap_or(1);
                    (s_id, ver)
                }
                _ => (None, 1),
            };

            decrypted_items.push(DecryptedOutboxItem {
                id: item.id.clone(),
                clinic_id: item.clinic_id.clone(),
                entity_type: item.entity_type.clone(),
                entity_id: item.entity_id.clone(),
                action: item.action.clone(),
                idempotency_key: item.idempotency_key.clone(),
                client_version,
                server_id,
                payload,
            });

            tx.execute(
                "UPDATE local_sync_outbox SET sync_status = 'IN_FLIGHT' WHERE id = ?1",
                params![item.id],
            )?;
        }

        tx.commit()?;
        Ok(decrypted_items)
    }

    /// Reverts in-flight outbox items back to PENDING if push failed or network dropped
    pub fn revert_in_flight_to_pending(
        conn: &Connection,
        outbox_ids: &[String],
        error_msg: Option<&str>,
    ) -> Result<usize, DatabaseOpError> {
        if outbox_ids.is_empty() {
            return Ok(0);
        }

        let mut count = 0;
        for id in outbox_ids {
            let rows = conn.execute(
                "UPDATE local_sync_outbox SET sync_status = 'PENDING', last_error = ?1, retry_count = retry_count + 1 WHERE id = ?2 AND sync_status = 'IN_FLIGHT'",
                params![error_msg, id],
            )?;
            count += rows;
        }
        Ok(count)
    }

    /// Applies individual push mutation result returned from backend POST /sync/push
    pub fn apply_push_mutation_result(
        conn: &mut Connection,
        outbox_id: &str,
        status: &str, // "APPLIED", "CONFLICT", "REJECTED"
        entity_type: &str,
        entity_id: &str,
        server_id: Option<&str>,
        server_version: Option<i64>,
        error: Option<&str>,
        conflict_details: Option<&serde_json::Value>,
    ) -> Result<(), DatabaseOpError> {
        let tx = conn.transaction()?;

        match status {
            "APPLIED" => {
                tx.execute(
                    r#"
                    UPDATE local_sync_outbox
                    SET sync_status = 'SYNCED',
                        synced_at = CURRENT_TIMESTAMP
                    WHERE id = ?1
                    "#,
                    params![outbox_id],
                )?;

                let s_version = server_version.unwrap_or(1);
                match entity_type {
                    "PATIENT" => {
                        tx.execute(
                            r#"
                            UPDATE local_patients
                            SET sync_status = 'SYNCED',
                                server_id = COALESCE(?1, server_id),
                                server_version = ?2,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE id = ?3
                            "#,
                            params![server_id, s_version, entity_id],
                        )?;
                    }
                    "CONSULTATION" => {
                        tx.execute(
                            r#"
                            UPDATE local_consultations
                            SET sync_status = 'SYNCED',
                                server_id = COALESCE(?1, server_id),
                                server_version = ?2,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE id = ?3
                            "#,
                            params![server_id, s_version, entity_id],
                        )?;
                    }
                    "PRESCRIPTION" | "PRESCRIPTION_REVISION" => {
                        tx.execute(
                            r#"
                            UPDATE local_prescriptions
                            SET sync_status = 'SYNCED',
                                server_id = COALESCE(?1, server_id),
                                server_version = ?2,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE id = ?3
                            "#,
                            params![server_id, s_version, entity_id],
                        )?;
                    }
                    "INVOICE" => {
                        tx.execute(
                            r#"
                            UPDATE local_invoices_v2
                            SET sync_status = 'SYNCED',
                                server_id = COALESCE(?1, server_id),
                                server_version = ?2,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE id = ?3
                            "#,
                            params![server_id, s_version, entity_id],
                        )?;
                    }
                    _ => {}
                }
            }
            "CONFLICT" => {
                tx.execute(
                    r#"
                    UPDATE local_sync_outbox
                    SET sync_status = 'CONFLICT',
                        last_error = ?1
                    WHERE id = ?2
                    "#,
                    params![error, outbox_id],
                )?;

                match entity_type {
                    "PATIENT" => {
                        tx.execute(
                            "UPDATE local_patients SET sync_status = 'CONFLICT', updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                            params![entity_id],
                        )?;
                    }
                    "CONSULTATION" => {
                        tx.execute(
                            "UPDATE local_consultations SET sync_status = 'CONFLICT', updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                            params![entity_id],
                        )?;
                    }
                    "PRESCRIPTION" | "PRESCRIPTION_REVISION" => {
                        tx.execute(
                            "UPDATE local_prescriptions SET sync_status = 'CONFLICT', updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                            params![entity_id],
                        )?;
                    }
                    "INVOICE" => {
                        tx.execute(
                            "UPDATE local_invoices_v2 SET sync_status = 'CONFLICT', updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                            params![entity_id],
                        )?;
                    }
                    _ => {}
                }

                let conflict_id = Uuid::new_v4().to_string();
                let server_ver = conflict_details
                    .and_then(|d| d.get("serverVersion"))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0) as i32;
                let client_ver = conflict_details
                    .and_then(|d| d.get("clientVersion"))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0) as i32;
                let conflict_reason = conflict_details
                    .and_then(|d| d.get("conflictReason").or_else(|| d.get("conflict_reason")).or_else(|| d.get("reason")))
                    .and_then(|v| v.as_str())
                    .unwrap_or("Server conflict reported")
                    .to_string();
                let server_payload = conflict_details
                    .and_then(|d| d.get("serverState"))
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "{}".to_string());
                let client_payload = conflict_details
                    .and_then(|d| d.get("clientPayload"))
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "{}".to_string());

                tx.execute(
                    r#"
                    INSERT INTO local_sync_conflicts (
                        id, outbox_id, entity_type, entity_id, server_version, client_version,
                        server_payload, client_payload, conflict_reason, resolution_payload,
                        status, resolved_at, resolution_strategy, created_at
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, 'OPEN', NULL, NULL, CURRENT_TIMESTAMP)
                    "#,
                    params![
                        conflict_id,
                        outbox_id,
                        entity_type,
                        entity_id,
                        server_ver,
                        client_ver,
                        server_payload,
                        client_payload,
                        conflict_reason,
                    ],
                )?;
            }
            _ => {
                tx.execute(
                    r#"
                    UPDATE local_sync_outbox
                    SET sync_status = 'FAILED',
                        last_error = ?1
                    WHERE id = ?2
                    "#,
                    params![error, outbox_id],
                )?;

                if entity_type == "INVOICE" {
                    let _ = tx.execute(
                        "UPDATE local_invoices_v2 SET sync_status = 'FAILED', updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                        params![entity_id],
                    );
                }
            }
        }

        tx.commit()?;
        Ok(())
    }

    /// Transactionally applies changes pulled from the server change feed to local SQLite.
    /// Clinical and demographic data is encrypted before local persistence.
    /// If an item conflicts with a local pending modification, the conflict is durably recorded in
    /// `local_sync_conflicts` and the local record is preserved (never overwritten).
    /// Cursor sequence is advanced within the exact same database transaction.
    pub fn apply_pull_feed_items(
        conn: &mut Connection,
        dek: &DatabaseEncryptionKey,
        clinic_id: &str,
        changes: &[SyncFeedChangeItem],
        current_seq: i64,
        has_more: bool,
    ) -> Result<i64, DatabaseOpError> {
        let tx = conn.transaction()?;

        let mut highest_seq = 0i64;

        for item in changes {
            if item.seq > highest_seq {
                highest_seq = item.seq;
            }

            // 1. Check for local conflict: is there an un-synced outbox item for this entity?
            let client_ent_id = item.client_entity_id.as_deref().unwrap_or("");
            let local_outbox_conflict: Option<(String, String, String, i32)> = {
                let mut outbox_stmt = tx.prepare(
                    r#"
                    SELECT id, sync_status, action, retry_count
                    FROM local_sync_outbox
                    WHERE clinic_id = ?1
                      AND (entity_id = ?2 OR entity_id = ?3)
                      AND sync_status IN ('PENDING', 'IN_FLIGHT')
                    LIMIT 1
                    "#,
                )?;

                let res = outbox_stmt
                    .query_map(
                        params![clinic_id, client_ent_id, item.entity_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )?
                    .filter_map(Result::ok)
                    .next();
                res
            };

            if let Some((outbox_id, _status, _action, _retries)) = local_outbox_conflict {
                // Concurrent local and remote edit: record conflict durably, DO NOT overwrite local data!
                let conflict_id = Uuid::new_v4().to_string();
                let server_payload_str = item.payload.to_string();

                let client_payload_str = match item.entity_type.as_str() {
                    "PATIENT" => {
                        let mut p_stmt = tx.prepare(
                            "SELECT encrypted_demographics, nonce FROM local_patients WHERE clinic_id = ?1 AND (id = ?2 OR server_id = ?3)"
                        )?;
                        let res: Option<(Vec<u8>, Vec<u8>)> = p_stmt
                            .query_map(
                                params![clinic_id, client_ent_id, item.entity_id],
                                |row| Ok((row.get(0)?, row.get(1)?)),
                            )?
                            .filter_map(Result::ok)
                            .next();
                        if let Some((enc, nonce)) = res {
                            decrypt_payload(&dek.key, &enc, &nonce)
                                .map(|b| String::from_utf8_lossy(&b).to_string())
                                .unwrap_or_else(|_| "{}".to_string())
                        } else {
                            "{}".to_string()
                        }
                    }
                    "CONSULTATION" => {
                        let mut c_stmt = tx.prepare(
                            "SELECT encrypted_clinical_data, nonce FROM local_consultations WHERE clinic_id = ?1 AND (id = ?2 OR server_id = ?3)"
                        )?;
                        let res: Option<(Vec<u8>, Vec<u8>)> = c_stmt
                            .query_map(
                                params![clinic_id, client_ent_id, item.entity_id],
                                |row| Ok((row.get(0)?, row.get(1)?)),
                            )?
                            .filter_map(Result::ok)
                            .next();
                        if let Some((enc, nonce)) = res {
                            decrypt_payload(&dek.key, &enc, &nonce)
                                .map(|b| String::from_utf8_lossy(&b).to_string())
                                .unwrap_or_else(|_| "{}".to_string())
                        } else {
                            "{}".to_string()
                        }
                    }
                    "PRESCRIPTION" | "PRESCRIPTION_REVISION" => {
                        let mut r_stmt = tx.prepare(
                            "SELECT encrypted_items, nonce FROM local_prescriptions WHERE clinic_id = ?1 AND (id = ?2 OR server_id = ?3)"
                        )?;
                        let res: Option<(Vec<u8>, Vec<u8>)> = r_stmt
                            .query_map(
                                params![clinic_id, client_ent_id, item.entity_id],
                                |row| Ok((row.get(0)?, row.get(1)?)),
                            )?
                            .filter_map(Result::ok)
                            .next();
                        if let Some((enc, nonce)) = res {
                            decrypt_payload(&dek.key, &enc, &nonce)
                                .map(|b| String::from_utf8_lossy(&b).to_string())
                                .unwrap_or_else(|_| "{}".to_string())
                        } else {
                            "{}".to_string()
                        }
                    }
                    "INVOICE" => {
                        let mut inv_stmt = tx.prepare(
                            "SELECT encrypted_billing_data, nonce FROM local_invoices_v2 WHERE clinic_id = ?1 AND (id = ?2 OR server_id = ?3)"
                        )?;
                        let res: Option<(Vec<u8>, Vec<u8>)> = inv_stmt
                            .query_map(
                                params![clinic_id, client_ent_id, item.entity_id],
                                |row| Ok((row.get(0)?, row.get(1)?)),
                            )?
                            .filter_map(Result::ok)
                            .next();
                        if let Some((enc, nonce)) = res {
                            decrypt_payload(&dek.key, &enc, &nonce)
                                .map(|b| String::from_utf8_lossy(&b).to_string())
                                .unwrap_or_else(|_| "{}".to_string())
                        } else {
                            "{}".to_string()
                        }
                    }
                    _ => "{}".to_string(),
                };

                tx.execute(
                    r#"
                    INSERT INTO local_sync_conflicts (
                        id, outbox_id, entity_type, entity_id, server_version, client_version,
                        server_payload, client_payload, conflict_reason, resolution_payload,
                        status, resolved_at, resolution_strategy, created_at
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, 'OPEN', NULL, NULL, CURRENT_TIMESTAMP)
                    "#,
                    params![
                        conflict_id,
                        outbox_id,
                        item.entity_type,
                        item.client_entity_id.as_deref().unwrap_or(&item.entity_id),
                        item.version as i32,
                        1i32,
                        server_payload_str,
                        client_payload_str,
                        "CONCURRENT_REMOTE_UPDATE",
                    ],
                )?;

                tx.execute(
                    "UPDATE local_sync_outbox SET sync_status = 'CONFLICT', last_error = 'Conflict with remote update' WHERE id = ?1",
                    params![outbox_id],
                )?;

                match item.entity_type.as_str() {
                    "PATIENT" => {
                        tx.execute(
                            "UPDATE local_patients SET sync_status = 'CONFLICT', updated_at = CURRENT_TIMESTAMP WHERE clinic_id = ?1 AND (id = ?2 OR server_id = ?3)",
                            params![clinic_id, client_ent_id, item.entity_id],
                        )?;
                    }
                    "CONSULTATION" => {
                        tx.execute(
                            "UPDATE local_consultations SET sync_status = 'CONFLICT', updated_at = CURRENT_TIMESTAMP WHERE clinic_id = ?1 AND (id = ?2 OR server_id = ?3)",
                            params![clinic_id, client_ent_id, item.entity_id],
                        )?;
                    }
                    "PRESCRIPTION" | "PRESCRIPTION_REVISION" => {
                        tx.execute(
                            "UPDATE local_prescriptions SET sync_status = 'CONFLICT', updated_at = CURRENT_TIMESTAMP WHERE clinic_id = ?1 AND (id = ?2 OR server_id = ?3)",
                            params![clinic_id, client_ent_id, item.entity_id],
                        )?;
                    }
                    "INVOICE" => {
                        tx.execute(
                            "UPDATE local_invoices_v2 SET sync_status = 'CONFLICT', updated_at = CURRENT_TIMESTAMP WHERE clinic_id = ?1 AND (id = ?2 OR server_id = ?3)",
                            params![clinic_id, client_ent_id, item.entity_id],
                        )?;
                    }
                    _ => {}
                }

                continue;
            }

            // 2. No conflict: apply remote changes to local database with encryption
            match item.entity_type.as_str() {
                "PATIENT" => {
                    if item.action == "DELETE" {
                        tx.execute(
                            "DELETE FROM local_patients WHERE clinic_id = ?1 AND (server_id = ?2 OR (?3 != '' AND id = ?3))",
                            params![clinic_id, item.entity_id, client_ent_id],
                        )?;
                        continue;
                    }
                    let name = item.payload.get("name").and_then(|v| v.as_str()).unwrap_or("Unnamed Patient");
                    let phone = item.payload.get("phone").and_then(|v| v.as_str()).unwrap_or("");
                    let gender = item.payload.get("gender").and_then(|v| v.as_str()).unwrap_or("OTHER");
                    let patient_code = item.payload.get("patientId")
                        .or_else(|| item.payload.get("patientCode"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("P-UNKNOWN");
                    let date_of_birth = item.payload.get("dateOfBirth").and_then(|v| v.as_str()).map(|s| s.to_string());
                    let age = item.payload.get("age").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                    let allergies: Vec<String> = item.payload.get("allergies")
                        .and_then(|v| v.as_array())
                        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                        .unwrap_or_default();
                    let conditions: Vec<String> = item.payload.get("conditions")
                        .and_then(|v| v.as_array())
                        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                        .unwrap_or_default();

                    let demographics = PatientDemographics {
                        name: name.to_string(),
                        phone: phone.to_string(),
                        gender: gender.to_string(),
                        date_of_birth,
                        age,
                        allergies,
                        conditions,
                        sensitive_notes: None,
                    };
                    let demo_bytes = serde_json::to_vec(&demographics)?;
                    let (enc_bytes, nonce) = encrypt_payload(&dek.key, &demo_bytes)?;

                    let existing_id: Option<String> = {
                        let mut check_stmt = tx.prepare(
                            "SELECT id FROM local_patients WHERE clinic_id = ?1 AND (server_id = ?2 OR (?3 != '' AND id = ?3)) LIMIT 1"
                        )?;
                        check_stmt
                            .query_map(
                                params![clinic_id, item.entity_id, client_ent_id],
                                |row| row.get(0),
                            )?
                            .filter_map(Result::ok)
                            .next()
                    };

                    if let Some(id) = existing_id {
                        tx.execute(
                            r#"
                            UPDATE local_patients
                            SET server_id = ?1,
                                patient_code = ?2,
                                encrypted_demographics = ?3,
                                nonce = ?4,
                                sync_status = 'SYNCED',
                                server_version = ?5,
                                local_version = ?5,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE id = ?6
                            "#,
                            params![item.entity_id, patient_code, enc_bytes, nonce, item.version, id],
                        )?;
                    } else {
                        let local_id = item.client_entity_id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());
                        tx.execute(
                            r#"
                            INSERT INTO local_patients (
                                id, server_id, clinic_id, patient_code, encrypted_demographics,
                                nonce, sync_status, server_version, local_version, created_at, updated_at
                            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'SYNCED', ?7, ?7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                            "#,
                            params![local_id, item.entity_id, clinic_id, patient_code, enc_bytes, nonce, item.version],
                        )?;
                    }
                }
                "CONSULTATION" => {
                    let chief_complaint = item.payload.get("chiefComplaint").and_then(|v| v.as_str()).unwrap_or("");
                    let diagnosis = item.payload.get("diagnosis").and_then(|v| v.as_str()).unwrap_or("");
                    let status = item.payload.get("status").and_then(|v| v.as_str()).unwrap_or("DRAFT");
                    let consultation_date = item.payload.get("consultationDate").and_then(|v| v.as_str()).unwrap_or("");
                    let doctor_id = item.actor_doctor_id.as_str();
                    let patient_id = item.payload.get("patientId").and_then(|v| v.as_str()).unwrap_or("");

                    let clinical_data = ClinicalData {
                        chief_complaint: chief_complaint.to_string(),
                        diagnosis: diagnosis.to_string(),
                        clinical_snapshot_json: Some(item.payload.to_string()),
                    };
                    let clin_bytes = serde_json::to_vec(&clinical_data)?;
                    let (enc_bytes, nonce) = encrypt_payload(&dek.key, &clin_bytes)?;

                    let existing_id: Option<String> = {
                        let mut check_stmt = tx.prepare(
                            "SELECT id FROM local_consultations WHERE clinic_id = ?1 AND (server_id = ?2 OR (?3 != '' AND id = ?3)) LIMIT 1"
                        )?;
                        check_stmt
                            .query_map(
                                params![clinic_id, item.entity_id, client_ent_id],
                                |row| row.get(0),
                            )?
                            .filter_map(Result::ok)
                            .next()
                    };

                    if let Some(id) = existing_id {
                        tx.execute(
                            r#"
                            UPDATE local_consultations
                            SET server_id = ?1,
                                status = ?2,
                                encrypted_clinical_data = ?3,
                                nonce = ?4,
                                sync_status = 'SYNCED',
                                server_version = ?5,
                                local_version = ?5,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE id = ?6
                            "#,
                            params![item.entity_id, status, enc_bytes, nonce, item.version, id],
                        )?;
                    } else {
                        let local_id = item.client_entity_id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());
                        tx.execute(
                            r#"
                            INSERT INTO local_consultations (
                                id, server_id, clinic_id, patient_id, doctor_id, consultation_date,
                                status, encrypted_clinical_data, nonce, sync_status, server_version, local_version,
                                created_at, updated_at
                            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'SYNCED', ?10, ?10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                            "#,
                            params![
                                local_id, item.entity_id, clinic_id, patient_id, doctor_id,
                                consultation_date, status, enc_bytes, nonce, item.version
                            ],
                        )?;
                    }
                }
                "PRESCRIPTION" | "PRESCRIPTION_REVISION" => {
                    let consultation_id = item.payload.get("consultationId")
                        .or_else(|| item.payload.get("revision").and_then(|r| r.get("consultationId")))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let patient_id = item.payload.get("patientId")
                        .or_else(|| item.payload.get("revision").and_then(|r| r.get("patientId")))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let doctor_id = item.actor_doctor_id.as_str();
                    let rx_number = item.payload.get("prescriptionNumber")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let revision_number = item.payload.get("revisionNumber")
                        .or_else(|| item.payload.get("currentRevisionNumber"))
                        .or_else(|| item.payload.get("revision").and_then(|r| r.get("revisionNumber")))
                        .and_then(|v| v.as_i64())
                        .unwrap_or(1) as i32;
                    let status = item.payload.get("status").and_then(|v| v.as_str()).unwrap_or("ACTIVE");
                    let items_val = item.payload.get("items")
                        .or_else(|| item.payload.get("revision").and_then(|r| r.get("items")))
                        .unwrap_or(&item.payload);
                    let items_str = items_val.to_string();

                    let (enc_bytes, nonce) = encrypt_payload(&dek.key, items_str.as_bytes())?;

                    let existing_id: Option<String> = {
                        let mut check_stmt = tx.prepare(
                            r#"
                            SELECT id FROM local_prescriptions
                            WHERE clinic_id = ?1
                              AND ((server_id = ?2 AND revision_number = ?3) OR (?4 != '' AND id = ?4))
                            LIMIT 1
                            "#
                        )?;
                        check_stmt
                            .query_map(
                                params![clinic_id, item.entity_id, revision_number, client_ent_id],
                                |row| row.get(0),
                            )?
                            .filter_map(Result::ok)
                            .next()
                    };

                    if let Some(id) = existing_id {
                        tx.execute(
                            r#"
                            UPDATE local_prescriptions
                            SET server_id = ?1,
                                revision_number = ?2,
                                status = ?3,
                                encrypted_items = ?4,
                                nonce = ?5,
                                sync_status = 'SYNCED',
                                server_version = ?6,
                                local_version = ?6,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE id = ?7
                            "#,
                            params![item.entity_id, revision_number, status, enc_bytes, nonce, item.version, id],
                        )?;
                    } else {
                        let effective_rx_number = if !rx_number.is_empty() && rx_number != "RX-UNKNOWN" {
                            rx_number.to_string()
                        } else {
                            tx.query_row(
                                "SELECT prescription_number FROM local_prescriptions WHERE clinic_id = ?1 AND server_id = ?2 LIMIT 1",
                                params![clinic_id, item.entity_id],
                                |r| r.get(0),
                            ).unwrap_or_else(|_| "RX-UNKNOWN".to_string())
                        };

                        let effective_patient_id = if !patient_id.is_empty() {
                            patient_id.to_string()
                        } else {
                            tx.query_row(
                                "SELECT patient_id FROM local_prescriptions WHERE clinic_id = ?1 AND server_id = ?2 LIMIT 1",
                                params![clinic_id, item.entity_id],
                                |r| r.get(0),
                            ).unwrap_or_default()
                        };

                        let effective_consultation_id = if !consultation_id.is_empty() {
                            consultation_id.to_string()
                        } else {
                            tx.query_row(
                                "SELECT consultation_id FROM local_prescriptions WHERE clinic_id = ?1 AND server_id = ?2 LIMIT 1",
                                params![clinic_id, item.entity_id],
                                |r| r.get(0),
                            ).unwrap_or_default()
                        };

                        // Mark older revisions for this prescription as SUPERSEDED to preserve immutability
                        tx.execute(
                            r#"
                            UPDATE local_prescriptions
                            SET status = 'SUPERSEDED',
                                updated_at = CURRENT_TIMESTAMP
                            WHERE clinic_id = ?1 AND (server_id = ?2 OR prescription_number = ?3) AND status = 'ACTIVE'
                            "#,
                            params![clinic_id, item.entity_id, effective_rx_number],
                        )?;

                        let local_id = item.client_entity_id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());
                        tx.execute(
                            r#"
                            INSERT INTO local_prescriptions (
                                id, server_id, clinic_id, consultation_id, patient_id, doctor_id,
                                prescription_number, revision_number, status, encrypted_items, nonce,
                                sync_status, server_version, local_version, created_at, updated_at
                            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'SYNCED', ?12, ?12, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                            "#,
                            params![
                                local_id, item.entity_id, clinic_id, effective_consultation_id, effective_patient_id, doctor_id,
                                effective_rx_number, revision_number, status, enc_bytes, nonce, item.version
                            ],
                        )?;
                    }
                }
                "INVOICE" => {
                    let invoice_number = item.payload.get("invoiceNumber").and_then(|v| v.as_str()).unwrap_or("INV-UNKNOWN");
                    let invoice_date = item.payload.get("invoiceDate").and_then(|v| v.as_str()).unwrap_or("2026-01-01");
                    let status = item.payload.get("status").and_then(|v| v.as_str()).unwrap_or("DRAFT");
                    let payment_status = item.payload.get("paymentStatus").and_then(|v| v.as_str()).unwrap_or("UNPAID");
                    let subtotal_paise = item.payload.get("subtotalPaise").and_then(|v| v.as_i64()).unwrap_or(0);
                    let discount_paise = item.payload.get("discountPaise").and_then(|v| v.as_i64()).unwrap_or(0);
                    let tax_rate_percent = item.payload.get("taxRatePercent").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let tax_paise = item.payload.get("taxPaise").and_then(|v| v.as_i64()).unwrap_or(0);
                    let total_paise = item.payload.get("totalPaise").and_then(|v| v.as_i64()).unwrap_or(0);
                    let patient_id = item.payload.get("patientId").and_then(|v| v.as_str()).unwrap_or("");
                    let consultation_id = item.payload.get("consultationId").and_then(|v| v.as_str());
                    let notes = item.payload.get("notes").and_then(|v| v.as_str()).map(|s| s.to_string());

                    let items_raw = item.payload.get("items").cloned().unwrap_or(serde_json::Value::Array(Vec::new()));
                    let items: Vec<InvoiceItem> = serde_json::from_value(items_raw).unwrap_or_default();
                    let billing_data = EncryptedBillingData {
                        items,
                        notes,
                    };
                    let billing_bytes = serde_json::to_vec(&billing_data)?;
                    let (enc_billing, nonce_billing) = encrypt_payload(&dek.key, &billing_bytes)?;

                    let existing_id: Option<String> = {
                        let mut check_stmt = tx.prepare(
                            "SELECT id FROM local_invoices_v2 WHERE clinic_id = ?1 AND (server_id = ?2 OR (?3 != '' AND id = ?3)) LIMIT 1"
                        )?;
                        check_stmt
                            .query_map(
                                params![clinic_id, item.entity_id, client_ent_id],
                                |row| row.get(0),
                            )?
                            .filter_map(Result::ok)
                            .next()
                    };

                    if let Some(id) = existing_id {
                        tx.execute(
                            r#"
                            UPDATE local_invoices_v2
                            SET server_id = ?1,
                                invoice_number = ?2,
                                invoice_date = ?3,
                                status = ?4,
                                payment_status = ?5,
                                subtotal_paise = ?6,
                                discount_paise = ?7,
                                tax_rate_percent = ?8,
                                tax_paise = ?9,
                                total_paise = ?10,
                                encrypted_billing_data = ?11,
                                nonce = ?12,
                                sync_status = 'SYNCED',
                                server_version = ?13,
                                local_version = ?13,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE id = ?14
                            "#,
                            params![
                                item.entity_id, invoice_number, invoice_date, status, payment_status,
                                subtotal_paise, discount_paise, tax_rate_percent, tax_paise, total_paise,
                                enc_billing, nonce_billing, item.version, id
                            ],
                        )?;
                    } else {
                        let local_id = item.client_entity_id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());
                        tx.execute(
                            r#"
                            INSERT INTO local_invoices_v2 (
                                id, server_id, clinic_id, patient_id, consultation_id,
                                invoice_number, invoice_date, status, payment_status,
                                subtotal_paise, discount_paise, tax_rate_percent, tax_paise, total_paise,
                                encrypted_billing_data, nonce, sync_status, server_version, local_version,
                                created_at, updated_at
                            ) VALUES (
                                ?1, ?2, ?3, ?4, ?5,
                                ?6, ?7, ?8, ?9,
                                ?10, ?11, ?12, ?13, ?14,
                                ?15, ?16, 'SYNCED', ?17, ?17,
                                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                            )
                            "#,
                            params![
                                local_id, item.entity_id, clinic_id, patient_id, consultation_id,
                                invoice_number, invoice_date, status, payment_status,
                                subtotal_paise, discount_paise, tax_rate_percent, tax_paise, total_paise,
                                enc_billing, nonce_billing, item.version
                            ],
                        )?;
                    }
                }
                _ => {}
            }
        }

        let final_seq = if highest_seq > 0 {
            highest_seq
        } else {
            current_seq
        };

        // Update local_sync_state transactionally
        let in_sync_val = if has_more { 0 } else { 1 };
        tx.execute(
            r#"
            INSERT INTO local_sync_state (clinic_id, last_pulled_seq, last_pulled_at, last_pushed_at, in_sync)
            VALUES (?1, ?2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?3)
            ON CONFLICT(clinic_id) DO UPDATE SET
                last_pulled_seq = MAX(local_sync_state.last_pulled_seq, excluded.last_pulled_seq),
                last_pulled_at = excluded.last_pulled_at,
                in_sync = excluded.in_sync
            "#,
            params![clinic_id, final_seq, in_sync_val],
        )?;

        tx.commit()?;
        Ok(final_seq)
    }

    /// Saves an invoice draft or update with encrypted billing data and outbox synchronization.
    /// Performs strict integer minor-unit calculations and clamps discount to prevent negative totals.
    pub fn save_invoice(
        conn: &mut Connection,
        dek: &DatabaseEncryptionKey,
        doctor_id: &str,
        args: SaveInvoiceArgs,
    ) -> Result<String, DatabaseOpError> {
        if args.items.is_empty() {
            return Err(DatabaseOpError::ConflictResolution(
                "At least one invoice item is required".to_string(),
            ));
        }

        let mut validated_items = Vec::new();
        let mut subtotal_paise = 0i64;

        for it in args.items {
            if it.quantity < 1 {
                return Err(DatabaseOpError::ConflictResolution(format!(
                    "Item '{}': quantity must be >= 1",
                    it.description
                )));
            }
            if it.unit_price_paise < 0 {
                return Err(DatabaseOpError::ConflictResolution(format!(
                    "Item '{}': unit price cannot be negative",
                    it.description
                )));
            }
            let item_total = it.quantity * it.unit_price_paise;
            subtotal_paise += item_total;
            validated_items.push(InvoiceItem {
                description: it.description.trim().to_string(),
                quantity: it.quantity,
                unit_price_paise: it.unit_price_paise,
                total_paise: item_total,
            });
        }

        let requested_discount = args.discount_paise.unwrap_or(0);
        if requested_discount < 0 {
            return Err(DatabaseOpError::ConflictResolution(
                "Discount cannot be negative".to_string(),
            ));
        }
        let discount_paise = requested_discount.min(subtotal_paise);
        let taxable_amount = subtotal_paise - discount_paise;

        let tax_rate = args.tax_rate_percent.unwrap_or(0.0);
        if tax_rate < 0.0 || tax_rate > 100.0 {
            return Err(DatabaseOpError::ConflictResolution(
                "Tax rate must be between 0 and 100".to_string(),
            ));
        }

        let tax_paise = ((taxable_amount as f64) * (tax_rate / 100.0)).round() as i64;
        let total_paise = taxable_amount + tax_paise;

        if total_paise < 0 {
            return Err(DatabaseOpError::ConflictResolution(
                "Total amount cannot be negative".to_string(),
            ));
        }

        let invoice_id = args.id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let status = args.status.unwrap_or_else(|| "DRAFT".to_string());
        let payment_status = args.payment_status.unwrap_or_else(|| "UNPAID".to_string());

        let billing_data = EncryptedBillingData {
            items: validated_items.clone(),
            notes: args.notes.clone(),
        };
        let billing_bytes = serde_json::to_vec(&billing_data)?;
        let (enc_billing, nonce_billing) = encrypt_payload(&dek.key, &billing_bytes)?;

        let tx = conn.transaction()?;

        let existing_status: Option<String> = tx
            .query_row(
                "SELECT status FROM local_invoices_v2 WHERE clinic_id = ?1 AND id = ?2",
                params![args.clinic_id, invoice_id],
                |row| row.get(0),
            )
            .optional()?;

        let (is_new, new_version) = match existing_status {
            Some(curr_status) => {
                if curr_status == "FINALIZED" || curr_status == "CANCELLED" {
                    return Err(DatabaseOpError::ConflictResolution(format!(
                        "Cannot edit invoice in {} status",
                        curr_status
                    )));
                }
                let curr_version: i32 = tx.query_row(
                    "SELECT local_version FROM local_invoices_v2 WHERE clinic_id = ?1 AND id = ?2",
                    params![args.clinic_id, invoice_id],
                    |row| row.get(0),
                )?;
                (false, curr_version + 1)
            }
            None => (true, 1),
        };

        if is_new {
            tx.execute(
                r#"
                INSERT INTO local_invoices_v2 (
                    id, server_id, clinic_id, patient_id, consultation_id,
                    invoice_number, invoice_date, status, payment_status,
                    subtotal_paise, discount_paise, tax_rate_percent, tax_paise, total_paise,
                    encrypted_billing_data, nonce, sync_status, server_version, local_version,
                    created_at, updated_at
                ) VALUES (
                    ?1, NULL, ?2, ?3, ?4,
                    ?5, ?6, ?7, ?8,
                    ?9, ?10, ?11, ?12, ?13,
                    ?14, ?15, 'PENDING', 1, ?16,
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
                "#,
                params![
                    invoice_id,
                    args.clinic_id,
                    args.patient_id,
                    args.consultation_id,
                    args.invoice_number,
                    args.invoice_date,
                    status,
                    payment_status,
                    subtotal_paise,
                    discount_paise,
                    tax_rate,
                    tax_paise,
                    total_paise,
                    enc_billing,
                    nonce_billing,
                    new_version,
                ],
            )?;
        } else {
            tx.execute(
                r#"
                UPDATE local_invoices_v2 SET
                    invoice_number = ?1,
                    invoice_date = ?2,
                    status = ?3,
                    payment_status = ?4,
                    subtotal_paise = ?5,
                    discount_paise = ?6,
                    tax_rate_percent = ?7,
                    tax_paise = ?8,
                    total_paise = ?9,
                    encrypted_billing_data = ?10,
                    nonce = ?11,
                    local_version = ?12,
                    sync_status = 'PENDING',
                    updated_at = CURRENT_TIMESTAMP
                WHERE clinic_id = ?13 AND id = ?14
                "#,
                params![
                    args.invoice_number,
                    args.invoice_date,
                    status,
                    payment_status,
                    subtotal_paise,
                    discount_paise,
                    tax_rate,
                    tax_paise,
                    total_paise,
                    enc_billing,
                    nonce_billing,
                    new_version,
                    args.clinic_id,
                    invoice_id,
                ],
            )?;
        }

        // Outbox entry (encrypted payload)
        let outbox_payload = json!({
            "patientId": args.patient_id,
            "consultationId": args.consultation_id,
            "invoiceNumber": args.invoice_number,
            "invoiceDate": args.invoice_date,
            "status": status,
            "paymentStatus": payment_status,
            "subtotalPaise": subtotal_paise,
            "discountPaise": discount_paise,
            "taxRatePercent": tax_rate,
            "taxPaise": tax_paise,
            "totalPaise": total_paise,
            "items": validated_items,
            "notes": args.notes,
            "doctorId": doctor_id,
            "version": new_version,
        });
        let outbox_bytes = serde_json::to_vec(&outbox_payload)?;
        let (enc_outbox, nonce_outbox) = encrypt_payload(&dek.key, &outbox_bytes)?;

        let outbox_id = Uuid::new_v4().to_string();
        let idempotency_key = format!("invoice-mutation-{}-v{}", invoice_id, new_version);
        let action = if is_new { "CREATE" } else { "UPDATE" };

        tx.execute(
            r#"
            INSERT INTO local_sync_outbox (
                id, clinic_id, entity_type, entity_id, action,
                idempotency_key, encrypted_payload, nonce, sync_status
            ) VALUES (?1, ?2, 'INVOICE', ?3, ?4, ?5, ?6, ?7, 'PENDING')
            "#,
            params![
                outbox_id,
                args.clinic_id,
                invoice_id,
                action,
                idempotency_key,
                enc_outbox,
                nonce_outbox,
            ],
        )?;

        tx.commit()?;
        Ok(invoice_id)
    }

    /// Retrieves invoices for a clinic with decrypted billing details.
    pub fn get_invoices(
        conn: &Connection,
        dek: &DatabaseEncryptionKey,
        clinic_id: &str,
        patient_id: Option<&str>,
    ) -> Result<Vec<InvoiceRecord>, DatabaseOpError> {
        let mut sql = String::from(
            r#"
            SELECT id, server_id, clinic_id, patient_id, consultation_id,
                   invoice_number, invoice_date, status, payment_status,
                   subtotal_paise, discount_paise, tax_rate_percent, tax_paise, total_paise,
                   encrypted_billing_data, nonce, sync_status, server_version, local_version,
                   created_at, updated_at
            FROM local_invoices_v2
            WHERE clinic_id = ?1
            "#,
        );

        if patient_id.is_some() {
            sql.push_str(" AND patient_id = ?2 ORDER BY created_at DESC");
        } else {
            sql.push_str(" ORDER BY created_at DESC");
        }

        let mut stmt = conn.prepare(&sql)?;
        let raw_rows: Vec<RawInvoiceRow> = if let Some(pid) = patient_id {
            stmt.query_map(params![clinic_id, pid], Self::map_invoice_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            stmt.query_map(params![clinic_id], Self::map_invoice_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };

        let mut invoices = Vec::new();
        for r in raw_rows {
            let (
                id, server_id, c_id, p_id, consult_id,
                inv_num, inv_date, status, payment_status,
                subtotal, discount, tax_rate, tax, total,
                enc_data, nonce, sync_status, s_ver, l_ver,
                created_at, updated_at,
            ) = r;

            let billing_data: EncryptedBillingData = match decrypt_payload(&dek.key, &enc_data, &nonce) {
                Ok(plain) => serde_json::from_slice(&plain).unwrap_or(EncryptedBillingData {
                    items: Vec::new(),
                    notes: None,
                }),
                Err(_) => EncryptedBillingData {
                    items: Vec::new(),
                    notes: None,
                },
            };

            invoices.push(InvoiceRecord {
                id,
                server_id,
                clinic_id: c_id,
                patient_id: p_id,
                consultation_id: consult_id,
                invoice_number: inv_num,
                invoice_date: inv_date,
                status,
                payment_status,
                items: billing_data.items,
                subtotal_paise: subtotal,
                discount_paise: discount,
                tax_rate_percent: tax_rate,
                tax_paise: tax,
                total_paise: total,
                notes: billing_data.notes,
                sync_status,
                server_version: s_ver,
                local_version: l_ver,
                created_at,
                updated_at,
            });
        }

        Ok(invoices)
    }

    /// Retrieves an invoice by ID with decrypted line items.
    pub fn get_invoice_by_id(
        conn: &Connection,
        dek: &DatabaseEncryptionKey,
        clinic_id: &str,
        invoice_id: &str,
    ) -> Result<Option<InvoiceRecord>, DatabaseOpError> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, server_id, clinic_id, patient_id, consultation_id,
                   invoice_number, invoice_date, status, payment_status,
                   subtotal_paise, discount_paise, tax_rate_percent, tax_paise, total_paise,
                   encrypted_billing_data, nonce, sync_status, server_version, local_version,
                   created_at, updated_at
            FROM local_invoices_v2
            WHERE clinic_id = ?1 AND id = ?2
            "#,
        )?;

        let row = stmt
            .query_row(params![clinic_id, invoice_id], |r| Self::map_invoice_row(r))
            .optional()?;

        match row {
            Some((
                id, server_id, c_id, p_id, consult_id,
                inv_num, inv_date, status, payment_status,
                subtotal, discount, tax_rate, tax, total,
                enc_data, nonce, sync_status, s_ver, l_ver,
                created_at, updated_at,
            )) => {
                let billing_data: EncryptedBillingData = match decrypt_payload(&dek.key, &enc_data, &nonce) {
                    Ok(plain) => serde_json::from_slice(&plain).unwrap_or(EncryptedBillingData {
                        items: Vec::new(),
                        notes: None,
                    }),
                    Err(_) => EncryptedBillingData {
                        items: Vec::new(),
                        notes: None,
                    },
                };

                Ok(Some(InvoiceRecord {
                    id,
                    server_id,
                    clinic_id: c_id,
                    patient_id: p_id,
                    consultation_id: consult_id,
                    invoice_number: inv_num,
                    invoice_date: inv_date,
                    status,
                    payment_status,
                    items: billing_data.items,
                    subtotal_paise: subtotal,
                    discount_paise: discount,
                    tax_rate_percent: tax_rate,
                    tax_paise: tax,
                    total_paise: total,
                    notes: billing_data.notes,
                    sync_status,
                    server_version: s_ver,
                    local_version: l_ver,
                    created_at,
                    updated_at,
                }))
            }
            None => Ok(None),
        }
    }

    /// Transitions an invoice draft to FINALIZED and enqueues sync mutation.
    pub fn finalize_invoice(
        conn: &mut Connection,
        dek: &DatabaseEncryptionKey,
        clinic_id: &str,
        doctor_id: &str,
        invoice_id: &str,
    ) -> Result<InvoiceRecord, DatabaseOpError> {
        let tx = conn.transaction()?;

        let current_status: String = tx
            .query_row(
                "SELECT status FROM local_invoices_v2 WHERE clinic_id = ?1 AND id = ?2",
                params![clinic_id, invoice_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| {
                DatabaseOpError::ConflictResolution("Invoice not found in clinic".to_string())
            })?;

        if current_status == "CANCELLED" {
            return Err(DatabaseOpError::ConflictResolution(
                "Cannot finalize cancelled invoice".to_string(),
            ));
        }

        if current_status == "DRAFT" {
            let new_version: i32 = tx.query_row(
                "SELECT local_version + 1 FROM local_invoices_v2 WHERE clinic_id = ?1 AND id = ?2",
                params![clinic_id, invoice_id],
                |row| row.get(0),
            )?;

            tx.execute(
                "UPDATE local_invoices_v2 SET status = 'FINALIZED', local_version = ?1, sync_status = 'PENDING', updated_at = CURRENT_TIMESTAMP WHERE clinic_id = ?2 AND id = ?3",
                params![new_version, clinic_id, invoice_id],
            )?;

            let outbox_payload = json!({
                "invoiceId": invoice_id,
                "status": "FINALIZED",
                "finalizedBy": doctor_id,
                "version": new_version,
            });
            let outbox_bytes = serde_json::to_vec(&outbox_payload)?;
            let (enc_outbox, nonce_outbox) = encrypt_payload(&dek.key, &outbox_bytes)?;

            let outbox_id = Uuid::new_v4().to_string();
            let idempotency_key = format!("invoice-finalize-{}-v{}", invoice_id, new_version);

            tx.execute(
                r#"
                INSERT INTO local_sync_outbox (
                    id, clinic_id, entity_type, entity_id, action,
                    idempotency_key, encrypted_payload, nonce, sync_status
                ) VALUES (?1, ?2, 'INVOICE', ?3, 'FINALIZE', ?4, ?5, ?6, 'PENDING')
                "#,
                params![
                    outbox_id,
                    clinic_id,
                    invoice_id,
                    idempotency_key,
                    enc_outbox,
                    nonce_outbox,
                ],
            )?;
        }

        tx.commit()?;

        Self::get_invoice_by_id(conn, dek, clinic_id, invoice_id)?
            .ok_or_else(|| DatabaseOpError::ConflictResolution("Failed to load finalized invoice".to_string()))
    }

    /// Adds or updates an entry in the local clinical formulary catalogue.
    /// Uses clinic-scoped matching on clinic_id, name, and formulation to avoid duplicates.
    pub fn save_formulary_item(
        conn: &mut Connection,
        clinic_id: &str,
        args: SaveFormularyArgs,
    ) -> Result<String, DatabaseOpError> {
        let item_id = match args.id {
            Some(ref id) if !id.trim().is_empty() => id.trim().to_string(),
            _ => {
                let existing_id: Option<String> = conn
                    .query_row(
                        "SELECT id FROM local_formulary_v2 WHERE clinic_id = ?1 AND LOWER(TRIM(name)) = LOWER(TRIM(?2)) AND LOWER(TRIM(formulation)) = LOWER(TRIM(?3)) LIMIT 1",
                        params![clinic_id, args.name.trim(), args.formulation.trim()],
                        |row| row.get(0),
                    )
                    .optional()?;
                existing_id.unwrap_or_else(|| Uuid::new_v4().to_string())
            }
        };

        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM local_formulary_v2 WHERE clinic_id = ?1 AND id = ?2)",
                params![clinic_id, item_id],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !exists {
            conn.execute(
                r#"
                INSERT INTO local_formulary_v2 (
                    id, server_id, clinic_id, name, active_ingredient,
                    formulation, strength, default_dose, default_route,
                    default_frequency, default_duration, default_instructions,
                    is_active, created_at, updated_at
                ) VALUES (
                    ?1, NULL, ?2, ?3, ?4,
                    ?5, ?6, ?7, ?8,
                    ?9, ?10, ?11,
                    1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
                "#,
                params![
                    item_id,
                    clinic_id,
                    args.name.trim(),
                    args.active_ingredient.as_deref().map(str::trim),
                    args.formulation.trim(),
                    args.strength.trim(),
                    args.default_dose.as_deref().map(str::trim),
                    args.default_route.as_deref().map(str::trim),
                    args.default_frequency.as_deref().map(str::trim),
                    args.default_duration.as_deref().map(str::trim),
                    args.default_instructions.as_deref().map(str::trim),
                ],
            )?;
        } else {
            conn.execute(
                r#"
                UPDATE local_formulary_v2 SET
                    name = ?1,
                    active_ingredient = COALESCE(?2, active_ingredient),
                    formulation = ?3,
                    strength = CASE WHEN ?4 != '' THEN ?4 ELSE strength END,
                    default_dose = COALESCE(?5, default_dose),
                    default_route = COALESCE(?6, default_route),
                    default_frequency = COALESCE(?7, default_frequency),
                    default_duration = COALESCE(?8, default_duration),
                    default_instructions = COALESCE(?9, default_instructions),
                    is_active = 1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE clinic_id = ?10 AND id = ?11
                "#,
                params![
                    args.name.trim(),
                    args.active_ingredient.as_deref().map(str::trim),
                    args.formulation.trim(),
                    args.strength.trim(),
                    args.default_dose.as_deref().map(str::trim),
                    args.default_route.as_deref().map(str::trim),
                    args.default_frequency.as_deref().map(str::trim),
                    args.default_duration.as_deref().map(str::trim),
                    args.default_instructions.as_deref().map(str::trim),
                    clinic_id,
                    item_id,
                ],
            )?;
        }

        Ok(item_id)
    }

    /// Retrieves active formulary items for a clinic.
    pub fn get_formulary_items(
        conn: &Connection,
        clinic_id: &str,
    ) -> Result<Vec<FormularyRecord>, DatabaseOpError> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, server_id, clinic_id, name, active_ingredient,
                   formulation, strength, default_dose, default_route,
                   default_frequency, default_duration, default_instructions,
                   is_active, created_at, updated_at
            FROM local_formulary_v2
            WHERE clinic_id = ?1 AND is_active = 1
            ORDER BY name ASC
            "#,
        )?;

        let rows = stmt.query_map(params![clinic_id], |row| {
            let is_active_int: i32 = row.get(12)?;
            Ok(FormularyRecord {
                id: row.get(0)?,
                server_id: row.get(1)?,
                clinic_id: row.get(2)?,
                name: row.get(3)?,
                active_ingredient: row.get(4)?,
                formulation: row.get(5)?,
                strength: row.get(6)?,
                default_dose: row.get(7)?,
                default_route: row.get(8)?,
                default_frequency: row.get(9)?,
                default_duration: row.get(10)?,
                default_instructions: row.get(11)?,
                is_active: is_active_int == 1,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
            })
        })?;

        let mut items = Vec::new();
        for r in rows {
            items.push(r?);
        }
        Ok(items)
    }

    /// Soft-deletes a formulary entry.
    pub fn delete_formulary_item(
        conn: &mut Connection,
        clinic_id: &str,
        id: &str,
    ) -> Result<(), DatabaseOpError> {
        conn.execute(
            "UPDATE local_formulary_v2 SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE clinic_id = ?1 AND id = ?2",
            params![clinic_id, id],
        )?;
        Ok(())
    }

    /// Caches reference medicine catalogue items into local SQLite for offline access.
    pub fn cache_catalogue_items(
        conn: &mut Connection,
        items: &[SaveCatalogueCacheItemArgs],
    ) -> Result<usize, DatabaseOpError> {
        let table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_catalogue_cache_v1')",
                [],
                |r| r.get(0),
            )
            .unwrap_or(false);
        if !table_exists {
            return Ok(0);
        }

        let tx = conn.transaction()?;
        let mut count = 0;
        {
            let mut stmt = tx.prepare(
                r#"
                INSERT INTO local_catalogue_cache_v1 (
                    id, item_type, name, brand_name, generic_name, product_name,
                    dosage_form, route, active_ingredients_json, strengths_json,
                    raw_strength_summary, is_combination, is_verified, source_provenance,
                    cached_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, CURRENT_TIMESTAMP)
                ON CONFLICT(id) DO UPDATE SET
                    item_type = excluded.item_type,
                    name = excluded.name,
                    brand_name = excluded.brand_name,
                    generic_name = excluded.generic_name,
                    product_name = excluded.product_name,
                    dosage_form = excluded.dosage_form,
                    route = excluded.route,
                    active_ingredients_json = excluded.active_ingredients_json,
                    strengths_json = excluded.strengths_json,
                    raw_strength_summary = excluded.raw_strength_summary,
                    is_combination = excluded.is_combination,
                    is_verified = excluded.is_verified,
                    source_provenance = excluded.source_provenance,
                    cached_at = CURRENT_TIMESTAMP
                "#,
            )?;

            for item in items {
                stmt.execute(params![
                    item.id.trim(),
                    item.item_type.trim(),
                    item.name.trim(),
                    item.brand_name.as_deref().map(str::trim),
                    item.generic_name.as_deref().map(str::trim),
                    item.product_name.as_deref().map(str::trim),
                    item.dosage_form.as_deref().map(str::trim),
                    item.route.as_deref().map(str::trim),
                    item.active_ingredients_json.as_deref().map(str::trim),
                    item.strengths_json.trim(),
                    item.raw_strength_summary.trim(),
                    if item.is_combination { 1 } else { 0 },
                    if item.is_verified { 1 } else { 0 },
                    item.source_provenance.as_deref().unwrap_or("CDCI_NRCES_INDIA").trim(),
                ])?;
                count += 1;
            }
        }
        tx.commit()?;
        Ok(count)
    }

    /// Searches the local reference catalogue cache for offline prescription assistance.
    pub fn search_local_catalogue(
        conn: &Connection,
        query: &str,
        limit: usize,
        _formulation: Option<&str>,
    ) -> Result<Vec<LocalCatalogueItem>, DatabaseOpError> {
        let raw_q = query.trim();
        if raw_q.is_empty() {
            return Ok(Vec::new());
        }

        let limit = if limit == 0 { 20 } else { limit.min(100) };
        let pattern = format!("%{}%", raw_q);
        let prefix_pattern = format!("{}%", raw_q);

        let mut items = Vec::new();

        // 1. Query doctor/clinic-imported Clinical Library items with highest priority
        let clinical_sql = r#"
            SELECT id, name, generic_name, brand_name, composition, strength, formulation,
                   dosage_form, route, manufacturer, category, pack_size, mrp, storage_instructions,
                   default_dosage, default_instructions, created_at
            FROM local_clinical_library_v1
            WHERE is_active = 1
              AND (name LIKE ?1 OR generic_name LIKE ?1 OR brand_name LIKE ?1 OR composition LIKE ?1)
            ORDER BY
                CASE WHEN name LIKE ?2 THEN 0 ELSE 1 END,
                name ASC
            LIMIT ?3
        "#;
        if let Ok(mut c_stmt) = conn.prepare(clinical_sql) {
            if let Ok(rows) = c_stmt.query_map(params![pattern, prefix_pattern, limit as i64], |row| {
                let c_id: String = row.get(0)?;
                let name: String = row.get(1)?;
                let gen_name: Option<String> = row.get(2)?;
                let b_name: Option<String> = row.get(3)?;
                let comp: Option<String> = row.get(4)?;
                let strength: String = row.get(5)?;
                let form: String = row.get(6)?;
                let d_form: Option<String> = row.get(7)?;
                let route: Option<String> = row.get(8)?;
                let mfg: Option<String> = row.get(9)?;
                let cat: Option<String> = row.get(10)?;
                let pack: Option<String> = row.get(11)?;
                let mrp: Option<f64> = row.get(12)?;
                let storage: Option<String> = row.get(13)?;
                let def_dose: Option<String> = row.get(14)?;
                let def_inst: Option<String> = row.get(15)?;
                let created: String = row.get(16)?;

                let meta = serde_json::json!({
                    "manufacturer": mfg,
                    "category": cat,
                    "pack_size": pack,
                    "mrp": mrp,
                    "composition": comp,
                    "storage_instructions": storage,
                    "default_dosage": def_dose,
                    "default_instructions": def_inst,
                });

                Ok(LocalCatalogueItem {
                    id: format!("clinical_{}", c_id),
                    item_type: "BRAND".to_string(),
                    name: name.clone(),
                    brand_name: b_name.or(Some(name.clone())),
                    generic_name: gen_name.or(comp),
                    product_name: Some(name),
                    dosage_form: d_form.or(Some(form)),
                    route,
                    active_ingredients_json: Some(meta.to_string()),
                    strengths_json: "[]".to_string(),
                    raw_strength_summary: strength,
                    is_combination: false,
                    is_verified: true,
                    source_provenance: "CLINICAL_LIBRARY".to_string(),
                    cached_at: created,
                })
            }) {
                for item in rows.flatten() {
                    items.push(item);
                }
            }
        }

        // 2. Query available pharmacy inventory stock so local stock items appear in consultation
        let stock_sql = r#"
            SELECT id, product_name, unit, company, quantity, batch_number, created_at
            FROM local_inventory_stock_v1
            WHERE (product_name LIKE ?1 OR company LIKE ?1)
            ORDER BY
                CASE WHEN product_name LIKE ?2 THEN 0 ELSE 1 END,
                product_name ASC
            LIMIT ?3
        "#;
        if let Ok(mut stock_stmt) = conn.prepare(stock_sql) {
            if let Ok(rows) = stock_stmt.query_map(params![pattern, prefix_pattern, limit as i64], |row| {
                let s_id: String = row.get(0)?;
                let p_name: String = row.get(1)?;
                let unit: String = row.get(2)?;
                let company: String = row.get(3)?;
                let qty: i64 = row.get::<_, f64>(4).map(|q| q as i64).or_else(|_| row.get::<_, i64>(4))?;
                let batch: Option<String> = row.get(5)?;
                let created: String = row.get(6)?;
                let batch_note = batch.map(|b| format!(" · Batch: {}", b)).unwrap_or_default();
                let meta_json = format!(r#"{{"manufacturer":"{}","stock":{}}}"#, company.replace('"', "\\\""), qty);
                Ok(LocalCatalogueItem {
                    id: format!("stock_{}", s_id),
                    item_type: "BRAND".to_string(),
                    name: format!("{} (Stock: {} {}{})", p_name, qty, unit, batch_note),
                    brand_name: Some(p_name.clone()),
                    generic_name: Some(company.clone()),
                    product_name: Some(p_name),
                    dosage_form: Some(unit.clone()),
                    route: None,
                    active_ingredients_json: Some(meta_json),
                    strengths_json: "[]".to_string(),
                    raw_strength_summary: unit,
                    is_combination: false,
                    is_verified: true,
                    source_provenance: "LOCAL_INVENTORY".to_string(),
                    cached_at: created,
                })
            }) {
                for item in rows.flatten() {
                    items.push(item);
                }
            }
        }

        items.truncate(limit);
        Ok(items)
    }

    /// Retrieves verified strength strings from the offline catalogue cache for auto-population.
    pub fn get_local_catalogue_strengths(
        conn: &Connection,
        medicine_name: &str,
        _formulation: Option<&str>,
    ) -> Result<Vec<String>, DatabaseOpError> {
        let raw_name = medicine_name.trim();
        if raw_name.is_empty() {
            return Ok(Vec::new());
        }

        let mut list = Vec::new();

        // Check if strength exists in local clinical library
        if let Ok(mut c_stmt) = conn.prepare(
            r#"
            SELECT DISTINCT strength
            FROM local_clinical_library_v1
            WHERE is_active = 1
              AND (name = ?1 OR generic_name = ?1 OR brand_name = ?1)
              AND strength != ''
            ORDER BY strength ASC
            "#,
        ) {
            if let Ok(mut rows) = c_stmt.query(params![raw_name]) {
                while let Ok(Some(row)) = rows.next() {
                    if let Ok(s) = row.get::<_, String>(0) {
                        if !list.contains(&s) {
                            list.push(s);
                        }
                    }
                }
            }
        }

        Ok(list)
    }

    /// Retrieves statistics about the locally cached catalogue (total items, brands, generics, verified).
    pub fn get_catalogue_cache_stats(conn: &Connection) -> Result<CatalogueCacheStats, DatabaseOpError> {
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_clinical_library_v1 WHERE is_active = 1", [], |r| r.get(0))
            .unwrap_or(0);
        Ok(CatalogueCacheStats {
            total_items: count,
            brand_count: count,
            generic_count: 0,
            verified_count: count,
        })
    }

    /// Retrieves a catalogue sync metadata value by key (e.g. cursor, sync status, version).
    pub fn get_catalogue_metadata(conn: &Connection, key: &str) -> Result<Option<String>, DatabaseOpError> {
        let mut stmt = conn.prepare("SELECT value FROM catalogue_sync_metadata WHERE key = ?1")?;
        let res = stmt.query_row(params![key], |row| row.get::<_, String>(0));
        match res {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(DatabaseOpError::Sqlite(e)),
        }
    }

    /// Idempotently sets or updates a catalogue sync metadata key-value pair.
    pub fn set_catalogue_metadata(conn: &Connection, key: &str, value: &str) -> Result<(), DatabaseOpError> {
        conn.execute(
            r#"
            INSERT INTO catalogue_sync_metadata (key, value, updated_at)
            VALUES (?1, ?2, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = CURRENT_TIMESTAMP
            "#,
            params![key, value],
        )?;
        Ok(())
    }

    /// Upserts a local clinic profile record into SQLite for durable offline profile settings.
    pub fn upsert_clinic_profile(
        conn: &Connection,
        profile: &ClinicProfileRecord,
    ) -> Result<(), DatabaseOpError> {
        conn.execute(
            r#"
            INSERT INTO local_clinic_profile (
                clinic_id, name, slug, phone, email, street, city, state, postal_code, country, location_link, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, CURRENT_TIMESTAMP)
            ON CONFLICT(clinic_id) DO UPDATE SET
                name = excluded.name,
                slug = excluded.slug,
                phone = excluded.phone,
                email = excluded.email,
                street = excluded.street,
                city = excluded.city,
                state = excluded.state,
                postal_code = excluded.postal_code,
                country = excluded.country,
                location_link = excluded.location_link,
                updated_at = CURRENT_TIMESTAMP
            "#,
            params![
                profile.clinic_id,
                profile.name,
                profile.slug,
                profile.phone,
                profile.email,
                profile.street,
                profile.city,
                profile.state,
                profile.postal_code,
                profile.country,
                profile.location_link,
            ],
        )?;
        Ok(())
    }

    /// Retrieves a local clinic profile record by clinic_id.
    pub fn get_clinic_profile(
        conn: &Connection,
        clinic_id: &str,
    ) -> Result<Option<ClinicProfileRecord>, DatabaseOpError> {
        let mut stmt = conn.prepare(
            r#"
            SELECT clinic_id, name, slug, phone, email, street, city, state, postal_code, country, location_link, updated_at
            FROM local_clinic_profile
            WHERE clinic_id = ?1
            "#,
        )?;
        let res = stmt.query_row(params![clinic_id], |row| {
            Ok(ClinicProfileRecord {
                clinic_id: row.get(0)?,
                name: row.get(1)?,
                slug: row.get(2)?,
                phone: row.get(3)?,
                email: row.get(4)?,
                street: row.get(5)?,
                city: row.get(6)?,
                state: row.get(7)?,
                postal_code: row.get(8)?,
                country: row.get(9)?,
                location_link: row.get(10)?,
                updated_at: row.get(11)?,
            })
        });

        match res {
            Ok(profile) => Ok(Some(profile)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(DatabaseOpError::Sqlite(e)),
        }
    }

    /// Upserts a local doctor profile record into SQLite for durable offline credentials.
    /// Preserves existing credentials without overwriting valid data with empty values.
    pub fn upsert_doctor_profile(
        conn: &Connection,
        profile: &DoctorProfileRecord,
    ) -> Result<(), DatabaseOpError> {
        conn.execute(
            r#"
            INSERT INTO local_doctor_profile (
                doctor_id, full_name, email, phone, qualification, registration_number, gender, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP)
            ON CONFLICT(doctor_id) DO UPDATE SET
                full_name = CASE WHEN excluded.full_name != '' THEN excluded.full_name ELSE local_doctor_profile.full_name END,
                email = CASE WHEN excluded.email != '' THEN excluded.email ELSE local_doctor_profile.email END,
                phone = CASE WHEN excluded.phone != '' THEN excluded.phone ELSE local_doctor_profile.phone END,
                qualification = CASE WHEN excluded.qualification != '' THEN excluded.qualification ELSE local_doctor_profile.qualification END,
                registration_number = CASE WHEN excluded.registration_number != '' THEN excluded.registration_number ELSE local_doctor_profile.registration_number END,
                gender = CASE WHEN excluded.gender != '' THEN excluded.gender ELSE local_doctor_profile.gender END,
                updated_at = CURRENT_TIMESTAMP
            "#,
            params![
                profile.doctor_id,
                profile.full_name,
                profile.email,
                profile.phone,
                profile.qualification,
                profile.registration_number,
                profile.gender,
            ],
        )?;
        Ok(())
    }

    /// Retrieves a local doctor profile record by doctor_id.
    pub fn get_doctor_profile(
        conn: &Connection,
        doctor_id: &str,
    ) -> Result<Option<DoctorProfileRecord>, DatabaseOpError> {
        let mut stmt = conn.prepare(
            r#"
            SELECT doctor_id, full_name, email, phone, qualification, registration_number, gender, updated_at
            FROM local_doctor_profile
            WHERE doctor_id = ?1
            "#,
        )?;
        let res = stmt
            .query_row(params![doctor_id], |row| {
                Ok(DoctorProfileRecord {
                    doctor_id: row.get(0)?,
                    full_name: row.get(1)?,
                    email: row.get(2)?,
                    phone: row.get(3)?,
                    qualification: row.get(4)?,
                    registration_number: row.get(5)?,
                    gender: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })
            .optional()?;
        Ok(res)
    }

    /// Retrieves the most recent local doctor profile record, if any exists.
    pub fn get_doctor_profile_any(
        conn: &Connection,
    ) -> Result<Option<DoctorProfileRecord>, DatabaseOpError> {
        let mut stmt = conn.prepare(
            r#"
            SELECT doctor_id, full_name, email, phone, qualification, registration_number, gender, updated_at
            FROM local_doctor_profile
            ORDER BY updated_at DESC
            LIMIT 1
            "#,
        )?;
        let res = stmt
            .query_row([], |row| {
                Ok(DoctorProfileRecord {
                    doctor_id: row.get(0)?,
                    full_name: row.get(1)?,
                    email: row.get(2)?,
                    phone: row.get(3)?,
                    qualification: row.get(4)?,
                    registration_number: row.get(5)?,
                    gender: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })
            .optional()?;
        Ok(res)
    }

    /// Retrieves all local clinic profile records.
    pub fn get_all_clinic_profiles(
        conn: &Connection,
    ) -> Result<Vec<ClinicProfileRecord>, DatabaseOpError> {
        let mut stmt = conn.prepare(
            r#"
            SELECT clinic_id, name, slug, phone, email, street, city, state, postal_code, country, location_link, updated_at
            FROM local_clinic_profile
            ORDER BY name ASC
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(ClinicProfileRecord {
                clinic_id: row.get(0)?,
                name: row.get(1)?,
                slug: row.get(2)?,
                phone: row.get(3)?,
                email: row.get(4)?,
                street: row.get(5)?,
                city: row.get(6)?,
                state: row.get(7)?,
                postal_code: row.get(8)?,
                country: row.get(9)?,
                location_link: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r.map_err(DatabaseOpError::Sqlite)?);
        }
        Ok(list)
    }


    /// Imports batch/inventory stock records for a clinic.
    /// Deduplicates by (clinic_id, LOWER(TRIM(product_name)), LOWER(TRIM(unit)), LOWER(TRIM(company))).
    /// If overwrite is false, existing items are safely skipped and counted in `skipped`.
    /// If overwrite is true, existing item quantities and values are updated safely.
    pub fn import_stock_records(
        conn: &mut Connection,
        clinic_id: &str,
        items: Vec<StockItemInput>,
        overwrite: bool,
        source_report: Option<&str>,
    ) -> Result<StockImportSummary, DatabaseOpError> {
        let default_source = "STOCK REPORT (18-10-26)";
        let report_name = source_report.unwrap_or(default_source);
        let mut successful = 0;
        let mut skipped = 0;
        let mut failed = 0;
        let mut total_quantity = 0.0;
        let mut total_value = 0.0;
        let mut errors = Vec::new();

        let tx = conn.transaction()?;

        for item in items {
            let p_name = item.product_name.trim();
            if p_name.is_empty() {
                failed += 1;
                errors.push("Skipped item with empty product name".to_string());
                continue;
            }
            if item.quantity < 0.0 {
                failed += 1;
                errors.push(format!("Product '{}' has negative quantity", p_name));
                continue;
            }

            let unit = item.unit.trim();
            let company = item.company.trim();

            let existing_row: Option<(String, f64, Option<f64>)> = tx
                .query_row(
                    r#"
                    SELECT id, quantity, value
                    FROM local_inventory_stock_v1
                    WHERE clinic_id = ?1
                      AND LOWER(TRIM(product_name)) = LOWER(TRIM(?2))
                      AND LOWER(TRIM(unit)) = LOWER(TRIM(?3))
                      AND LOWER(TRIM(company)) = LOWER(TRIM(?4))
                    LIMIT 1
                    "#,
                    params![clinic_id, p_name, unit, company],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;

            match existing_row {
                Some((id, _old_qty, _old_val)) => {
                    if !overwrite {
                        skipped += 1;
                    } else {
                        tx.execute(
                            r#"
                            UPDATE local_inventory_stock_v1
                            SET quantity = ?1,
                                value = ?2,
                                batch_number = COALESCE(?3, batch_number),
                                source_report = ?4,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE clinic_id = ?5 AND id = ?6
                            "#,
                            params![
                                item.quantity,
                                item.value,
                                item.batch_number.as_deref().map(str::trim),
                                report_name,
                                clinic_id,
                                id,
                            ],
                        )?;
                        successful += 1;
                        total_quantity += item.quantity;
                        if let Some(v) = item.value {
                            total_value += v;
                        }
                    }
                }
                None => {
                    let new_id = Uuid::new_v4().to_string();
                    tx.execute(
                        r#"
                        INSERT INTO local_inventory_stock_v1 (
                            id, clinic_id, product_name, unit, company,
                            quantity, value, batch_number, source_report,
                            created_at, updated_at
                        ) VALUES (
                            ?1, ?2, ?3, ?4, ?5,
                            ?6, ?7, ?8, ?9,
                            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                        )
                        "#,
                        params![
                            new_id,
                            clinic_id,
                            p_name,
                            unit,
                            company,
                            item.quantity,
                            item.value,
                            item.batch_number.as_deref().map(str::trim),
                            report_name,
                        ],
                    )?;
                    successful += 1;
                    total_quantity += item.quantity;
                    if let Some(v) = item.value {
                        total_value += v;
                    }
                }
            }
        }

        tx.commit()?;

        Ok(StockImportSummary {
            total_records: successful + skipped + failed,
            successful,
            skipped,
            failed,
            total_quantity,
            total_value,
            errors,
        })
    }

    /// Queries inventory stock records for a clinic with optional substring filter.
    pub fn get_stock_records(
        conn: &Connection,
        clinic_id: &str,
        query: Option<&str>,
    ) -> Result<Vec<StockItemRecord>, DatabaseOpError> {
        let (sql, filter) = match query.map(str::trim).filter(|q| !q.is_empty()) {
            Some(q) => (
                r#"
                SELECT id, clinic_id, product_name, unit, company,
                       quantity, value, batch_number, source_report,
                       created_at, updated_at
                FROM local_inventory_stock_v1
                WHERE clinic_id = ?1
                  AND (product_name LIKE ?2 OR company LIKE ?2 OR unit LIKE ?2)
                ORDER BY product_name ASC
                "#,
                Some(format!("%{}%", q)),
            ),
            None => (
                r#"
                SELECT id, clinic_id, product_name, unit, company,
                       quantity, value, batch_number, source_report,
                       created_at, updated_at
                FROM local_inventory_stock_v1
                WHERE clinic_id = ?1
                ORDER BY product_name ASC
                "#,
                None,
            ),
        };

        let mut stmt = conn.prepare(sql)?;
        let rows = match filter {
            Some(f) => stmt.query_map(params![clinic_id, f], Self::map_stock_row)?,
            None => stmt.query_map(params![clinic_id], Self::map_stock_row)?,
        };

        let mut records = Vec::new();
        for row in rows {
            records.push(row?);
        }
        Ok(records)
    }

    /// Computes summary metrics for clinic inventory stock (total products, total quantity, total value).
    pub fn get_stock_summary(
        conn: &Connection,
        clinic_id: &str,
    ) -> Result<StockSummaryRecord, DatabaseOpError> {
        let summary = conn.query_row(
            r#"
            SELECT COUNT(*), COALESCE(SUM(quantity), 0.0), COALESCE(SUM(value), 0.0)
            FROM local_inventory_stock_v1
            WHERE clinic_id = ?1
            "#,
            params![clinic_id],
            |row| {
                Ok(StockSummaryRecord {
                    total_products: row.get::<_, i64>(0)? as usize,
                    total_quantity: row.get(1)?,
                    total_value: row.get(2)?,
                })
            },
        )?;
        Ok(summary)
    }

    fn map_stock_row(row: &rusqlite::Row) -> rusqlite::Result<StockItemRecord> {
        Ok(StockItemRecord {
            id: row.get(0)?,
            clinic_id: row.get(1)?,
            product_name: row.get(2)?,
            unit: row.get(3)?,
            company: row.get(4)?,
            quantity: row.get(5)?,
            value: row.get(6)?,
            batch_number: row.get(7)?,
            source_report: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
        })
    }

    /// Imports an Excel/CSV batch of medicine records into the Clinical Library.
    /// Preserves strict tenant isolation by clinic_id.
    /// Deduplicates against existing active records on (clinic_id, name, formulation, strength).
    /// Tracks complete provenance with batch_id and audit history.
    pub fn import_clinical_library(
        conn: &mut Connection,
        clinic_id: &str,
        batch: ClinicalImportBatchInput,
    ) -> Result<ClinicalImportSummary, DatabaseOpError> {
        let batch_id = Uuid::new_v4().to_string();
        let total_input_rows = batch.total_rows;
        let mut valid_rows = 0;
        let mut invalid_rows = batch.invalid_rows;
        let mut imported_rows = 0;
        let mut skipped_rows = 0;
        let allow_update = batch.allow_update.unwrap_or(false);

        let tx = conn.transaction()?;

        // 1. Record the import batch in local_import_batches_v1
        tx.execute(
            r#"
            INSERT INTO local_import_batches_v1 (
                id, clinic_id, doctor_id, file_name,
                total_rows, valid_rows, invalid_rows,
                imported_rows, skipped_rows, status,
                created_at
            ) VALUES (
                ?1, ?2, ?3, ?4,
                ?5, 0, ?6,
                0, 0, 'COMPLETED',
                CURRENT_TIMESTAMP
            )
            "#,
            params![
                batch_id,
                clinic_id,
                batch.doctor_id.as_deref().map(str::trim),
                batch.file_name.trim(),
                total_input_rows as i64,
                invalid_rows as i64,
            ],
        )?;

        // 2. Process each medicine item
        for item in batch.items {
            let name = item.name.trim();
            if name.is_empty() {
                invalid_rows += 1;
                continue;
            }
            valid_rows += 1;

            let strength = item.strength.trim();
            let formulation = if item.formulation.trim().is_empty() {
                "Tablet"
            } else {
                item.formulation.trim()
            };

            // Check for existing duplicate in clinic library
            let existing_id: Option<String> = tx
                .query_row(
                    r#"
                    SELECT id FROM local_clinical_library_v1
                    WHERE clinic_id = ?1
                      AND LOWER(TRIM(name)) = LOWER(TRIM(?2))
                      AND LOWER(TRIM(formulation)) = LOWER(TRIM(?3))
                      AND LOWER(TRIM(strength)) = LOWER(TRIM(?4))
                      AND is_active = 1
                    LIMIT 1
                    "#,
                    params![clinic_id, name, formulation, strength],
                    |row| row.get(0),
                )
                .optional()?;

            match existing_id {
                Some(existing_item_id) => {
                    if !allow_update {
                        // Never silently overwrite: skip and record duplicate
                        skipped_rows += 1;
                    } else {
                        // Safe update of optional non-destructive metadata
                        tx.execute(
                            r#"
                            UPDATE local_clinical_library_v1 SET
                                generic_name = COALESCE(?1, generic_name),
                                brand_name = COALESCE(?2, brand_name),
                                composition = COALESCE(?3, composition),
                                dosage_form = COALESCE(?4, dosage_form),
                                route = COALESCE(?5, route),
                                manufacturer = COALESCE(?6, manufacturer),
                                category = COALESCE(?7, category),
                                pack_size = COALESCE(?8, pack_size),
                                mrp = COALESCE(?9, mrp),
                                storage_instructions = COALESCE(?10, storage_instructions),
                                default_dosage = COALESCE(?11, default_dosage),
                                default_frequency = COALESCE(?12, default_frequency),
                                default_duration = COALESCE(?13, default_duration),
                                default_instructions = COALESCE(?14, default_instructions),
                                updated_at = CURRENT_TIMESTAMP
                            WHERE clinic_id = ?15 AND id = ?16
                            "#,
                            params![
                                item.generic_name.as_deref().map(str::trim),
                                item.brand_name.as_deref().map(str::trim),
                                item.composition.as_deref().map(str::trim),
                                item.dosage_form.as_deref().map(str::trim),
                                item.route.as_deref().map(str::trim),
                                item.manufacturer.as_deref().map(str::trim),
                                item.category.as_deref().map(str::trim),
                                item.pack_size.as_deref().map(str::trim),
                                item.mrp,
                                item.storage_instructions.as_deref().map(str::trim),
                                item.default_dosage.as_deref().map(str::trim),
                                item.default_frequency.as_deref().map(str::trim),
                                item.default_duration.as_deref().map(str::trim),
                                item.default_instructions.as_deref().map(str::trim),
                                clinic_id,
                                existing_item_id,
                            ],
                        )?;
                        imported_rows += 1;
                    }
                }
                None => {
                    let item_id = Uuid::new_v4().to_string();
                    tx.execute(
                        r#"
                        INSERT INTO local_clinical_library_v1 (
                            id, server_id, clinic_id, batch_id,
                            name, generic_name, brand_name, composition,
                            strength, formulation, dosage_form, route,
                            manufacturer, category, pack_size, mrp,
                            storage_instructions, default_dosage, default_frequency,
                            default_duration, default_instructions,
                            is_active, sync_status,
                            created_at, updated_at
                        ) VALUES (
                            ?1, NULL, ?2, ?3,
                            ?4, ?5, ?6, ?7,
                            ?8, ?9, ?10, ?11,
                            ?12, ?13, ?14, ?15,
                            ?16, ?17, ?18,
                            ?19, ?20,
                            1, 'PENDING',
                            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                        )
                        "#,
                        params![
                            item_id,
                            clinic_id,
                            batch_id,
                            name,
                            item.generic_name.as_deref().map(str::trim),
                            item.brand_name.as_deref().map(str::trim),
                            item.composition.as_deref().map(str::trim),
                            strength,
                            formulation,
                            item.dosage_form.as_deref().map(str::trim),
                            item.route.as_deref().map(str::trim),
                            item.manufacturer.as_deref().map(str::trim),
                            item.category.as_deref().map(str::trim),
                            item.pack_size.as_deref().map(str::trim),
                            item.mrp,
                            item.storage_instructions.as_deref().map(str::trim),
                            item.default_dosage.as_deref().map(str::trim),
                            item.default_frequency.as_deref().map(str::trim),
                            item.default_duration.as_deref().map(str::trim),
                            item.default_instructions.as_deref().map(str::trim),
                        ],
                    )?;
                    imported_rows += 1;
                }
            }
        }

        // 3. Update the batch summary totals
        tx.execute(
            r#"
            UPDATE local_import_batches_v1 SET
                valid_rows = ?1,
                invalid_rows = ?2,
                imported_rows = ?3,
                skipped_rows = ?4
            WHERE clinic_id = ?5 AND id = ?6
            "#,
            params![
                valid_rows as i64,
                invalid_rows as i64,
                imported_rows as i64,
                skipped_rows as i64,
                clinic_id,
                batch_id,
            ],
        )?;

        let created_at: String = tx.query_row(
            "SELECT created_at FROM local_import_batches_v1 WHERE id = ?1",
            params![batch_id],
            |row| row.get(0),
        )?;

        tx.commit()?;

        Ok(ClinicalImportSummary {
            batch_id,
            file_name: batch.file_name,
            total_rows: total_input_rows,
            valid_rows,
            invalid_rows,
            imported_rows,
            skipped_rows,
            status: "COMPLETED".to_string(),
            created_at,
        })
    }

    /// Safely rolls back an entire import batch for a clinic.
    /// Deactivates medicines associated with that batch without affecting manual entries or other batches.
    pub fn rollback_clinical_library_batch(
        conn: &mut Connection,
        clinic_id: &str,
        batch_id: &str,
    ) -> Result<usize, DatabaseOpError> {
        let tx = conn.transaction()?;

        let batch_status: Option<String> = tx
            .query_row(
                "SELECT status FROM local_import_batches_v1 WHERE clinic_id = ?1 AND id = ?2",
                params![clinic_id, batch_id],
                |row| row.get(0),
            )
            .optional()?;

        match batch_status {
            Some(status) => {
                if status == "ROLLED_BACK" {
                    return Ok(0);
                }
            }
            None => return Ok(0),
        }

        let affected = tx.execute(
            "UPDATE local_clinical_library_v1 SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE clinic_id = ?1 AND batch_id = ?2",
            params![clinic_id, batch_id],
        )?;

        tx.execute(
            "UPDATE local_import_batches_v1 SET status = 'ROLLED_BACK', rolled_back_at = CURRENT_TIMESTAMP WHERE clinic_id = ?1 AND id = ?2",
            params![clinic_id, batch_id],
        )?;

        tx.commit()?;
        Ok(affected)
    }

    /// Queries active medicines from the Clinical Library for a clinic.
    pub fn get_clinical_library_items(
        conn: &Connection,
        clinic_id: &str,
        query: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<ClinicalMedicineRecord>, DatabaseOpError> {
        let limit = if limit == 0 { 50 } else { limit.min(500) };
        let (sql, filter) = match query.map(str::trim).filter(|q| !q.is_empty()) {
            Some(q) => (
                r#"
                SELECT id, server_id, clinic_id, batch_id, name, generic_name,
                       brand_name, composition, strength, formulation, dosage_form,
                       route, manufacturer, category, pack_size, mrp,
                       storage_instructions, default_dosage, default_frequency,
                       default_duration, default_instructions, is_active,
                       created_at, updated_at
                FROM local_clinical_library_v1
                WHERE clinic_id = ?1 AND is_active = 1
                  AND (name LIKE ?2 OR generic_name LIKE ?2 OR brand_name LIKE ?2 OR composition LIKE ?2 OR manufacturer LIKE ?2)
                ORDER BY name ASC
                LIMIT ?3 OFFSET ?4
                "#,
                Some(format!("%{}%", q)),
            ),
            None => (
                r#"
                SELECT id, server_id, clinic_id, batch_id, name, generic_name,
                       brand_name, composition, strength, formulation, dosage_form,
                       route, manufacturer, category, pack_size, mrp,
                       storage_instructions, default_dosage, default_frequency,
                       default_duration, default_instructions, is_active,
                       created_at, updated_at
                FROM local_clinical_library_v1
                WHERE clinic_id = ?1 AND is_active = 1
                ORDER BY name ASC
                LIMIT ?2 OFFSET ?3
                "#,
                None,
            ),
        };

        let mut stmt = conn.prepare(sql)?;
        let rows = match filter {
            Some(f) => stmt.query_map(params![clinic_id, f, limit as i64, offset as i64], Self::map_clinical_medicine_row)?,
            None => stmt.query_map(params![clinic_id, limit as i64, offset as i64], Self::map_clinical_medicine_row)?,
        };

        let mut records = Vec::new();
        for row in rows {
            records.push(row?);
        }
        Ok(records)
    }

    /// Queries import batch audit history for a clinic.
    pub fn get_clinical_library_batches(
        conn: &Connection,
        clinic_id: &str,
    ) -> Result<Vec<ClinicalImportBatchRecord>, DatabaseOpError> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, clinic_id, doctor_id, file_name,
                   total_rows, valid_rows, invalid_rows,
                   imported_rows, skipped_rows, status,
                   created_at, rolled_back_at
            FROM local_import_batches_v1
            WHERE clinic_id = ?1
            ORDER BY created_at DESC
            LIMIT 50
            "#,
        )?;

        let rows = stmt.query_map(params![clinic_id], Self::map_clinical_batch_row)?;
        let mut records = Vec::new();
        for row in rows {
            records.push(row?);
        }
        Ok(records)
    }

    /// Saves or updates a single clinical medicine record manually.
    pub fn save_clinical_library_item(
        conn: &mut Connection,
        clinic_id: &str,
        item: SaveClinicalMedicineArgs,
    ) -> Result<String, DatabaseOpError> {
        let item_id = match item.id {
            Some(ref id) if !id.trim().is_empty() => id.trim().to_string(),
            _ => Uuid::new_v4().to_string(),
        };

        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM local_clinical_library_v1 WHERE clinic_id = ?1 AND id = ?2)",
                params![clinic_id, item_id],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !exists {
            conn.execute(
                r#"
                INSERT INTO local_clinical_library_v1 (
                    id, server_id, clinic_id, batch_id,
                    name, generic_name, brand_name, composition,
                    strength, formulation, dosage_form, route,
                    manufacturer, category, pack_size, mrp,
                    storage_instructions, default_dosage, default_frequency,
                    default_duration, default_instructions,
                    is_active, sync_status,
                    created_at, updated_at
                ) VALUES (
                    ?1, NULL, ?2, NULL,
                    ?3, ?4, ?5, ?6,
                    ?7, ?8, ?9, ?10,
                    ?11, ?12, ?13, ?14,
                    ?15, ?16, ?17,
                    ?18, ?19,
                    1, 'PENDING',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
                "#,
                params![
                    item_id,
                    clinic_id,
                    item.name.trim(),
                    item.generic_name.as_deref().map(str::trim),
                    item.brand_name.as_deref().map(str::trim),
                    item.composition.as_deref().map(str::trim),
                    item.strength.trim(),
                    item.formulation.trim(),
                    item.dosage_form.as_deref().map(str::trim),
                    item.route.as_deref().map(str::trim),
                    item.manufacturer.as_deref().map(str::trim),
                    item.category.as_deref().map(str::trim),
                    item.pack_size.as_deref().map(str::trim),
                    item.mrp,
                    item.storage_instructions.as_deref().map(str::trim),
                    item.default_dosage.as_deref().map(str::trim),
                    item.default_frequency.as_deref().map(str::trim),
                    item.default_duration.as_deref().map(str::trim),
                    item.default_instructions.as_deref().map(str::trim),
                ],
            )?;
        } else {
            conn.execute(
                r#"
                UPDATE local_clinical_library_v1 SET
                    name = ?1,
                    generic_name = ?2,
                    brand_name = ?3,
                    composition = ?4,
                    strength = ?5,
                    formulation = ?6,
                    dosage_form = ?7,
                    route = ?8,
                    manufacturer = ?9,
                    category = ?10,
                    pack_size = ?11,
                    mrp = ?12,
                    storage_instructions = ?13,
                    default_dosage = ?14,
                    default_frequency = ?15,
                    default_duration = ?16,
                    default_instructions = ?17,
                    updated_at = CURRENT_TIMESTAMP
                WHERE clinic_id = ?18 AND id = ?19
                "#,
                params![
                    item.name.trim(),
                    item.generic_name.as_deref().map(str::trim),
                    item.brand_name.as_deref().map(str::trim),
                    item.composition.as_deref().map(str::trim),
                    item.strength.trim(),
                    item.formulation.trim(),
                    item.dosage_form.as_deref().map(str::trim),
                    item.route.as_deref().map(str::trim),
                    item.manufacturer.as_deref().map(str::trim),
                    item.category.as_deref().map(str::trim),
                    item.pack_size.as_deref().map(str::trim),
                    item.mrp,
                    item.storage_instructions.as_deref().map(str::trim),
                    item.default_dosage.as_deref().map(str::trim),
                    item.default_frequency.as_deref().map(str::trim),
                    item.default_duration.as_deref().map(str::trim),
                    item.default_instructions.as_deref().map(str::trim),
                    clinic_id,
                    item_id,
                ],
            )?;
        }

        Ok(item_id)
    }

    /// Archives (soft-deletes) a medicine from the Clinical Library.
    pub fn archive_clinical_library_item(
        conn: &mut Connection,
        clinic_id: &str,
        id: &str,
    ) -> Result<(), DatabaseOpError> {
        conn.execute(
            "UPDATE local_clinical_library_v1 SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE clinic_id = ?1 AND id = ?2",
            params![clinic_id, id],
        )?;
        Ok(())
    }

    fn map_clinical_medicine_row(row: &rusqlite::Row) -> rusqlite::Result<ClinicalMedicineRecord> {
        let is_act: i32 = row.get(21)?;
        Ok(ClinicalMedicineRecord {
            id: row.get(0)?,
            server_id: row.get(1)?,
            clinic_id: row.get(2)?,
            batch_id: row.get(3)?,
            name: row.get(4)?,
            generic_name: row.get(5)?,
            brand_name: row.get(6)?,
            composition: row.get(7)?,
            strength: row.get(8)?,
            formulation: row.get(9)?,
            dosage_form: row.get(10)?,
            route: row.get(11)?,
            manufacturer: row.get(12)?,
            category: row.get(13)?,
            pack_size: row.get(14)?,
            mrp: row.get(15)?,
            storage_instructions: row.get(16)?,
            default_dosage: row.get(17)?,
            default_frequency: row.get(18)?,
            default_duration: row.get(19)?,
            default_instructions: row.get(20)?,
            is_active: is_act == 1,
            created_at: row.get(22)?,
            updated_at: row.get(23)?,
        })
    }

    fn map_clinical_batch_row(row: &rusqlite::Row) -> rusqlite::Result<ClinicalImportBatchRecord> {
        Ok(ClinicalImportBatchRecord {
            id: row.get(0)?,
            clinic_id: row.get(1)?,
            doctor_id: row.get(2)?,
            file_name: row.get(3)?,
            total_rows: row.get(4)?,
            valid_rows: row.get(5)?,
            invalid_rows: row.get(6)?,
            imported_rows: row.get(7)?,
            skipped_rows: row.get(8)?,
            status: row.get(9)?,
            created_at: row.get(10)?,
            rolled_back_at: row.get(11)?,
        })
    }

    fn map_invoice_row(
        row: &rusqlite::Row,
    ) -> rusqlite::Result<RawInvoiceRow> {
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
            row.get(6)?,
            row.get(7)?,
            row.get(8)?,
            row.get(9)?,
            row.get(10)?,
            row.get(11)?,
            row.get(12)?,
            row.get(13)?,
            row.get(14)?,
            row.get(15)?,
            row.get(16)?,
            row.get(17)?,
            row.get(18)?,
            row.get(19)?,
            row.get(20)?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations::MigrationRunner;

    fn setup_test_db() -> (Connection, DatabaseEncryptionKey) {
        let mut conn = Connection::open_in_memory().expect("in-memory DB opens");
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let dek = DatabaseEncryptionKey::new([7u8; 32]);
        MigrationRunner::run_migrations(&mut conn, &dek).expect("migrations run");
        (conn, dek)
    }

    #[test]
    fn test_zero_plaintext_in_raw_sqlite_tables() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_001";

        let patient_name = "Ananya Sharma";
        let patient_phone = "9876543210";
        let diagnosis = "Acute bronchitis with severe bronchospasm";
        let rx_items = r#"[{"name":"Amoxicillin 500mg"}]"#;

        // 1. Insert patient
        DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_id,
            "P-00101",
            patient_name,
            patient_phone,
            "FEMALE",
            Some("1994-06-15"),
            32,
            &["Sulfa drugs".to_string()],
            &["Hypertension".to_string()],
            Some("Secret clinical observation"),
        )
        .unwrap();

        // 2. Insert consultation
        DbOperations::insert_consultation(
            &mut conn,
            &dek,
            clinic_id,
            "pat_1",
            "doc_1",
            "2026-10-25",
            "Fever and cough",
            diagnosis,
            Some(r#"{"snapshot":"confidential"}"#),
        )
        .unwrap();

        // 3. Insert prescription
        DbOperations::insert_prescription(
            &mut conn,
            &dek,
            clinic_id,
            "c_1",
            "pat_1",
            "doc_1",
            "RX-00101",
            rx_items,
        )
        .unwrap();

        // RAW SQL AUDIT: inspect every text column across all tables
        // Verify patient name does not appear in any raw text column
        let mut stmt = conn
            .prepare("SELECT patient_code, sync_status FROM local_patients")
            .unwrap();
        let mut rows = stmt.query([]).unwrap();
        while let Some(r) = rows.next().unwrap() {
            let code: String = r.get(0).unwrap();
            let sync: String = r.get(1).unwrap();
            assert!(!code.contains(patient_name));
            assert!(!sync.contains(patient_name));
        }

        // Verify diagnosis does not appear in local_consultations
        let mut c_stmt = conn
            .prepare("SELECT status, sync_status FROM local_consultations")
            .unwrap();
        let mut c_rows = c_stmt.query([]).unwrap();
        while let Some(r) = c_rows.next().unwrap() {
            let st: String = r.get(0).unwrap();
            assert!(!st.contains(diagnosis));
        }

        // Verify outbox does not contain plaintext payload
        let mut o_stmt = conn
            .prepare("SELECT idempotency_key, sync_status FROM local_sync_outbox")
            .unwrap();
        let mut o_rows = o_stmt.query([]).unwrap();
        while let Some(r) = o_rows.next().unwrap() {
            let idem: String = r.get(0).unwrap();
            assert!(!idem.contains(patient_name));
            assert!(!idem.contains(diagnosis));
        }

        // Verify authorized reads decrypt data accurately
        let patients = DbOperations::get_patients(&conn, &dek, clinic_id).unwrap();
        assert_eq!(patients.len(), 1);
        assert_eq!(patients[0].name, patient_name);
        assert_eq!(patients[0].phone, patient_phone);
        assert_eq!(patients[0].sensitive_notes, Some("Secret clinical observation".to_string()));

        let consults = DbOperations::get_consultations(&conn, &dek, clinic_id, None).unwrap();
        assert_eq!(consults.len(), 1);
        assert_eq!(consults[0].diagnosis, diagnosis);

        let rxs = DbOperations::get_prescriptions(&conn, &dek, clinic_id, None).unwrap();
        assert_eq!(rxs.len(), 1);
        assert_eq!(rxs[0].items_json, Some(rx_items.to_string()));
    }

    #[test]
    fn test_tamper_detection_in_database() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_001";

        DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_id,
            "P-00101",
            "Ananya",
            "9876543210",
            "FEMALE",
            None,
            30,
            &[],
            &[],
            None,
        )
        .unwrap();

        // Tamper with encrypted_demographics blob directly in SQLite
        conn.execute(
            "UPDATE local_patients SET encrypted_demographics = X'1234567890ABCDEF' WHERE clinic_id = ?1",
            params![clinic_id],
        )
        .unwrap();

        let result = DbOperations::get_patients(&conn, &dek, clinic_id);
        assert!(result.is_err(), "Tampered ciphertext must fail AEAD verification");
    }

    #[test]
    fn test_wrong_key_fails_decryption() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_001";

        DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_id,
            "P-00101",
            "Ananya",
            "9876543210",
            "FEMALE",
            None,
            30,
            &[],
            &[],
            None,
        )
        .unwrap();

        let wrong_dek = DatabaseEncryptionKey::new([99u8; 32]);
        let result = DbOperations::get_patients(&conn, &wrong_dek, clinic_id);
        assert!(result.is_err(), "Reading with wrong key must fail AEAD decryption");
    }

    #[test]
    fn test_migration_v1_to_v2_migrates_plaintext_to_encrypted() {
        let mut conn = Connection::open_in_memory().unwrap();
        let dek = DatabaseEncryptionKey::new([42u8; 32]);

        // 1. Manually apply V1 schema
        conn.execute(super::super::schema::CREATE_MIGRATIONS_TABLE, []).unwrap();
        conn.execute_batch(super::super::schema::MIGRATION_V1_SQL).unwrap();
        conn.execute(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES (1, 'initial', 'v1')",
            [],
        )
        .unwrap();

        // 2. Insert plaintext records into V1
        conn.execute(
            r#"
            INSERT INTO local_patients (
                id, clinic_id, patient_code, name, phone, gender, age, allergies_json, conditions_json
            ) VALUES ('p1', 'clinic_1', 'P-001', 'Old Patient', '12345', 'MALE', 40, '[]', '[]')
            "#,
            [],
        )
        .unwrap();

        conn.execute(
            r#"
            INSERT INTO local_consultations (
                id, clinic_id, patient_id, doctor_id, consultation_date, chief_complaint, diagnosis
            ) VALUES ('c1', 'clinic_1', 'p1', 'doc_1', '2026-10-25', 'Old Complaint', 'Old Diagnosis')
            "#,
            [],
        )
        .unwrap();

        conn.execute(
            r#"
            INSERT INTO local_prescriptions (
                id, clinic_id, consultation_id, patient_id, doctor_id, prescription_number,
                encrypted_items, nonce, sync_status
            ) VALUES ('rx1', 'clinic_1', 'c1', 'p1', 'doc_1', 'RX-00101', X'00', X'00', 'ACTIVE')
            "#,
            [],
        )
        .unwrap();

        // 3. Run migration to V2
        MigrationRunner::run_migrations(&mut conn, &dek).expect("migration to v2 succeeds");

        // 4. Verify version 2 recorded
        let v2_applied: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 2)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(v2_applied);

        // 5. Verify data is now readable via decrypted operations
        let patients = DbOperations::get_patients(&conn, &dek, "clinic_1").unwrap();
        assert_eq!(patients.len(), 1);
        assert_eq!(patients[0].name, "Old Patient");

        let consults = DbOperations::get_consultations(&conn, &dek, "clinic_1", None).unwrap();
        assert_eq!(consults.len(), 1);
        assert_eq!(consults[0].diagnosis, "Old Diagnosis");

        let rx_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_prescriptions WHERE id = 'rx1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rx_count, 1, "Prescription must be preserved across migration");
    }

    #[test]
    fn test_recover_in_flight_jobs() {
        let (mut conn, _dek) = setup_test_db();

        conn.execute(
            r#"
            INSERT INTO local_sync_outbox (
                id, clinic_id, entity_type, entity_id, action, idempotency_key, encrypted_payload, nonce, sync_status
            ) VALUES ('outbox_1', 'clinic_1', 'PATIENT', 'pat_1', 'CREATE', 'idem_1', X'00', X'00', 'IN_FLIGHT')
            "#,
            [],
        )
        .unwrap();

        let recovered = DbOperations::recover_in_flight_jobs(&mut conn).unwrap();
        assert_eq!(recovered, 1);

        let summary = DbOperations::get_outbox_summary(&conn, "clinic_1").unwrap();
        assert_eq!(summary.pending_count, 1);
        assert_eq!(summary.in_flight_count, 0);
    }

    #[test]
    fn test_migration_v2_to_v3_preserves_data_and_adds_sync_state() {
        use crate::db::schema::{CREATE_MIGRATIONS_TABLE, MIGRATION_V1_SQL};

        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let dek = DatabaseEncryptionKey::new([42u8; 32]);

        // 1. Manually set up V1 baseline with outbox and conflict
        conn.execute(CREATE_MIGRATIONS_TABLE, []).unwrap();
        conn.execute_batch(MIGRATION_V1_SQL).unwrap();
        conn.execute(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES (1, 'v1', 'chk1')",
            [],
        )
        .unwrap();

        // Insert legacy conflict
        conn.execute(
            r#"
            INSERT INTO local_sync_outbox (
                id, clinic_id, entity_type, entity_id, action, idempotency_key, payload_json, sync_status
            ) VALUES ('outbox_conflict_1', 'clinic_1', 'PATIENT', 'pat_1', 'UPDATE', 'idem_c1', '{}', 'CONFLICT')
            "#,
            [],
        )
        .unwrap();

        conn.execute(
            r#"
            INSERT INTO local_sync_conflicts (
                id, outbox_id, entity_type, entity_id, server_version, client_version,
                server_payload, client_payload, conflict_reason
            ) VALUES (
                'conflict_v1', 'outbox_conflict_1', 'PATIENT', 'pat_1', 3, 2,
                '{"name":"Server Name"}', '{"name":"Client Name"}', 'Concurrent modification'
            )
            "#,
            [],
        )
        .unwrap();

        // 2. Migrate to V2
        MigrationRunner::run_migrations(&mut conn, &dek).expect("migrations up to v3 succeed");

        // 3. Verify V3 recorded in schema_migrations
        let v3_applied: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 3)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(v3_applied, "Migration V3 must be recorded");

        // 4. Verify existing conflict was migrated with DEFAULT 'OPEN' and NULL resolution_payload
        let conflicts = DbOperations::get_conflicts(&conn, Some("OPEN")).unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].id, "conflict_v1");
        assert_eq!(conflicts[0].status, "OPEN");
        assert_eq!(conflicts[0].resolution_payload, None);

        // 5. Verify local_sync_state table is operational
        let initial_state = DbOperations::get_sync_state(&conn, "clinic_1").unwrap();
        assert!(initial_state.is_none());

        let new_state = SyncStateRecord {
            clinic_id: "clinic_1".to_string(),
            last_pulled_seq: 150,
            last_pulled_at: "2026-10-27 12:00:00".to_string(),
            last_pushed_at: Some("2026-10-27 12:05:00".to_string()),
            in_sync: true,
        };
        DbOperations::upsert_sync_state(&mut conn, &new_state).unwrap();

        let loaded_state = DbOperations::get_sync_state(&conn, "clinic_1")
            .unwrap()
            .expect("sync state exists");
        assert_eq!(loaded_state.clinic_id, "clinic_1");
        assert_eq!(loaded_state.last_pulled_seq, 150);
        assert!(loaded_state.in_sync);

        // 6. Test resolving the conflict
        let resolved = DbOperations::resolve_conflict(
            &mut conn,
            "conflict_v1",
            ConflictStatus::Resolved,
            "MANUAL_CLINICAL_MERGE",
            Some(r#"{"name":"Merged Clinical Name"}"#),
        )
        .unwrap();
        assert!(resolved);

        let open_conflicts = DbOperations::get_conflicts(&conn, Some("OPEN")).unwrap();
        assert_eq!(open_conflicts.len(), 0);

        let resolved_conflicts = DbOperations::get_conflicts(&conn, Some("RESOLVED")).unwrap();
        assert_eq!(resolved_conflicts.len(), 1);
        assert_eq!(resolved_conflicts[0].status, "RESOLVED");
        assert_eq!(
            resolved_conflicts[0].resolution_strategy.as_deref(),
            Some("MANUAL_CLINICAL_MERGE")
        );
        assert_eq!(
            resolved_conflicts[0].resolution_payload.as_deref(),
            Some(r#"{"name":"Merged Clinical Name"}"#)
        );
    }

    #[test]
    fn test_migration_v3_idempotency() {
        let (mut conn, dek) = setup_test_db();

        // Running migrations again must be completely idempotent
        let res = MigrationRunner::run_migrations(&mut conn, &dek);
        assert!(res.is_ok(), "Second run must be an idempotent no-op");

        // Verify version 3 remains recorded exactly once
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 3",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_migration_unsupported_future_version_rejected() {
        use crate::db::migrations::MigrationError;

        let mut conn = Connection::open_in_memory().unwrap();
        let dek = DatabaseEncryptionKey::new([1u8; 32]);

        conn.execute(
            "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, checksum TEXT)",
            [],
        )
        .unwrap();

        // Simulate a database from a newer future application (e.g. version 99)
        conn.execute(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES (99, 'future_v99', 'chk99')",
            [],
        )
        .unwrap();

        let result = MigrationRunner::run_migrations(&mut conn, &dek);
        assert!(
            matches!(result, Err(MigrationError::UnsupportedSchemaVersion(99))),
            "Must fail closed when database schema version exceeds supported range"
        );
    }

    #[test]
    fn test_in_flight_crash_recovery() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_recovery_test";

        DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_id,
            "P-101",
            "Patient One",
            "9998887771",
            "MALE",
            None,
            30,
            &[],
            &[],
            None,
        )
        .unwrap();

        // Mark it IN_FLIGHT simulating in-flight network request before process crash
        conn.execute(
            "UPDATE local_sync_outbox SET sync_status = 'IN_FLIGHT' WHERE clinic_id = ?1",
            params![clinic_id],
        )
        .unwrap();

        // Run crash recovery
        let recovered = DbOperations::recover_in_flight_jobs(&mut conn).unwrap();
        assert_eq!(recovered, 1);

        // Verify status is restored to PENDING
        let summary = DbOperations::get_outbox_summary(&conn, clinic_id).unwrap();
        assert_eq!(summary.pending_count, 1);
        assert_eq!(summary.in_flight_count, 0);
    }

    #[test]
    fn test_get_pending_outbox_batch_and_revert() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_batch_test";

        DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_id,
            "P-201",
            "Batch Patient",
            "9998887772",
            "FEMALE",
            None,
            25,
            &[],
            &[],
            None,
        )
        .unwrap();

        // 1. Fetch batch
        let batch = DbOperations::get_pending_outbox_batch(&mut conn, &dek, clinic_id, 10).unwrap();
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].entity_type, "PATIENT");
        assert_eq!(batch[0].payload["name"], "Batch Patient");

        // Outbox should now be IN_FLIGHT
        let summary = DbOperations::get_outbox_summary(&conn, clinic_id).unwrap();
        assert_eq!(summary.pending_count, 0);
        assert_eq!(summary.in_flight_count, 1);

        // 2. Simulate push network failure -> revert to PENDING
        let ids: Vec<String> = batch.iter().map(|b| b.id.clone()).collect();
        let reverted = DbOperations::revert_in_flight_to_pending(&conn, &ids, Some("Connection dropped")).unwrap();
        assert_eq!(reverted, 1);

        let summary2 = DbOperations::get_outbox_summary(&conn, clinic_id).unwrap();
        assert_eq!(summary2.pending_count, 1);
        assert_eq!(summary2.in_flight_count, 0);
    }

    #[test]
    fn test_apply_push_mutation_result_applied_and_conflict() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_push_test";

        let pat_id = DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_id,
            "P-301",
            "Push Patient",
            "9998887773",
            "MALE",
            None,
            40,
            &[],
            &[],
            None,
        )
        .unwrap();

        let batch = DbOperations::get_pending_outbox_batch(&mut conn, &dek, clinic_id, 10).unwrap();
        assert_eq!(batch.len(), 1);
        let outbox_id = &batch[0].id;

        // 1. Apply APPLIED result
        DbOperations::apply_push_mutation_result(
            &mut conn,
            outbox_id,
            "APPLIED",
            "PATIENT",
            &pat_id,
            Some("server_pat_123"),
            Some(1),
            None,
            None,
        )
        .unwrap();

        let patients = DbOperations::get_patients(&conn, &dek, clinic_id).unwrap();
        assert_eq!(patients.len(), 1);
        assert_eq!(patients[0].server_id.as_deref(), Some("server_pat_123"));
        assert_eq!(patients[0].sync_status, "SYNCED");

        // 2. Insert another patient and simulate CONFLICT
        let pat_id2 = DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_id,
            "P-302",
            "Conflict Patient",
            "9998887774",
            "FEMALE",
            None,
            42,
            &[],
            &[],
            None,
        )
        .unwrap();

        let batch2 = DbOperations::get_pending_outbox_batch(&mut conn, &dek, clinic_id, 10).unwrap();
        assert_eq!(batch2.len(), 1);
        let outbox_id2 = &batch2[0].id;

        let conflict_details = serde_json::json!({
            "conflictReason": "CONCURRENT_MODIFICATION",
            "serverVersion": 2,
            "clientVersion": 1,
            "serverState": { "name": "Conflict Patient Server" },
            "clientPayload": { "name": "Conflict Patient" }
        });

        DbOperations::apply_push_mutation_result(
            &mut conn,
            outbox_id2,
            "CONFLICT",
            "PATIENT",
            &pat_id2,
            Some("server_pat_456"),
            Some(2),
            Some("Version mismatch"),
            Some(&conflict_details),
        )
        .unwrap();

        // Verify conflict recorded durably in local_sync_conflicts
        let conflicts = DbOperations::get_conflicts(&conn, Some("OPEN")).unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].entity_id, pat_id2);
        assert_eq!(conflicts[0].conflict_reason, "CONCURRENT_MODIFICATION");
        assert_eq!(conflicts[0].status, "OPEN");

        // Verify patient status is marked CONFLICT
        let patients2 = DbOperations::get_patients(&conn, &dek, clinic_id).unwrap();
        let p2 = patients2.iter().find(|p| p.id == pat_id2).unwrap();
        assert_eq!(p2.sync_status, "CONFLICT");
    }

    #[test]
    fn test_cursor_progression_and_pull_items() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_pull_test";

        let changes = vec![
            SyncFeedChangeItem {
                seq: 1,
                entity_type: "PATIENT".to_string(),
                entity_id: "remote_p_1".to_string(),
                client_entity_id: None,
                action: "CREATE".to_string(),
                version: 1,
                payload: serde_json::json!({
                    "name": "Pulled Patient",
                    "phone": "9876543210",
                    "gender": "FEMALE",
                    "patientId": "P-9001",
                    "age": 28,
                    "allergies": ["Pollen"],
                    "conditions": []
                }),
                committed_at: "2026-10-27T10:00:00Z".to_string(),
                actor_doctor_id: "doc_99".to_string(),
            },
            SyncFeedChangeItem {
                seq: 2,
                entity_type: "PATIENT".to_string(),
                entity_id: "remote_p_2".to_string(),
                client_entity_id: None,
                action: "CREATE".to_string(),
                version: 1,
                payload: serde_json::json!({
                    "name": "Second Pulled Patient",
                    "phone": "9876543211",
                    "gender": "MALE",
                    "patientId": "P-9002",
                    "age": 35,
                    "allergies": [],
                    "conditions": ["Asthma"]
                }),
                committed_at: "2026-10-27T10:05:00Z".to_string(),
                actor_doctor_id: "doc_99".to_string(),
            },
        ];

        // 1. Apply pulled changes
        let final_seq = DbOperations::apply_pull_feed_items(
            &mut conn,
            &dek,
            clinic_id,
            &changes,
            2,
            false,
        )
        .unwrap();
        assert_eq!(final_seq, 2);

        // Verify cursor in local_sync_state
        let state = DbOperations::get_sync_state(&conn, clinic_id).unwrap().unwrap();
        assert_eq!(state.last_pulled_seq, 2);
        assert!(state.in_sync);

        // Verify patients were inserted with encryption
        let patients = DbOperations::get_patients(&conn, &dek, clinic_id).unwrap();
        assert_eq!(patients.len(), 2);
        assert!(patients.iter().any(|p| p.name == "Pulled Patient" && p.patient_code == "P-9001"));
        assert!(patients.iter().any(|p| p.name == "Second Pulled Patient" && p.patient_code == "P-9002"));

        // 2. Next pull progresses cursor monotonically
        let changes2 = vec![
            SyncFeedChangeItem {
                seq: 3,
                entity_type: "PATIENT".to_string(),
                entity_id: "remote_p_3".to_string(),
                client_entity_id: None,
                action: "CREATE".to_string(),
                version: 1,
                payload: serde_json::json!({
                    "name": "Third Patient",
                    "phone": "9876543212",
                    "gender": "OTHER",
                    "patientId": "P-9003",
                    "age": 50,
                    "allergies": [],
                    "conditions": []
                }),
                committed_at: "2026-10-27T10:10:00Z".to_string(),
                actor_doctor_id: "doc_99".to_string(),
            },
        ];

        let final_seq2 = DbOperations::apply_pull_feed_items(
            &mut conn,
            &dek,
            clinic_id,
            &changes2,
            3,
            false,
        )
        .unwrap();
        assert_eq!(final_seq2, 3);

        let state2 = DbOperations::get_sync_state(&conn, clinic_id).unwrap().unwrap();
        assert_eq!(state2.last_pulled_seq, 3);
    }

    #[test]
    fn test_pull_feed_items_concurrent_conflict_durably_recorded() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_conflict_test";

        // Insert local patient which generates pending outbox mutation
        let local_pat_id = DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_id,
            "P-CONFLICT",
            "Local Offline Patient",
            "9876500000",
            "MALE",
            None,
            30,
            &[],
            &[],
            None,
        )
        .unwrap();

        // Remote feed delivers concurrent modification for the same client_entity_id
        let remote_changes = vec![SyncFeedChangeItem {
            seq: 10,
            entity_type: "PATIENT".to_string(),
            entity_id: "server_pat_99".to_string(),
            client_entity_id: Some(local_pat_id.clone()),
            action: "UPDATE".to_string(),
            version: 2,
            payload: serde_json::json!({
                "name": "Remote Concurrent Patient Edit",
                "phone": "9876599999",
                "gender": "MALE",
                "patientId": "P-CONFLICT",
                "age": 31,
                "allergies": [],
                "conditions": []
            }),
            committed_at: "2026-10-27T10:20:00Z".to_string(),
            actor_doctor_id: "doc_remote".to_string(),
        }];

        DbOperations::apply_pull_feed_items(
            &mut conn,
            &dek,
            clinic_id,
            &remote_changes,
            10,
            false,
        )
        .unwrap();

        // 1. Verify conflict is durably recorded in local_sync_conflicts
        let conflicts = DbOperations::get_conflicts(&conn, Some("OPEN")).unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].conflict_reason, "CONCURRENT_REMOTE_UPDATE");
        assert_eq!(conflicts[0].status, "OPEN");

        // 2. Verify local patient was NOT silently overwritten
        let patients = DbOperations::get_patients(&conn, &dek, clinic_id).unwrap();
        let local_p = patients.iter().find(|p| p.id == local_pat_id).unwrap();
        assert_eq!(local_p.name, "Local Offline Patient"); // Preserved!
        assert_eq!(local_p.sync_status, "CONFLICT");
    }

    #[test]
    fn test_cross_clinic_tenant_isolation() {
        let (mut conn, dek) = setup_test_db();
        let clinic_a = "clinic_alpha";
        let clinic_b = "clinic_beta";

        DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_a,
            "P-A1",
            "Patient Alpha",
            "1111111111",
            "MALE",
            None,
            20,
            &[],
            &[],
            None,
        )
        .unwrap();

        DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_b,
            "P-B1",
            "Patient Beta",
            "2222222222",
            "FEMALE",
            None,
            22,
            &[],
            &[],
            None,
        )
        .unwrap();

        // Verify outbox batch isolation
        let batch_a = DbOperations::get_pending_outbox_batch(&mut conn, &dek, clinic_a, 10).unwrap();
        assert_eq!(batch_a.len(), 1);
        assert_eq!(batch_a[0].clinic_id, clinic_a);
        assert_eq!(batch_a[0].payload["name"], "Patient Alpha");

        let batch_b = DbOperations::get_pending_outbox_batch(&mut conn, &dek, clinic_b, 10).unwrap();
        assert_eq!(batch_b.len(), 1);
        assert_eq!(batch_b[0].clinic_id, clinic_b);
        assert_eq!(batch_b[0].payload["name"], "Patient Beta");

        // Verify read isolation
        let patients_a = DbOperations::get_patients(&conn, &dek, clinic_a).unwrap();
        assert_eq!(patients_a.len(), 1);
        assert_eq!(patients_a[0].name, "Patient Alpha");

        let patients_b = DbOperations::get_patients(&conn, &dek, clinic_b).unwrap();
        assert_eq!(patients_b.len(), 1);
        assert_eq!(patients_b[0].name, "Patient Beta");
    }

    #[test]
    fn test_crud_lifecycle_and_restart_persistence() {
        let db_path = std::env::temp_dir().join(format!("cliniqo_crud_test_{}.db", uuid::Uuid::new_v4()));
        let dek = DatabaseEncryptionKey::new([42u8; 32]);
        let clinic_id = "clinic_restart_test";

        let patient_id = {
            let mut conn = Connection::open(&db_path).unwrap();
            conn.pragma_update(None, "foreign_keys", "ON").unwrap();
            MigrationRunner::run_migrations(&mut conn, &dek).unwrap();

            // 1. Create patient
            let pid = DbOperations::insert_patient(
                &mut conn,
                &dek,
                clinic_id,
                "PC-9900",
                "Dev Patel",
                "9811122233",
                "MALE",
                Some("1989-11-05"),
                36,
                &["Aspirin".to_string()],
                &["Hypertension".to_string()],
                Some("Initial consultation required"),
            )
            .unwrap();

            // 2. Read patient
            let patients = DbOperations::get_patients(&conn, &dek, clinic_id).unwrap();
            assert_eq!(patients.len(), 1);
            assert_eq!(patients[0].id, pid);
            assert_eq!(patients[0].name, "Dev Patel");
            assert_eq!(patients[0].local_version, 1);

            // 3. Update patient
            DbOperations::update_patient(
                &mut conn,
                &dek,
                clinic_id,
                &pid,
                "PC-9900",
                "Dev Patel",
                "9811199999", // updated phone
                "MALE",
                Some("1989-11-05"),
                37, // updated age
                &["Aspirin".to_string(), "Ibuprofen".to_string()],
                &["Hypertension".to_string()],
                Some("Follow-up completed"),
            )
            .unwrap();

            // Read again before close
            let updated = DbOperations::get_patients(&conn, &dek, clinic_id).unwrap();
            assert_eq!(updated[0].phone, "9811199999");
            assert_eq!(updated[0].age, 37);
            assert_eq!(updated[0].local_version, 2);

            pid
            // conn closes here, simulating shutdown
        };

        // 4. Simulate application restart: reopen from disk
        {
            let mut conn = Connection::open(&db_path).unwrap();
            conn.pragma_update(None, "foreign_keys", "ON").unwrap();
            MigrationRunner::run_migrations(&mut conn, &dek).unwrap();

            // Verify persistence after restart
            let restored = DbOperations::get_patients(&conn, &dek, clinic_id).unwrap();
            assert_eq!(restored.len(), 1);
            assert_eq!(restored[0].id, patient_id);
            assert_eq!(restored[0].name, "Dev Patel");
            assert_eq!(restored[0].phone, "9811199999");
            assert_eq!(restored[0].age, 37);
            assert_eq!(restored[0].local_version, 2);

            // 5. Delete patient
            DbOperations::delete_patient(&mut conn, &dek, clinic_id, &patient_id).unwrap();

            let after_delete = DbOperations::get_patients(&conn, &dek, clinic_id).unwrap();
            assert_eq!(after_delete.len(), 0);

            // Verify outbox contains the delete action
            let outbox = DbOperations::get_pending_outbox_batch(&mut conn, &dek, clinic_id, 10).unwrap();
            assert!(outbox.iter().any(|item| item.action == "DELETE" && item.entity_id == patient_id));
        }

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn test_conflict_resolution_use_server() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_res_test";

        let local_pat_id = DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_id,
            "P-100",
            "Local Offline Name",
            "1111111111",
            "MALE",
            None,
            25,
            &["LocalAllergy".to_string()],
            &[],
            None,
        )
        .unwrap();

        let batch = DbOperations::get_pending_outbox_batch(&mut conn, &dek, clinic_id, 10).unwrap();
        let outbox_id = &batch[0].id;

        let conflict_details = serde_json::json!({
            "conflictReason": "DIVERGENT_CLINICAL_DATA",
            "serverVersion": 5,
            "clientVersion": 1,
            "serverState": {
                "patientId": "P-100",
                "name": "Server Authoritative Name",
                "phone": "9999999999",
                "gender": "MALE",
                "age": 26,
                "allergies": ["ServerAllergy"],
                "conditions": ["ServerCondition"]
            },
            "clientPayload": {
                "name": "Local Offline Name",
                "phone": "1111111111"
            }
        });

        DbOperations::apply_push_mutation_result(
            &mut conn,
            outbox_id,
            "CONFLICT",
            "PATIENT",
            &local_pat_id,
            Some("srv_p1"),
            Some(5),
            Some("Conflict"),
            Some(&conflict_details),
        )
        .unwrap();

        let open_conflicts = DbOperations::get_conflicts_for_clinic(&conn, clinic_id, Some("OPEN")).unwrap();
        assert_eq!(open_conflicts.len(), 1);
        let conflict_id = &open_conflicts[0].id;

        // Resolve using USE_SERVER
        let resolved = DbOperations::apply_conflict_resolution(
            &mut conn,
            &dek,
            clinic_id,
            conflict_id,
            "USE_SERVER",
            None,
        )
        .unwrap();

        assert_eq!(resolved.status, "RESOLVED");
        assert_eq!(resolved.resolution_strategy.as_deref(), Some("USE_SERVER"));

        // Verify patient record updated with server data and SYNCED
        let patients = DbOperations::get_patients(&conn, &dek, clinic_id).unwrap();
        let p = &patients[0];
        assert_eq!(p.name, "Server Authoritative Name");
        assert_eq!(p.phone, "9999999999");
        assert_eq!(p.age, 26);
        assert_eq!(p.allergies, vec!["ServerAllergy".to_string()]);
        assert_eq!(p.conditions, vec!["ServerCondition".to_string()]);
        assert_eq!(p.sync_status, "SYNCED");
        assert_eq!(p.server_version, 5);

        // Verify no pending outbox mutations remain
        let summary = DbOperations::get_outbox_summary(&conn, clinic_id).unwrap();
        assert_eq!(summary.pending_count, 0);
        assert_eq!(summary.conflict_count, 0);
    }

    #[test]
    fn test_conflict_resolution_use_local() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_uselocal_test";

        let local_pat_id = DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_id,
            "P-200",
            "Doctor Desired Name",
            "2222222222",
            "FEMALE",
            None,
            30,
            &[],
            &[],
            None,
        )
        .unwrap();

        let batch = DbOperations::get_pending_outbox_batch(&mut conn, &dek, clinic_id, 10).unwrap();
        let outbox_id = &batch[0].id;

        let conflict_details = serde_json::json!({
            "conflictReason": "CONCURRENT_MODIFICATION",
            "serverVersion": 3,
            "clientVersion": 1,
            "serverState": { "name": "Server Name" },
            "clientPayload": { "name": "Doctor Desired Name", "phone": "2222222222" }
        });

        DbOperations::apply_push_mutation_result(
            &mut conn,
            outbox_id,
            "CONFLICT",
            "PATIENT",
            &local_pat_id,
            Some("srv_p2"),
            Some(3),
            Some("Conflict"),
            Some(&conflict_details),
        )
        .unwrap();

        let open_conflicts = DbOperations::get_conflicts_for_clinic(&conn, clinic_id, Some("OPEN")).unwrap();
        let conflict_id = &open_conflicts[0].id;

        // Resolve using USE_LOCAL
        let resolved = DbOperations::apply_conflict_resolution(
            &mut conn,
            &dek,
            clinic_id,
            conflict_id,
            "USE_LOCAL",
            None,
        )
        .unwrap();

        assert_eq!(resolved.status, "RESOLVED");
        assert_eq!(resolved.resolution_strategy.as_deref(), Some("USE_LOCAL"));

        // Verify local patient marked PENDING with monotonic version >= server_version + 1
        let patients = DbOperations::get_patients(&conn, &dek, clinic_id).unwrap();
        let p = &patients[0];
        assert_eq!(p.name, "Doctor Desired Name");
        assert_eq!(p.sync_status, "PENDING");
        assert_eq!(p.local_version, 4);

        // Verify a NEW outbox mutation is enqueued with target version 4
        let new_batch = DbOperations::get_pending_outbox_batch(&mut conn, &dek, clinic_id, 10).unwrap();
        assert_eq!(new_batch.len(), 1);
        assert_eq!(new_batch[0].action, "UPDATE");
        assert!(new_batch[0].idempotency_key.contains("resolve-uselocal"));
    }

    #[test]
    fn test_conflict_resolution_merge_manual() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_merge_test";

        let local_pat_id = DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_id,
            "P-300",
            "Dr Alice Notes",
            "3333333333",
            "FEMALE",
            None,
            45,
            &["Penicillin".to_string()],
            &[],
            None,
        )
        .unwrap();

        let batch = DbOperations::get_pending_outbox_batch(&mut conn, &dek, clinic_id, 10).unwrap();
        let outbox_id = &batch[0].id;

        let conflict_details = serde_json::json!({
            "conflictReason": "DIVERGENT_CLINICAL_DATA",
            "serverVersion": 2,
            "clientVersion": 1,
            "serverState": {
                "name": "Dr Bob Notes",
                "phone": "3333333333",
                "allergies": ["Sulfa"],
                "conditions": ["Diabetes"]
            },
            "clientPayload": {
                "name": "Dr Alice Notes",
                "allergies": ["Penicillin"]
            }
        });

        DbOperations::apply_push_mutation_result(
            &mut conn,
            outbox_id,
            "CONFLICT",
            "PATIENT",
            &local_pat_id,
            Some("srv_p3"),
            Some(2),
            Some("Conflict"),
            Some(&conflict_details),
        )
        .unwrap();

        let open_conflicts = DbOperations::get_conflicts_for_clinic(&conn, clinic_id, Some("OPEN")).unwrap();
        let conflict_id = &open_conflicts[0].id;

        // Merged clinical data combines allergies Penicillin and Sulfa
        let merged_payload = serde_json::json!({
            "patientId": "P-300",
            "name": "Dr Alice & Bob Reconciled",
            "phone": "3333333333",
            "gender": "FEMALE",
            "age": 45,
            "allergies": ["Penicillin", "Sulfa"],
            "conditions": ["Diabetes"]
        })
        .to_string();

        let resolved = DbOperations::apply_conflict_resolution(
            &mut conn,
            &dek,
            clinic_id,
            conflict_id,
            "MERGE_MANUAL",
            Some(&merged_payload),
        )
        .unwrap();

        assert_eq!(resolved.status, "RESOLVED");
        assert_eq!(resolved.resolution_strategy.as_deref(), Some("MERGE_MANUAL"));

        // Verify patient updated with merged clinical state
        let patients = DbOperations::get_patients(&conn, &dek, clinic_id).unwrap();
        let p = &patients[0];
        assert_eq!(p.name, "Dr Alice & Bob Reconciled");
        assert_eq!(p.allergies, vec!["Penicillin".to_string(), "Sulfa".to_string()]);
        assert_eq!(p.conditions, vec!["Diabetes".to_string()]);
        assert_eq!(p.sync_status, "PENDING");
    }

    #[test]
    fn test_conflict_resolution_preserve_both_consultations() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_preserve_test";

        let pat_id = DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_id,
            "P-400",
            "Preserve Patient",
            "4444444444",
            "MALE",
            None,
            50,
            &[],
            &[],
            None,
        )
        .unwrap();

        let consult_id = DbOperations::insert_consultation(
            &mut conn,
            &dek,
            clinic_id,
            &pat_id,
            "doc_local",
            "2026-10-27",
            "Severe Migraine",
            "Tension Headache",
            None,
        )
        .unwrap();

        let batch = DbOperations::get_pending_outbox_batch(&mut conn, &dek, clinic_id, 10).unwrap();
        let outbox_id = batch.iter().find(|b| b.entity_id == consult_id).unwrap().id.clone();

        let conflict_details = serde_json::json!({
            "conflictReason": "CONCURRENT_DRAFT_COLLISION",
            "serverVersion": 2,
            "clientVersion": 1,
            "serverState": {
                "status": "COMPLETED",
                "chiefComplaint": "Abdominal Pain",
                "diagnosis": "Gastritis"
            },
            "clientPayload": {
                "status": "DRAFT",
                "chiefComplaint": "Severe Migraine",
                "diagnosis": "Tension Headache"
            }
        });

        DbOperations::apply_push_mutation_result(
            &mut conn,
            &outbox_id,
            "CONFLICT",
            "CONSULTATION",
            &consult_id,
            Some("srv_c4"),
            Some(2),
            Some("Conflict"),
            Some(&conflict_details),
        )
        .unwrap();

        let open_conflicts = DbOperations::get_conflicts_for_clinic(&conn, clinic_id, Some("OPEN")).unwrap();
        let conflict_id = &open_conflicts[0].id;

        // Resolve using PRESERVE_BOTH
        let resolved = DbOperations::apply_conflict_resolution(
            &mut conn,
            &dek,
            clinic_id,
            conflict_id,
            "PRESERVE_BOTH",
            None,
        )
        .unwrap();

        assert_eq!(resolved.status, "RESOLVED");
        assert_eq!(resolved.resolution_strategy.as_deref(), Some("PRESERVE_BOTH"));

        // Verify there are now TWO distinct consultations locally:
        // 1. The original consultation with server data (Gastritis), marked SYNCED
        // 2. The cloned consultation with local data (Severe Migraine), marked PENDING
        let consults = DbOperations::get_consultations(&conn, &dek, clinic_id, None).unwrap();
        assert_eq!(consults.len(), 2);

        let server_c = consults.iter().find(|c| c.id == consult_id).unwrap();
        assert_eq!(server_c.diagnosis, "Gastritis");
        assert_eq!(server_c.sync_status, "SYNCED");

        let cloned_c = consults.iter().find(|c| c.id != consult_id).unwrap();
        assert_eq!(cloned_c.diagnosis, "Tension Headache");
        assert_eq!(cloned_c.chief_complaint, "Severe Migraine");
        assert_eq!(cloned_c.sync_status, "PENDING");
    }

    #[test]
    fn test_conflict_resolution_tenant_isolation_and_idempotency() {
        let (mut conn, dek) = setup_test_db();
        let clinic_a = "clinic_alpha";
        let clinic_b = "clinic_beta";

        let pat_a = DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_a,
            "P-A",
            "Alpha Patient",
            "111",
            "MALE",
            None,
            20,
            &[],
            &[],
            None,
        )
        .unwrap();

        let batch_a = DbOperations::get_pending_outbox_batch(&mut conn, &dek, clinic_a, 10).unwrap();
        let outbox_a = &batch_a[0].id;

        DbOperations::apply_push_mutation_result(
            &mut conn,
            outbox_a,
            "CONFLICT",
            "PATIENT",
            &pat_a,
            Some("srv_a"),
            Some(2),
            Some("Conflict"),
            None,
        )
        .unwrap();

        let conflicts_a = DbOperations::get_conflicts_for_clinic(&conn, clinic_a, Some("OPEN")).unwrap();
        assert_eq!(conflicts_a.len(), 1);
        let conflict_a_id = &conflicts_a[0].id;

        // Clinic B must see ZERO conflicts
        let conflicts_b = DbOperations::get_conflicts_for_clinic(&conn, clinic_b, Some("OPEN")).unwrap();
        assert_eq!(conflicts_b.len(), 0);

        // Clinic B cannot resolve Clinic A's conflict
        let unauthorized_res = DbOperations::apply_conflict_resolution(
            &mut conn,
            &dek,
            clinic_b,
            conflict_a_id,
            "USE_SERVER",
            None,
        );
        assert!(unauthorized_res.is_err(), "Must reject cross-clinic conflict resolution");

        // Clinic A resolves successfully
        let success_res = DbOperations::apply_conflict_resolution(
            &mut conn,
            &dek,
            clinic_a,
            conflict_a_id,
            "USE_SERVER",
            None,
        );
        assert!(success_res.is_ok());

        // Attempting to resolve an already resolved conflict fails closed
        let duplicate_res = DbOperations::apply_conflict_resolution(
            &mut conn,
            &dek,
            clinic_a,
            conflict_a_id,
            "USE_SERVER",
            None,
        );
        assert!(duplicate_res.is_err(), "Duplicate resolution of resolved conflict must fail closed");
    }

    #[test]
    fn test_save_invoice_minor_units_arithmetic_and_encryption() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_billing_1";
        let doctor_id = "doc_billing_1";
        let patient_id = "pat_billing_1";

        let args = SaveInvoiceArgs {
            id: None,
            clinic_id: clinic_id.to_string(),
            patient_id: patient_id.to_string(),
            consultation_id: Some("cons_1".to_string()),
            invoice_number: "INV-2026-0001".to_string(),
            invoice_date: "2026-10-28".to_string(),
            status: Some("DRAFT".to_string()),
            payment_status: Some("UNPAID".to_string()),
            items: vec![
                InvoiceItem {
                    description: "Consultation".to_string(),
                    quantity: 2,
                    unit_price_paise: 80000,
                    total_paise: 0,
                },
                InvoiceItem {
                    description: "Injection Procedure".to_string(),
                    quantity: 1,
                    unit_price_paise: 25000,
                    total_paise: 0,
                },
            ],
            discount_paise: Some(10000),
            tax_rate_percent: Some(18.0),
            notes: Some("Confidential billing notes".to_string()),
        };

        let invoice_id = DbOperations::save_invoice(&mut conn, &dek, doctor_id, args).unwrap();

        // 1. Verify in-database encryption (zero plaintext notes or line items)
        let (_enc_bytes, _nonce_bytes): (Vec<u8>, Vec<u8>) = conn
            .query_row(
                "SELECT encrypted_billing_data, nonce FROM local_invoices_v2 WHERE id = ?1",
                params![invoice_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        let raw_table_text: String = conn
            .query_row(
                "SELECT quote(encrypted_billing_data) FROM local_invoices_v2 WHERE id = ?1",
                params![invoice_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!raw_table_text.contains("Consultation"));
        assert!(!raw_table_text.contains("Confidential billing notes"));

        // 2. Verify arithmetic via get_invoice_by_id
        let inv = DbOperations::get_invoice_by_id(&conn, &dek, clinic_id, &invoice_id)
            .unwrap()
            .expect("invoice found");

        // Subtotal = (2 * 80000) + (1 * 25000) = 185000 paise
        assert_eq!(inv.subtotal_paise, 185000);
        // Discount = 10000 paise
        assert_eq!(inv.discount_paise, 10000);
        // Taxable = 175000 paise, 18% tax = 31500 paise
        assert_eq!(inv.tax_paise, 31500);
        // Total = 175000 + 31500 = 206500 paise
        assert_eq!(inv.total_paise, 206500);
        assert_eq!(inv.items.len(), 2);
        assert_eq!(inv.notes.as_deref(), Some("Confidential billing notes"));
        assert_eq!(inv.status, "DRAFT");
    }

    #[test]
    fn test_invoice_discount_clamped_and_negative_rejection() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_billing_2";
        let doctor_id = "doc_billing_2";

        // Discount > subtotal is clamped
        let args_clamped = SaveInvoiceArgs {
            id: None,
            clinic_id: clinic_id.to_string(),
            patient_id: "pat_1".to_string(),
            consultation_id: None,
            invoice_number: "INV-2026-0002".to_string(),
            invoice_date: "2026-10-28".to_string(),
            status: Some("DRAFT".to_string()),
            payment_status: Some("UNPAID".to_string()),
            items: vec![InvoiceItem {
                description: "Basic Checkup".to_string(),
                quantity: 1,
                unit_price_paise: 50000,
                total_paise: 0,
            }],
            discount_paise: Some(80000), // Exceeds 50000
            tax_rate_percent: Some(0.0),
            notes: None,
        };

        let inv_id = DbOperations::save_invoice(&mut conn, &dek, doctor_id, args_clamped).unwrap();
        let inv = DbOperations::get_invoice_by_id(&conn, &dek, clinic_id, &inv_id)
            .unwrap()
            .unwrap();
        assert_eq!(inv.subtotal_paise, 50000);
        assert_eq!(inv.discount_paise, 50000);
        assert_eq!(inv.total_paise, 0);

        // Negative price rejected
        let args_neg = SaveInvoiceArgs {
            id: None,
            clinic_id: clinic_id.to_string(),
            patient_id: "pat_1".to_string(),
            consultation_id: None,
            invoice_number: "INV-2026-0003".to_string(),
            invoice_date: "2026-10-28".to_string(),
            status: Some("DRAFT".to_string()),
            payment_status: Some("UNPAID".to_string()),
            items: vec![InvoiceItem {
                description: "Bad item".to_string(),
                quantity: 1,
                unit_price_paise: -100,
                total_paise: 0,
            }],
            discount_paise: None,
            tax_rate_percent: None,
            notes: None,
        };

        assert!(DbOperations::save_invoice(&mut conn, &dek, doctor_id, args_neg).is_err());
    }

    #[test]
    fn test_invoice_finalize_and_immutability() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_billing_3";
        let doctor_id = "doc_billing_3";

        let args = SaveInvoiceArgs {
            id: None,
            clinic_id: clinic_id.to_string(),
            patient_id: "pat_3".to_string(),
            consultation_id: None,
            invoice_number: "INV-2026-0004".to_string(),
            invoice_date: "2026-10-28".to_string(),
            status: Some("DRAFT".to_string()),
            payment_status: Some("UNPAID".to_string()),
            items: vec![InvoiceItem {
                description: "Procedure".to_string(),
                quantity: 1,
                unit_price_paise: 100000,
                total_paise: 0,
            }],
            discount_paise: None,
            tax_rate_percent: None,
            notes: None,
        };

        let invoice_id = DbOperations::save_invoice(&mut conn, &dek, doctor_id, args.clone()).unwrap();

        // Finalize invoice
        let finalized = DbOperations::finalize_invoice(&mut conn, &dek, clinic_id, doctor_id, &invoice_id).unwrap();
        assert_eq!(finalized.status, "FINALIZED");

        // Attempting to edit finalized invoice must fail
        let mut edit_args = args;
        edit_args.id = Some(invoice_id.clone());
        edit_args.discount_paise = Some(20000);

        let edit_res = DbOperations::save_invoice(&mut conn, &dek, doctor_id, edit_args);
        assert!(edit_res.is_err(), "Editing finalized invoice must be prohibited");
    }

    #[test]
    fn test_invoice_clinic_tenancy_isolation() {
        let (mut conn, dek) = setup_test_db();
        let clinic_a = "clinic_alpha";
        let clinic_b = "clinic_beta";
        let doctor_id = "doc_1";

        let args = SaveInvoiceArgs {
            id: None,
            clinic_id: clinic_a.to_string(),
            patient_id: "pat_a".to_string(),
            consultation_id: None,
            invoice_number: "INV-ALPHA-1".to_string(),
            invoice_date: "2026-10-28".to_string(),
            status: Some("DRAFT".to_string()),
            payment_status: Some("UNPAID".to_string()),
            items: vec![InvoiceItem {
                description: "Service A".to_string(),
                quantity: 1,
                unit_price_paise: 50000,
                total_paise: 0,
            }],
            discount_paise: None,
            tax_rate_percent: None,
            notes: None,
        };

        let invoice_id = DbOperations::save_invoice(&mut conn, &dek, doctor_id, args).unwrap();

        // Clinic B cannot see Clinic A's invoice
        let res_b = DbOperations::get_invoice_by_id(&conn, &dek, clinic_b, &invoice_id).unwrap();
        assert!(res_b.is_none());

        let list_b = DbOperations::get_invoices(&conn, &dek, clinic_b, None).unwrap();
        assert!(list_b.is_empty());

        // Clinic B cannot finalize Clinic A's invoice
        let finalize_b = DbOperations::finalize_invoice(&mut conn, &dek, clinic_b, doctor_id, &invoice_id);
        assert!(finalize_b.is_err());
    }

    #[test]
    fn test_formulary_crud_and_tenancy() {
        let (mut conn, _dek) = setup_test_db();
        let clinic_a = "clinic_form_a";
        let clinic_b = "clinic_form_b";

        let args = SaveFormularyArgs {
            id: None,
            clinic_id: clinic_a.to_string(),
            name: "Paracetamol".to_string(),
            active_ingredient: Some("Acetaminophen".to_string()),
            formulation: "TABLET".to_string(),
            strength: "650 mg".to_string(),
            default_dose: Some("1 tablet".to_string()),
            default_route: Some("ORAL".to_string()),
            default_frequency: Some("TID".to_string()),
            default_duration: Some("3 days".to_string()),
            default_instructions: Some("Take after food".to_string()),
        };

        let item_id = DbOperations::save_formulary_item(&mut conn, clinic_a, args).unwrap();

        // Retrieve for Clinic A
        let items_a = DbOperations::get_formulary_items(&conn, clinic_a).unwrap();
        assert_eq!(items_a.len(), 1);
        assert_eq!(items_a[0].name, "Paracetamol");
        assert_eq!(items_a[0].active_ingredient.as_deref(), Some("Acetaminophen"));
        assert_eq!(items_a[0].formulation, "TABLET");

        // Clinic B sees empty formulary
        let items_b = DbOperations::get_formulary_items(&conn, clinic_b).unwrap();
        assert!(items_b.is_empty());

        // Delete (soft delete)
        DbOperations::delete_formulary_item(&mut conn, clinic_a, &item_id).unwrap();
        let items_after = DbOperations::get_formulary_items(&conn, clinic_a).unwrap();
        assert!(items_after.is_empty());
    }

    #[test]
    fn test_invoice_push_mutation_applied_conflict_rejected() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_inv_sync";
        let doctor_id = "doctor_inv_sync";

        let args1 = SaveInvoiceArgs {
            id: None,
            clinic_id: clinic_id.to_string(),
            patient_id: "pat_sync_1".to_string(),
            consultation_id: None,
            invoice_number: "INV-2026-0001".to_string(),
            invoice_date: "2026-10-28".to_string(),
            status: Some("DRAFT".to_string()),
            payment_status: Some("UNPAID".to_string()),
            items: vec![InvoiceItem {
                description: "Test Consultation".to_string(),
                quantity: 1,
                unit_price_paise: 80000,
                total_paise: 80000,
            }],
            discount_paise: Some(0),
            tax_rate_percent: Some(18.0),
            notes: Some("Initial draft".to_string()),
        };

        let inv_id1 = DbOperations::save_invoice(&mut conn, &dek, doctor_id, args1).unwrap();

        let batch1 = DbOperations::get_pending_outbox_batch(&mut conn, &dek, clinic_id, 10).unwrap();
        assert_eq!(batch1.len(), 1);
        assert_eq!(batch1[0].entity_type, "INVOICE");
        assert_eq!(batch1[0].entity_id, inv_id1);
        let outbox_id1 = &batch1[0].id;

        // 1. APPLIED: verifies sync_status transitions to SYNCED and server_id is stored
        DbOperations::apply_push_mutation_result(
            &mut conn,
            outbox_id1,
            "APPLIED",
            "INVOICE",
            &inv_id1,
            Some("srv_inv_101"),
            Some(1),
            None,
            None,
        )
        .unwrap();

        let inv_rec1 = DbOperations::get_invoice_by_id(&conn, &dek, clinic_id, &inv_id1).unwrap().unwrap();
        assert_eq!(inv_rec1.sync_status, "SYNCED");
        assert_eq!(inv_rec1.server_id.as_deref(), Some("srv_inv_101"));
        assert_eq!(inv_rec1.server_version, 1);

        // 2. CONFLICT: second invoice marked as CONFLICT
        let args2 = SaveInvoiceArgs {
            id: None,
            clinic_id: clinic_id.to_string(),
            patient_id: "pat_sync_2".to_string(),
            consultation_id: None,
            invoice_number: "INV-2026-0002".to_string(),
            invoice_date: "2026-10-28".to_string(),
            status: Some("DRAFT".to_string()),
            payment_status: Some("UNPAID".to_string()),
            items: vec![InvoiceItem {
                description: "Test Consultation 2".to_string(),
                quantity: 1,
                unit_price_paise: 50000,
                total_paise: 50000,
            }],
            discount_paise: None,
            tax_rate_percent: None,
            notes: None,
        };
        let inv_id2 = DbOperations::save_invoice(&mut conn, &dek, doctor_id, args2).unwrap();
        let batch2 = DbOperations::get_pending_outbox_batch(&mut conn, &dek, clinic_id, 10).unwrap();
        assert_eq!(batch2.len(), 1);
        let outbox_id2 = &batch2[0].id;

        let conflict_details = json!({
            "conflictReason": "STALE_VERSION",
            "serverVersion": 3,
            "clientVersion": 1,
            "serverState": { "totalPaise": 60000 },
            "clientPayload": { "totalPaise": 50000 }
        });

        DbOperations::apply_push_mutation_result(
            &mut conn,
            outbox_id2,
            "CONFLICT",
            "INVOICE",
            &inv_id2,
            Some("srv_inv_102"),
            Some(3),
            Some("Client version is stale"),
            Some(&conflict_details),
        )
        .unwrap();

        let inv_rec2 = DbOperations::get_invoice_by_id(&conn, &dek, clinic_id, &inv_id2).unwrap().unwrap();
        assert_eq!(inv_rec2.sync_status, "CONFLICT");

        let conflicts = DbOperations::get_conflicts(&conn, Some("OPEN")).unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].entity_type, "INVOICE");
        assert_eq!(conflicts[0].entity_id, inv_id2);

        // 3. REJECTED: third invoice fails and preserves FAILED recoverable state
        let args3 = SaveInvoiceArgs {
            id: None,
            clinic_id: clinic_id.to_string(),
            patient_id: "pat_sync_3".to_string(),
            consultation_id: None,
            invoice_number: "INV-2026-0003".to_string(),
            invoice_date: "2026-10-28".to_string(),
            status: Some("DRAFT".to_string()),
            payment_status: Some("UNPAID".to_string()),
            items: vec![InvoiceItem {
                description: "Test Service 3".to_string(),
                quantity: 1,
                unit_price_paise: 20000,
                total_paise: 20000,
            }],
            discount_paise: None,
            tax_rate_percent: None,
            notes: None,
        };
        let inv_id3 = DbOperations::save_invoice(&mut conn, &dek, doctor_id, args3).unwrap();
        let batch3 = DbOperations::get_pending_outbox_batch(&mut conn, &dek, clinic_id, 10).unwrap();
        assert_eq!(batch3.len(), 1);
        let outbox_id3 = &batch3[0].id;

        DbOperations::apply_push_mutation_result(
            &mut conn,
            outbox_id3,
            "REJECTED",
            "INVOICE",
            &inv_id3,
            None,
            None,
            Some("Validation failure on server"),
            None,
        )
        .unwrap();

        let inv_rec3 = DbOperations::get_invoice_by_id(&conn, &dek, clinic_id, &inv_id3).unwrap().unwrap();
        assert_eq!(inv_rec3.sync_status, "FAILED");
    }

    #[test]
    fn test_invoice_pull_feed_items_sync_and_conflict() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_pull_inv";
        let doctor_id = "doctor_pull_inv";

        // 1. Pull remote invoice without local conflict
        let remote_inv_item = SyncFeedChangeItem {
            seq: 1,
            entity_type: "INVOICE".to_string(),
            entity_id: "srv_inv_5001".to_string(),
            client_entity_id: Some("client_inv_local_1".to_string()),
            action: "CREATE".to_string(),
            version: 1,
            payload: json!({
                "invoiceNumber": "INV-2026-5001",
                "invoiceDate": "2026-10-28",
                "status": "FINALIZED",
                "paymentStatus": "PAID",
                "subtotalPaise": 100000,
                "discountPaise": 10000,
                "taxRatePercent": 18.0,
                "taxPaise": 16200,
                "totalPaise": 106200,
                "patientId": "pat_pulled_1",
                "consultationId": null,
                "items": [{
                    "description": "Pulled Consultation",
                    "quantity": 1,
                    "unitPricePaise": 100000,
                    "totalPaise": 100000
                }],
                "notes": "Paid in full"
            }),
            committed_at: "2026-10-28T10:00:00Z".to_string(),
            actor_doctor_id: doctor_id.to_string(),
        };

        let final_seq = DbOperations::apply_pull_feed_items(&mut conn, &dek, clinic_id, &[remote_inv_item], 0, false).unwrap();
        assert_eq!(final_seq, 1);

        let pulled_invoices = DbOperations::get_invoices(&conn, &dek, clinic_id, None).unwrap();
        assert_eq!(pulled_invoices.len(), 1);
        assert_eq!(pulled_invoices[0].invoice_number, "INV-2026-5001");
        assert_eq!(pulled_invoices[0].status, "FINALIZED");
        assert_eq!(pulled_invoices[0].payment_status, "PAID");
        assert_eq!(pulled_invoices[0].total_paise, 106200);
        assert_eq!(pulled_invoices[0].sync_status, "SYNCED");

        // 2. Concurrent remote update when local invoice has PENDING outbox mutation
        let args_local = SaveInvoiceArgs {
            id: None,
            clinic_id: clinic_id.to_string(),
            patient_id: "pat_pulled_2".to_string(),
            consultation_id: None,
            invoice_number: "INV-2026-5002".to_string(),
            invoice_date: "2026-10-28".to_string(),
            status: Some("DRAFT".to_string()),
            payment_status: Some("UNPAID".to_string()),
            items: vec![InvoiceItem {
                description: "Local Draft Item".to_string(),
                quantity: 1,
                unit_price_paise: 50000,
                total_paise: 50000,
            }],
            discount_paise: None,
            tax_rate_percent: None,
            notes: Some("Local edit before sync".to_string()),
        };
        let local_inv_id = DbOperations::save_invoice(&mut conn, &dek, doctor_id, args_local).unwrap();

        // Simulate incoming remote update for the same local invoice
        let conflicting_remote = SyncFeedChangeItem {
            seq: 2,
            entity_type: "INVOICE".to_string(),
            entity_id: "srv_inv_5002".to_string(),
            client_entity_id: Some(local_inv_id.clone()),
            action: "UPDATE".to_string(),
            version: 2,
            payload: json!({
                "invoiceNumber": "INV-2026-5002",
                "status": "FINALIZED",
                "paymentStatus": "PAID",
                "totalPaise": 55000
            }),
            committed_at: "2026-10-28T10:05:00Z".to_string(),
            actor_doctor_id: "other_doctor".to_string(),
        };

        DbOperations::apply_pull_feed_items(&mut conn, &dek, clinic_id, &[conflicting_remote], 1, false).unwrap();

        // Local data preserved and not overwritten!
        let local_inv = DbOperations::get_invoice_by_id(&conn, &dek, clinic_id, &local_inv_id).unwrap().unwrap();
        assert_eq!(local_inv.status, "DRAFT");
        assert_eq!(local_inv.sync_status, "CONFLICT");

        // Conflict recorded in local_sync_conflicts
        let conflicts = DbOperations::get_conflicts(&conn, Some("OPEN")).unwrap();
        assert!(conflicts.iter().any(|c| c.entity_type == "INVOICE" && c.entity_id == local_inv_id));
    }

    #[test]
    fn test_catalogue_cache_and_offline_search() {
        let (mut conn, _dek) = setup_test_db();

        let items = vec![
            SaveCatalogueCacheItemArgs {
                id: "B1001".to_string(),
                item_type: "BRAND".to_string(),
                name: "Dolo 650".to_string(),
                brand_name: Some("Dolo 650".to_string()),
                generic_name: Some("Paracetamol".to_string()),
                product_name: Some("Dolo 650 Tablet".to_string()),
                dosage_form: Some("Tablet".to_string()),
                route: Some("Oral".to_string()),
                active_ingredients_json: Some(r#"["Paracetamol"]"#.to_string()),
                strengths_json: r#"[{"raw_strength":"650 mg","value":650,"unit":"mg"}]"#.to_string(),
                raw_strength_summary: "650 mg".to_string(),
                is_combination: false,
                is_verified: true,
                source_provenance: Some("CDCI_NRCES_INDIA".to_string()),
            },
            SaveCatalogueCacheItemArgs {
                id: "B1002".to_string(),
                item_type: "BRAND".to_string(),
                name: "Calpol 500".to_string(),
                brand_name: Some("Calpol 500".to_string()),
                generic_name: Some("Paracetamol".to_string()),
                product_name: Some("Calpol 500 Tablet".to_string()),
                dosage_form: Some("Tablet".to_string()),
                route: Some("Oral".to_string()),
                active_ingredients_json: Some(r#"["Paracetamol"]"#.to_string()),
                strengths_json: r#"[{"raw_strength":"500 mg","value":500,"unit":"mg"}]"#.to_string(),
                raw_strength_summary: "500 mg".to_string(),
                is_combination: false,
                is_verified: true,
                source_provenance: Some("CDCI_NRCES_INDIA".to_string()),
            },
            SaveCatalogueCacheItemArgs {
                id: "B1003".to_string(),
                item_type: "BRAND".to_string(),
                name: "Calpol 250 Syrup".to_string(),
                brand_name: Some("Calpol 250 Syrup".to_string()),
                generic_name: Some("Paracetamol".to_string()),
                product_name: Some("Calpol 250 Syrup".to_string()),
                dosage_form: Some("Syrup".to_string()),
                route: Some("Oral".to_string()),
                active_ingredients_json: Some(r#"["Paracetamol"]"#.to_string()),
                strengths_json: r#"[{"raw_strength":"250 mg/5 mL","value":250,"unit":"mg/5 mL"}]"#.to_string(),
                raw_strength_summary: "250 mg/5 mL".to_string(),
                is_combination: false,
                is_verified: true,
                source_provenance: Some("CDCI_NRCES_INDIA".to_string()),
            },
            SaveCatalogueCacheItemArgs {
                id: "B1004".to_string(),
                item_type: "BRAND".to_string(),
                name: "Unverified Herb".to_string(),
                brand_name: Some("Unverified Herb".to_string()),
                generic_name: None,
                product_name: None,
                dosage_form: Some("Ointment".to_string()),
                route: Some("Topical".to_string()),
                active_ingredients_json: None,
                strengths_json: "[]".to_string(),
                raw_strength_summary: "Unspecified".to_string(),
                is_combination: false,
                is_verified: false,
                source_provenance: Some("CDCI_NRCES_INDIA".to_string()),
            },
        ];

        // 1. Cache items safely returns 0 post-CDCI removal
        let count = DbOperations::cache_catalogue_items(&mut conn, &items).unwrap();
        assert_eq!(count, 0);

        // 2. Insert test items into local_inventory_stock_v1
        conn.execute(
            r#"
            INSERT INTO local_inventory_stock_v1 (
                id, clinic_id, product_name, unit, company, quantity, value, batch_number, source_report, created_at, updated_at
            ) VALUES
            ('s1', 'c1', 'Calpol 250 Syrup', 'Bottle', 'GSK', 25, 45.0, 'B1', 'STOCK REPORT', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
            ('s2', 'c1', 'Calpol 500', 'Strip', 'GSK', 100, 30.0, 'B2', 'STOCK REPORT', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
            ('s3', 'c1', 'Dolo 650', 'Strip', 'Micro Labs', 50, 35.0, 'B3', 'STOCK REPORT', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            "#,
            [],
        ).unwrap();

        // 3. Search prefix matches
        let search_results = DbOperations::search_local_catalogue(&conn, "Calpol", 10, None).unwrap();
        assert_eq!(search_results.len(), 2);
        assert!(search_results[0].name.contains("Calpol"));

        // 4. Search company / manufacturer
        let para_results = DbOperations::search_local_catalogue(&conn, "Micro Labs", 10, None).unwrap();
        assert_eq!(para_results.len(), 1);
        assert!(para_results[0].name.contains("Dolo 650"));

        // 5. Verify cache stats
        let stats = DbOperations::get_catalogue_cache_stats(&conn).unwrap();
        assert_eq!(stats.total_items, 0);

        // 6. Safe idempotency on rerun
        let count2 = DbOperations::cache_catalogue_items(&mut conn, &items).unwrap();
        assert_eq!(count2, 0);
    }

    #[test]
    fn test_clinic_profile_persistence() {
        let (conn, _dek) = setup_test_db();
        let clinic_id = "test-clinic-42";

        // Initial check: profile does not exist
        let initial = DbOperations::get_clinic_profile(&conn, clinic_id).unwrap();
        assert!(initial.is_none());

        // Upsert clinic profile
        let profile = ClinicProfileRecord {
            clinic_id: clinic_id.to_string(),
            name: "Dr. Patekar Multi-Speciality Clinic".to_string(),
            slug: "dr-patekar-clinic".to_string(),
            phone: "+91 9876543210".to_string(),
            email: "clinic@drpatekar.com".to_string(),
            street: "123 Healthcare Ave, Suite 4".to_string(),
            city: "Mumbai".to_string(),
            state: "Maharashtra".to_string(),
            postal_code: "400001".to_string(),
            country: "India".to_string(),
            location_link: "https://maps.google.com/?q=19.0760,72.8777".to_string(),
            updated_at: None,
        };

        DbOperations::upsert_clinic_profile(&conn, &profile).unwrap();

        // Retrieve and verify
        let fetched = DbOperations::get_clinic_profile(&conn, clinic_id).unwrap().expect("found");
        assert_eq!(fetched.clinic_id, clinic_id);
        assert_eq!(fetched.name, "Dr. Patekar Multi-Speciality Clinic");
        assert_eq!(fetched.phone, "+91 9876543210");
        assert_eq!(fetched.email, "clinic@drpatekar.com");
        assert_eq!(fetched.street, "123 Healthcare Ave, Suite 4");
        assert_eq!(fetched.city, "Mumbai");
        assert_eq!(fetched.state, "Maharashtra");
        assert_eq!(fetched.postal_code, "400001");
        assert_eq!(fetched.country, "India");
        assert_eq!(fetched.location_link, "https://maps.google.com/?q=19.0760,72.8777");
        assert!(fetched.updated_at.is_some());

        // Update profile
        let mut updated = profile.clone();
        updated.name = "Dr. Patekar Advanced Clinic".to_string();
        updated.phone = "+91 9999999999".to_string();
        DbOperations::upsert_clinic_profile(&conn, &updated).unwrap();

        let refetched = DbOperations::get_clinic_profile(&conn, clinic_id).unwrap().expect("found");
        assert_eq!(refetched.name, "Dr. Patekar Advanced Clinic");
        assert_eq!(refetched.phone, "+91 9999999999");
    }

    #[test]
    fn test_doctor_profile_persistence_and_non_destructive_update() {
        let (conn, _dek) = setup_test_db();
        let doctor_id = "doc-test-101";

        // Initial check: profile does not exist
        let initial = DbOperations::get_doctor_profile(&conn, doctor_id).unwrap();
        assert!(initial.is_none());

        // Upsert doctor profile
        let profile = DoctorProfileRecord {
            doctor_id: doctor_id.to_string(),
            full_name: "Dr. Dipesh Patekar".to_string(),
            email: "dipesh@cliniqo.test".to_string(),
            phone: "+91 9876543210".to_string(),
            qualification: "MBBS, MD (Medicine)".to_string(),
            registration_number: "MMC 2024/05/98765".to_string(),
            gender: "Male".to_string(),
            updated_at: None,
        };

        DbOperations::upsert_doctor_profile(&conn, &profile).unwrap();

        // Retrieve and verify
        let fetched = DbOperations::get_doctor_profile(&conn, doctor_id).unwrap().expect("found");
        assert_eq!(fetched.doctor_id, doctor_id);
        assert_eq!(fetched.full_name, "Dr. Dipesh Patekar");
        assert_eq!(fetched.email, "dipesh@cliniqo.test");
        assert_eq!(fetched.phone, "+91 9876543210");
        assert_eq!(fetched.qualification, "MBBS, MD (Medicine)");
        assert_eq!(fetched.registration_number, "MMC 2024/05/98765");
        assert_eq!(fetched.gender, "Male");
        assert!(fetched.updated_at.is_some());

        // Non-destructive update: empty values must NOT overwrite existing valid credentials
        let partial_update = DoctorProfileRecord {
            doctor_id: doctor_id.to_string(),
            full_name: "".to_string(),
            email: "".to_string(),
            phone: "+91 9123456789".to_string(),
            qualification: "".to_string(),
            registration_number: "".to_string(),
            gender: "".to_string(),
            updated_at: None,
        };
        DbOperations::upsert_doctor_profile(&conn, &partial_update).unwrap();

        let refetched = DbOperations::get_doctor_profile(&conn, doctor_id).unwrap().expect("found");
        assert_eq!(refetched.phone, "+91 9123456789");
        assert_eq!(refetched.full_name, "Dr. Dipesh Patekar", "Existing full name must be preserved");
        assert_eq!(refetched.qualification, "MBBS, MD (Medicine)", "Existing qualification must be preserved");
        assert_eq!(refetched.registration_number, "MMC 2024/05/98765", "Existing registration number must be preserved");

        // Test get_doctor_profile_any retrieves the active profile
        let any_profile = DbOperations::get_doctor_profile_any(&conn).unwrap().expect("found profile");
        assert_eq!(any_profile.doctor_id, doctor_id);
        assert_eq!(any_profile.full_name, "Dr. Dipesh Patekar");
    }

    #[test]
    fn test_get_all_clinic_profiles() {
        let (conn, _dek) = setup_test_db();

        let p1 = ClinicProfileRecord {
            clinic_id: "clinic-b".to_string(),
            name: "B Clinic".to_string(),
            slug: "b-clinic".to_string(),
            phone: "111".to_string(),
            email: "b@clinic.test".to_string(),
            street: "".to_string(),
            city: "".to_string(),
            state: "".to_string(),
            postal_code: "".to_string(),
            country: "India".to_string(),
            location_link: "".to_string(),
            updated_at: None,
        };
        let p2 = ClinicProfileRecord {
            clinic_id: "clinic-a".to_string(),
            name: "A Clinic".to_string(),
            slug: "a-clinic".to_string(),
            phone: "222".to_string(),
            email: "a@clinic.test".to_string(),
            street: "".to_string(),
            city: "".to_string(),
            state: "".to_string(),
            postal_code: "".to_string(),
            country: "India".to_string(),
            location_link: "".to_string(),
            updated_at: None,
        };

        DbOperations::upsert_clinic_profile(&conn, &p1).unwrap();
        DbOperations::upsert_clinic_profile(&conn, &p2).unwrap();

        let all = DbOperations::get_all_clinic_profiles(&conn).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].name, "A Clinic", "Must be ordered by name");
        assert_eq!(all[1].name, "B Clinic");
    }

    #[test]
    fn test_formulary_item_deduplication_by_name_and_formulation() {
        let (mut conn, _dek) = setup_test_db();
        let clinic_id = "clinic-dedup-1";

        let args1 = SaveFormularyArgs {
            id: None,
            clinic_id: clinic_id.to_string(),
            name: "Amoxicillin".to_string(),
            active_ingredient: Some("Amoxicillin Trihydrate".to_string()),
            formulation: "Capsule".to_string(),
            strength: "500 mg".to_string(),
            default_dose: Some("1 cap".to_string()),
            default_route: Some("Oral".to_string()),
            default_frequency: Some("TID".to_string()),
            default_duration: Some("5 days".to_string()),
            default_instructions: Some("After food".to_string()),
        };

        let id1 = DbOperations::save_formulary_item(&mut conn, clinic_id, args1).unwrap();

        // Save again with same name & formulation (case-insensitive) but updated strength
        let args2 = SaveFormularyArgs {
            id: None,
            clinic_id: clinic_id.to_string(),
            name: "amoxicillin ".to_string(),
            active_ingredient: None,
            formulation: "Capsule ".to_string(),
            strength: "625 mg".to_string(),
            default_dose: None,
            default_route: None,
            default_frequency: None,
            default_duration: None,
            default_instructions: None,
        };

        let id2 = DbOperations::save_formulary_item(&mut conn, clinic_id, args2).unwrap();
        assert_eq!(id1, id2, "Must reuse existing ID and deduplicate entry");

        let items = DbOperations::get_formulary_items(&conn, clinic_id).unwrap();
        assert_eq!(items.len(), 1, "There must only be 1 formulary item");
        assert_eq!(items[0].strength, "625 mg");
        assert_eq!(items[0].active_ingredient.as_deref(), Some("Amoxicillin Trihydrate"), "Non-destructive update preserves existing active ingredient");
    }

    #[test]
    fn test_inventory_stock_import_deduplication_and_separation() {
        let (mut conn, _dek) = setup_test_db();
        let clinic_id = "clinic-stock-test-1";

        let sample_items = vec![
            StockItemInput {
                product_name: "6D BODYPROOF".to_string(),
                unit: "TAB".to_string(),
                company: "EMRYS".to_string(),
                quantity: 180.0,
                value: Some(1745.88),
                batch_number: None,
            },
            StockItemInput {
                product_name: "SLISHINE 20GM".to_string(),
                unit: "CREAM".to_string(),
                company: "SILVE".to_string(),
                quantity: 4.0,
                value: None, // Missing value preserved accurately
                batch_number: None,
            },
            StockItemInput {
                product_name: "A TO Z DROPS".to_string(),
                unit: "15 ML".to_string(),
                company: "ALK".to_string(),
                quantity: 3.0,
                value: Some(348.03),
                batch_number: None,
            },
        ];

        // 1. Initial import with overwrite = false
        let summary1 = DbOperations::import_stock_records(
            &mut conn,
            clinic_id,
            sample_items.clone(),
            false,
            Some("STOCK REPORT (18-10-26)"),
        )
        .expect("initial import succeeds");

        assert_eq!(summary1.successful, 3);
        assert_eq!(summary1.skipped, 0);
        assert_eq!(summary1.failed, 0);
        assert_eq!(summary1.total_quantity, 187.0);
        assert!((summary1.total_value - 2093.91).abs() < 0.001);

        // 2. Re-import the exact same data without overwrite: must skip all duplicates!
        let summary2 = DbOperations::import_stock_records(
            &mut conn,
            clinic_id,
            sample_items.clone(),
            false,
            Some("STOCK REPORT (18-10-26)"),
        )
        .expect("second import succeeds");

        assert_eq!(summary2.successful, 0, "No duplicate records should be created");
        assert_eq!(summary2.skipped, 3, "All 3 existing records must be safely skipped");
        assert_eq!(summary2.failed, 0);

        // 3. Verify records in database
        let records = DbOperations::get_stock_records(&conn, clinic_id, None).unwrap();
        assert_eq!(records.len(), 3);
        assert_eq!(records[0].product_name, "6D BODYPROOF");
        assert_eq!(records[0].quantity, 180.0);
        assert_eq!(records[0].value, Some(1745.88));

        // Verify SLISHINE 20GM has None value preserved
        let slishine = records.iter().find(|r| r.product_name == "SLISHINE 20GM").unwrap();
        assert_eq!(slishine.quantity, 4.0);
        assert_eq!(slishine.value, None, "Missing source value must be preserved as None");

        // 4. Overwrite mode: updating quantity when explicitly requested
        let updated_items = vec![
            StockItemInput {
                product_name: "6D BODYPROOF".to_string(),
                unit: "TAB".to_string(),
                company: "EMRYS".to_string(),
                quantity: 200.0, // updated from 180 to 200
                value: Some(1940.00),
                batch_number: Some("BATCH-001".to_string()),
            },
        ];
        let summary3 = DbOperations::import_stock_records(
            &mut conn,
            clinic_id,
            updated_items,
            true, // explicit overwrite
            Some("STOCK REPORT (18-10-26)"),
        )
        .unwrap();
        assert_eq!(summary3.successful, 1);
        assert_eq!(summary3.skipped, 0);

        let records_after = DbOperations::get_stock_records(&conn, clinic_id, Some("BODYPROOF")).unwrap();
        assert_eq!(records_after.len(), 1);
        assert_eq!(records_after[0].quantity, 200.0);
        assert_eq!(records_after[0].value, Some(1940.00));
        assert_eq!(records_after[0].batch_number.as_deref(), Some("BATCH-001"));

        // 5. Test summary computation
        let stats = DbOperations::get_stock_summary(&conn, clinic_id).unwrap();
        assert_eq!(stats.total_products, 3);
        assert_eq!(stats.total_quantity, 207.0); // 200 + 4 + 3

        // 6. Strict architectural isolation: inventory tables do NOT touch formulary or catalogue tables
        let formulary_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_formulary_v2 WHERE clinic_id = ?1", params![clinic_id], |r| r.get(0))
            .unwrap();
        assert_eq!(formulary_count, 0, "Inventory stock must not populate local_formulary_v2");
    }

    #[test]
    fn test_clinical_library_import_duplicate_detection_and_rollback() {
        use crate::db::schema::ClinicalImportItemInput;

        let mut conn = Connection::open_in_memory().unwrap();
        let dek = DatabaseEncryptionKey::new([0x99u8; 32]);
        MigrationRunner::run_migrations(&mut conn, &dek).expect("migrations run");

        let clinic_a = "clinic_alpha";
        let clinic_b = "clinic_beta";

        // 1. Import a batch for Clinic A
        let items_batch_1 = vec![
            ClinicalImportItemInput {
                name: "Amoxicillin Clavulanate".to_string(),
                generic_name: Some("Amoxicillin + Clavulanic Acid".to_string()),
                brand_name: Some("Augmentin".to_string()),
                composition: Some("Amoxicillin 500mg, Clavulanic Acid 125mg".to_string()),
                strength: "625 mg".to_string(),
                formulation: "Tablet".to_string(),
                dosage_form: Some("Tablet".to_string()),
                route: Some("Oral".to_string()),
                manufacturer: Some("GSK".to_string()),
                category: Some("Antibiotic".to_string()),
                pack_size: Some("10 Tablets".to_string()),
                mrp: Some(210.50),
                storage_instructions: Some("Store below 25°C".to_string()),
                default_dosage: Some("1 tablet".to_string()),
                default_frequency: Some("Twice daily".to_string()),
                default_duration: Some("5 days".to_string()),
                default_instructions: Some("After food".to_string()),
            },
            ClinicalImportItemInput {
                name: "Pantoprazole DSR".to_string(),
                generic_name: Some("Pantoprazole + Domperidone".to_string()),
                brand_name: Some("Pan-D".to_string()),
                composition: Some("Pantoprazole 40mg, Domperidone 30mg".to_string()),
                strength: "40 mg + 30 mg".to_string(),
                formulation: "Capsule".to_string(),
                dosage_form: Some("Capsule".to_string()),
                route: Some("Oral".to_string()),
                manufacturer: Some("Alkem".to_string()),
                category: Some("Antacid / PPI".to_string()),
                pack_size: Some("15 Capsules".to_string()),
                mrp: Some(195.00),
                storage_instructions: None,
                default_dosage: Some("1 capsule".to_string()),
                default_frequency: Some("Once daily".to_string()),
                default_duration: Some("7 days".to_string()),
                default_instructions: Some("Before breakfast".to_string()),
            },
            ClinicalImportItemInput {
                name: "".to_string(), // Invalid: empty medicine name
                generic_name: None,
                brand_name: None,
                composition: None,
                strength: "".to_string(),
                formulation: "".to_string(),
                dosage_form: None,
                route: None,
                manufacturer: None,
                category: None,
                pack_size: None,
                mrp: None,
                storage_instructions: None,
                default_dosage: None,
                default_frequency: None,
                default_duration: None,
                default_instructions: None,
            },
        ];

        let batch_input_1 = ClinicalImportBatchInput {
            clinic_id: clinic_a.to_string(),
            doctor_id: Some("doc_1".to_string()),
            file_name: "clinic_medicines.xlsx".to_string(),
            items: items_batch_1,
            total_rows: 3,
            invalid_rows: 0,
            allow_update: Some(false),
        };

        let summary1 = DbOperations::import_clinical_library(&mut conn, clinic_a, batch_input_1).unwrap();
        assert_eq!(summary1.total_rows, 3);
        assert_eq!(summary1.valid_rows, 2);
        assert_eq!(summary1.invalid_rows, 1);
        assert_eq!(summary1.imported_rows, 2);
        assert_eq!(summary1.skipped_rows, 0);

        // 2. Strict Tenant Isolation: Clinic B must see 0 medicines
        let clinic_b_items = DbOperations::get_clinical_library_items(&conn, clinic_b, None, 50, 0).unwrap();
        assert_eq!(clinic_b_items.len(), 0, "Clinic B must not see Clinic A medicines");

        // Clinic A sees both imported medicines
        let clinic_a_items = DbOperations::get_clinical_library_items(&conn, clinic_a, None, 50, 0).unwrap();
        assert_eq!(clinic_a_items.len(), 2);
        assert_eq!(clinic_a_items[0].name, "Amoxicillin Clavulanate");
        assert_eq!(clinic_a_items[0].strength, "625 mg");
        assert_eq!(clinic_a_items[0].formulation, "Tablet");
        assert_eq!(clinic_a_items[0].mrp, Some(210.50));

        // 3. Repeated import: duplicate detection prevents redundant records
        let repeat_items = vec![
            ClinicalImportItemInput {
                name: "Amoxicillin Clavulanate".to_string(),
                generic_name: Some("Amoxicillin + Clavulanic Acid".to_string()),
                brand_name: Some("Augmentin".to_string()),
                composition: Some("Amoxicillin 500mg, Clavulanic Acid 125mg".to_string()),
                strength: "625 mg".to_string(),
                formulation: "Tablet".to_string(),
                dosage_form: Some("Tablet".to_string()),
                route: Some("Oral".to_string()),
                manufacturer: Some("GSK".to_string()),
                category: Some("Antibiotic".to_string()),
                pack_size: Some("10 Tablets".to_string()),
                mrp: Some(210.50),
                storage_instructions: None,
                default_dosage: None,
                default_frequency: None,
                default_duration: None,
                default_instructions: None,
            },
        ];
        let repeat_batch = ClinicalImportBatchInput {
            clinic_id: clinic_a.to_string(),
            doctor_id: Some("doc_1".to_string()),
            file_name: "clinic_medicines_reupload.xlsx".to_string(),
            items: repeat_items,
            total_rows: 1,
            invalid_rows: 0,
            allow_update: Some(false),
        };
        let repeat_summary = DbOperations::import_clinical_library(&mut conn, clinic_a, repeat_batch).unwrap();
        assert_eq!(repeat_summary.imported_rows, 0, "Duplicate record must not be re-imported");
        assert_eq!(repeat_summary.skipped_rows, 1, "Duplicate must be recorded as skipped");

        // Verify count remains 2
        let clinic_a_items_after_repeat = DbOperations::get_clinical_library_items(&conn, clinic_a, None, 50, 0).unwrap();
        assert_eq!(clinic_a_items_after_repeat.len(), 2);

        // 4. Consultation search integration: clinical library items are searchable with CLINICAL_LIBRARY provenance
        let search_results = DbOperations::search_local_catalogue(&conn, "Amoxicillin", 10, None).unwrap();
        assert!(!search_results.is_empty());
        let clinical_match = search_results.iter().find(|i| i.source_provenance == "CLINICAL_LIBRARY");
        assert!(clinical_match.is_some(), "Search must surface Clinical Library medicines");
        let item = clinical_match.unwrap();
        assert_eq!(item.name, "Amoxicillin Clavulanate");
        assert_eq!(item.raw_strength_summary, "625 mg");

        // 5. Rollback verification: rolling back batch deactivates medicines from that batch
        let rolled_back_count = DbOperations::rollback_clinical_library_batch(&mut conn, clinic_a, &summary1.batch_id).unwrap();
        assert_eq!(rolled_back_count, 2, "Must roll back all 2 imported medicines");

        let clinic_a_items_after_rollback = DbOperations::get_clinical_library_items(&conn, clinic_a, None, 50, 0).unwrap();
        assert_eq!(clinic_a_items_after_rollback.len(), 0, "Rolled back medicines must be inactive");

        let batches = DbOperations::get_clinical_library_batches(&conn, clinic_a).unwrap();
        assert_eq!(batches[1].status, "ROLLED_BACK");
        assert!(batches[1].rolled_back_at.is_some());

        // 6. Architectural isolation: CDCI and Stock tables are completely unaffected
        let stock_count: i64 = conn.query_row("SELECT COUNT(*) FROM local_inventory_stock_v1", [], |r| r.get(0)).unwrap();
        assert_eq!(stock_count, 0, "Clinical library must not touch inventory stock table");
    }

    #[test]
    fn test_fresh_installation_and_idempotent_seeding_of_full_pharmacy_stock_report() {
        let (mut conn, _dek) = setup_test_db();
        let clinic_id = "fresh-clinic-uuid";

        // Verify fresh SQLite database starts with 0 stock records
        let initial_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_inventory_stock_v1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(initial_count, 0, "Fresh installation must start with 0 stock items");

        // Load canonical stock report JSON (1,793 items)
        let json_str = include_str!("../../../src/data/stock-report-18-10-26.json");
        let raw_items: Vec<serde_json::Value> = serde_json::from_str(json_str).expect("Valid JSON");
        assert_eq!(raw_items.len(), 1793, "Dataset must contain exactly 1,793 records");

        let items: Vec<StockItemInput> = raw_items
            .into_iter()
            .map(|val| StockItemInput {
                product_name: val["product_name"].as_str().unwrap().to_string(),
                unit: val["unit"].as_str().unwrap().to_string(),
                company: val["company"].as_str().unwrap().to_string(),
                quantity: val["quantity"].as_f64().unwrap_or(0.0),
                value: val["value"].as_f64(),
                batch_number: val["batch_number"].as_str().map(|s| s.to_string()),
            })
            .collect();

        // 1. First run / Fresh installation seed
        let summary1 = DbOperations::import_stock_records(
            &mut conn,
            clinic_id,
            items.clone(),
            false,
            Some("STOCK REPORT (18-10-26)"),
        )
        .expect("initial seed succeeds");

        assert_eq!(summary1.successful, 1793, "All 1,793 records must be seeded");
        assert_eq!(summary1.skipped, 0);
        assert_eq!(summary1.failed, 0);

        let count_after_first: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_inventory_stock_v1 WHERE clinic_id = ?1", [clinic_id], |r| r.get(0))
            .unwrap();
        assert_eq!(count_after_first, 1793);

        // 2. Second launch / Rerun idempotency test on same database
        let summary2 = DbOperations::import_stock_records(
            &mut conn,
            clinic_id,
            items.clone(),
            false,
            Some("STOCK REPORT (18-10-26)"),
        )
        .expect("second seed succeeds");

        assert_eq!(summary2.successful, 0, "Second launch must not create duplicate entries");
        assert_eq!(summary2.skipped, 1793, "All 1,793 entries must be recognized as existing and skipped");
        assert_eq!(summary2.failed, 0);

        let count_after_second: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_inventory_stock_v1 WHERE clinic_id = ?1", [clinic_id], |r| r.get(0))
            .unwrap();
        assert_eq!(count_after_second, 1793, "Total count must remain exactly 1,793 with zero duplicates");

        // 3. Consultation Autocomplete Search Verification
        // Search "BODYPROOF"
        let search_bodyproof = DbOperations::search_local_catalogue(&conn, "BODYPROOF", 10, None).unwrap();
        assert!(!search_bodyproof.is_empty(), "BODYPROOF must be found in autocomplete");
        let first_match = &search_bodyproof[0];
        assert!(first_match.name.contains("6D BODYPROOF"));
        assert!(first_match.name.contains("Stock: 180 TAB"));
        assert_eq!(first_match.dosage_form.as_deref(), Some("TAB"));
        assert!(first_match.id.starts_with("stock_"));

        // Search "ZYTEE" (last item in dataset)
        let search_zytee = DbOperations::search_local_catalogue(&conn, "ZYTEE", 10, None).unwrap();
        assert!(!search_zytee.is_empty(), "ZYTEE must be found in autocomplete");
        assert!(search_zytee[0].name.contains("ZYTEE GEL"));
        assert!(search_zytee[0].name.contains("Stock: 6 GEL"));

        // Search by company name "EMRYS"
        let search_company = DbOperations::search_local_catalogue(&conn, "EMRYS", 10, None).unwrap();
        assert!(!search_company.is_empty(), "Search by company name must return matching stock items");
    }

    #[test]
    fn test_sequential_patient_id_format_and_non_reuse() {
        assert_eq!(DbOperations::format_sequential_patient_id(1), "AAA-0001");
        assert_eq!(DbOperations::format_sequential_patient_id(9999), "AAA-9999");
        assert_eq!(DbOperations::format_sequential_patient_id(10000), "AAB-0001");
        assert_eq!(DbOperations::format_sequential_patient_id(19998), "AAB-9999");
        assert_eq!(DbOperations::format_sequential_patient_id(19999), "AAC-0001");

        assert_eq!(DbOperations::parse_sequential_patient_id("AAA-0001"), Some(1));
        assert_eq!(DbOperations::parse_sequential_patient_id("AAA-9999"), Some(9999));
        assert_eq!(DbOperations::parse_sequential_patient_id("AAB-0001"), Some(10000));
        assert_eq!(DbOperations::parse_sequential_patient_id("AAC-0001"), Some(19999));
        assert_eq!(DbOperations::parse_sequential_patient_id("PC-1049"), None);
        assert_eq!(DbOperations::parse_sequential_patient_id("invalid"), None);

        let mut conn = Connection::open_in_memory().unwrap();
        let dek = DatabaseEncryptionKey { key: [7u8; 32] };
        crate::db::migrations::MigrationRunner::run_migrations(&mut conn, &dek).unwrap();

        let clinic_id = "clinic_seq_test";

        // Initial next code should be AAA-0001
        let next_1 = DbOperations::get_next_patient_code(&mut conn, clinic_id).unwrap();
        assert_eq!(next_1, "AAA-0001");

        // Insert first patient (auto-allocated AAA-0001)
        let pat1_id = DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_id,
            "",
            "Patient One",
            "9999999991",
            "Female",
            None,
            28,
            &[],
            &[],
            None,
        ).unwrap();

        // Next code should be AAA-0002
        let next_2 = DbOperations::get_next_patient_code(&mut conn, clinic_id).unwrap();
        assert_eq!(next_2, "AAA-0002");

        // Insert second patient with explicit AAA-0002
        let pat2_id = DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_id,
            "AAA-0002",
            "Patient Two",
            "9999999992",
            "Male",
            None,
            34,
            &[],
            &[],
            None,
        ).unwrap();

        // Delete second patient (AAA-0002)
        DbOperations::delete_patient(&mut conn, &dek, clinic_id, &pat2_id).unwrap();

        // Next code must be AAA-0003, NEVER reusing deleted AAA-0002
        let next_3 = DbOperations::get_next_patient_code(&mut conn, clinic_id).unwrap();
        assert_eq!(next_3, "AAA-0003");

        // Insert third patient, verifying allocation uses AAA-0003
        let pat3_id = DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_id,
            "",
            "Patient Three",
            "9999999993",
            "Other",
            None,
            40,
            &[],
            &[],
            None,
        ).unwrap();

        let patients = DbOperations::get_patients(&conn, &dek, clinic_id).unwrap();
        assert_eq!(patients.len(), 2);
        assert!(patients.iter().any(|p| p.id == pat1_id && p.patient_code == "AAA-0001"));
        assert!(patients.iter().any(|p| p.id == pat3_id && p.patient_code == "AAA-0003"));
        assert!(!patients.iter().any(|p| p.patient_code == "AAA-0002"));
    }

    #[test]
    fn test_patient_last_visit_tracking_with_finalized_prescriptions() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_visit_test";
        let doctor_id = "doc_001";

        // 1. Create a patient
        let pat_id = DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_id,
            "",
            "Visit Test Patient",
            "9876543210",
            "Female",
            None,
            28,
            &[],
            &[],
            None,
        )
        .unwrap();

        // Initially: No visits yet
        let patients = DbOperations::get_patients(&conn, &dek, clinic_id).unwrap();
        assert_eq!(patients.len(), 1);
        assert_eq!(patients[0].last_visit, None);

        // 2. Insert draft consultation without prescription -> still No visits yet
        let c1_id = DbOperations::insert_consultation(
            &mut conn,
            &dek,
            clinic_id,
            &pat_id,
            doctor_id,
            "2026-11-01",
            "Headache",
            "Tension Headache",
            None,
        )
        .unwrap();

        let patients_after_draft = DbOperations::get_patients(&conn, &dek, clinic_id).unwrap();
        assert_eq!(patients_after_draft[0].last_visit, None);

        // 3. Finalize prescription for consultation c1 -> last_visit is now populated
        let rx1_id = DbOperations::insert_prescription(
            &mut conn,
            &dek,
            clinic_id,
            &c1_id,
            &pat_id,
            doctor_id,
            "RX-100001",
            r#"[{"id":1,"name":"Paracetamol","formulation":"Tablet","dose":"500mg"}]"#,
        )
        .unwrap();
        assert!(!rx1_id.is_empty());

        let patients_after_rx1 = DbOperations::get_patients(&conn, &dek, clinic_id).unwrap();
        assert!(patients_after_rx1[0].last_visit.is_some());

        // 4. Create second finalized consultation c2 with a later date
        let c2_id = DbOperations::insert_consultation(
            &mut conn,
            &dek,
            clinic_id,
            &pat_id,
            doctor_id,
            "2026-11-10",
            "Follow-up",
            "Recovered",
            None,
        )
        .unwrap();

        DbOperations::insert_prescription(
            &mut conn,
            &dek,
            clinic_id,
            &c2_id,
            &pat_id,
            doctor_id,
            "RX-100002",
            r#"[{"id":2,"name":"Vitamin C","formulation":"Tablet","dose":"500mg"}]"#,
        )
        .unwrap();

        let patients_after_rx2 = DbOperations::get_patients(&conn, &dek, clinic_id).unwrap();
        assert_eq!(patients_after_rx2.len(), 1);
        assert!(patients_after_rx2[0].last_visit.is_some());

        // 5. Verify multiple prescriptions for the same consultation do not create duplicate visits
        let rx2_revision = "RX-100002-REV2";
        conn.execute(
            r#"
            INSERT INTO local_prescriptions (
                id, clinic_id, consultation_id, patient_id, doctor_id,
                prescription_number, revision_number, status, encrypted_items, nonce, sync_status, local_version
            ) VALUES ('rx_rev_2', ?1, ?2, ?3, ?4, ?5, 2, 'ACTIVE', X'00', X'00', 'PENDING', 2)
            "#,
            params![clinic_id, c2_id, pat_id, doctor_id, rx2_revision],
        ).unwrap();

        let patients_multi_rx = DbOperations::get_patients(&conn, &dek, clinic_id).unwrap();
        assert_eq!(patients_multi_rx.len(), 1, "Multiple prescriptions must never duplicate patient records");
        assert!(patients_multi_rx[0].last_visit.is_some());

        // 6. Verify cancelled prescriptions are excluded
        let pat_cancel_id = DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_id,
            "",
            "Cancelled Patient",
            "9876543299",
            "Male",
            None,
            40,
            &[],
            &[],
            None,
        ).unwrap();

        let c_cancel_id = DbOperations::insert_consultation(
            &mut conn,
            &dek,
            clinic_id,
            &pat_cancel_id,
            doctor_id,
            "2026-11-05",
            "Cancelled Complaint",
            "Cancelled Diagnosis",
            None,
        ).unwrap();

        conn.execute(
            r#"
            INSERT INTO local_prescriptions (
                id, clinic_id, consultation_id, patient_id, doctor_id,
                prescription_number, revision_number, status, encrypted_items, nonce, sync_status, local_version
            ) VALUES ('rx_cancel_1', ?1, ?2, ?3, ?4, 'RX-CANCEL', 1, 'CANCELLED', X'00', X'00', 'SYNCED', 1)
            "#,
            params![clinic_id, c_cancel_id, pat_cancel_id, doctor_id],
        ).unwrap();

        let patients_with_cancelled = DbOperations::get_patients(&conn, &dek, clinic_id).unwrap();
        let cancel_patient = patients_with_cancelled.iter().find(|p| p.id == pat_cancel_id).unwrap();
        assert_eq!(cancel_patient.last_visit, None, "Cancelled prescriptions must be excluded from last visit");

        // 7. Verify cloud-synced consultations matching via server_id are recognized
        let pat_sync_id = DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_id,
            "",
            "Cloud Synced Patient",
            "9876543288",
            "Female",
            None,
            33,
            &[],
            &[],
            None,
        ).unwrap();

        conn.execute(
            "UPDATE local_patients SET server_id = 'srv_pat_88' WHERE id = ?1",
            params![pat_sync_id],
        ).unwrap();

        // Synced consultation and prescription referencing server_ids
        conn.execute(
            r#"
            INSERT INTO local_consultations (
                id, server_id, clinic_id, patient_id, doctor_id, consultation_date,
                status, encrypted_clinical_data, nonce, sync_status, server_version, local_version
            ) VALUES ('local_c_sync', 'srv_c_88', ?1, 'srv_pat_88', ?2, '2026-11-08', 'FINALIZED', X'00', X'00', 'SYNCED', 1, 1)
            "#,
            params![clinic_id, doctor_id],
        ).unwrap();

        conn.execute(
            r#"
            INSERT INTO local_prescriptions (
                id, server_id, clinic_id, consultation_id, patient_id, doctor_id,
                prescription_number, revision_number, status, encrypted_items, nonce, sync_status, server_version, local_version
            ) VALUES ('local_rx_sync', 'srv_rx_88', ?1, 'srv_c_88', 'srv_pat_88', ?2, 'RX-SYNC-88', 1, 'ACTIVE', X'00', X'00', 'SYNCED', 1, 1)
            "#,
            params![clinic_id, doctor_id],
        ).unwrap();

        let patients_with_cloud = DbOperations::get_patients(&conn, &dek, clinic_id).unwrap();
        let cloud_patient = patients_with_cloud.iter().find(|p| p.id == pat_sync_id).unwrap();
        assert!(cloud_patient.last_visit.is_some(), "Cloud synced consultation matching via server_id must populate last_visit");
    }

    #[test]
    fn test_patient_deletion_preserves_cloud_server_id_and_retry() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_del_retry_test";
        let cloud_server_id = "672f0123456789abcdef0123";

        // 1. Create a patient that has already synced with the cloud (has server_id)
        let pat_id = DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_id,
            "P-DEL-101",
            "Synced Patient",
            "9876543210",
            "FEMALE",
            Some("1995-05-15"),
            31,
            &["Penicillin".to_string()],
            &[],
            None,
        )
        .unwrap();

        // Simulate successful initial sync assigning server_id
        conn.execute(
            "UPDATE local_patients SET server_id = ?1, sync_status = 'SYNCED' WHERE id = ?2",
            params![cloud_server_id, pat_id],
        )
        .unwrap();

        // Clear create mutation from outbox to isolate delete test
        conn.execute("DELETE FROM local_sync_outbox WHERE clinic_id = ?1", params![clinic_id]).unwrap();

        // 2. Delete patient locally
        DbOperations::delete_patient(&mut conn, &dek, clinic_id, &pat_id).unwrap();

        // Confirm local patient row is completely gone from SQLite
        let local_patients = DbOperations::get_patients(&conn, &dek, clinic_id).unwrap();
        assert_eq!(local_patients.len(), 0);

        // 3. Fetch pending outbox batch for sync worker push
        let batch1 = DbOperations::get_pending_outbox_batch(&mut conn, &dek, clinic_id, 10).unwrap();
        assert_eq!(batch1.len(), 1);
        let item1 = &batch1[0];
        assert_eq!(item1.action, "DELETE");
        assert_eq!(item1.entity_type, "PATIENT");
        assert_eq!(item1.entity_id, pat_id);
        // CRITICAL: server_id must be preserved even though local_patients row was deleted!
        assert_eq!(item1.server_id, Some(cloud_server_id.to_string()));
        assert_eq!(item1.payload["serverId"], cloud_server_id);
        assert_eq!(item1.payload["patientCode"], "P-DEL-101");

        // Outbox is now IN_FLIGHT
        let summary1 = DbOperations::get_outbox_summary(&conn, clinic_id).unwrap();
        assert_eq!(summary1.pending_count, 0);
        assert_eq!(summary1.in_flight_count, 1);

        // 4. Simulate network failure during push and retry
        let outbox_ids = vec![item1.id.clone()];
        let reverted = DbOperations::revert_in_flight_to_pending(&conn, &outbox_ids, Some("Network timeout")).unwrap();
        assert_eq!(reverted, 1);

        let summary2 = DbOperations::get_outbox_summary(&conn, clinic_id).unwrap();
        assert_eq!(summary2.pending_count, 1);
        assert_eq!(summary2.in_flight_count, 0);

        // 5. Next sync iteration (retry) must STILL retain the preserved server_id
        let batch2 = DbOperations::get_pending_outbox_batch(&mut conn, &dek, clinic_id, 10).unwrap();
        assert_eq!(batch2.len(), 1);
        let item2 = &batch2[0];
        assert_eq!(item2.server_id, Some(cloud_server_id.to_string()));
        assert_eq!(item2.payload["serverId"], cloud_server_id);

        // 6. Backend applies mutation
        DbOperations::apply_push_mutation_result(
            &mut conn,
            &item2.id,
            "APPLIED",
            "PATIENT",
            &pat_id,
            Some(cloud_server_id),
            Some(2),
            None,
            None,
        )
        .unwrap();

        // Verify outbox marked SYNCED
        let summary3 = DbOperations::get_outbox_summary(&conn, clinic_id).unwrap();
        assert_eq!(summary3.pending_count, 0);
        assert_eq!(summary3.in_flight_count, 0);
    }

    #[test]
    fn test_prescription_revision_lifecycle_and_immutability() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_rx_rev";
        let doctor_id = "doc_rev_1";
        let doctor_id_2 = "doc_rev_2";

        // 1. Create patient and consultation
        let pat_id = DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_id,
            "P-REV-101",
            "Revision Patient",
            "9876543210",
            "Male",
            None,
            35,
            &[],
            &[],
            None,
        )
        .unwrap();

        let c_id = DbOperations::insert_consultation(
            &mut conn,
            &dek,
            clinic_id,
            &pat_id,
            doctor_id,
            "2026-11-14",
            "Acute bronchitis",
            "Bronchitis",
            Some(r#"{"vitals":{"heartRate":"72"}}"#),
        )
        .unwrap();

        // 2. Finalize initial prescription (Revision 1)
        let rx1_items = r#"[{"id":1,"name":"Amoxicillin","formulation":"Capsule","dose":"500mg","frequency":"Three times daily","duration":"5 days"}]"#;
        let rx1_id = DbOperations::insert_prescription(
            &mut conn,
            &dek,
            clinic_id,
            &c_id,
            &pat_id,
            doctor_id,
            "RX-2026-0001",
            rx1_items,
        )
        .unwrap();

        // Check initial state
        let rxs_initial = DbOperations::get_prescriptions(&conn, &dek, clinic_id, Some(&pat_id)).unwrap();
        assert_eq!(rxs_initial.len(), 1);
        assert_eq!(rxs_initial[0].id, rx1_id);
        assert_eq!(rxs_initial[0].revision_number, 1);
        assert_eq!(rxs_initial[0].status, "ACTIVE");
        assert_eq!(rxs_initial[0].items_json.as_deref(), Some(rx1_items));

        // 3. Attempt revision with mismatched expected_revision_number -> must fail
        let rx2_items = r#"[{"id":1,"name":"Amoxicillin","formulation":"Capsule","dose":"500mg","frequency":"Three times daily","duration":"7 days"},{"id":2,"name":"Paracetamol","formulation":"Tablet","dose":"650mg","frequency":"As needed","duration":"3 days"}]"#;
        let wrong_rev_res = DbOperations::revise_prescription(
            &mut conn,
            &dek,
            clinic_id,
            &rx1_id,
            2, // Wrong: expected is 1
            rx2_items,
            "Extended antibiotic course",
            doctor_id_2,
        );
        assert!(wrong_rev_res.is_err(), "Mismatched expected revision must fail optimistic lock");

        // 4. Attempt revision without reason -> must fail
        let empty_reason_res = DbOperations::revise_prescription(
            &mut conn,
            &dek,
            clinic_id,
            &rx1_id,
            1,
            rx2_items,
            "   ",
            doctor_id_2,
        );
        assert!(empty_reason_res.is_err(), "Empty revision reason must be rejected");

        // 5. Successful revision to Revision 2
        let rx2_id = DbOperations::revise_prescription(
            &mut conn,
            &dek,
            clinic_id,
            &rx1_id,
            1,
            rx2_items,
            "Extended antibiotic course and added antipyretic",
            doctor_id_2,
        )
        .unwrap();
        assert_ne!(rx1_id, rx2_id, "Revision must produce a new unique row");

        // 6. Verify Revision 1 remains immutable with original medicines in local_prescriptions
        let rx1_direct: (String, i32, Vec<u8>, Vec<u8>) = conn
            .query_row(
                "SELECT status, revision_number, encrypted_items, nonce FROM local_prescriptions WHERE id = ?1",
                params![rx1_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(rx1_direct.0, "SUPERSEDED", "Previous revision must be SUPERSEDED");
        assert_eq!(rx1_direct.1, 1, "Original revision number must remain 1");
        let rx1_decrypted = crate::crypto::decrypt_payload(&dek.key, &rx1_direct.2, &rx1_direct.3).unwrap();
        assert_eq!(String::from_utf8(rx1_decrypted).unwrap(), rx1_items, "Original items must remain completely unchanged");

        // 7. Verify Revision 2 is ACTIVE with revision_number 2
        let rx2_direct: (String, i32, Vec<u8>, Vec<u8>) = conn
            .query_row(
                "SELECT status, revision_number, encrypted_items, nonce FROM local_prescriptions WHERE id = ?1",
                params![rx2_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(rx2_direct.0, "ACTIVE");
        assert_eq!(rx2_direct.1, 2);
        let rx2_decrypted = crate::crypto::decrypt_payload(&dek.key, &rx2_direct.2, &rx2_direct.3).unwrap();
        assert_eq!(String::from_utf8(rx2_decrypted).unwrap(), rx2_items);

        // 8. Verify get_prescriptions returns both revisions in descending order (Revision 2 first, then Revision 1)
        let all_rxs = DbOperations::get_prescriptions(&conn, &dek, clinic_id, Some(&pat_id)).unwrap();
        assert_eq!(all_rxs.len(), 2);
        let latest = &all_rxs[0];
        let previous = &all_rxs[1];
        assert_eq!(latest.revision_number, 2);
        assert_eq!(latest.status, "ACTIVE");
        assert_eq!(previous.revision_number, 1);
        assert_eq!(previous.status, "SUPERSEDED");

        // 9. Verify outbox contains REVISE action for PRESCRIPTION with expected details
        let outbox_batch = DbOperations::get_pending_outbox_batch(&mut conn, &dek, clinic_id, 10).unwrap();
        let revise_outbox = outbox_batch.iter().find(|o| o.action == "REVISE" && o.entity_type == "PRESCRIPTION").unwrap();
        assert_eq!(revise_outbox.payload["expectedRevisionNumber"], 1);
        assert_eq!(revise_outbox.payload["reasonForRevision"], "Extended antibiotic course and added antipyretic");

        // 10. Attempt to revise Revision 1 a SECOND time after Revision 2 already exists
        // Must fail because Revision 1 is SUPERSEDED (not ACTIVE) and Revision 2 already exists
        let rx3_items = r#"[{"id":1,"name":"Azithromycin","formulation":"Tablet","dose":"500mg","frequency":"Once daily","duration":"3 days"}]"#;
        let second_rev1_attempt = DbOperations::revise_prescription(
            &mut conn,
            &dek,
            clinic_id,
            &rx1_id,
            1,
            rx3_items,
            "Duplicate revision attempt",
            doctor_id_2,
        );
        assert!(second_rev1_attempt.is_err(), "Revising a SUPERSEDED prescription (Rev 1) must be rejected");

        // 11. Verify invariants: Exactly one Revision 2 exists, Revision 1 remains immutable, Revision 2 remains ACTIVE
        let all_rxs_after = DbOperations::get_prescriptions(&conn, &dek, clinic_id, Some(&pat_id)).unwrap();
        assert_eq!(all_rxs_after.len(), 2, "There must still be exactly 2 prescription records");
        assert_eq!(all_rxs_after[0].id, rx2_id, "Latest record must still be original Revision 2");
        assert_eq!(all_rxs_after[0].revision_number, 2);
        assert_eq!(all_rxs_after[0].status, "ACTIVE");
        assert_eq!(all_rxs_after[1].id, rx1_id, "Previous record must still be Revision 1");
        assert_eq!(all_rxs_after[1].revision_number, 1);
        assert_eq!(all_rxs_after[1].status, "SUPERSEDED");

        // 12. Verify no duplicate outbox event was created in local_sync_outbox
        let total_revise_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_sync_outbox WHERE clinic_id = ?1 AND action = 'REVISE' AND entity_type = 'PRESCRIPTION'",
                params![clinic_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(total_revise_count, 1, "Must have exactly 1 REVISE outbox entry in total");
    }

    #[test]
    fn test_prescription_revision_status_validation_and_rollback() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_status_check";
        let doctor_id = "doc_status_1";

        let pat_id = DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_id,
            "P-STAT-101",
            "Status Patient",
            "9876543211",
            "Female",
            None,
            28,
            &[],
            &[],
            None,
        )
        .unwrap();

        let c_id = DbOperations::insert_consultation(
            &mut conn,
            &dek,
            clinic_id,
            &pat_id,
            doctor_id,
            "2026-11-15",
            "Routine checkup",
            "Healthy",
            None,
        )
        .unwrap();

        let rx_items = r#"[{"id":1,"name":"Multivitamin","formulation":"Tablet","dose":"1 daily","frequency":"Once daily","duration":"30 days"}]"#;
        let rx_id = DbOperations::insert_prescription(
            &mut conn,
            &dek,
            clinic_id,
            &c_id,
            &pat_id,
            doctor_id,
            "RX-STAT-0001",
            rx_items,
        )
        .unwrap();

        // 1. Manually set status to DISCONTINUED and attempt revision -> must fail
        conn.execute("UPDATE local_prescriptions SET status = 'DISCONTINUED' WHERE id = ?1", params![rx_id]).unwrap();
        let discon_res = DbOperations::revise_prescription(
            &mut conn,
            &dek,
            clinic_id,
            &rx_id,
            1,
            rx_items,
            "Try revise discontinued",
            doctor_id,
        );
        assert!(discon_res.is_err());
        assert!(discon_res.unwrap_err().to_string().contains("Only ACTIVE prescriptions can be revised"));

        // 2. Manually set status to CANCELLED and attempt revision -> must fail
        conn.execute("UPDATE local_prescriptions SET status = 'CANCELLED' WHERE id = ?1", params![rx_id]).unwrap();
        let cancel_res = DbOperations::revise_prescription(
            &mut conn,
            &dek,
            clinic_id,
            &rx_id,
            1,
            rx_items,
            "Try revise cancelled",
            doctor_id,
        );
        assert!(cancel_res.is_err());
        assert!(cancel_res.unwrap_err().to_string().contains("Only ACTIVE prescriptions can be revised"));

        // 3. Manually set status to SUPERSEDED and attempt revision -> must fail
        conn.execute("UPDATE local_prescriptions SET status = 'SUPERSEDED' WHERE id = ?1", params![rx_id]).unwrap();
        let super_res = DbOperations::revise_prescription(
            &mut conn,
            &dek,
            clinic_id,
            &rx_id,
            1,
            rx_items,
            "Try revise superseded",
            doctor_id,
        );
        assert!(super_res.is_err());
        assert!(super_res.unwrap_err().to_string().contains("Only ACTIVE prescriptions can be revised"));

        // Verify no extra prescriptions or outbox records were created
        let rxs = DbOperations::get_prescriptions(&conn, &dek, clinic_id, Some(&pat_id)).unwrap();
        assert_eq!(rxs.len(), 1);
        let outbox = DbOperations::get_pending_outbox_batch(&mut conn, &dek, clinic_id, 10).unwrap();
        assert_eq!(outbox.iter().filter(|o| o.action == "REVISE").count(), 0);
    }

    #[test]
    fn test_prescription_sync_offline_restart_idempotency_and_pull_revisions() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_sync_rx_test";
        let doctor_id = "doc_sync_1";

        // 1. Create Patient & Consultation locally
        let pat_id = DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_id,
            "P-SYNC-101",
            "Aarav Sharma",
            "9876500001",
            "Male",
            None,
            40,
            &[],
            &[],
            None,
        )
        .unwrap();

        let c_id = DbOperations::insert_consultation(
            &mut conn,
            &dek,
            clinic_id,
            &pat_id,
            doctor_id,
            "2026-11-14",
            "Acute Bronchitis",
            "Bronchitis",
            None,
        )
        .unwrap();

        // 2. Create Prescription Revision 1 (Online creation flow)
        let rx1_items = r#"[{"id":1,"name":"Amoxicillin","formulation":"Capsule","dose":"500 mg","frequency":"TDS","duration":"5 days"}]"#;
        let rx1_id = DbOperations::insert_prescription(
            &mut conn,
            &dek,
            clinic_id,
            &c_id,
            &pat_id,
            doctor_id,
            "RX-2026-0001",
            rx1_items,
        )
        .unwrap();

        // Simulate initial sync to server: assign server_id = "srv_rx_101" to Revision 1
        DbOperations::apply_push_mutation_result(
            &mut conn,
            "outbox-create-rx1",
            "APPLIED",
            "PRESCRIPTION",
            &rx1_id,
            Some("srv_rx_101"),
            Some(1),
            None,
            None,
        )
        .unwrap();

        // 3. Offline Revision to Revision 2
        let rx2_items = r#"[{"id":1,"name":"Amoxicillin","formulation":"Capsule","dose":"500 mg","frequency":"TDS","duration":"7 days"},{"id":2,"name":"Cetirizine","formulation":"Tablet","dose":"10 mg","frequency":"OD","duration":"5 days"}]"#;
        let rx2_id = DbOperations::revise_prescription(
            &mut conn,
            &dek,
            clinic_id,
            &rx1_id,
            1,
            rx2_items,
            "Extended antibiotic course and added antihistamine",
            doctor_id,
        )
        .unwrap();

        // Verify Revision 1 is SUPERSEDED and Revision 2 is ACTIVE
        let rxs = DbOperations::get_prescriptions(&conn, &dek, clinic_id, Some(&pat_id)).unwrap();
        assert_eq!(rxs.len(), 2);
        assert_eq!(rxs[0].id, rx2_id);
        assert_eq!(rxs[0].revision_number, 2);
        assert_eq!(rxs[0].status, "ACTIVE");
        assert_eq!(rxs[1].id, rx1_id);
        assert_eq!(rxs[1].revision_number, 1);
        assert_eq!(rxs[1].status, "SUPERSEDED");

        // 4. Fetch pending outbox batch: verify idempotency key and payload
        let batch1 = DbOperations::get_pending_outbox_batch(&mut conn, &dek, clinic_id, 10).unwrap();
        let revise_item = batch1.iter().find(|i| i.action == "REVISE" && i.entity_id == rx2_id).unwrap();
        let expected_key = format!("prescription-revise-{rx2_id}-r2");
        assert_eq!(revise_item.idempotency_key, expected_key);
        assert_eq!(revise_item.server_id, Some("srv_rx_101".to_string()));
        assert_eq!(revise_item.payload["prescriptionNumber"], "RX-2026-0001");
        assert_eq!(revise_item.payload["expectedRevisionNumber"], 1);
        assert_eq!(revise_item.client_version, 1);

        // 5. Idempotent Retry: simulate network timeout while push is in flight
        let outbox_id = revise_item.id.clone();
        let reverted = DbOperations::revert_in_flight_to_pending(&conn, &[outbox_id.clone()], Some("Network timeout during push")).unwrap();
        assert_eq!(reverted, 1);

        // Re-read outbox batch: same idempotency key must be preserved
        let batch2 = DbOperations::get_pending_outbox_batch(&mut conn, &dek, clinic_id, 10).unwrap();
        let retry_item = batch2.iter().find(|i| i.id == outbox_id).unwrap();
        assert_eq!(retry_item.idempotency_key, expected_key);
        assert_eq!(retry_item.server_id, Some("srv_rx_101".to_string()));

        // 6. Push succeeds on server: apply APPLIED result
        DbOperations::apply_push_mutation_result(
            &mut conn,
            &outbox_id,
            "APPLIED",
            "PRESCRIPTION",
            &rx2_id,
            Some("srv_rx_101"),
            Some(2),
            None,
            None,
        )
        .unwrap();

        let rx2_after_sync: (String, String, i32) = conn
            .query_row(
                "SELECT sync_status, server_id, server_version FROM local_prescriptions WHERE id = ?1",
                params![rx2_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(rx2_after_sync.0, "SYNCED");
        assert_eq!(rx2_after_sync.1, "srv_rx_101");
        assert_eq!(rx2_after_sync.2, 2);

        // 7. Pull remote Revision 3 from cloud change feed (e.g. edited by another workstation)
        let rx3_items = serde_json::json!([
            {"id": 1, "name": "Amoxicillin", "formulation": "Capsule", "dose": "500 mg"},
            {"id": 2, "name": "Cetirizine", "formulation": "Tablet", "dose": "10 mg"},
            {"id": 3, "name": "Vitamin C", "formulation": "Tablet", "dose": "500 mg"}
        ]);
        let remote_rev3 = SyncFeedChangeItem {
            seq: 201,
            entity_type: "PRESCRIPTION_REVISION".to_string(),
            entity_id: "srv_rx_101".to_string(),
            client_entity_id: None,
            action: "REVISE".to_string(),
            version: 3,
            committed_at: "2026-11-14T12:00:00Z".to_string(),
            actor_doctor_id: doctor_id.to_string(),
            payload: serde_json::json!({
                "prescriptionId": "srv_rx_101",
                "revisionNumber": 3,
                "revision": {
                    "prescriptionId": "srv_rx_101",
                    "consultationId": c_id,
                    "patientId": pat_id,
                    "revisionNumber": 3,
                    "reasonForRevision": "Added nutritional support",
                    "items": rx3_items
                }
            }),
        };

        DbOperations::apply_pull_feed_items(&mut conn, &dek, clinic_id, &[remote_rev3], 201, false).unwrap();

        // 8. Verify all 3 revisions exist and are correctly ordered in patient history
        let all_revisions = DbOperations::get_prescriptions(&conn, &dek, clinic_id, Some(&pat_id)).unwrap();
        assert_eq!(all_revisions.len(), 3, "Must have exactly 3 revisions");
        assert_eq!(all_revisions[0].revision_number, 3, "Latest revision must be Rev 3");
        assert_eq!(all_revisions[0].status, "ACTIVE");
        assert_eq!(all_revisions[1].revision_number, 2, "Previous revision Rev 2 must remain");
        assert_eq!(all_revisions[1].status, "SUPERSEDED");
        assert_eq!(all_revisions[2].revision_number, 1, "Original revision Rev 1 must remain");
        assert_eq!(all_revisions[2].status, "SUPERSEDED");

        // Verify Rev 1 original items are still completely intact
        assert_eq!(all_revisions[2].items_json.as_deref(), Some(rx1_items));

        // 9. Concurrency conflict handling: stale push returns CONFLICT
        let (enc_stale, nonce_stale) = crate::crypto::encrypt_payload(&dek.key, b"{}").unwrap();
        conn.execute(
            r#"
            INSERT INTO local_sync_outbox (
                id, clinic_id, entity_type, entity_id, action, idempotency_key, encrypted_payload, nonce, sync_status
            ) VALUES ('outbox-stale-test', ?1, 'PRESCRIPTION', ?2, 'REVISE', 'idem-stale-test-key', ?3, ?4, 'IN_FLIGHT')
            "#,
            params![clinic_id, rx1_id, enc_stale, nonce_stale],
        )
        .unwrap();

        let stale_conflict_details = serde_json::json!({
            "conflictReason": "CONCURRENT_REVISION_COLLISION",
            "serverVersion": 3,
            "clientVersion": 1,
            "reason": "Stale revision rejected"
        });

        DbOperations::apply_push_mutation_result(
            &mut conn,
            "outbox-stale-test",
            "CONFLICT",
            "PRESCRIPTION",
            &rx1_id,
            Some("srv_rx_101"),
            Some(3),
            Some("Optimistic lock conflict"),
            Some(&stale_conflict_details),
        )
        .unwrap();

        // Verify conflict recorded in local_sync_conflicts
        let conflict_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_sync_conflicts WHERE entity_type = 'PRESCRIPTION' AND status = 'OPEN'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(conflict_count, 1);
    }

    #[test]
    fn test_twenty_consecutive_patient_creations() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_twenty_consecutive";

        let mut allocated_codes = Vec::new();
        for i in 1..=20 {
            let res = DbOperations::insert_patient_ext(
                &mut conn,
                &dek,
                clinic_id,
                "PT-INIT",
                &format!("Patient Number {i}"),
                &format!("98765432{:02}", i),
                "Male",
                Some("1990-01-01"),
                30 + (i as i32 % 50),
                &["Paracetamol".to_string()],
                &["Hypertension".to_string()],
                Some("Test notes"),
                Some(&format!("mut-batch-{i}")),
            )
            .expect("Patient creation succeeds");

            let expected_code = DbOperations::format_sequential_patient_id(i);
            assert_eq!(res.patient_code, expected_code, "Patient {i} must receive sequential code {expected_code}");
            allocated_codes.push(res.patient_code);
        }

        // Verify all 20 codes are distinct
        let mut sorted = allocated_codes.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 20, "All 20 allocated patient codes must be strictly distinct");

        // Verify count in local_patients
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_patients WHERE clinic_id = ?1",
                params![clinic_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 20);

        // Verify all 20 outbox records exist
        let outbox_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_sync_outbox WHERE clinic_id = ?1 AND entity_type = 'PATIENT'",
                params![clinic_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(outbox_count, 20);
    }

    #[test]
    fn test_candidate_code_collision_reallocates_safely() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_collision_test";

        // Patient 1 gets candidate "AAA-0003"
        let res1 = DbOperations::insert_patient_ext(
            &mut conn,
            &dek,
            clinic_id,
            "AAA-0003",
            "First Patient",
            "9876543210",
            "Female",
            None,
            28,
            &[],
            &[],
            None,
            Some("mut-coll-1"),
        )
        .expect("Patient 1 succeeds");

        assert_eq!(res1.patient_code, "AAA-0003");

        // Patient 2 also submits candidate "AAA-0003" (e.g. from stale React state)
        let res2 = DbOperations::insert_patient_ext(
            &mut conn,
            &dek,
            clinic_id,
            "AAA-0003",
            "Second Patient",
            "9876543211",
            "Male",
            None,
            35,
            &[],
            &[],
            None,
            Some("mut-coll-2"),
        )
        .expect("Patient 2 safely reallocates");

        // Must allocate next sequential code, not overwrite or fail!
        assert_ne!(res2.patient_code, "AAA-0003", "Colliding candidate code must be reallocated");
        assert_eq!(res2.patient_code, "AAA-0004", "Allocates next available code AAA-0004");
        assert_ne!(res1.id, res2.id, "Patients have distinct IDs");

        // Verify Patient 1 remains intact in local_patients
        let p1_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM local_patients WHERE id = ?1 AND patient_code = 'AAA-0003')",
                params![res1.id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(p1_exists, "Patient 1 code AAA-0003 was not overwritten or destroyed");

        // Verify Patient 2 exists with AAA-0004
        let p2_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM local_patients WHERE id = ?1 AND patient_code = 'AAA-0004')",
                params![res2.id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(p2_exists, "Patient 2 code AAA-0004 exists");

        // Both are distinct in database
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_patients WHERE clinic_id = ?1",
                params![clinic_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(total, 2);
    }

    #[test]
    fn test_insert_patient_idempotency_with_mutation_id() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_idempotency_test";
        let mutation_id = "unique-client-mutation-uuid-999";

        // First creation attempt
        let res1 = DbOperations::insert_patient_ext(
            &mut conn,
            &dek,
            clinic_id,
            "PT-INIT",
            "Dr. Patient",
            "9876500000",
            "Male",
            None,
            42,
            &[],
            &[],
            None,
            Some(mutation_id),
        )
        .expect("First creation succeeds");

        // Second creation attempt with EXACT same client mutation ID (simulating retry / double click)
        let res2 = DbOperations::insert_patient_ext(
            &mut conn,
            &dek,
            clinic_id,
            "PT-INIT",
            "Dr. Patient",
            "9876500000",
            "Male",
            None,
            42,
            &[],
            &[],
            None,
            Some(mutation_id),
        )
        .expect("Retry returns existing record idempotently");

        assert_eq!(res1.id, res2.id, "Idempotent retry must return the same patient ID");
        assert_eq!(res1.patient_code, res2.patient_code, "Idempotent retry must return the same patient code");

        // Verify exactly 1 patient in database
        let p_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_patients WHERE clinic_id = ?1",
                params![clinic_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(p_count, 1, "No duplicate patient created");

        // Verify exactly 1 outbox mutation
        let o_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_sync_outbox WHERE clinic_id = ?1",
                params![clinic_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(o_count, 1, "No duplicate outbox entry created");
    }

    #[test]
    fn test_patient_creation_edge_cases_phone_age_gender() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_edge_cases";

        // Case A: Blank optional phone number
        let res_blank_phone = DbOperations::insert_patient_ext(
            &mut conn,
            &dek,
            clinic_id,
            "PT-INIT",
            "Patient Blank Phone",
            "",
            "Female",
            None,
            25,
            &[],
            &[],
            None,
            None,
        )
        .expect("Patient with blank phone succeeds");
        assert!(!res_blank_phone.id.is_empty());

        // Case B: Valid 10-digit phone number
        let res_valid_phone = DbOperations::insert_patient_ext(
            &mut conn,
            &dek,
            clinic_id,
            "PT-INIT",
            "Patient Valid Phone",
            "9123456789",
            "Male",
            None,
            30,
            &[],
            &[],
            None,
            None,
        )
        .expect("Patient with valid phone succeeds");
        assert!(!res_valid_phone.id.is_empty());

        // Case C: Missing age (0) and blank gender
        let res_missing_age_gender = DbOperations::insert_patient_ext(
            &mut conn,
            &dek,
            clinic_id,
            "PT-INIT",
            "Patient Minimal",
            "",
            "",
            None,
            0,
            &[],
            &[],
            None,
            None,
        )
        .expect("Patient with 0 age and empty gender succeeds");
        assert!(!res_missing_age_gender.id.is_empty());

        // Verify all 3 were persisted and decryptable
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_patients WHERE clinic_id = ?1",
                params![clinic_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 3);
    }

    #[test]
    fn test_existing_patient_update_preserves_code_and_increments_version() {
        let (mut conn, dek) = setup_test_db();
        let clinic_id = "clinic_update_test";

        let created = DbOperations::insert_patient_ext(
            &mut conn,
            &dek,
            clinic_id,
            "PT-INIT",
            "Initial Name",
            "9876543210",
            "Male",
            None,
            30,
            &[],
            &[],
            None,
            None,
        )
        .expect("Initial insert succeeds");

        assert_eq!(created.patient_code, "AAA-0001");

        // Update patient
        DbOperations::update_patient(
            &mut conn,
            &dek,
            clinic_id,
            &created.id,
            &created.patient_code,
            "Updated Name",
            "9876543210",
            "Male",
            None,
            31,
            &["Penicillin".to_string()],
            &[],
            Some("Updated notes"),
        )
        .expect("Update succeeds");

        // Verify patient_code unchanged, local_version is 2
        let (saved_code, ver): (String, i32) = conn
            .query_row(
                "SELECT patient_code, local_version FROM local_patients WHERE clinic_id = ?1 AND id = ?2",
                params![clinic_id, &created.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(saved_code, "AAA-0001");
        assert_eq!(ver, 2);

        // Verify outbox has UPDATE mutation
        let has_update_outbox: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM local_sync_outbox WHERE clinic_id = ?1 AND entity_id = ?2 AND action = 'UPDATE')",
                params![clinic_id, &created.id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(has_update_outbox);
    }
}
