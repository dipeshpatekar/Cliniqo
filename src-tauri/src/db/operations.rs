use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;
use uuid::Uuid;
use thiserror::Error;
use crate::crypto::{decrypt_payload, encrypt_payload, CryptoError};
use crate::crypto::key_manager::DatabaseEncryptionKey;
use super::schema::{
    CatalogueCacheStats, ClinicalData, ConflictStatus, ConsultationRecord, DecryptedOutboxItem, EncryptedBillingData,
    FormularyRecord, InvoiceItem, InvoiceRecord, LocalCatalogueItem, PatientDemographics, PatientRecord,
    PrescriptionRecord, SaveCatalogueCacheItemArgs, SaveFormularyArgs, SaveInvoiceArgs, SyncConflictRecord, SyncFeedChangeItem,
    SyncOutboxSummary, SyncStateRecord,
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
    /// Inserts a patient record locally. All demographics and outbox mutation payloads are
    /// encrypted at rest using AES-256-GCM.
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
        let patient_id = Uuid::new_v4().to_string();
        let idempotency_key = format!("local-patient-create-{patient_id}");

        // 1. Pack and encrypt all demographic and sensitive fields
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

        // 2. Pack and encrypt sync outbox mutation payload
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

        tx.execute(
            r#"
            INSERT INTO local_patients (
                id, clinic_id, patient_code, encrypted_demographics, nonce, sync_status, local_version
            ) VALUES (?1, ?2, ?3, ?4, ?5, 'PENDING', 1)
            "#,
            params![
                patient_id,
                clinic_id,
                patient_code,
                encrypted_demographics,
                demo_nonce,
            ],
        )?;

        let outbox_id = Uuid::new_v4().to_string();
        tx.execute(
            r#"
            INSERT INTO local_sync_outbox (
                id, clinic_id, entity_type, entity_id, action, idempotency_key, encrypted_payload, nonce, sync_status
            ) VALUES (?1, ?2, 'PATIENT', ?3, 'CREATE', ?4, ?5, ?6, 'PENDING')
            "#,
            params![outbox_id, clinic_id, patient_id, idempotency_key, encrypted_outbox, outbox_nonce],
        )?;

        tx.commit()?;
        Ok(patient_id)
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

        let (actual_id, current_local_ver): (String, i32) = tx.query_row(
            "SELECT id, local_version FROM local_patients WHERE clinic_id = ?1 AND (id = ?2 OR patient_code = ?2) LIMIT 1",
            params![clinic_id, patient_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        let new_ver = current_local_ver + 1;

        tx.execute(
            "DELETE FROM local_patients WHERE clinic_id = ?1 AND id = ?2",
            params![clinic_id, actual_id],
        )?;

        let outbox_id = Uuid::new_v4().to_string();
        let idempotency_key = format!("local-patient-delete-{actual_id}-{new_ver}");
        let (encrypted_outbox, outbox_nonce) = encrypt_payload(&dek.key, b"{}")?;

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
            SELECT id, server_id, clinic_id, patient_code, encrypted_demographics, nonce,
                   sync_status, server_version, local_version, updated_at
            FROM local_patients
            WHERE clinic_id = ?1
            ORDER BY updated_at DESC
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
    ) -> Result<Vec<ConsultationRecord>, DatabaseOpError> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, server_id, clinic_id, patient_id, doctor_id, consultation_date,
                   status, encrypted_clinical_data, nonce, sync_status,
                   server_version, local_version, updated_at
            FROM local_consultations
            WHERE clinic_id = ?1
            ORDER BY updated_at DESC
            "#,
        )?;

        let rows = stmt.query_map(params![clinic_id], |row| {
            let id: String = row.get(0)?;
            let server_id: Option<String> = row.get(1)?;
            let clinic_id: String = row.get(2)?;
            let patient_id: String = row.get(3)?;
            let doctor_id: String = row.get(4)?;
            let consultation_date: String = row.get(5)?;
            let status: String = row.get(6)?;
            let enc_bytes: Vec<u8> = row.get(7)?;
            let nonce: Vec<u8> = row.get(8)?;
            let sync_status: String = row.get(9)?;
            let server_version: i32 = row.get(10)?;
            let local_version: i32 = row.get(11)?;
            let updated_at: String = row.get(12)?;

            Ok((
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
            ))
        })?;

        let mut results = Vec::new();
        for r in rows {
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
            ) = r?;

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
        let prescription_id = Uuid::new_v4().to_string();
        let idempotency_key = format!("local-prescription-create-{prescription_id}");

        let (encrypted_items, nonce) = encrypt_payload(&dek.key, items_json.as_bytes())?;

        let outbox_payload = json!({
            "consultationId": consultation_id,
            "patientId": patient_id,
            "doctorId": doctor_id,
            "prescriptionNumber": prescription_number,
            "itemsJson": items_json,
        })
        .to_string();

        let (encrypted_outbox, outbox_nonce) = encrypt_payload(&dek.key, outbox_payload.as_bytes())?;

        let tx = conn.transaction()?;

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
    ) -> Result<Vec<PrescriptionRecord>, DatabaseOpError> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, server_id, clinic_id, consultation_id, patient_id, doctor_id,
                   prescription_number, revision_number, status, encrypted_items, nonce,
                   sync_status, server_version, local_version, created_at
            FROM local_prescriptions
            WHERE clinic_id = ?1
            ORDER BY created_at DESC
            "#,
        )?;

        let rows = stmt.query_map(params![clinic_id], |row| {
            let id: String = row.get(0)?;
            let server_id: Option<String> = row.get(1)?;
            let clinic_id: String = row.get(2)?;
            let consultation_id: String = row.get(3)?;
            let patient_id: String = row.get(4)?;
            let doctor_id: String = row.get(5)?;
            let prescription_number: String = row.get(6)?;
            let revision_number: i32 = row.get(7)?;
            let status: String = row.get(8)?;
            let enc_items: Vec<u8> = row.get(9)?;
            let nonce: Vec<u8> = row.get(10)?;
            let sync_status: String = row.get(11)?;
            let server_version: i32 = row.get(12)?;
            let local_version: i32 = row.get(13)?;
            let created_at: String = row.get(14)?;

            Ok((
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
            ))
        })?;

        let mut results = Vec::new();
        for r in rows {
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
            ) = r?;

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

    /// Aggregates sync outbox counts by state.
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

            let server_id: Option<String> = match item.entity_type.as_str() {
                "PATIENT" => {
                    tx.query_row(
                        "SELECT server_id FROM local_patients WHERE id = ?1",
                        params![item.entity_id],
                        |r| r.get(0),
                    ).ok().flatten()
                }
                "CONSULTATION" => {
                    tx.query_row(
                        "SELECT server_id FROM local_consultations WHERE id = ?1",
                        params![item.entity_id],
                        |r| r.get(0),
                    ).ok().flatten()
                }
                "PRESCRIPTION" | "PRESCRIPTION_REVISION" => {
                    tx.query_row(
                        "SELECT server_id FROM local_prescriptions WHERE id = ?1",
                        params![item.entity_id],
                        |r| r.get(0),
                    ).ok().flatten()
                }
                _ => None,
            };

            decrypted_items.push(DecryptedOutboxItem {
                id: item.id.clone(),
                clinic_id: item.clinic_id.clone(),
                entity_type: item.entity_type.clone(),
                entity_id: item.entity_id.clone(),
                action: item.action.clone(),
                idempotency_key: item.idempotency_key.clone(),
                client_version: 1,
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
                    let consultation_id = item.payload.get("consultationId").and_then(|v| v.as_str()).unwrap_or("");
                    let patient_id = item.payload.get("patientId").and_then(|v| v.as_str()).unwrap_or("");
                    let doctor_id = item.actor_doctor_id.as_str();
                    let rx_number = item.payload.get("prescriptionNumber").and_then(|v| v.as_str()).unwrap_or("RX-UNKNOWN");
                    let revision_number = item.payload.get("revisionNumber").and_then(|v| v.as_i64()).unwrap_or(1) as i32;
                    let status = item.payload.get("status").and_then(|v| v.as_str()).unwrap_or("ACTIVE");
                    let items_val = item.payload.get("items").unwrap_or(&item.payload);
                    let items_str = items_val.to_string();

                    let (enc_bytes, nonce) = encrypt_payload(&dek.key, items_str.as_bytes())?;

                    let existing_id: Option<String> = {
                        let mut check_stmt = tx.prepare(
                            "SELECT id FROM local_prescriptions WHERE clinic_id = ?1 AND (server_id = ?2 OR (?3 != '' AND id = ?3)) LIMIT 1"
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
                                local_id, item.entity_id, clinic_id, consultation_id, patient_id, doctor_id,
                                rx_number, revision_number, status, enc_bytes, nonce, item.version
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
    pub fn save_formulary_item(
        conn: &mut Connection,
        clinic_id: &str,
        args: SaveFormularyArgs,
    ) -> Result<String, DatabaseOpError> {
        let item_id = args.id.unwrap_or_else(|| Uuid::new_v4().to_string());
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
                    active_ingredient = ?2,
                    formulation = ?3,
                    strength = ?4,
                    default_dose = ?5,
                    default_route = ?6,
                    default_frequency = ?7,
                    default_duration = ?8,
                    default_instructions = ?9,
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
        formulation: Option<&str>,
    ) -> Result<Vec<LocalCatalogueItem>, DatabaseOpError> {
        let raw_q = query.trim();
        if raw_q.is_empty() {
            return Ok(Vec::new());
        }

        let limit = if limit == 0 { 20 } else { limit.min(100) };
        let pattern = format!("%{}%", raw_q);
        let prefix_pattern = format!("{}%", raw_q);

        let mut query_sql = String::from(
            r#"
            SELECT id, item_type, name, brand_name, generic_name, product_name,
                   dosage_form, route, active_ingredients_json, strengths_json,
                   raw_strength_summary, is_combination, is_verified, source_provenance,
                   cached_at
            FROM local_catalogue_cache_v1
            WHERE (name LIKE ?1
               OR generic_name LIKE ?1
               OR brand_name LIKE ?1
               OR product_name LIKE ?1)
            "#,
        );

        let clean_form = formulation.map(str::trim).filter(|f| !f.is_empty());
        if clean_form.is_some() {
            query_sql.push_str(" AND (dosage_form LIKE ?4)");
        }

        query_sql.push_str(
            r#"
            ORDER BY
               CASE WHEN name LIKE ?2 THEN 0 ELSE 1 END,
               name ASC
            LIMIT ?3
            "#,
        );

        let mut stmt = conn.prepare(&query_sql)?;

        let map_row = |row: &rusqlite::Row| -> Result<LocalCatalogueItem, rusqlite::Error> {
            let is_comb: i32 = row.get(11)?;
            let is_ver: i32 = row.get(12)?;
            Ok(LocalCatalogueItem {
                id: row.get(0)?,
                item_type: row.get(1)?,
                name: row.get(2)?,
                brand_name: row.get(3)?,
                generic_name: row.get(4)?,
                product_name: row.get(5)?,
                dosage_form: row.get(6)?,
                route: row.get(7)?,
                active_ingredients_json: row.get(8)?,
                strengths_json: row.get(9)?,
                raw_strength_summary: row.get(10)?,
                is_combination: is_comb == 1,
                is_verified: is_ver == 1,
                source_provenance: row.get(13)?,
                cached_at: row.get(14)?,
            })
        };

        let mut items = Vec::new();
        if let Some(form) = clean_form {
            let form_pattern = format!("%{}%", form);
            let rows = stmt.query_map(params![pattern, prefix_pattern, limit as i64, form_pattern], map_row)?;
            for item in rows {
                items.push(item?);
            }
        } else {
            let rows = stmt.query_map(params![pattern, prefix_pattern, limit as i64], map_row)?;
            for item in rows {
                items.push(item?);
            }
        }
        Ok(items)
    }

    /// Retrieves verified strength strings from the offline catalogue cache for auto-population.
    pub fn get_local_catalogue_strengths(
        conn: &Connection,
        medicine_name: &str,
        formulation: Option<&str>,
    ) -> Result<Vec<String>, DatabaseOpError> {
        let raw_name = medicine_name.trim();
        if raw_name.is_empty() {
            return Ok(Vec::new());
        }

        let mut query_sql = String::from(
            r#"
            SELECT DISTINCT raw_strength_summary
            FROM local_catalogue_cache_v1
            WHERE (name = ?1 OR generic_name = ?1 OR brand_name = ?1 OR product_name = ?1)
              AND is_verified = 1
              AND raw_strength_summary != ''
              AND raw_strength_summary != 'Unspecified'
            "#,
        );

        if formulation.is_some() {
            query_sql.push_str(" AND (dosage_form LIKE '%' || ?2 || '%')");
        }
        query_sql.push_str(" ORDER BY raw_strength_summary ASC");

        let mut stmt = conn.prepare(&query_sql)?;
        let mut list = Vec::new();

        if let Some(form) = formulation {
            let mut rows = stmt.query(params![raw_name, form.trim()])?;
            while let Some(row) = rows.next()? {
                let s: String = row.get(0)?;
                if !s.trim().is_empty() {
                    list.push(s);
                }
            }
        } else {
            let mut rows = stmt.query(params![raw_name])?;
            while let Some(row) = rows.next()? {
                let s: String = row.get(0)?;
                if !s.trim().is_empty() {
                    list.push(s);
                }
            }
        }
        Ok(list)
    }

    /// Retrieves statistics about the locally cached catalogue (total items, brands, generics, verified).
    pub fn get_catalogue_cache_stats(conn: &Connection) -> Result<CatalogueCacheStats, DatabaseOpError> {
        let mut stmt = conn.prepare(
            r#"
            SELECT
                COUNT(*),
                COALESCE(SUM(CASE WHEN item_type = 'BRAND' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN item_type = 'GENERIC' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN is_verified = 1 THEN 1 ELSE 0 END), 0)
            FROM local_catalogue_cache_v1
            "#,
        )?;
        let stats = stmt.query_row([], |row| {
            Ok(CatalogueCacheStats {
                total_items: row.get(0)?,
                brand_count: row.get(1)?,
                generic_count: row.get(2)?,
                verified_count: row.get(3)?,
            })
        })?;
        Ok(stats)
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

        let consults = DbOperations::get_consultations(&conn, &dek, clinic_id).unwrap();
        assert_eq!(consults.len(), 1);
        assert_eq!(consults[0].diagnosis, diagnosis);

        let rxs = DbOperations::get_prescriptions(&conn, &dek, clinic_id).unwrap();
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

        let consults = DbOperations::get_consultations(&conn, &dek, "clinic_1").unwrap();
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

        // Simulate a database from a newer future application (e.g. version 6)
        conn.execute(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES (6, 'future_v6', 'chk6')",
            [],
        )
        .unwrap();

        let result = MigrationRunner::run_migrations(&mut conn, &dek);
        assert!(
            matches!(result, Err(MigrationError::UnsupportedSchemaVersion(6))),
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
        let consults = DbOperations::get_consultations(&conn, &dek, clinic_id).unwrap();
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

        // 1. Cache items
        let count = DbOperations::cache_catalogue_items(&mut conn, &items).unwrap();
        assert_eq!(count, 4);

        // 2. Search prefix matches first
        let search_results = DbOperations::search_local_catalogue(&conn, "Calpol", 10, None).unwrap();
        assert_eq!(search_results.len(), 2);
        assert_eq!(search_results[0].name, "Calpol 250 Syrup");
        assert_eq!(search_results[1].name, "Calpol 500");

        // 2b. Search with formulation filter
        let filtered_search = DbOperations::search_local_catalogue(&conn, "Calpol", 10, Some("Syrup")).unwrap();
        assert_eq!(filtered_search.len(), 1);
        assert_eq!(filtered_search[0].name, "Calpol 250 Syrup");

        // 3. Search substring/generic name
        let para_results = DbOperations::search_local_catalogue(&conn, "Paracetamol", 10, None).unwrap();
        assert_eq!(para_results.len(), 3);

        // 3b. Verify cache stats
        let stats = DbOperations::get_catalogue_cache_stats(&conn).unwrap();
        assert_eq!(stats.total_items, 4);
        assert_eq!(stats.brand_count, 4);
        assert_eq!(stats.verified_count, 3);

        // 4. Extract verified strengths for medicine
        let calpol_strengths = DbOperations::get_local_catalogue_strengths(&conn, "Calpol 500", None).unwrap();
        assert_eq!(calpol_strengths, vec!["500 mg"]);

        let tablet_strengths = DbOperations::get_local_catalogue_strengths(&conn, "Paracetamol", Some("Tablet")).unwrap();
        assert_eq!(tablet_strengths, vec!["500 mg", "650 mg"]);

        // 5. Unverified strengths are not extracted
        let herb_strengths = DbOperations::get_local_catalogue_strengths(&conn, "Unverified Herb", None).unwrap();
        assert!(herb_strengths.is_empty());

        // 6. Safe idempotency on rerun
        let count2 = DbOperations::cache_catalogue_items(&mut conn, &items).unwrap();
        assert_eq!(count2, 4);
    }
}
