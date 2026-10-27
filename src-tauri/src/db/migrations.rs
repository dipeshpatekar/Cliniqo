use rusqlite::{params, Connection};
use thiserror::Error;
use crate::crypto::key_manager::DatabaseEncryptionKey;
use crate::crypto::{encrypt_payload, CryptoError};
use super::schema::{
    ClinicalData, PatientDemographics, CREATE_MIGRATIONS_TABLE, MIGRATION_V1_SQL, MIGRATION_V2_SQL,
};

#[derive(Error, Debug)]
pub enum MigrationError {
    #[error("SQLite database error during migration: {0}")]
    SqliteError(#[from] rusqlite::Error),

    #[error("Cryptography error during schema data migration: {0}")]
    CryptoError(#[from] CryptoError),

    #[error("Serialization error during schema migration: {0}")]
    SerializationError(#[from] serde_json::Error),

    #[error("Migration transaction failed: {0}")]
    TransactionError(String),
}

pub struct MigrationRunner;

impl MigrationRunner {
    pub fn run_migrations(
        conn: &mut Connection,
        dek: &DatabaseEncryptionKey,
    ) -> Result<(), MigrationError> {
        // 1. Ensure migrations table exists
        conn.execute(CREATE_MIGRATIONS_TABLE, [])?;

        // 2. Check if v1 has already been applied
        let v1_applied: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 1)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !v1_applied {
            log::info!("Applying local offline SQLite migration v1 (Foundation baseline)...");
            let tx = conn.transaction()?;
            tx.execute_batch(MIGRATION_V1_SQL)?;
            tx.execute(
                "INSERT INTO schema_migrations (version, name, checksum) VALUES (?1, ?2, ?3)",
                params![1, "initial_foundation_schema", "v1_cliniqo_offline_schema"],
            )?;
            tx.commit()?;
            log::info!("Migration v1 applied successfully.");
        }

        // 3. Check if v2 (Zero Plaintext Encryption at Rest) has already been applied
        let v2_applied: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 2)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !v2_applied {
            log::info!("Applying local offline SQLite migration v2 (Zero-plaintext encryption at rest)...");
            Self::migrate_to_v2(conn, dek)?;
            log::info!("Migration v2 applied successfully. All sensitive clinical data and outbox mutations encrypted.");
        }

        Ok(())
    }

    fn migrate_to_v2(
        conn: &mut Connection,
        dek: &DatabaseEncryptionKey,
    ) -> Result<(), MigrationError> {
        let tx = conn.transaction()?;

        // Execute DDL creating V2 target tables
        tx.execute_batch(MIGRATION_V2_SQL)?;

        // Check if old local_patients has unencrypted 'name' column
        let has_old_patient_name: bool = {
            let mut stmt = tx.prepare("PRAGMA table_info(local_patients)")?;
            let mut rows = stmt.query([])?;
            let mut found = false;
            while let Some(row) = rows.next()? {
                let col_name: String = row.get(1)?;
                if col_name == "name" {
                    found = true;
                    break;
                }
            }
            found
        };

        if has_old_patient_name {
            log::info!("Migrating existing v1 patient records to encrypted format...");
            let mut select_stmt = tx.prepare(
                r#"
                SELECT id, server_id, clinic_id, patient_code, name, phone, gender,
                       date_of_birth, age, allergies_json, conditions_json, sync_status,
                       server_version, local_version, created_at, updated_at
                FROM local_patients
                "#,
            )?;

            let old_patients: Vec<(
                String,
                Option<String>,
                String,
                String,
                String,
                String,
                String,
                Option<String>,
                i32,
                String,
                String,
                String,
                i32,
                i32,
                String,
                String,
            )> = select_stmt
                .query_map([], |row| {
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
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;

            drop(select_stmt);

            for p in old_patients {
                let allergies: Vec<String> = serde_json::from_str(&p.9).unwrap_or_default();
                let conditions: Vec<String> = serde_json::from_str(&p.10).unwrap_or_default();
                let demo = PatientDemographics {
                    name: p.4,
                    phone: p.5,
                    gender: p.6,
                    date_of_birth: p.7,
                    age: p.8,
                    allergies,
                    conditions,
                    sensitive_notes: None,
                };

                let demo_json = serde_json::to_vec(&demo)?;
                let (enc_bytes, nonce) = encrypt_payload(&dek.key, &demo_json)?;

                tx.execute(
                    r#"
                    INSERT INTO local_patients_v2 (
                        id, server_id, clinic_id, patient_code, encrypted_demographics, nonce,
                        sync_status, server_version, local_version, created_at, updated_at
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                    "#,
                    params![p.0, p.1, p.2, p.3, enc_bytes, nonce, p.11, p.12, p.13, p.14, p.15],
                )?;
            }
        }

        // Migrate consultations if old table has plaintext 'diagnosis'
        let has_old_diagnosis: bool = {
            let mut stmt = tx.prepare("PRAGMA table_info(local_consultations)")?;
            let mut rows = stmt.query([])?;
            let mut found = false;
            while let Some(row) = rows.next()? {
                let col_name: String = row.get(1)?;
                if col_name == "diagnosis" {
                    found = true;
                    break;
                }
            }
            found
        };

        if has_old_diagnosis {
            log::info!("Migrating existing v1 consultation records to encrypted format...");
            let mut select_stmt = tx.prepare(
                r#"
                SELECT id, server_id, clinic_id, patient_id, doctor_id, consultation_date,
                       status, chief_complaint, diagnosis, sync_status,
                       server_version, local_version, created_at, updated_at
                FROM local_consultations
                "#,
            )?;

            let old_consults: Vec<(
                String,
                Option<String>,
                String,
                String,
                String,
                String,
                String,
                String,
                String,
                String,
                i32,
                i32,
                String,
                String,
            )> = select_stmt
                .query_map([], |row| {
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
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;

            drop(select_stmt);

            for c in old_consults {
                let clinical_data = ClinicalData {
                    chief_complaint: c.7,
                    diagnosis: c.8,
                    clinical_snapshot_json: None,
                };
                let clinical_bytes = serde_json::to_vec(&clinical_data)?;
                let (enc_bytes, nonce) = encrypt_payload(&dek.key, &clinical_bytes)?;

                tx.execute(
                    r#"
                    INSERT INTO local_consultations_v2 (
                        id, server_id, clinic_id, patient_id, doctor_id, consultation_date, status,
                        encrypted_clinical_data, nonce, sync_status, server_version, local_version,
                        created_at, updated_at
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                    "#,
                    params![c.0, c.1, c.2, c.3, c.4, c.5, c.6, enc_bytes, nonce, c.9, c.10, c.11, c.12, c.13],
                )?;
            }
        }

        // Migrate outbox if old table has plaintext 'payload_json'
        let has_old_outbox_payload: bool = {
            let mut stmt = tx.prepare("PRAGMA table_info(local_sync_outbox)")?;
            let mut rows = stmt.query([])?;
            let mut found = false;
            while let Some(row) = rows.next()? {
                let col_name: String = row.get(1)?;
                if col_name == "payload_json" {
                    found = true;
                    break;
                }
            }
            found
        };

        if has_old_outbox_payload {
            log::info!("Migrating existing v1 outbox records to encrypted payload format...");
            let mut select_stmt = tx.prepare(
                r#"
                SELECT id, clinic_id, entity_type, entity_id, action, idempotency_key,
                       payload_json, sync_status, retry_count, last_error, created_at, synced_at
                FROM local_sync_outbox
                "#,
            )?;

            let old_outbox: Vec<(
                String,
                String,
                String,
                String,
                String,
                String,
                String,
                String,
                i32,
                Option<String>,
                String,
                Option<String>,
            )> = select_stmt
                .query_map([], |row| {
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
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;

            drop(select_stmt);

            for o in old_outbox {
                let (enc_bytes, nonce) = encrypt_payload(&dek.key, o.6.as_bytes())?;
                tx.execute(
                    r#"
                    INSERT INTO local_sync_outbox_v2 (
                        id, clinic_id, entity_type, entity_id, action, idempotency_key,
                        encrypted_payload, nonce, sync_status, retry_count, last_error, created_at, synced_at
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                    "#,
                    params![o.0, o.1, o.2, o.3, o.4, o.5, enc_bytes, nonce, o.7, o.8, o.9, o.10, o.11],
                )?;
            }
        }

        // Copy existing prescriptions if table exists
        let has_old_prescriptions: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'local_prescriptions')",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if has_old_prescriptions {
            log::info!("Preserving existing v1 prescriptions into encrypted v2 table...");
            tx.execute(
                r#"
                INSERT INTO local_prescriptions_v2 (
                    id, server_id, clinic_id, consultation_id, patient_id, doctor_id,
                    prescription_number, revision_number, status, encrypted_items, nonce,
                    sync_status, server_version, local_version, created_at, updated_at
                )
                SELECT id, server_id, clinic_id, consultation_id, patient_id, doctor_id,
                       prescription_number, revision_number, status, encrypted_items, nonce,
                       sync_status, server_version, local_version, created_at, updated_at
                FROM local_prescriptions
                "#,
                [],
            )?;
        }

        // Atomically replace old tables with encrypted V2 tables
        tx.execute_batch(
            r#"
            DROP TABLE IF EXISTS local_patients;
            ALTER TABLE local_patients_v2 RENAME TO local_patients;

            DROP TABLE IF EXISTS local_consultations;
            ALTER TABLE local_consultations_v2 RENAME TO local_consultations;

            DROP TABLE IF EXISTS local_prescriptions;
            ALTER TABLE local_prescriptions_v2 RENAME TO local_prescriptions;

            DROP TABLE IF EXISTS local_sync_outbox;
            ALTER TABLE local_sync_outbox_v2 RENAME TO local_sync_outbox;
            "#,
        )?;

        // Record migration in schema_migrations
        tx.execute(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES (?1, ?2, ?3)",
            params![2, "encrypted_fields_at_rest", "v2_cliniqo_zero_plaintext"],
        )?;

        tx.commit()?;
        Ok(())
    }
}
