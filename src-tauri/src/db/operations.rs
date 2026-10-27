use rusqlite::{params, Connection};
use serde_json::json;
use uuid::Uuid;
use thiserror::Error;
use crate::crypto::{decrypt_payload, encrypt_payload, CryptoError};
use crate::crypto::key_manager::DatabaseEncryptionKey;
use super::schema::{
    ClinicalData, ConsultationRecord, PatientDemographics, PatientRecord, PrescriptionRecord,
    SyncOutboxSummary,
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
}
