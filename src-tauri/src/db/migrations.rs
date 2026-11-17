use rusqlite::{params, Connection};
use thiserror::Error;
use crate::crypto::key_manager::DatabaseEncryptionKey;
use crate::crypto::{encrypt_payload, CryptoError};
use super::schema::{
    ClinicalData, PatientDemographics, CREATE_MIGRATIONS_TABLE, MIGRATION_V1_SQL, MIGRATION_V2_SQL,
    MIGRATION_V3_SQL, MIGRATION_V4_SQL, MIGRATION_V5_SQL, MIGRATION_V6_SQL, MIGRATION_V7_SQL,
    MIGRATION_V8_SQL, MIGRATION_V9_SQL, MIGRATION_V10_SQL, MIGRATION_V11_SQL, MIGRATION_V12_SQL,
    MIGRATION_V13_SQL,
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

    #[error("Unsupported schema version: database is at version {0}, but this client only supports up to version 13. Please update the application.")]
    UnsupportedSchemaVersion(i32),
}

pub struct MigrationRunner;

impl MigrationRunner {
    pub fn run_migrations(
        conn: &mut Connection,
        dek: &DatabaseEncryptionKey,
    ) -> Result<(), MigrationError> {
        // 1. Ensure migrations table exists
        conn.execute(CREATE_MIGRATIONS_TABLE, [])?;

        // Disable foreign keys during table reconstruction migrations (SQLite requirement).
        // Must be performed outside any active transaction block.
        conn.pragma_update(None, "foreign_keys", "OFF")?;

        let migration_res = Self::run_migration_steps(conn, dek);

        // Foreign keys pragma MUST be restored on every success and failure path outside transactions
        let restore_res = conn.pragma_update(None, "foreign_keys", "ON");

        match migration_res {
            Ok(()) => {
                restore_res?;
                Ok(())
            }
            Err(e) => {
                if let Err(r_err) = restore_res {
                    log::error!(
                        "Failed to restore foreign_keys pragma on migration failure path: {r_err}"
                    );
                }
                Err(e)
            }
        }
    }

    fn run_migration_steps(
        conn: &mut Connection,
        dek: &DatabaseEncryptionKey,
    ) -> Result<(), MigrationError> {
        // 2. Safeguard: Reject unsupported future schema versions
        let max_version: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        if max_version > 13 {
            return Err(MigrationError::UnsupportedSchemaVersion(max_version));
        }

        // 3. Check if v1 has already been applied
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

        // 4. Check if v2 (Zero Plaintext Encryption at Rest) has already been applied
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

        // 5. Check if v3 (Sync Engine State & Conflict Extensions) has already been applied
        let v3_applied: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 3)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !v3_applied {
            log::info!("Applying local offline SQLite migration v3 (Sync state & conflict resolution)...");
            Self::migrate_to_v3(conn)?;
            log::info!("Migration v3 applied successfully. Sync state and extended conflict schemas active.");
        }

        // 6. Check if v4 (Billing & Clinical Formulary) has already been applied
        let v4_applied: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 4)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !v4_applied {
            log::info!("Applying local offline SQLite migration v4 (Billing & Clinical Formulary)...");
            Self::migrate_to_v4(conn)?;
            log::info!("Migration v4 applied successfully. Billing and clinical formulary schemas active.");
        }

        // 7. Check if v5 has already been applied
        let v5_applied: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 5)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !v5_applied {
            log::info!("Applying local offline SQLite migration v5 (Catalogue offline cache)...");
            Self::migrate_to_v5(conn)?;
            log::info!("Migration v5 applied successfully. Local catalogue cache active.");
        }

        // 8. Check if v6 (Clinic profile persistence) has already been applied
        let v6_applied: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 6)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !v6_applied {
            log::info!("Applying local offline SQLite migration v6 (Clinic profile persistence)...");
            Self::migrate_to_v6(conn)?;
            log::info!("Migration v6 applied successfully. Local clinic profile active.");
        }

        // 9. Check if v7 (CDCI ProductMaster 104,367 backfill & reconciliation) has already been applied
        let v7_applied: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 7)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !v7_applied {
            log::info!("Applying local offline SQLite migration v7 (CDCI ProductMaster 104,367 backfill & reconciliation)...");
            Self::migrate_to_v7(conn)?;
            log::info!("Migration v7 applied successfully. Catalogue reconciliation complete.");
        }

        // 10. Check if v8 (Doctor profile persistence) has already been applied
        let v8_applied: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 8)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !v8_applied {
            log::info!("Applying local offline SQLite migration v8 (Doctor profile credentials persistence)...");
            Self::migrate_to_v8(conn)?;
            log::info!("Migration v8 applied successfully. Local doctor profile active.");
        }

        // 11. Check if v9 (Inventory stock tracking) has been applied
        let v9_applied: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 9)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !v9_applied {
            log::info!("Applying local offline SQLite migration v9 (Inventory stock tracking)...");
            Self::migrate_to_v9(conn)?;
            log::info!("Migration v9 applied successfully. Local inventory stock active.");
        }

        // 12. Check if v10 (Clinical Library & Import Batches) has been applied
        let v10_applied: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 10)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !v10_applied {
            log::info!("Applying local offline SQLite migration v10 (Clinical library & import tracking)...");
            Self::migrate_to_v10(conn)?;
            log::info!("Migration v10 applied successfully. Local clinical library active.");
        }

        // 13. Check if v11 (Purge legacy CDCI dataset) has been applied
        let v11_applied: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 11)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !v11_applied {
            log::info!("Applying local offline SQLite migration v11 (Purge CDCI dataset)...");
            Self::migrate_to_v11(conn)?;
            log::info!("Migration v11 applied successfully. Legacy CDCI tables purged.");
        }

        // 14. Check if v12 (Sequential Patient Counters) has been applied
        let v12_applied: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 12)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !v12_applied {
            log::info!("Applying local offline SQLite migration v12 (Sequential patient counters)...");
            let tx = conn.transaction()?;
            tx.execute_batch(MIGRATION_V12_SQL)?;
            tx.execute(
                "INSERT INTO schema_migrations (version, name, checksum) VALUES (?1, ?2, ?3)",
                params![12, "sequential_patient_counters", "v12_seq_counters"],
            )?;
            tx.commit()?;
            log::info!("Migration v12 applied successfully. Sequential patient counters active.");
        }

        // 15. Check if v13 (Patient mutation idempotency) has been applied
        let v13_applied: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 13)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !v13_applied {
            log::info!("Applying local offline SQLite migration v13 (Patient mutation idempotency)...");
            let tx = conn.transaction()?;
            tx.execute_batch(MIGRATION_V13_SQL)?;
            tx.execute(
                "INSERT INTO schema_migrations (version, name, checksum) VALUES (?1, ?2, ?3)",
                params![13, "patient_mutation_idempotency", "v13_mutation_idempotency"],
            )?;
            tx.commit()?;
            log::info!("Migration v13 applied successfully. Patient mutation idempotency active.");
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

    fn migrate_to_v3(conn: &mut Connection) -> Result<(), MigrationError> {
        let tx = conn.transaction()?;

        // 1. Create local_sync_state table and index
        tx.execute_batch(MIGRATION_V3_SQL)?;

        // 2. Check and alter local_sync_conflicts idempotently
        let (has_resolution_payload, has_status) = {
            let mut stmt = tx.prepare("PRAGMA table_info(local_sync_conflicts)")?;
            let mut rows = stmt.query([])?;
            let mut has_res = false;
            let mut has_st = false;
            while let Some(row) = rows.next()? {
                let col_name: String = row.get(1)?;
                if col_name == "resolution_payload" {
                    has_res = true;
                } else if col_name == "status" {
                    has_st = true;
                }
            }
            (has_res, has_st)
        };

        if !has_resolution_payload {
            tx.execute(
                "ALTER TABLE local_sync_conflicts ADD COLUMN resolution_payload TEXT NULL",
                [],
            )?;
        }

        if !has_status {
            tx.execute(
                "ALTER TABLE local_sync_conflicts ADD COLUMN status TEXT NOT NULL DEFAULT 'OPEN'",
                [],
            )?;
        }

        // 3. Create conflict querying indexes
        tx.execute(
            "CREATE INDEX IF NOT EXISTS idx_sync_conflicts_status ON local_sync_conflicts(status)",
            [],
        )?;
        tx.execute(
            "CREATE INDEX IF NOT EXISTS idx_sync_conflicts_entity ON local_sync_conflicts(entity_type, entity_id)",
            [],
        )?;

        // 4. Record migration in schema_migrations
        tx.execute(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES (?1, ?2, ?3)",
            params![3, "sync_engine_state_and_conflicts_v3", "v3_cliniqo_sync_state"],
        )?;

        tx.commit()?;
        Ok(())
    }

    fn migrate_to_v4(conn: &mut Connection) -> Result<(), MigrationError> {
        let tx = conn.transaction()?;
        tx.execute_batch(MIGRATION_V4_SQL)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES (?1, ?2, ?3)",
            params![4, "billing_and_formulary_v4", "v4_cliniqo_billing_formulary_schema"],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn migrate_to_v5(conn: &mut Connection) -> Result<(), MigrationError> {
        let tx = conn.transaction()?;
        tx.execute_batch(MIGRATION_V5_SQL)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES (?1, ?2, ?3)",
            params![5, "catalogue_offline_cache_v5", "v5_cliniqo_catalogue_cache_schema"],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn migrate_to_v6(conn: &mut Connection) -> Result<(), MigrationError> {
        let tx = conn.transaction()?;
        tx.execute_batch(MIGRATION_V6_SQL)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES (?1, ?2, ?3)",
            params![6, "clinic_profile_persistence_v6", "v6_cliniqo_clinic_profile_schema"],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn migrate_to_v7(conn: &mut Connection) -> Result<(), MigrationError> {
        let tx = conn.transaction()?;
        tx.execute_batch(MIGRATION_V7_SQL)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES (?1, ?2, ?3)",
            params![7, "catalogue_product_master_backfill", "v7_cdci_104367_reconciled"],
        )?;
        tx.commit()?;

        // Perform backfill/reconciliation of the local catalogue cache in app runtime
        #[cfg(not(test))]
        if let Err(e) = crate::db::catalogue_seed::reconcile_and_seed_local_catalogue(conn, None) {
            log::warn!("Migration v7 catalogue reconciliation note: {e}");
        }

        Ok(())
    }

    fn migrate_to_v8(conn: &mut Connection) -> Result<(), MigrationError> {
        let tx = conn.transaction()?;
        tx.execute_batch(MIGRATION_V8_SQL)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES (?1, ?2, ?3)",
            params![8, "doctor_profile_persistence_v8", "v8_cliniqo_doctor_profile_schema"],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn migrate_to_v9(conn: &mut Connection) -> Result<(), MigrationError> {
        let tx = conn.transaction()?;
        tx.execute_batch(MIGRATION_V9_SQL)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES (?1, ?2, ?3)",
            params![9, "inventory_stock_tracking_v9", "v9_cliniqo_inventory_stock_schema"],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn migrate_to_v10(conn: &mut Connection) -> Result<(), MigrationError> {
        let tx = conn.transaction()?;
        tx.execute_batch(MIGRATION_V10_SQL)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES (?1, ?2, ?3)",
            params![10, "clinical_library_and_import_batches_v10", "v10_cliniqo_clinical_library_schema"],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn migrate_to_v11(conn: &mut Connection) -> Result<(), MigrationError> {
        let tx = conn.transaction()?;
        tx.execute_batch(MIGRATION_V11_SQL)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES (?1, ?2, ?3)",
            params![11, "purge_cdci_dataset_v11", "v11_cliniqo_purge_cdci_dataset_schema"],
        )?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn get_foreign_keys_status(conn: &Connection) -> i32 {
        conn.query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn test_migration_failure_restores_foreign_keys_and_rolls_back() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        assert_eq!(get_foreign_keys_status(&conn), 1);

        let dek = DatabaseEncryptionKey::new([0x42u8; 32]);

        // 1. Manually insert an unsupported future version in schema_migrations table
        conn.execute(CREATE_MIGRATIONS_TABLE, []).unwrap();
        conn.execute(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES (99, 'future_version', 'checksum99')",
            [],
        )
        .unwrap();

        // 2. Run migrations - should fail due to unsupported version
        let result = MigrationRunner::run_migrations(&mut conn, &dek);
        assert!(matches!(
            result,
            Err(MigrationError::UnsupportedSchemaVersion(99))
        ));

        // 3. Verify foreign_keys pragma is restored to 1 (ON) even on failure path
        assert_eq!(
            get_foreign_keys_status(&conn),
            1,
            "foreign_keys pragma must be restored to ON on failure"
        );

        // 4. Verify connection remains healthy and safe for subsequent queries
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_successful_migrations_preserve_foreign_keys_on() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        assert_eq!(get_foreign_keys_status(&conn), 1);

        let dek = DatabaseEncryptionKey::new([0x55u8; 32]);
        MigrationRunner::run_migrations(&mut conn, &dek).expect("migrations succeed");

        assert_eq!(
            get_foreign_keys_status(&conn),
            1,
            "foreign_keys pragma must remain ON after successful migrations"
        );
    }

    #[test]
    fn test_migration_v5_creates_catalogue_cache() {
        let mut conn = Connection::open_in_memory().unwrap();
        let dek = DatabaseEncryptionKey::new([0x77u8; 32]);
        MigrationRunner::run_migrations(&mut conn, &dek).expect("migrations succeed");

        let max_version: i32 = conn
            .query_row(
                "SELECT MAX(version) FROM schema_migrations",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(max_version >= 11);

        let v7_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 7)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(v7_exists, "Migration v7 must exist after running migrations");

        let v8_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 8)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(v8_exists, "Migration v8 must exist after running migrations");

        let v10_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 10)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(v10_exists, "Migration v10 must exist after running migrations");

        let v11_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 11)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(v11_exists, "Migration v11 must exist after running migrations");

        let table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_catalogue_cache_v1')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!table_exists, "local_catalogue_cache_v1 table must be purged after v11 migration");

        let clinic_table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_clinic_profile')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(clinic_table_exists, "local_clinic_profile table must exist after v6 migration");

        let doctor_table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_doctor_profile')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(doctor_table_exists, "local_doctor_profile table must exist after v8 migration");

        let clinical_lib_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_clinical_library_v1')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(clinical_lib_exists, "local_clinical_library_v1 table must exist after v10 migration");

        let v12_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 12)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(v12_exists, "Migration v12 must exist after running migrations");

        let v13_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 13)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(v13_exists, "Migration v13 must exist after running migrations");

        let idempotency_table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_mutation_idempotency')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(idempotency_table_exists, "local_mutation_idempotency table must exist after v13 migration");
    }

    #[test]
    fn test_migration_v13_creates_missing_idempotency_table_on_existing_v12_database() {
        let mut conn = Connection::open_in_memory().unwrap();
        let dek = DatabaseEncryptionKey::new([0x88u8; 32]);

        // 1. Run migrations to setup initial database
        MigrationRunner::run_migrations(&mut conn, &dek).expect("initial migrations succeed");

        // 2. Simulate existing v1.0.2 database:
        // - schema version is 12 (delete version 13 from schema_migrations)
        // - local_mutation_idempotency is dropped/missing
        // - local_seq_counters is present and seeded with patients up to AAA-0015
        conn.execute("DELETE FROM schema_migrations WHERE version = 13", []).unwrap();
        conn.execute("DROP TABLE IF EXISTS local_mutation_idempotency", []).unwrap();

        let clinic_id = "clinic_v13_sim";

        // Seed sequence counter at 15
        conn.execute(
            "INSERT INTO local_seq_counters (clinic_id, sequence_name, last_seq) VALUES (?1, 'patient', 15)",
            params![clinic_id],
        ).unwrap();

        // Verify state before running migration V13:
        let max_ver: i32 = conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get(0)).unwrap();
        assert_eq!(max_ver, 12, "Database must be simulated at schema version 12");

        let has_idempotency_before: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_mutation_idempotency')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!has_idempotency_before, "local_mutation_idempotency must be missing before V13");

        // 3. Run migrations — V13 must detect missing version 13 and execute cleanly
        MigrationRunner::run_migrations(&mut conn, &dek).expect("migration to V13 succeeds");

        // 4. Verify version 13 recorded and table created
        let max_ver_after: i32 = conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get(0)).unwrap();
        assert_eq!(max_ver_after, 13, "Schema version must now be 13");

        let has_idempotency_after: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_mutation_idempotency')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(has_idempotency_after, "local_mutation_idempotency table must now exist");

        // Verify existing sequence counter state was preserved
        let seq_preserved: u32 = conn
            .query_row(
                "SELECT last_seq FROM local_seq_counters WHERE clinic_id = ?1 AND sequence_name = 'patient'",
                params![clinic_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(seq_preserved, 15, "Sequence counter must remain preserved");

        // 5. Test patient creation for pappu with AAA-0016 and client mutation ID
        use crate::db::operations::DbOperations;
        let next_code = DbOperations::get_next_patient_code(&mut conn, clinic_id).unwrap();
        assert_eq!(next_code, "AAA-0016");

        let pappu_res = DbOperations::insert_patient_ext(
            &mut conn,
            &dek,
            clinic_id,
            "AAA-0016",
            "pappu",
            "",
            "",
            None,
            0,
            &[],
            &[],
            Some(r#"{"registeredAt":"2026-11-17T22:02:00","alternatePhone":"","address":"","ageMonths":0}"#),
            Some("mut_pappu_v13_client_mutation_id"),
        );
        assert!(pappu_res.is_ok(), "Patient pappu creation must succeed with V13 idempotency: {:?}", pappu_res.err());
        let saved_pappu = pappu_res.unwrap();
        assert_eq!(saved_pappu.patient_code, "AAA-0016");

        // 6. Retry the same save and verify idempotency returns existing patient (no duplicates)
        let retry_pappu = DbOperations::insert_patient_ext(
            &mut conn,
            &dek,
            clinic_id,
            "AAA-0016",
            "pappu",
            "",
            "",
            None,
            0,
            &[],
            &[],
            Some(r#"{"registeredAt":"2026-11-17T22:02:00","alternatePhone":"","address":"","ageMonths":0}"#),
            Some("mut_pappu_v13_client_mutation_id"),
        ).expect("Retry succeeds idempotently");
        assert_eq!(retry_pappu.id, saved_pappu.id, "Retry must return identical patient ID");

        // Verify idempotency record in local_mutation_idempotency table
        let (idem_entity_id, idem_code): (String, String) = conn
            .query_row(
                "SELECT entity_id, patient_code FROM local_mutation_idempotency WHERE clinic_id = ?1 AND idempotency_key = ?2",
                params![clinic_id, "mut_pappu_v13_client_mutation_id"],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(idem_entity_id, saved_pappu.id);
        assert_eq!(idem_code, "AAA-0016");
    }

    #[test]
    fn test_failed_migration_does_not_record_version_13() {
        let mut conn = Connection::open_in_memory().unwrap();
        let dek = DatabaseEncryptionKey::new([0x99u8; 32]);

        // Run migrations up to v12
        MigrationRunner::run_migrations(&mut conn, &dek).expect("initial migrations succeed");
        conn.execute("DELETE FROM schema_migrations WHERE version = 13", []).unwrap();

        // Create a conflicting object named local_mutation_idempotency (e.g. as a view) that causes CREATE TABLE to fail
        conn.execute("DROP TABLE IF EXISTS local_mutation_idempotency", []).unwrap();
        conn.execute("CREATE VIEW local_mutation_idempotency AS SELECT 1 AS dummy", []).unwrap();

        // Now run migration with a statement that will fail
        let run_res = (|| -> Result<(), MigrationError> {
            let tx = conn.transaction()?;
            // Trying to create a table with same name as existing view will fail in SQLite
            tx.execute_batch("CREATE TABLE local_mutation_idempotency (dummy TEXT PRIMARY KEY);")?;
            tx.execute(
                "INSERT INTO schema_migrations (version, name, checksum) VALUES (13, 'patient_mutation_idempotency', 'v13_fail_test')",
                [],
            )?;
            tx.commit()?;
            Ok(())
        })();

        assert!(run_res.is_err(), "Conflicting object must cause migration transaction to fail");

        // Verify version 13 was rolled back and is NOT in schema_migrations
        let v13_recorded: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 13)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!v13_recorded, "Version 13 must NOT be recorded when migration fails");
    }
}
