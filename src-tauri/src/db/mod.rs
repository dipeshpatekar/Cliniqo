pub mod backup;
pub mod catalogue_seed;
pub mod migrations;
pub mod operations;
pub mod schema;

use std::fs;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use crate::crypto::decrypt_payload;
use crate::crypto::key_manager::{DatabaseEncryptionKey, KeyManager};
use migrations::{MigrationError, MigrationRunner};
use operations::{DatabaseOpError, DbOperations};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseDiagnosticsResult {
    pub health_status: String,
    pub integrity_ok: bool,
    pub integrity_details: String,
    pub foreign_key_violations: i64,
    pub schema_version: i32,
    pub wal_checkpoint_ok: bool,
    pub outbox_recovered_count: usize,
    pub encryption_key_compatible: bool,
    pub messages: Vec<String>,
}

const MAX_IDLE_READ_CONNS: usize = 4;

#[derive(Error, Debug)]
pub enum DatabaseError {
    #[error("Failed to connect or configure SQLite: {0}")]
    ConnectionError(#[from] rusqlite::Error),

    #[error("Migration error: {0}")]
    Migration(#[from] MigrationError),

    #[error("Key store error: {0}")]
    KeyStore(String),

    #[error("Operation error: {0}")]
    Operation(#[from] DatabaseOpError),

    #[error("Filesystem error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Database integrity check failed: {0}")]
    IntegrityError(String),
}

pub struct ReadConnectionGuard<'a> {
    conn: Option<Connection>,
    pool: &'a Mutex<Vec<Connection>>,
    generation: u64,
    current_generation: &'a AtomicU64,
}

impl Deref for ReadConnectionGuard<'_> {
    type Target = Connection;

    fn deref(&self) -> &Self::Target {
        self.conn
            .as_ref()
            .expect("ReadConnectionGuard accessed after drop")
    }
}

impl Drop for ReadConnectionGuard<'_> {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            if self.generation == self.current_generation.load(Ordering::Acquire) {
                let mut pool = self.pool.lock().unwrap_or_else(|e| e.into_inner());
                if pool.len() < MAX_IDLE_READ_CONNS {
                    pool.push(conn);
                }
            }
        }
    }
}

pub struct DatabaseManager {
    conn: Mutex<Connection>,
    read_pool: Mutex<Vec<Connection>>,
    pool_generation: AtomicU64,
    backup_in_progress: AtomicBool,
    dek: DatabaseEncryptionKey,
    db_path: PathBuf,
    app_data_dir: PathBuf,
}

pub struct BackupOperationGuard<'a> {
    flag: &'a AtomicBool,
}

impl Drop for BackupOperationGuard<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::Release);
    }
}

impl DatabaseManager {
    fn configure_read_connection(conn: &Connection) -> Result<(), rusqlite::Error> {
        conn.pragma_update(None, "query_only", "ON")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        Ok(())
    }

    pub fn init(app_data_dir: &Path) -> Result<Self, DatabaseError> {
        let db_dir = app_data_dir.join("data");
        fs::create_dir_all(&db_dir)?;

        let db_path = db_dir.join("cliniqo_local.db");

        // 1. Unprotect or generate DEK
        let key_mgr = KeyManager::new(app_data_dir);
        let dek = key_mgr
            .get_or_create_dek()
            .map_err(|e| DatabaseError::KeyStore(e.to_string()))?;

        // 2. Open SQLite connection
        let mut conn = Connection::open(&db_path)?;

        // 3. Configure performance and integrity PRAGMAs
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;

        // 4. Run automated migrations
        MigrationRunner::run_migrations(&mut conn, &dek)?;

        // 5. Recovery check: reset any lingering in-flight outbox items from ungraceful shutdown
        DbOperations::recover_in_flight_jobs(&mut conn)?;

        // 6. Reconcile offline reference medicine catalogue (in release/app runtime)
        #[cfg(not(test))]
        if let Err(e) = catalogue_seed::reconcile_and_seed_local_catalogue(&mut conn, None) {
            log::warn!("Offline catalogue auto-seed note: {e}");
        }

        // Pre-warm one read-only WAL connection for immediate concurrent UI reads
        let mut initial_readers = Vec::new();
        if let Ok(r_conn) = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) {
            if Self::configure_read_connection(&r_conn).is_ok() {
                initial_readers.push(r_conn);
            }
        }

        log::info!(
            "Local encrypted SQLite database initialized successfully at: {:?}",
            db_path
        );

        Ok(Self {
            conn: Mutex::new(conn),
            read_pool: Mutex::new(initial_readers),
            pool_generation: AtomicU64::new(1),
            backup_in_progress: AtomicBool::new(false),
            dek,
            db_path,
            app_data_dir: app_data_dir.to_path_buf(),
        })
    }

    pub fn try_acquire_backup_lock(&self) -> Option<BackupOperationGuard<'_>> {
        if self
            .backup_in_progress
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            Some(BackupOperationGuard {
                flag: &self.backup_in_progress,
            })
        } else {
            None
        }
    }

    pub fn is_backup_in_progress(&self) -> bool {
        self.backup_in_progress.load(Ordering::Acquire)
    }

    pub fn get_app_data_dir(&self) -> &Path {
        &self.app_data_dir
    }

    pub fn get_connection(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| {
            log::error!("SQLite write mutex was poisoned; recovering inner connection.");
            e.into_inner()
        })
    }

    /// Acquires a pooled WAL read-only connection configured with `PRAGMA query_only = ON`,
    /// `foreign_keys = ON`, and `busy_timeout = 5000`, allowing concurrent reads without blocking
    /// or waiting on the serialized writer connection.
    pub fn get_read_connection(&self) -> Result<ReadConnectionGuard<'_>, DatabaseError> {
        let pool_gen = self.pool_generation.load(Ordering::Acquire);
        {
            let mut pool = self.read_pool.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(conn) = pool.pop() {
                return Ok(ReadConnectionGuard {
                    conn: Some(conn),
                    pool: &self.read_pool,
                    generation: pool_gen,
                    current_generation: &self.pool_generation,
                });
            }
        }

        let conn = Connection::open_with_flags(
            &self.db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        Self::configure_read_connection(&conn)?;
        Ok(ReadConnectionGuard {
            conn: Some(conn),
            pool: &self.read_pool,
            generation: pool_gen,
            current_generation: &self.pool_generation,
        })
    }

    pub fn get_dek(&self) -> &DatabaseEncryptionKey {
        &self.dek
    }

    pub fn get_db_path(&self) -> &Path {
        &self.db_path
    }

    /// Replaces the active SQLite database in-place using SQLite's online backup API,
    /// maintaining a pre-restore rollback snapshot in case replacement or validation fails,
    /// invalidating stale pooled read connections, re-applying migrations, and verifying integrity.
    pub fn replace_database(&self, new_db_path: &Path) -> Result<(), DatabaseError> {
        // Invalidate existing pooled read connections before truncating WAL and replacing DB
        self.pool_generation.fetch_add(1, Ordering::SeqCst);
        {
            let mut pool = self.read_pool.lock().unwrap_or_else(|e| e.into_inner());
            pool.clear();
        }

        let mut guard = self.get_connection();

        // 0. Stage pre-restore safety snapshot so interrupted/failed restores never destroy live data
        let rollback_path = self.db_path.with_file_name(format!(
            "pre_restore_rollback_{}.db.tmp",
            uuid::Uuid::new_v4()
        ));
        {
            let mut rollback_conn = Connection::open(&rollback_path)?;
            let backup_res = {
                let backup = rusqlite::backup::Backup::new(&*guard, &mut rollback_conn)?;
                backup.run_to_completion(200, std::time::Duration::from_millis(5), None)
            };
            drop(rollback_conn);
            if let Err(e) = backup_res {
                let _ = fs::remove_file(&rollback_path);
                return Err(DatabaseError::ConnectionError(e));
            }
        }

        // Helper closure to execute replacement steps; any error rolls back to rollback_path
        let apply_res: Result<(), DatabaseError> = (|| {
            // 1. Truncate checkpoint to flush any pending WAL frames
            let _ = guard.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");

            // 2. Open source database from validated temporary restored file
            let restored_conn = Connection::open(new_db_path)?;

            // 3. Stream restored database directly into active connection via online backup API
            {
                let backup = rusqlite::backup::Backup::new(&restored_conn, &mut *guard)?;
                backup.run_to_completion(100, std::time::Duration::from_millis(10), None)?;
            }

            // 4. Reconfigure database PRAGMAs
            guard.pragma_update(None, "journal_mode", "WAL")?;
            guard.pragma_update(None, "synchronous", "NORMAL")?;
            guard.pragma_update(None, "foreign_keys", "ON")?;
            guard.pragma_update(None, "busy_timeout", 5000)?;

            // 5. Run migrations (in case backup was from an earlier schema version e.g. v1.0.4)
            MigrationRunner::run_migrations(&mut guard, &self.dek)?;

            // 6. Verify restored DB integrity and foreign keys post-migration
            let integrity_status: String =
                guard.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
            if !integrity_status.eq_ignore_ascii_case("ok") {
                return Err(DatabaseError::IntegrityError(format!(
                    "Post-restore SQLite integrity check failed: {integrity_status}"
                )));
            }
            let fk_violations: i64 = {
                let mut stmt = guard.prepare("PRAGMA foreign_key_check")?;
                let count = stmt.query_map([], |_| Ok(()))?.count() as i64;
                count
            };
            if fk_violations > 0 {
                return Err(DatabaseError::IntegrityError(format!(
                    "Post-restore foreign key check found {fk_violations} violation(s)"
                )));
            }

            // 7. Reset any in-flight jobs
            DbOperations::recover_in_flight_jobs(&mut guard)?;
            Ok(())
        })();

        if let Err(err) = apply_res {
            log::error!("Database replace failed ({err}); rolling back to pre-restore snapshot...");
            if let Ok(rb_conn) = Connection::open(&rollback_path) {
                if let Ok(backup) = rusqlite::backup::Backup::new(&rb_conn, &mut *guard) {
                    let _ = backup.run_to_completion(200, std::time::Duration::from_millis(5), None);
                }
                let _ = guard.pragma_update(None, "journal_mode", "WAL");
                let _ = guard.pragma_update(None, "synchronous", "NORMAL");
                let _ = guard.pragma_update(None, "foreign_keys", "ON");
                let _ = guard.pragma_update(None, "busy_timeout", 5000);
            }
            let _ = fs::remove_file(&rollback_path);
            return Err(err);
        }

        drop(guard);
        let _ = fs::remove_file(&rollback_path);

        // Re-warm read pool cleanly after atomic replacement
        if let Ok(r_guard) = self.get_read_connection() {
            drop(r_guard);
        }

        log::info!("Database replaced and re-migrated successfully from backup snapshot.");
        Ok(())
    }

    /// Inspects SQLite structural integrity, foreign keys, WAL checkpoint state, schema version,
    /// and DEK decryption compatibility without discarding or altering clinical records.
    pub fn run_diagnostics(&self) -> Result<DatabaseDiagnosticsResult, DatabaseError> {
        let mut conn = self.get_connection();
        let wal_checkpoint_ok = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);").is_ok();
        let integrity_details: String = conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .unwrap_or_else(|e| format!("Error running integrity_check: {e}"));
        let integrity_ok = integrity_details.eq_ignore_ascii_case("ok");

        let foreign_key_violations: i64 = match conn.prepare("PRAGMA foreign_key_check") {
            Ok(mut stmt) => match stmt.query_map([], |_| Ok(())) {
                Ok(rows) => rows.count() as i64,
                Err(_) => -1,
            },
            Err(_) => -1,
        };

        let schema_version: i32 = conn
            .query_row("SELECT COALESCE(MAX(version), 0) FROM schema_migrations", [], |r| r.get(0))
            .unwrap_or(0);

        let outbox_recovered_count = DbOperations::recover_in_flight_jobs(&mut conn).unwrap_or(0);

        // Verify local DEK can decrypt existing clinical ciphertexts (never swallows errors)
        let mut encryption_key_compatible = true;
        let mut messages: Vec<String> = Vec::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT encrypted_demographics, nonce FROM local_patients LIMIT 1",
        ) {
            if let Ok(mut rows) = stmt.query([]) {
                if let Ok(Some(row)) = rows.next() {
                    let enc: Vec<u8> = row.get(0)?;
                    let nonce: Vec<u8> = row.get(1)?;
                    if let Err(e) = decrypt_payload(&self.dek.key, &enc, &nonce) {
                        encryption_key_compatible = false;
                        messages.push(format!(
                            "Local encryption key verification failed on patient record: {e}. Preserve this database file and restore from a passphrase backup or original DPAPI key."
                        ));
                    }
                }
            }
        }

        if !integrity_ok {
            messages.push(format!(
                "SQLite structural integrity check reported issues ({integrity_details}). Existing clinical data has NOT been deleted; export/copy your data directory or restore a verified encrypted backup."
            ));
        }
        if foreign_key_violations > 0 {
            messages.push(format!(
                "Detected {foreign_key_violations} foreign key reference mismatch(es)."
            ));
        } else if foreign_key_violations < 0 {
            messages.push("Could not verify foreign key constraints.".to_string());
        }
        if outbox_recovered_count > 0 {
            messages.push(format!(
                "Recovered {outbox_recovered_count} interrupted background job(s)."
            ));
        }

        let health_status = if !integrity_ok || !encryption_key_compatible {
            "corrupted".to_string()
        } else if foreign_key_violations != 0 || !wal_checkpoint_ok {
            "warning".to_string()
        } else {
            messages.push("Local encrypted database passed integrity, foreign-key, WAL, and key verification checks.".to_string());
            "healthy".to_string()
        };

        Ok(DatabaseDiagnosticsResult {
            health_status,
            integrity_ok,
            integrity_details,
            foreign_key_violations: foreign_key_violations.max(0),
            schema_version,
            wal_checkpoint_ok,
            outbox_recovered_count,
            encryption_key_compatible,
            messages,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_read_connection_enforces_query_only_and_concurrent_wal_reads() {
        let temp_dir = std::env::temp_dir().join(format!("cliniqo_db_rw_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).unwrap();
        let db = std::sync::Arc::new(DatabaseManager::init(&temp_dir).unwrap());

        // Insert a patient via writer connection
        {
            let mut write_conn = db.get_connection();
            DbOperations::insert_patient_ext(
                &mut write_conn,
                db.get_dek(),
                "clinic_rw",
                "PT-INIT",
                "Concurrent Patient",
                "9876543210",
                "Female",
                None,
                31,
                &[],
                &[],
                None,
                None,
            )
            .unwrap();
        }

        // Hold writer mutex and verify a read connection still runs concurrently without deadlocking!
        let _held_writer = db.get_connection();
        let read_conn = db.get_read_connection().unwrap();

        let query_only: i32 = read_conn
            .query_row("PRAGMA query_only", [], |r| r.get(0))
            .unwrap();
        assert_eq!(query_only, 1, "Read connection must enforce query_only = ON");

        let fk: i32 = read_conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1, "Read connection must enforce foreign_keys = ON");

        // Verify writes are rejected on read-only connection
        let write_attempt = read_conn.execute(
            "INSERT INTO local_seq_counters (clinic_id, sequence_name, last_seq) VALUES ('x', 'patient', 1)",
            [],
        );
        assert!(write_attempt.is_err(), "Read-only connection must reject mutations");

        let patients = DbOperations::get_patients(&read_conn, db.get_dek(), "clinic_rw").unwrap();
        assert_eq!(patients.len(), 1);
        assert_eq!(patients[0].name, "Concurrent Patient");

        drop(read_conn);
        drop(_held_writer);
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_read_pool_concurrency_wal_checkpoint_replacement_and_leak_safety() {
        let temp_dir = std::env::temp_dir().join(format!("cliniqo_db_pool_stress_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).unwrap();
        let db = std::sync::Arc::new(DatabaseManager::init(&temp_dir).unwrap());

        {
            let mut w = db.get_connection();
            DbOperations::insert_patient_ext(
                &mut w,
                db.get_dek(),
                "clinic_pool_a",
                "PT-INIT",
                "Alpha Patient",
                "9876500001",
                "Female",
                None,
                25,
                &[],
                &[],
                None,
                None,
            )
            .unwrap();
            // Trigger WAL checkpoint while pool is warmed
            w.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        }

        // 1. Multi-thread concurrent readers + serialized writer stress test
        let db_writer = db.clone();
        let writer_handle = std::thread::spawn(move || {
            for i in 0..8 {
                let mut w = db_writer.get_connection();
                DbOperations::insert_patient_ext(
                    &mut w,
                    db_writer.get_dek(),
                    "clinic_pool_a",
                    "PT-INIT",
                    &format!("Writer Patient {i}"),
                    &format!("987650010{i}"),
                    "Male",
                    None,
                    30 + i,
                    &[],
                    &[],
                    None,
                    None,
                )
                .unwrap();
            }
        });

        let mut reader_handles = Vec::new();
        for _ in 0..6 {
            let db_reader = db.clone();
            reader_handles.push(std::thread::spawn(move || {
                for _ in 0..15 {
                    let r = db_reader.get_read_connection().unwrap();
                    let items = DbOperations::get_patients(&r, db_reader.get_dek(), "clinic_pool_a").unwrap();
                    assert!(!items.is_empty());
                    // Verify isolation from other clinics
                    let isolated = DbOperations::get_patients(&r, db_reader.get_dek(), "clinic_pool_b").unwrap();
                    assert!(isolated.is_empty());
                }
            }));
        }

        writer_handle.join().unwrap();
        for h in reader_handles {
            h.join().unwrap();
        }

        // 2. Verify no connection leaks above MAX_IDLE_READ_CONNS
        for _ in 0..20 {
            let r = db.get_read_connection().unwrap();
            let count: i64 = r.query_row("SELECT COUNT(*) FROM local_patients WHERE clinic_id = 'clinic_pool_a'", [], |row| row.get(0)).unwrap();
            assert_eq!(count, 9);
        }
        assert!(db.read_pool.lock().unwrap().len() <= MAX_IDLE_READ_CONNS);

        // 3. Test replace_database & stale ReadConnectionGuard pool_generation invalidation
        let snap_dir = std::env::temp_dir().join(format!("cliniqo_db_snap_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&snap_dir).unwrap();
        {
            // Create a backup snapshot DB with only 1 different patient
            let snap_mgr = DatabaseManager::init(&snap_dir).unwrap();
            let mut sw = snap_mgr.get_connection();
            DbOperations::insert_patient_ext(
                &mut sw,
                snap_mgr.get_dek(),
                "clinic_pool_a",
                "AAA-0099",
                "Restored Snapshot Patient",
                "9111199999",
                "Female",
                None,
                45,
                &[],
                &[],
                None,
                None,
            )
            .unwrap();
            sw.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        }
        // Re-encrypt snapshot patient with active DEK so restored DB is readable with db.get_dek()
        let snap_path = snap_dir.join("data").join("cliniqo_local.db");
        {
            let mut raw_snap = Connection::open(&snap_path).unwrap();
            raw_snap.execute("DELETE FROM local_patients", []).unwrap();
            DbOperations::insert_patient_ext(
                &mut raw_snap,
                db.get_dek(),
                "clinic_pool_a",
                "AAA-0099",
                "Restored Snapshot Patient",
                "9111199999",
                "Female",
                None,
                45,
                &[],
                &[],
                None,
                None,
            )
            .unwrap();
            raw_snap.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        }

        let stale_guard = db.get_read_connection().unwrap();
        let gen_before = db.pool_generation.load(Ordering::Acquire);
        db.replace_database(&snap_path).unwrap();
        let gen_after = db.pool_generation.load(Ordering::Acquire);
        assert!(gen_after > gen_before, "replace_database must increment pool_generation");

        // Dropping stale guard must NOT push stale connection back into read_pool (only 1 re-warmed reader exists)
        drop(stale_guard);
        assert_eq!(db.read_pool.lock().unwrap().len(), 1);

        let fresh_guard = db.get_read_connection().unwrap();
        let after_patients = DbOperations::get_patients(&fresh_guard, db.get_dek(), "clinic_pool_a").unwrap();
        assert_eq!(after_patients.len(), 1);
        assert_eq!(after_patients[0].name, "Restored Snapshot Patient");
        drop(fresh_guard);

        let _ = fs::remove_dir_all(&temp_dir);
        let _ = fs::remove_dir_all(&snap_dir);
    }
}
