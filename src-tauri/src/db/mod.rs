pub mod backup;
pub mod catalogue_seed;
pub mod migrations;
pub mod operations;
pub mod schema;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use rusqlite::Connection;
use thiserror::Error;
use crate::crypto::key_manager::{DatabaseEncryptionKey, KeyManager};
use migrations::{MigrationError, MigrationRunner};
use operations::{DatabaseOpError, DbOperations};

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
}

pub struct DatabaseManager {
    conn: Mutex<Connection>,
    dek: DatabaseEncryptionKey,
    db_path: PathBuf,
}

impl DatabaseManager {
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

        log::info!(
            "Local encrypted SQLite database initialized successfully at: {:?}",
            db_path
        );

        Ok(Self {
            conn: Mutex::new(conn),
            dek,
            db_path,
        })
    }

    pub fn get_connection(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("SQLite mutex poisoned")
    }

    pub fn get_dek(&self) -> &DatabaseEncryptionKey {
        &self.dek
    }

    pub fn get_db_path(&self) -> &Path {
        &self.db_path
    }

    /// Replaces the active SQLite database in-place using SQLite's online backup API,
    /// re-applies migrations, and runs crash recovery.
    pub fn replace_database(&self, new_db_path: &Path) -> Result<(), DatabaseError> {
        let mut guard = self.conn.lock().expect("SQLite mutex poisoned");

        // 1. Truncate checkpoint to flush any pending WAL frames
        let _ = guard.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");

        // 2. Open source database from temporary restored file
        let restored_conn = Connection::open(new_db_path)?;

        // 3. Use SQLite online backup API to stream restored database directly into active connection
        {
            let backup = rusqlite::backup::Backup::new(&restored_conn, &mut *guard)?;
            backup.run_to_completion(100, std::time::Duration::from_millis(10), None)?;
        }

        // 4. Reconfigure database PRAGMAs
        guard.pragma_update(None, "journal_mode", "WAL")?;
        guard.pragma_update(None, "synchronous", "NORMAL")?;
        guard.pragma_update(None, "foreign_keys", "ON")?;
        guard.pragma_update(None, "busy_timeout", 5000)?;

        // 5. Run migrations (in case backup was from an earlier schema version)
        MigrationRunner::run_migrations(&mut guard, &self.dek)?;

        // 6. Reset any in-flight jobs
        DbOperations::recover_in_flight_jobs(&mut guard)?;

        log::info!("Database replaced and re-migrated successfully from backup snapshot.");
        Ok(())
    }
}
