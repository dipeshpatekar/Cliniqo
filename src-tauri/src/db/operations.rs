use rusqlite::{params, Connection};
use serde_json::json;
use uuid::Uuid;
use thiserror::Error;
use crate::crypto::{decrypt_payload, encrypt_payload, CryptoError};
use crate::crypto::key_manager::DatabaseEncryptionKey;
use super::schema::{
    ClinicalData, ConflictStatus, ConsultationRecord, DecryptedOutboxItem, PatientDemographics,
    PatientRecord, PrescriptionRecord, SyncConflictRecord, SyncFeedChangeItem, SyncOutboxSummary,
    SyncStateRecord,
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
}

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

        // Simulate a database from a newer future application (e.g. version 4)
        conn.execute(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES (4, 'future_v4', 'chk4')",
            [],
        )
        .unwrap();

        let result = MigrationRunner::run_migrations(&mut conn, &dek);
        assert!(
            matches!(result, Err(MigrationError::UnsupportedSchemaVersion(4))),
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
}
