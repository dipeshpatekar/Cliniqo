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
}
