use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
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
pub const CURRENT_SCHEMA_VERSION: i32 = 14;
pub const AUTO_BACKUP_PREFIX: &str = "cliniqo_autobackup_";
pub const MANUAL_BACKUP_PREFIX: &str = "cliniqo_backup_";
const MIN_FREE_DISK_MARGIN_BYTES: u64 = 5 * 1024 * 1024;

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

    #[error("Backup operation already in progress")]
    AlreadyRunning,

    #[error("Insufficient disk space for encrypted backup: {0}")]
    LowDiskSpace(String),
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AutoBackupConfig {
    pub enabled: bool,
    pub interval_hours: u32,
    pub max_retained: usize,
}

impl Default for AutoBackupConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_hours: 24,
            max_retained: 7,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalBackupEntry {
    pub file_name: String,
    pub file_path: String,
    pub size_bytes: u64,
    pub created_at: String,
    pub is_auto: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoBackupPersistedState {
    pub last_backup_at: Option<String>,
    pub last_status: String,
    pub last_error: Option<String>,
    pub last_file_path: Option<String>,
}

impl Default for AutoBackupPersistedState {
    fn default() -> Self {
        Self {
            last_backup_at: None,
            last_status: "idle".to_string(),
            last_error: None,
            last_file_path: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoBackupStatus {
    pub config: AutoBackupConfig,
    pub is_running: bool,
    pub last_backup_at: Option<String>,
    pub last_status: String,
    pub last_error: Option<String>,
    pub last_file_path: Option<String>,
    pub retained_count: usize,
    pub manual_count: usize,
    pub backup_directory: String,
    pub backups: Vec<LocalBackupEntry>,
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

    /// Resolves the default backup directory: Documents/Cliniqo/Backups/
    ///
    /// Precedence for resolving the Documents folder:
    /// 1. Provided `documents_dir` override (e.g. from Tauri's AppHandle `app.path().document_dir()`).
    /// 2. `CLINIQO_DOCUMENTS_DIR` environment variable (for testing and manual overrides).
    /// 3. OS environment resolution:
    ///    - On Windows: `%USERPROFILE%\Documents` (or `%HOMEDRIVE%%HOMEPATH%\Documents`).
    ///    - On macOS / Unix: `$HOME/Documents`.
    /// 4. Fallback: temporary directory / `Documents`.
    pub fn resolve_default_backup_directory(documents_dir: Option<&Path>) -> PathBuf {
        let docs = if let Some(d) = documents_dir {
            d.to_path_buf()
        } else if let Ok(env_docs) = std::env::var("CLINIQO_DOCUMENTS_DIR") {
            PathBuf::from(env_docs)
        } else {
            Self::get_system_documents_dir()
        };

        docs.join("Cliniqo").join("Backups")
    }

    /// Resolves the operating system's Documents directory without requiring a Tauri AppHandle.
    pub fn get_system_documents_dir() -> PathBuf {
        #[cfg(target_os = "windows")]
        {
            if let Ok(user_profile) = std::env::var("USERPROFILE") {
                return PathBuf::from(user_profile).join("Documents");
            }
            if let (Ok(drive), Ok(path)) = (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH")) {
                return PathBuf::from(format!("{}{}", drive, path)).join("Documents");
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            if let Ok(home) = std::env::var("HOME") {
                return PathBuf::from(home).join("Documents");
            }
        }

        std::env::temp_dir().join("Documents")
    }

    /// Exports an encrypted SQLite backup to file or returns base64-encoded package.
    pub fn export_backup(
        db: &DatabaseManager,
        clinic_id: &str,
        passphrase: Option<&str>,
        destination_path: Option<&Path>,
    ) -> Result<BackupExportResult, BackupError> {
        Self::export_backup_with_documents_dir(db, clinic_id, passphrase, destination_path, None)
    }

    /// Exports an encrypted SQLite backup with an explicit Documents directory base.
    pub fn export_backup_with_documents_dir(
        db: &DatabaseManager,
        clinic_id: &str,
        passphrase: Option<&str>,
        destination_path: Option<&Path>,
        documents_dir: Option<&Path>,
    ) -> Result<BackupExportResult, BackupError> {
        let _lock = db.try_acquire_backup_lock().ok_or(BackupError::AlreadyRunning)?;
        Self::export_backup_internal(
            db,
            clinic_id,
            passphrase,
            destination_path,
            documents_dir,
            MANUAL_BACKUP_PREFIX,
            None,
        )
    }

    fn export_backup_internal(
        db: &DatabaseManager,
        clinic_id: &str,
        passphrase: Option<&str>,
        destination_path: Option<&Path>,
        documents_dir: Option<&Path>,
        file_prefix: &str,
        available_space_override: Option<u64>,
    ) -> Result<BackupExportResult, BackupError> {
        if clinic_id.trim().is_empty() {
            return Err(BackupError::AuthFailed("Clinic ID cannot be empty".to_string()));
        }

        let target_dir_for_space = if let Some(p) = destination_path {
            p.parent().unwrap_or_else(|| Path::new(".")).to_path_buf()
        } else {
            Self::resolve_default_backup_directory(documents_dir)
        };
        fs::create_dir_all(&target_dir_for_space)?;
        Self::cleanup_stale_temp_files(&target_dir_for_space);

        // Estimate required disk space cleanly before creating temporary snapshots
        let estimated_db_size = fs::metadata(db.get_db_path()).map(|m| m.len()).unwrap_or(0);
        let min_required = estimated_db_size.saturating_add(MIN_FREE_DISK_MARGIN_BYTES);
        if let Some(avail) = available_space_override.or_else(|| Self::get_available_disk_bytes(&target_dir_for_space)) {
            if avail < min_required {
                return Err(BackupError::LowDiskSpace(format!(
                    "Only {} bytes available on backup drive; at least {} bytes required.",
                    avail, min_required
                )));
            }
        }

        let temp_dir = std::env::temp_dir().join(format!("cliniqo_export_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir)?;
        let vacuum_path = temp_dir.join("vacuumed.db");

        // 1. Take a safe point-in-time WAL-flushed snapshot of the database using VACUUM INTO
        {
            let conn = db.get_connection();
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);");
            let vacuum_path_str = vacuum_path.to_str().ok_or_else(|| {
                BackupError::InvalidFormat("Vacuum destination path contains invalid UTF-8".to_string())
            })?;
            if let Err(e) = conn.execute("VACUUM INTO ?", rusqlite::params![vacuum_path_str]) {
                let _ = fs::remove_dir_all(&temp_dir);
                return Err(BackupError::Database(e));
            }
        }

        // 2. Read the vacuumed database bytes and compute SHA-256 checksum
        let db_bytes = fs::read(&vacuum_path).map_err(|e| {
            let _ = fs::remove_dir_all(&temp_dir);
            BackupError::Io(e)
        })?;
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
                    "SELECT COUNT(*) FROM local_invoices_v2 WHERE clinic_id = ?",
                    [clinic_id],
                    |r| r.get(0),
                )
                .unwrap_or_else(|_| {
                    conn.query_row(
                        "SELECT COUNT(*) FROM local_invoices WHERE clinic_id = ?",
                        [clinic_id],
                        |r| r.get(0),
                    )
                    .unwrap_or(0)
                });

            let ob_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM local_sync_outbox WHERE clinic_id = ?",
                    [clinic_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            let s_ver: i32 = conn
                .query_row(
                    "SELECT COALESCE(MAX(version), 13) FROM schema_migrations",
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

        // Verify actual container bytes fit on target filesystem before staging write
        if let Some(avail) = available_space_override.or_else(|| Self::get_available_disk_bytes(&target_dir_for_space)) {
            let needed = (container.len() as u64).saturating_add(1024 * 1024);
            if avail < needed {
                let _ = fs::remove_dir_all(&temp_dir);
                return Err(BackupError::LowDiskSpace(format!(
                    "Only {} bytes available on backup drive; backup requires {} bytes.",
                    avail, needed
                )));
            }
        }

        // 9. Atomically save backup file to destination or default backup path (Documents/Cliniqo/Backups/)
        let timestamp_str = chrono::Utc::now().format("%Y%m%d_%H%M%S").to_string();
        let mut backup_file_name = format!("{}{}_{}.clxbk", file_prefix, clinic_id, timestamp_str);

        let final_path = if let Some(p) = destination_path {
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent)?;
            }
            Self::write_container_atomically(p, &container)?;
            Some(p.to_string_lossy().to_string())
        } else {
            let backup_dir = Self::resolve_default_backup_directory(documents_dir);
            fs::create_dir_all(&backup_dir)?;

            let mut final_file_path = backup_dir.join(&backup_file_name);
            if final_file_path.exists() {
                let mut counter = 1;
                loop {
                    let candidate_name = format!("{}{}_{}_{}.clxbk", file_prefix, clinic_id, timestamp_str, counter);
                    let candidate_path = backup_dir.join(&candidate_name);
                    if !candidate_path.exists() {
                        final_file_path = candidate_path;
                        backup_file_name = candidate_name;
                        break;
                    }
                    counter += 1;
                }
            }

            Self::write_container_atomically(&final_file_path, &container)?;
            log::info!("Encrypted backup successfully exported atomically to: {:?}", final_file_path);
            Some(final_file_path.to_string_lossy().to_string())
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

    fn write_container_atomically(target_path: &Path, bytes: &[u8]) -> Result<(), BackupError> {
        let tmp_name = format!(
            "{}.tmp.{}",
            target_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("backup.clxbk"),
            uuid::Uuid::new_v4()
        );
        let tmp_path = target_path.with_file_name(tmp_name);

        let write_result: Result<(), BackupError> = (|| {
            let mut file = File::create(&tmp_path).map_err(Self::map_disk_io_error)?;
            file.write_all(bytes).map_err(Self::map_disk_io_error)?;
            file.sync_all().map_err(Self::map_disk_io_error)?;
            drop(file);

            let meta = fs::metadata(&tmp_path).map_err(Self::map_disk_io_error)?;
            if meta.len() != bytes.len() as u64 {
                return Err(BackupError::Io(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "Staged backup file length mismatch",
                )));
            }
            fs::rename(&tmp_path, target_path).map_err(Self::map_disk_io_error)?;
            Ok(())
        })();

        if let Err(err) = write_result {
            let _ = fs::remove_file(&tmp_path);
            return Err(err);
        }
        Ok(())
    }

    fn map_disk_io_error(err: std::io::Error) -> BackupError {
        let raw = err.raw_os_error();
        let is_disk_full = raw == Some(28) || raw == Some(112) || raw == Some(39);
        if is_disk_full || err.to_string().to_lowercase().contains("no space left") {
            BackupError::LowDiskSpace(err.to_string())
        } else {
            BackupError::Io(err)
        }
    }

    fn cleanup_stale_temp_files(backup_dir: &Path) {
        if let Ok(entries) = fs::read_dir(backup_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.contains(".clxbk.tmp.") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    fn get_available_disk_bytes(dir: &Path) -> Option<u64> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

        let wide: Vec<u16> = dir
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut free_bytes: u64 = 0;
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut free_bytes as *mut u64,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if ok != 0 {
            Some(free_bytes)
        } else {
            None
        }
    }

    #[cfg(not(target_os = "windows"))]
    fn get_available_disk_bytes(_dir: &Path) -> Option<u64> {
        None
    }

    /// Validates an encrypted backup package without modifying the active database.
    pub fn verify_backup_package(
        db: &DatabaseManager,
        backup_bytes: &[u8],
        expected_clinic_id: Option<&str>,
        passphrase: Option<&str>,
    ) -> Result<(BackupManifest, Vec<u8>), BackupError> {
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
        let db_bytes = decrypted_bundle[4 + manifest_len..].to_vec();

        if let Some(expected_clinic) = expected_clinic_id.map(str::trim).filter(|c| !c.is_empty()) {
            if manifest.clinic_id != expected_clinic {
                return Err(BackupError::AuthFailed(format!(
                    "Backup belongs to clinic '{}' and cannot overwrite active clinic '{}'.",
                    manifest.clinic_id, expected_clinic
                )));
            }
        }

        // 5. Verify database SHA-256 checksum against manifest
        let mut sha256_hasher = Sha256::new();
        sha256_hasher.update(&db_bytes);
        let actual_db_sha256 = format!("{:x}", sha256_hasher.finalize());

        if actual_db_sha256 != manifest.db_sha256 {
            return Err(BackupError::IntegrityCheckFailed(format!(
                "Database checksum mismatch: manifest expected {}, found {}",
                manifest.db_sha256, actual_db_sha256
            )));
        }

        // 6. Verify schema version compatibility
        if manifest.schema_version < 1 || manifest.schema_version > CURRENT_SCHEMA_VERSION {
            return Err(BackupError::UnsupportedVersion(
                manifest.schema_version,
                CURRENT_SCHEMA_VERSION,
            ));
        }

        Ok((manifest, db_bytes))
    }

    fn verify_staged_database_integrity_and_dek(
        temp_test_db: &Path,
        db: &DatabaseManager,
    ) -> Result<(), BackupError> {
        let test_conn = Connection::open(temp_test_db)?;
        let integrity_status: String = test_conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if !integrity_status.eq_ignore_ascii_case("ok") {
            return Err(BackupError::IntegrityCheckFailed(format!(
                "SQLite integrity check failed on backup database: {integrity_status}"
            )));
        }

        let fk_violations = {
            let mut stmt = test_conn.prepare("PRAGMA foreign_key_check")?;
            let count = stmt.query_map([], |_| Ok(()))?.count();
            count
        };
        if fk_violations > 0 {
            return Err(BackupError::IntegrityCheckFailed(format!(
                "Foreign key consistency check failed on backup database ({fk_violations} violation(s))"
            )));
        }

        // Verify local DPAPI DEK can decrypt inner SQLite rows before touching live database
        let dek = &db.get_dek().key;
        if let Ok(mut stmt) = test_conn.prepare("SELECT encrypted_demographics, nonce FROM local_patients LIMIT 1") {
            if let Ok(mut rows) = stmt.query([]) {
                if let Ok(Some(row)) = rows.next() {
                    let enc: Vec<u8> = row.get(0)?;
                    let nonce: Vec<u8> = row.get(1)?;
                    if decrypt_payload(dek, &enc, &nonce).is_err() {
                        return Err(BackupError::AuthFailed(
                            "Database encryption key mismatch: this backup was encrypted with a different local DPAPI installation key and cannot be decrypted on this machine without the original key."
                                .to_string(),
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    /// Verifies and restores an encrypted SQLite backup package atomically with rollback safety.
    pub fn restore_backup(
        db: &DatabaseManager,
        backup_bytes: &[u8],
        expected_clinic_id: Option<&str>,
        passphrase: Option<&str>,
    ) -> Result<BackupRestoreResult, BackupError> {
        let _lock = db.try_acquire_backup_lock().ok_or(BackupError::AlreadyRunning)?;
        let (manifest, db_bytes) =
            Self::verify_backup_package(db, backup_bytes, expected_clinic_id, passphrase)?;

        // 7. Test SQLite file integrity, foreign keys, and DEK compatibility in an isolated staging DB
        let temp_dir = std::env::temp_dir().join(format!("cliniqo_restore_val_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir)?;
        let temp_test_db = temp_dir.join("test_restore.db");
        fs::write(&temp_test_db, &db_bytes)?;

        if let Err(err) = Self::verify_staged_database_integrity_and_dek(&temp_test_db, db) {
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(err);
        }

        // 8. Safely perform in-place atomic restore using SQLite's online backup API (with rollback net)
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

    pub fn load_auto_backup_config(app_data_dir: &Path) -> AutoBackupConfig {
        let path = app_data_dir.join("auto_backup_config.json");
        if let Ok(raw) = fs::read_to_string(path) {
            if let Ok(mut cfg) = serde_json::from_str::<AutoBackupConfig>(&raw) {
                cfg.interval_hours = cfg.interval_hours.clamp(1, 168);
                cfg.max_retained = cfg.max_retained.clamp(1, 30);
                return cfg;
            }
        }
        AutoBackupConfig::default()
    }

    pub fn save_auto_backup_config(app_data_dir: &Path, config: &AutoBackupConfig) -> Result<AutoBackupConfig, BackupError> {
        let normalized = AutoBackupConfig {
            enabled: config.enabled,
            interval_hours: config.interval_hours.clamp(1, 168),
            max_retained: config.max_retained.clamp(1, 30),
        };
        fs::create_dir_all(app_data_dir)?;
        let path = app_data_dir.join("auto_backup_config.json");
        let bytes = serde_json::to_vec_pretty(&normalized)?;
        Self::write_container_atomically(&path, &bytes)?;
        Ok(normalized)
    }

    pub fn load_auto_backup_state(app_data_dir: &Path) -> AutoBackupPersistedState {
        let path = app_data_dir.join("auto_backup_status.json");
        if let Ok(raw) = fs::read_to_string(path) {
            if let Ok(st) = serde_json::from_str::<AutoBackupPersistedState>(&raw) {
                return st;
            }
        }
        AutoBackupPersistedState::default()
    }

    fn save_auto_backup_state(app_data_dir: &Path, state: &AutoBackupPersistedState) {
        let _ = fs::create_dir_all(app_data_dir);
        let path = app_data_dir.join("auto_backup_status.json");
        if let Ok(bytes) = serde_json::to_vec_pretty(state) {
            let _ = Self::write_container_atomically(&path, &bytes);
        }
    }

    pub fn list_clinic_backups(backup_dir: &Path, clinic_id: &str) -> Vec<LocalBackupEntry> {
        let mut entries = Vec::new();
        let auto_prefix = format!("{AUTO_BACKUP_PREFIX}{clinic_id}_");
        let manual_prefix = format!("{MANUAL_BACKUP_PREFIX}{clinic_id}_");
        if let Ok(read) = fs::read_dir(backup_dir) {
            for item in read.flatten() {
                let path = item.path();
                if !path.is_file() {
                    continue;
                }
                let name = item.file_name().to_string_lossy().to_string();
                if !name.ends_with(".clxbk") {
                    continue;
                }
                let is_auto = name.starts_with(&auto_prefix);
                let is_manual = name.starts_with(&manual_prefix);
                if !is_auto && !is_manual {
                    continue;
                }
                if let Ok(meta) = item.metadata() {
                    let created_at = meta
                        .modified()
                        .ok()
                        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
                        .unwrap_or_default();
                    entries.push(LocalBackupEntry {
                        file_name: name,
                        file_path: path.to_string_lossy().to_string(),
                        size_bytes: meta.len(),
                        created_at,
                        is_auto,
                    });
                }
            }
        }
        entries.sort_by(|a, b| b.file_name.cmp(&a.file_name));
        entries
    }

    pub fn get_auto_backup_status(
        db: &DatabaseManager,
        clinic_id: &str,
        app_data_dir: &Path,
        documents_dir: Option<&Path>,
    ) -> AutoBackupStatus {
        let config = Self::load_auto_backup_config(app_data_dir);
        let persisted = Self::load_auto_backup_state(app_data_dir);
        let backup_dir = Self::resolve_default_backup_directory(documents_dir);
        let backups = Self::list_clinic_backups(&backup_dir, clinic_id);
        let retained_count = backups.iter().filter(|b| b.is_auto).count();
        let manual_count = backups.iter().filter(|b| !b.is_auto).count();

        AutoBackupStatus {
            config,
            is_running: db.is_backup_in_progress(),
            last_backup_at: persisted.last_backup_at,
            last_status: persisted.last_status,
            last_error: persisted.last_error,
            last_file_path: persisted.last_file_path,
            retained_count,
            manual_count,
            backup_directory: backup_dir.to_string_lossy().to_string(),
            backups,
        }
    }

    /// Runs scheduled/on-demand local auto-backup with verification BEFORE rotating older auto-backups.
    /// Never deletes manual user exports (`cliniqo_backup_*`) and never deletes the sole valid backup.
    pub fn run_auto_backup_with_dirs(
        db: &DatabaseManager,
        clinic_id: &str,
        app_data_dir: &Path,
        documents_dir: Option<&Path>,
        is_consultation_active: bool,
        force: bool,
    ) -> Result<AutoBackupStatus, BackupError> {
        Self::run_auto_backup_with_space_override(
            db,
            clinic_id,
            app_data_dir,
            documents_dir,
            is_consultation_active,
            force,
            None,
        )
    }

    fn run_auto_backup_with_space_override(
        db: &DatabaseManager,
        clinic_id: &str,
        app_data_dir: &Path,
        documents_dir: Option<&Path>,
        is_consultation_active: bool,
        force: bool,
        available_space_override: Option<u64>,
    ) -> Result<AutoBackupStatus, BackupError> {
        let config = Self::load_auto_backup_config(app_data_dir);
        let mut persisted = Self::load_auto_backup_state(app_data_dir);

        if !force && !config.enabled {
            return Ok(Self::get_auto_backup_status(db, clinic_id, app_data_dir, documents_dir));
        }
        if !force && is_consultation_active {
            persisted.last_status = "skipped".to_string();
            persisted.last_error = Some("Deferred while active consultation is in progress.".to_string());
            Self::save_auto_backup_state(app_data_dir, &persisted);
            return Ok(Self::get_auto_backup_status(db, clinic_id, app_data_dir, documents_dir));
        }
        if !force {
            if let Some(ref last_at) = persisted.last_backup_at {
                if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(last_at) {
                    let elapsed = chrono::Utc::now().signed_duration_since(parsed.with_timezone(&chrono::Utc));
                    if elapsed < chrono::Duration::hours(config.interval_hours as i64) {
                        return Ok(Self::get_auto_backup_status(db, clinic_id, app_data_dir, documents_dir));
                    }
                }
            }
        }

        let _lock = match db.try_acquire_backup_lock() {
            Some(g) => g,
            None => return Err(BackupError::AlreadyRunning),
        };

        let export_res = Self::export_backup_internal(
            db,
            clinic_id,
            None,
            None,
            documents_dir,
            AUTO_BACKUP_PREFIX,
            available_space_override,
        );

        let result = match export_res {
            Ok(res) => res,
            Err(err) => {
                persisted.last_status = "error".to_string();
                persisted.last_error = Some(err.to_string());
                Self::save_auto_backup_state(app_data_dir, &persisted);
                return Err(err);
            }
        };

        // Validate newly written auto-backup BEFORE deleting any old auto-backups
        if let Some(ref path_str) = result.backup_file_path {
            let written_bytes = fs::read(path_str)?;
            if let Err(err) = Self::verify_backup_package(db, &written_bytes, Some(clinic_id), None) {
                let _ = fs::remove_file(path_str);
                persisted.last_status = "error".to_string();
                persisted.last_error = Some(format!("Auto-backup validation failed: {err}"));
                Self::save_auto_backup_state(app_data_dir, &persisted);
                return Err(err);
            }
            let backup_dir = Self::resolve_default_backup_directory(documents_dir);
            Self::rotate_auto_backups(&backup_dir, clinic_id, config.max_retained);
        }

        persisted.last_backup_at = Some(chrono::Utc::now().to_rfc3339());
        persisted.last_status = "success".to_string();
        persisted.last_error = None;
        persisted.last_file_path = result.backup_file_path;
        Self::save_auto_backup_state(app_data_dir, &persisted);

        Ok(Self::get_auto_backup_status(db, clinic_id, app_data_dir, documents_dir))
    }

    /// Safely rotates automatic backups, keeping at least max(1, max_retained) newest valid backups
    /// and NEVER deleting manual `cliniqo_backup_*` exports.
    pub fn rotate_auto_backups(backup_dir: &Path, clinic_id: &str, max_retained: usize) {
        let keep_count = max_retained.max(1);
        let auto_backups: Vec<LocalBackupEntry> = Self::list_clinic_backups(backup_dir, clinic_id)
            .into_iter()
            .filter(|e| e.is_auto)
            .collect();

        if auto_backups.len() <= keep_count || auto_backups.len() <= 1 {
            return;
        }

        for old in auto_backups.into_iter().skip(keep_count) {
            let _ = fs::remove_file(old.file_path);
        }
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
        let export_res = BackupManager::export_backup(&db, clinic_id, None, Some(&temp_dir.join("Documents")))
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
        let export_res = BackupManager::export_backup(&db, clinic_id, Some(passphrase), Some(&temp_dir.join("Documents")))
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

        let export_res = BackupManager::export_backup(&db, clinic_id, None, Some(&temp_dir.join("Documents"))).unwrap();
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
        let export_res = BackupManager::export_backup(&db, clinic_id, None, Some(&temp_dir.join("Documents"))).unwrap();
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

    #[test]
    fn test_default_backup_directory_resolution() {
        let test_docs = Path::new("/custom/user/Documents");
        let backup_dir = BackupManager::resolve_default_backup_directory(Some(test_docs));
        assert_eq!(
            backup_dir,
            PathBuf::from("/custom/user/Documents").join("Cliniqo").join("Backups")
        );
        assert!(backup_dir.ends_with(Path::new("Cliniqo").join("Backups")));
    }

    #[test]
    fn test_backup_folder_auto_created_and_exported_to_documents() {
        let (db, temp_dir) = setup_test_db("cliniqo_test_backup_doc_create");
        let clinic_id = "clinic_doc_test";
        let test_docs = temp_dir.join("MyDocuments");

        let expected_backup_dir = test_docs.join("Cliniqo").join("Backups");
        assert!(!expected_backup_dir.exists(), "Backup directory must not exist prior to export");

        let export_res = BackupManager::export_backup_with_documents_dir(
            &db,
            clinic_id,
            None,
            None,
            Some(&test_docs),
        ).expect("Export to documents succeeds");

        assert!(expected_backup_dir.exists(), "Documents/Cliniqo/Backups must be auto-created");
        let exported_path_str = export_res.backup_file_path.expect("Backup file path returned");
        let exported_path = PathBuf::from(&exported_path_str);

        assert!(exported_path.exists(), "Exported backup file must exist on disk");
        assert!(exported_path.starts_with(&expected_backup_dir), "File must be directly inside Documents/Cliniqo/Backups");
        assert!(export_res.backup_file_name.starts_with(&format!("cliniqo_backup_{}", clinic_id)));
        assert!(export_res.backup_file_name.ends_with(".clxbk"));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_repeated_exports_create_separate_files_without_overwriting() {
        let (db, temp_dir) = setup_test_db("cliniqo_test_backup_separate");
        let clinic_id = "clinic_multi";
        let test_docs = temp_dir.join("Docs");

        let res1 = BackupManager::export_backup_with_documents_dir(
            &db,
            clinic_id,
            None,
            None,
            Some(&test_docs),
        ).expect("First export succeeds");

        let res2 = BackupManager::export_backup_with_documents_dir(
            &db,
            clinic_id,
            None,
            None,
            Some(&test_docs),
        ).expect("Second export succeeds");

        let path1 = PathBuf::from(res1.backup_file_path.unwrap());
        let path2 = PathBuf::from(res2.backup_file_path.unwrap());

        assert_ne!(path1, path2, "Repeated exports must create distinct backup files");
        assert!(path1.exists(), "First backup file must remain present");
        assert!(path2.exists(), "Second backup file must exist");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_previous_backups_remain_unaffected() {
        let (db, temp_dir) = setup_test_db("cliniqo_test_backup_prior");
        let clinic_id = "clinic_prior";
        let test_docs = temp_dir.join("Docs");
        let backup_dir = test_docs.join("Cliniqo").join("Backups");
        fs::create_dir_all(&backup_dir).unwrap();

        let prior_file = backup_dir.join("cliniqo_backup_clinic_prior_20261101_120000.clxbk");
        fs::write(&prior_file, b"prior_backup_content").unwrap();

        // Export a new backup
        let res = BackupManager::export_backup_with_documents_dir(
            &db,
            clinic_id,
            None,
            None,
            Some(&test_docs),
        ).expect("New export succeeds");

        let new_path = PathBuf::from(res.backup_file_path.unwrap());
        assert_ne!(new_path, prior_file);
        assert_eq!(fs::read(&prior_file).unwrap(), b"prior_backup_content", "Prior backup must not be modified or deleted");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_auto_backup_scheduling_rotation_low_disk_and_overlap_protection() {
        let (db, temp_dir) = setup_test_db("cliniqo_test_autobk");
        let clinic_id = "clinic_auto_1";
        let docs_dir = temp_dir.join("Docs");
        let backup_dir = BackupManager::resolve_default_backup_directory(Some(&docs_dir));

        {
            let mut conn = db.get_connection();
            DbOperations::insert_patient(
                &mut conn,
                db.get_dek(),
                clinic_id,
                "PT-INIT",
                "AutoBackup Patient",
                "+919800112233",
                "Female",
                None,
                32,
                &[],
                &[],
                None,
            )
            .unwrap();
        }

        // 1. Save custom retention policy (keep 2 auto backups)
        BackupManager::save_auto_backup_config(
            db.get_app_data_dir(),
            &AutoBackupConfig {
                enabled: true,
                interval_hours: 12,
                max_retained: 2,
            },
        )
        .unwrap();

        // 2. Active consultation defers non-forced auto-backup cleanly
        let skipped = BackupManager::run_auto_backup_with_dirs(
            &db,
            clinic_id,
            db.get_app_data_dir(),
            Some(&docs_dir),
            true,
            false,
        )
        .unwrap();
        assert_eq!(skipped.last_status, "skipped");
        assert_eq!(skipped.retained_count, 0);

        // 3. Low disk space fails safely with BackupError::LowDiskSpace and leaves zero temp files
        let low_disk = BackupManager::run_auto_backup_with_space_override(
            &db,
            clinic_id,
            db.get_app_data_dir(),
            Some(&docs_dir),
            false,
            true,
            Some(1024),
        );
        assert!(matches!(low_disk, Err(BackupError::LowDiskSpace(_))));

        // 4. Overlap guard prevents concurrent overlapping backup executions
        {
            let _held = db.try_acquire_backup_lock().unwrap();
            let overlap = BackupManager::run_auto_backup_with_dirs(
                &db,
                clinic_id,
                db.get_app_data_dir(),
                Some(&docs_dir),
                false,
                true,
            );
            assert!(matches!(overlap, Err(BackupError::AlreadyRunning)));
        }

        // 5. Create 1 manual export + 3 forced auto-backups; verify rotation keeps 2 newest auto-backups
        //    and NEVER deletes the manual backup!
        let manual = BackupManager::export_backup_with_documents_dir(
            &db,
            clinic_id,
            None,
            None,
            Some(&docs_dir),
        )
        .unwrap();
        let manual_path = PathBuf::from(manual.backup_file_path.unwrap());

        for _ in 0..3 {
            let st = BackupManager::run_auto_backup_with_dirs(
                &db,
                clinic_id,
                db.get_app_data_dir(),
                Some(&docs_dir),
                false,
                true,
            )
            .unwrap();
            assert_eq!(st.last_status, "success");
        }

        let final_status =
            BackupManager::get_auto_backup_status(&db, clinic_id, db.get_app_data_dir(), Some(&docs_dir));
        assert_eq!(final_status.retained_count, 2, "Rotation must retain max_retained=2 newest auto-backups");
        assert_eq!(final_status.manual_count, 1, "Manual exports must never be deleted by auto-rotation");
        assert!(manual_path.exists(), "Manual backup file must still exist on disk");

        // Even if max_retained=1, never delete the sole remaining auto-backup
        BackupManager::rotate_auto_backups(&backup_dir, clinic_id, 1);
        let after_one =
            BackupManager::get_auto_backup_status(&db, clinic_id, db.get_app_data_dir(), Some(&docs_dir));
        assert_eq!(after_one.retained_count, 1);
        BackupManager::rotate_auto_backups(&backup_dir, clinic_id, 0);
        let never_zero =
            BackupManager::get_auto_backup_status(&db, clinic_id, db.get_app_data_dir(), Some(&docs_dir));
        assert_eq!(never_zero.retained_count, 1, "Rotation must never delete the only valid auto-backup");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_restore_rejects_incomplete_unsupported_version_and_dek_mismatch_preserving_live_db() {
        let (db1, dir1) = setup_test_db("cliniqo_test_rst_src");
        let (db2, dir2) = setup_test_db("cliniqo_test_rst_dst");
        let clinic = "clinic_iso_r";

        {
            let mut c1 = db1.get_connection();
            DbOperations::insert_patient(
                &mut c1,
                db1.get_dek(),
                clinic,
                "PT-INIT",
                "Source Machine Patient",
                "+919811100001",
                "Male",
                None,
                40,
                &[],
                &[],
                None,
            )
            .unwrap();
        }
        {
            let mut c2 = db2.get_connection();
            DbOperations::insert_patient(
                &mut c2,
                db2.get_dek(),
                clinic,
                "PT-INIT",
                "Existing Target Patient",
                "+919822200002",
                "Female",
                None,
                35,
                &[],
                &[],
                None,
            )
            .unwrap();
        }

        // Export passphrase backup from db1 (different random DEK from db2!)
        let pass = "SharedPass123!";
        let exp = BackupManager::export_backup(&db1, clinic, Some(pass), Some(&dir1.join("b1.clxbk"))).unwrap();
        let b1_bytes = fs::read(exp.backup_file_path.unwrap()).unwrap();

        // 1. Incomplete backup rejected
        let truncated = &b1_bytes[..b1_bytes.len() / 2];
        assert!(BackupManager::restore_backup(&db2, truncated, Some(clinic), Some(pass)).is_err());

        // 2. DEK mismatch across installations fails closed BEFORE modifying db2!
        let dek_mismatch = BackupManager::restore_backup(&db2, &b1_bytes, Some(clinic), Some(pass));
        assert!(
            matches!(dek_mismatch, Err(BackupError::AuthFailed(_))),
            "Passphrase backup with alien DEK must fail closed before overwriting live DB"
        );
        {
            let c2 = db2.get_connection();
            let pts = DbOperations::get_patients(&c2, db2.get_dek(), clinic).unwrap();
            assert_eq!(pts.len(), 1);
            assert_eq!(pts[0].name, "Existing Target Patient", "Live DB must remain intact after rejected restore");
        }

        // 3. Unsupported future schema version rejected cleanly
        let future_manifest = BackupManifest {
            magic: "CLINIQO_BACKUP".to_string(),
            version: 1,
            clinic_id: clinic.to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            app_version: "9.9.9".to_string(),
            schema_version: CURRENT_SCHEMA_VERSION + 5,
            patients_count: 0,
            consultations_count: 0,
            prescriptions_count: 0,
            invoices_count: 0,
            outbox_count: 0,
            db_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_string(),
        };
        let fm_bytes = serde_json::to_vec(&future_manifest).unwrap();
        let mut f_bundle = Vec::new();
        f_bundle.extend_from_slice(&(fm_bytes.len() as u32).to_be_bytes());
        f_bundle.extend_from_slice(&fm_bytes);
        let salt = [0x11u8; 16];
        let key = BackupManager::derive_key_from_passphrase(pass, &salt, 100_000);
        let (fcipher, fnonce) = encrypt_payload(&key, &f_bundle).unwrap();
        let mut future_container = Vec::new();
        future_container.extend_from_slice(BACKUP_MAGIC_V1);
        future_container.push(FLAG_PASSPHRASE);
        future_container.extend_from_slice(&salt);
        future_container.extend_from_slice(&fnonce);
        future_container.extend_from_slice(&fcipher);

        let ver_err = BackupManager::restore_backup(&db2, &future_container, Some(clinic), Some(pass));
        assert!(matches!(ver_err, Err(BackupError::UnsupportedVersion(_, _))));

        // 4. Diagnostics check passes cleanly on healthy DB and preserves read pool
        let diag = db2.run_diagnostics().unwrap();
        assert_eq!(diag.health_status, "healthy");
        assert!(diag.integrity_ok);
        assert_eq!(diag.foreign_key_violations, 0);
        assert!(diag.encryption_key_compatible);

        let _ = fs::remove_dir_all(&dir1);
        let _ = fs::remove_dir_all(&dir2);
    }
}
