use std::fs;
use std::path::Path;
use aes_gcm::aead::OsRng;
use aes_gcm::aead::rand_core::RngCore;
use hmac::{Hmac, Mac};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use zeroize::Zeroize;

use crate::crypto::{decrypt_payload, encrypt_payload, CryptoError};
use super::migrations::MigrationError;
use super::operations::DatabaseOpError;
use super::DatabaseManager;

type HmacSha256 = Hmac<Sha256>;

pub const BACKUP_MAGIC_V1: &[u8; 18] = b"CLINIQO_BACKUP_V1\0";
pub const FLAG_CLINIC_KEY: u8 = 0;
pub const FLAG_PASSPHRASE: u8 = 1;
pub const CURRENT_SCHEMA_VERSION: i32 = 12;

#[derive(Error, Debug)]
pub enum BackupError {
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("Migration error: {0}")]
    Migration(#[from] MigrationError),

    #[error("Database operation error: {0}")]
    Operation(#[from] DatabaseOpError),

    #[error("Cryptography error: {0}")]
    Crypto(#[from] CryptoError),

    #[error("Filesystem I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Invalid backup format: {0}")]
    InvalidFormat(String),

    #[error("Integrity check failed: {0}")]
    IntegrityCheckFailed(String),

    #[error("Database restore failed: {0}")]
    RestoreFailed(String),

    #[error("Unsupported backup schema version: backup is version {0}, client supports up to {1}")]
    UnsupportedVersion(i32, i32),

    #[error("Authentication failed: {0}")]
    AuthFailed(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupManifest {
    pub magic: String,
    pub version: u32,
    pub clinic_id: String,
    pub created_at: String,
    pub app_version: String,
    pub schema_version: i32,
    pub patients_count: u64,
    pub consultations_count: u64,
    pub prescriptions_count: u64,
    pub invoices_count: u64,
    pub outbox_count: u64,
    pub db_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupExportResult {
    pub success: bool,
    pub backup_file_name: String,
    pub backup_file_path: Option<String>,
    pub backup_bytes_base64: Option<String>,
    pub manifest: BackupManifest,
    pub file_size_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupRestoreResult {
    pub success: bool,
    pub restored_at: String,
    pub clinic_id: String,
    pub manifest: BackupManifest,
    pub patients_count: u64,
    pub consultations_count: u64,
    pub prescriptions_count: u64,
    pub invoices_count: u64,
}

pub struct BackupManager;

impl BackupManager {
    /// Derives an encryption key from a user passphrase and a 16-byte salt using PBKDF2-HMAC-SHA256.
    pub fn derive_key_from_passphrase(passphrase: &str, salt: &[u8; 16], rounds: u32) -> [u8; 32] {
        let mut mac = HmacSha256::new_from_slice(passphrase.as_bytes()).expect("HMAC supports any key size");
        mac.update(salt);
        mac.update(&1u32.to_be_bytes());
        let mut u = mac.finalize().into_bytes();
        let mut result = u;

        for _ in 1..rounds {
            let mut inner = HmacSha256::new_from_slice(passphrase.as_bytes()).expect("HMAC supports any key size");
            inner.update(&u);
            u = inner.finalize().into_bytes();
            for (r, byte) in result.iter_mut().zip(u.iter()) {
                *r ^= byte;
            }
        }

        let mut key = [0u8; 32];
        key.copy_from_slice(&result);
        key
    }

    /// Derives a backup encryption key from the local Database Encryption Key (DEK) and salt.
    pub fn derive_key_from_dek(dek: &[u8; 32], clinic_id: &str, salt: &[u8; 16]) -> [u8; 32] {
        let mut mac = HmacSha256::new_from_slice(dek).expect("HMAC supports 32-byte key");
        mac.update(b"CLINIQO_BACKUP_KEY_V1");
        mac.update(clinic_id.as_bytes());
        mac.update(salt);
        let bytes = mac.finalize().into_bytes();
        let mut key = [0u8; 32];
        key.copy_from_slice(&bytes);
        key
    }

    /// Exports an encrypted SQLite backup to file or returns base64-encoded package.
    pub fn export_backup(
        db: &DatabaseManager,
        clinic_id: &str,
        passphrase: Option<&str>,
        destination_path: Option<&Path>,
    ) -> Result<BackupExportResult, BackupError> {
        if clinic_id.trim().is_empty() {
            return Err(BackupError::AuthFailed("Clinic ID cannot be empty".to_string()));
        }

        let temp_dir = std::env::temp_dir().join(format!("cliniqo_export_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir)?;
        let vacuum_path = temp_dir.join("vacuumed.db");

        // 1. Take a safe point-in-time snapshot of the database using VACUUM INTO
        {
            let conn = db.get_connection();
            // SQLite VACUUM INTO flushes and merges WAL journal into a single consistent standalone file
            let vacuum_path_str = vacuum_path.to_str().ok_or_else(|| {
                BackupError::InvalidFormat("Vacuum destination path contains invalid UTF-8".to_string())
            })?;
            conn.execute("VACUUM INTO ?", rusqlite::params![vacuum_path_str])?;
        }

        // 2. Read the vacuumed database bytes and compute SHA-256 checksum
        let db_bytes = fs::read(&vacuum_path)?;
        let mut sha256_hasher = Sha256::new();
        sha256_hasher.update(&db_bytes);
        let db_sha256 = format!("{:x}", sha256_hasher.finalize());

        // 3. Query clinical and sync record counts for the manifest
        let (patients_count, consultations_count, prescriptions_count, invoices_count, outbox_count, schema_version) = {
            let conn = db.get_connection();
            let p_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM local_patients WHERE clinic_id = ?",
                    [clinic_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            let c_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM local_consultations WHERE clinic_id = ?",
                    [clinic_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            let rx_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM local_prescriptions WHERE clinic_id = ?",
                    [clinic_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            let inv_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM local_invoices WHERE clinic_id = ?",
                    [clinic_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            let ob_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM local_sync_outbox WHERE clinic_id = ?",
                    [clinic_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            let s_ver: i32 = conn
                .query_row(
                    "SELECT COALESCE(MAX(version), 12) FROM schema_migrations",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(CURRENT_SCHEMA_VERSION);

            (
                p_count.max(0) as u64,
                c_count.max(0) as u64,
                rx_count.max(0) as u64,
                inv_count.max(0) as u64,
                ob_count.max(0) as u64,
                s_ver,
            )
        };

        // 4. Construct manifest metadata
        let manifest = BackupManifest {
            magic: "CLINIQO_BACKUP".to_string(),
            version: 1,
            clinic_id: clinic_id.to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            schema_version,
            patients_count,
            consultations_count,
            prescriptions_count,
            invoices_count,
            outbox_count,
            db_sha256,
        };

        let manifest_bytes = serde_json::to_vec(&manifest)?;

        // 5. Build unencrypted payload bundle:
        // [manifest_length: 4 bytes BE] + [manifest_json] + [database_sqlite_bytes]
        let mut bundle = Vec::with_capacity(4 + manifest_bytes.len() + db_bytes.len());
        bundle.extend_from_slice(&(manifest_bytes.len() as u32).to_be_bytes());
        bundle.extend_from_slice(&manifest_bytes);
        bundle.extend_from_slice(&db_bytes);

        // 6. Generate random 16-byte salt and derive encryption key
        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);

        let (mut key, flag) = if let Some(pass) = passphrase.filter(|p| !p.trim().is_empty()) {
            (Self::derive_key_from_passphrase(pass.trim(), &salt, 100_000), FLAG_PASSPHRASE)
        } else {
            (Self::derive_key_from_dek(&db.get_dek().key, clinic_id, &salt), FLAG_CLINIC_KEY)
        };

        // 7. Encrypt payload bundle with AES-256-GCM
        let (ciphertext, nonce) = encrypt_payload(&key, &bundle)?;
        key.zeroize();

        // 8. Assemble final backup container:
        // [MAGIC: 18 bytes] + [FLAG: 1 byte] + [SALT: 16 bytes] + [NONCE: 12 bytes] + [CIPHERTEXT + TAG]
        let mut container = Vec::with_capacity(BACKUP_MAGIC_V1.len() + 1 + salt.len() + nonce.len() + ciphertext.len());
        container.extend_from_slice(BACKUP_MAGIC_V1);
        container.push(flag);
        container.extend_from_slice(&salt);
        container.extend_from_slice(&nonce);
        container.extend_from_slice(&ciphertext);

        // 9. Save backup file to destination or default backup path
        let timestamp_str = chrono::Utc::now().format("%Y%m%d_%H%M%S").to_string();
        let backup_file_name = format!("cliniqo_backup_{}_{}.clxbk", clinic_id, timestamp_str);

        let final_path = if let Some(p) = destination_path {
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(p, &container)?;
            Some(p.to_string_lossy().to_string())
        } else {
            let app_data_dir = db.get_db_path().parent().and_then(|p| p.parent()).unwrap_or_else(|| Path::new("."));
            let backup_dir = app_data_dir.join("backups");
            fs::create_dir_all(&backup_dir)?;
            let p = backup_dir.join(&backup_file_name);
            fs::write(&p, &container)?;
            Some(p.to_string_lossy().to_string())
        };

        let file_size_bytes = container.len();
        let backup_bytes_base64 = Some(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &container));

        // Clean up temporary vacuum directory
        let _ = fs::remove_dir_all(&temp_dir);

        Ok(BackupExportResult {
            success: true,
            backup_file_name,
            backup_file_path: final_path,
            backup_bytes_base64,
            manifest,
            file_size_bytes,
        })
    }

    /// Verifies and restores an encrypted SQLite backup package.
    pub fn restore_backup(
        db: &DatabaseManager,
        backup_bytes: &[u8],
        expected_clinic_id: Option<&str>,
        passphrase: Option<&str>,
    ) -> Result<BackupRestoreResult, BackupError> {
        // Minimum container length: magic(18) + flag(1) + salt(16) + nonce(12) + tag(16) = 63 bytes
        if backup_bytes.len() < 63 {
            return Err(BackupError::InvalidFormat(
                "Backup file is too short to be a valid Cliniqo encrypted backup".to_string(),
            ));
        }

        // 1. Verify magic header
        if &backup_bytes[..18] != BACKUP_MAGIC_V1 {
            return Err(BackupError::InvalidFormat(
                "Invalid backup header: file does not match Cliniqo backup format".to_string(),
            ));
        }

        let flag = backup_bytes[18];
        let mut salt = [0u8; 16];
        salt.copy_from_slice(&backup_bytes[19..35]);

        let nonce = &backup_bytes[35..47];
        let ciphertext = &backup_bytes[47..];

        // 2. Derive key based on encryption flag
        let mut key = match flag {
            FLAG_PASSPHRASE => {
                let pass = passphrase
                    .map(|p| p.trim())
                    .filter(|p| !p.is_empty())
                    .ok_or_else(|| {
                        BackupError::AuthFailed(
                            "This backup is protected with a passphrase. Please enter the backup passphrase."
                                .to_string(),
                        )
                    })?;
                Self::derive_key_from_passphrase(pass, &salt, 100_000)
            }
            FLAG_CLINIC_KEY => {
                let clinic = expected_clinic_id.unwrap_or("");
                Self::derive_key_from_dek(&db.get_dek().key, clinic, &salt)
            }
            unknown => {
                return Err(BackupError::InvalidFormat(format!(
                    "Unrecognized backup encryption flag: {unknown}"
                )));
            }
        };

        // 3. Decrypt bundle with AES-256-GCM (validates cryptographic authentication tag)
        let decrypted_bundle = decrypt_payload(&key, ciphertext, nonce).map_err(|_| {
            key.zeroize();
            BackupError::IntegrityCheckFailed(
                "Cryptographic verification failed: incorrect passphrase or corrupted backup file.".to_string(),
            )
        })?;
        key.zeroize();

        // 4. Parse bundle: [manifest_length: 4 bytes BE] + [manifest_json] + [database_sqlite_bytes]
        if decrypted_bundle.len() < 4 {
            return Err(BackupError::InvalidFormat("Decrypted bundle corrupted: missing length header".to_string()));
        }

        let manifest_len = u32::from_be_bytes([
            decrypted_bundle[0],
            decrypted_bundle[1],
            decrypted_bundle[2],
            decrypted_bundle[3],
        ]) as usize;

        if decrypted_bundle.len() < 4 + manifest_len {
            return Err(BackupError::InvalidFormat("Decrypted bundle corrupted: incomplete manifest payload".to_string()));
        }

        let manifest_bytes = &decrypted_bundle[4..4 + manifest_len];
        let manifest: BackupManifest = serde_json::from_slice(manifest_bytes)?;
        let db_bytes = &decrypted_bundle[4 + manifest_len..];

        // 5. Verify database SHA-256 checksum against manifest
        let mut sha256_hasher = Sha256::new();
        sha256_hasher.update(db_bytes);
        let actual_db_sha256 = format!("{:x}", sha256_hasher.finalize());

        if actual_db_sha256 != manifest.db_sha256 {
            return Err(BackupError::IntegrityCheckFailed(format!(
                "Database checksum mismatch: manifest expected {}, found {}",
                manifest.db_sha256, actual_db_sha256
            )));
        }

        // 6. Verify schema version compatibility
        if manifest.schema_version > CURRENT_SCHEMA_VERSION {
            return Err(BackupError::UnsupportedVersion(
                manifest.schema_version,
                CURRENT_SCHEMA_VERSION,
            ));
        }

        // 7. Test SQLite file integrity in an isolated temporary connection
        let temp_dir = std::env::temp_dir().join(format!("cliniqo_restore_val_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir)?;
        let temp_test_db = temp_dir.join("test_restore.db");
        fs::write(&temp_test_db, db_bytes)?;

        {
            let test_conn = Connection::open(&temp_test_db)?;
            let integrity_status: String = test_conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
            if integrity_status.to_lowercase() != "ok" {
                let _ = fs::remove_dir_all(&temp_dir);
                return Err(BackupError::IntegrityCheckFailed(format!(
                    "SQLite integrity check failed on backup database: {integrity_status}"
                )));
            }
        }

        // 8. Safely perform in-place atomic restore using SQLite's online backup API
        db.replace_database(&temp_test_db).map_err(|e| {
            let _ = fs::remove_dir_all(&temp_dir);
            BackupError::RestoreFailed(format!("Failed to replace database: {e}"))
        })?;

        let _ = fs::remove_dir_all(&temp_dir);

        Ok(BackupRestoreResult {
            success: true,
            restored_at: chrono::Utc::now().to_rfc3339(),
            clinic_id: manifest.clinic_id.clone(),
            patients_count: manifest.patients_count,
            consultations_count: manifest.consultations_count,
            prescriptions_count: manifest.prescriptions_count,
            invoices_count: manifest.invoices_count,
            manifest,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Arc;
    use crate::db::operations::DbOperations;

    fn setup_test_db(prefix: &str) -> (Arc<DatabaseManager>, PathBuf) {
        let temp_dir = std::env::temp_dir().join(format!("{}_{}", prefix, uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).unwrap();
        let db = Arc::new(DatabaseManager::init(&temp_dir).unwrap());
        (db, temp_dir)
    }

    #[test]
    fn test_backup_export_and_restore_roundtrip_preserves_clinical_records() {
        let (db, temp_dir) = setup_test_db("cliniqo_test_backup_rt");
        let clinic_id = "clinic_alpha";

        // Insert patient record
        let patient_id = {
            let mut conn = db.get_connection();
            DbOperations::insert_patient(
                &mut conn,
                db.get_dek(),
                clinic_id,
                "PT-INIT",
                "Ananya Iyer",
                "+919876543210",
                "Female",
                Some("1992-05-15"),
                34,
                &["Penicillin".to_string()],
                &["Asthma".to_string()],
                Some("Private clinical note"),
            )
            .expect("Insert patient succeeds")
        };

        // Export one-click backup
        let export_res = BackupManager::export_backup(&db, clinic_id, None, None)
            .expect("Export backup succeeds");

        assert!(export_res.success);
        assert_eq!(export_res.manifest.clinic_id, clinic_id);
        assert_eq!(export_res.manifest.patients_count, 1);
        let backup_path = export_res.backup_file_path.expect("Backup path returned");

        // Read the backup file bytes and verify zero plaintext
        let backup_file_bytes = fs::read(&backup_path).expect("Read backup file succeeds");
        assert_eq!(&backup_file_bytes[..18], BACKUP_MAGIC_V1);
        assert_eq!(backup_file_bytes[18], FLAG_CLINIC_KEY);

        // Security assertion: raw backup MUST NOT contain plaintext patient name or phone
        let backup_raw_str = String::from_utf8_lossy(&backup_file_bytes);
        assert!(!backup_raw_str.contains("Ananya Iyer"), "Backup must never leak plaintext patient name");
        assert!(!backup_raw_str.contains("+919876543210"), "Backup must never leak plaintext patient phone");
        assert!(!backup_raw_str.contains("Private clinical note"), "Backup must never leak sensitive notes");

        // Now modify the database (delete the patient or simulate loss)
        {
            let mut conn = db.get_connection();
            DbOperations::delete_patient(&mut conn, db.get_dek(), clinic_id, &patient_id).expect("Delete patient succeeds");
            let patients = DbOperations::get_patients(&conn, db.get_dek(), clinic_id).unwrap();
            assert_eq!(patients.len(), 0, "Patient should be deleted before restore");
        }

        // Restore from the backup file
        let restore_res = BackupManager::restore_backup(&db, &backup_file_bytes, Some(clinic_id), None)
            .expect("Restore backup succeeds");

        assert!(restore_res.success);
        assert_eq!(restore_res.patients_count, 1);

        // Verify patient record is restored and readable with the DEK
        {
            let conn = db.get_connection();
            let patients = DbOperations::get_patients(&conn, db.get_dek(), clinic_id).unwrap();
            assert_eq!(patients.len(), 1);
            assert_eq!(patients[0].id, patient_id);
            assert_eq!(patients[0].name, "Ananya Iyer");
            assert_eq!(patients[0].phone, "+919876543210");
            assert_eq!(patients[0].allergies, vec!["Penicillin"]);
        }

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_backup_with_passphrase_and_wrong_passphrase_rejection() {
        let (db, temp_dir) = setup_test_db("cliniqo_test_backup_pass");
        let clinic_id = "clinic_beta";
        let passphrase = "DoctorSecretPassword2026!";

        // Insert patient
        {
            let mut conn = db.get_connection();
            DbOperations::insert_patient(
                &mut conn,
                db.get_dek(),
                clinic_id,
                "PT-INIT",
                "Vikram Mehta",
                "+919820411882",
                "Male",
                None,
                45,
                &[],
                &[],
                None,
            )
            .expect("Insert succeeds");
        }

        // Export password-protected backup
        let export_res = BackupManager::export_backup(&db, clinic_id, Some(passphrase), None)
            .expect("Export succeeds");

        let backup_path = export_res.backup_file_path.unwrap();
        let backup_file_bytes = fs::read(&backup_path).unwrap();
        assert_eq!(backup_file_bytes[18], FLAG_PASSPHRASE);

        // 1. Attempt restore with WRONG password
        let wrong_res = BackupManager::restore_backup(&db, &backup_file_bytes, Some(clinic_id), Some("WrongPassword"));
        assert!(wrong_res.is_err(), "Restore with incorrect passphrase must fail");

        // 2. Attempt restore with MISSING password
        let missing_res = BackupManager::restore_backup(&db, &backup_file_bytes, Some(clinic_id), None);
        assert!(missing_res.is_err(), "Restore without passphrase for password-protected backup must fail");

        // 3. Attempt restore with CORRECT password
        let correct_res = BackupManager::restore_backup(&db, &backup_file_bytes, Some(clinic_id), Some(passphrase));
        assert!(correct_res.is_ok(), "Restore with correct passphrase must succeed");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_backup_tamper_detection_fails_closed() {
        let (db, temp_dir) = setup_test_db("cliniqo_test_backup_tamper");
        let clinic_id = "clinic_gamma";

        let export_res = BackupManager::export_backup(&db, clinic_id, None, None).unwrap();
        let backup_path = export_res.backup_file_path.unwrap();
        let mut backup_bytes = fs::read(&backup_path).unwrap();

        // Tamper with one byte in the ciphertext payload
        let last_idx = backup_bytes.len() - 5;
        backup_bytes[last_idx] ^= 0xFF;

        let restore_res = BackupManager::restore_backup(&db, &backup_bytes, Some(clinic_id), None);
        assert!(restore_res.is_err(), "Tampered backup must be rejected by AEAD authentication tag");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_backup_includes_sync_outbox_and_sequence_counters() {
        let (db, temp_dir) = setup_test_db("cliniqo_test_backup_sync");
        let clinic_id = "clinic_delta";

        // Insert patient which allocates sequential patient ID and queues sync outbox mutation
        let patient_id = {
            let mut conn = db.get_connection();
            DbOperations::insert_patient(
                &mut conn,
                db.get_dek(),
                clinic_id,
                "PT-INIT",
                "Priya Sharma",
                "+919811223344",
                "Female",
                Some("1988-10-20"),
                38,
                &[],
                &[],
                None,
            )
            .unwrap()
        };

        // Enqueue an outbox record to verify outbox backup inclusion
        {
            let conn = db.get_connection();
            let dek = db.get_dek();
            let (enc, nonce) = crate::crypto::encrypt_payload(&dek.key, b"{}").unwrap();
            conn.execute(
                "INSERT INTO local_sync_outbox (id, clinic_id, entity_type, entity_id, action, idempotency_key, encrypted_payload, nonce, sync_status) VALUES ('outbox_bk_1', ?1, 'CLINIC_PROFILE', 'c1', 'UPDATE', 'idem_bk', ?2, ?3, 'PENDING')",
                rusqlite::params![clinic_id, enc, nonce],
            ).unwrap();
        }

        // Export backup
        let export_res = BackupManager::export_backup(&db, clinic_id, None, None).unwrap();
        assert_eq!(export_res.manifest.patients_count, 1);
        assert_eq!(export_res.manifest.outbox_count, 1);

        let backup_bytes = fs::read(export_res.backup_file_path.unwrap()).unwrap();

        // Simulate complete database reset
        {
            let conn = db.get_connection();
            conn.execute("DELETE FROM local_patients", []).unwrap();
            conn.execute("DELETE FROM local_sync_outbox", []).unwrap();
            conn.execute("DELETE FROM local_seq_counters", []).unwrap();

            assert_eq!(DbOperations::get_patients(&conn, db.get_dek(), clinic_id).unwrap().len(), 0);
            assert_eq!(DbOperations::get_outbox_summary(&conn, clinic_id).unwrap().pending_count, 0);
        }

        // Restore backup
        let restore_res = BackupManager::restore_backup(&db, &backup_bytes, Some(clinic_id), None).unwrap();
        assert!(restore_res.success);

        // Verify restored state: patient restored, sync outbox mutation restored, sequence counter preserved
        {
            let mut conn = db.get_connection();
            let patients = DbOperations::get_patients(&conn, db.get_dek(), clinic_id).unwrap();
            assert_eq!(patients.len(), 1);
            assert_eq!(patients[0].id, patient_id);

            let outbox = DbOperations::get_outbox_summary(&conn, clinic_id).unwrap();
            assert_eq!(outbox.pending_count, 1);

            // Verify next sequential patient ID continues sequentially from restored counter (no duplication)
            let next_code = DbOperations::get_next_patient_code(&mut conn, clinic_id).unwrap();
            assert_eq!(next_code, "AAA-0002");
        }

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
