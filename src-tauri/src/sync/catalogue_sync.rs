//! Cliniqo Native Catalogue Synchronization Engine
//! Handles resilient, resumable, cursor-paginated initial and incremental
//! synchronization of the reference CDCI medicine master catalogue from the cloud backend
//! into local encrypted SQLite cache (`local_catalogue_cache_v1`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::auth::SessionManager;
use crate::db::operations::DbOperations;
use crate::db::schema::SaveCatalogueCacheItemArgs;
use crate::db::DatabaseManager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueSyncStatus {
    pub status: String, // "IDLE" | "SYNCING" | "COMPLETED" | "FAILED"
    pub downloaded_count: usize,
    pub total_count: usize,
    pub last_cursor: Option<String>,
    pub last_synced_at: Option<String>,
    pub error: Option<String>,
    pub is_ready: bool,
}

impl Default for CatalogueSyncStatus {
    fn default() -> Self {
        Self {
            status: "IDLE".to_string(),
            downloaded_count: 0,
            total_count: 0,
            last_cursor: None,
            last_synced_at: None,
            error: None,
            is_ready: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueFeedResponse {
    pub items: Vec<CatalogueFeedItem>,
    pub next_cursor: Option<String>,
    pub total: usize,
    pub attribution: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueFeedItem {
    pub id: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub name: String,
    pub brand_name: Option<String>,
    pub generic_name: Option<String>,
    pub product_name: Option<String>,
    pub dosage_form: Option<String>,
    pub route: Option<String>,
    pub strengths: Option<serde_json::Value>,
    pub raw_strength_summary: Option<String>,
    pub is_combination: Option<bool>,
    pub is_strength_verified: Option<bool>,
    pub source_provenance: Option<String>,
}

pub struct CatalogueSyncManager {
    db: Arc<DatabaseManager>,
    session_mgr: Arc<SessionManager>,
    status: Arc<RwLock<CatalogueSyncStatus>>,
    is_running: Arc<AtomicBool>,
}

impl CatalogueSyncManager {
    pub fn new(db: Arc<DatabaseManager>, session_mgr: Arc<SessionManager>) -> Self {
        let manager = Self {
            db,
            session_mgr,
            status: Arc::new(RwLock::new(CatalogueSyncStatus::default())),
            is_running: Arc::new(AtomicBool::new(false)),
        };
        manager.refresh_status_from_db_sync();
        manager
    }

    /// Reads metadata from SQLite on startup to determine whether the local cache is already seeded or ready.
    pub fn refresh_status_from_db_sync(&self) {
        let conn = self.db.get_connection();
        let total_items: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_catalogue_cache_v1", [], |r| r.get(0))
            .unwrap_or(0);

        let stored_status = DbOperations::get_catalogue_metadata(&conn, "catalogue_sync_status")
            .unwrap_or(None)
            .unwrap_or_else(|| "IDLE".to_string());

        let stored_total: usize = DbOperations::get_catalogue_metadata(&conn, "catalogue_sync_total")
            .unwrap_or(None)
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);

        let stored_cursor = DbOperations::get_catalogue_metadata(&conn, "catalogue_sync_cursor")
            .unwrap_or(None);

        let last_synced_at = DbOperations::get_catalogue_metadata(&conn, "catalogue_sync_last_synced_at")
            .unwrap_or(None);

        let is_ready = total_items > 0 && stored_status == "COMPLETED";

        // If local cache has rows (> 100k) from flat file seed or previous complete sync, mark ready
        let effective_status = if is_ready || total_items >= 100_000 {
            "COMPLETED".to_string()
        } else {
            stored_status
        };

        let effective_ready = is_ready || total_items >= 100_000;

        let initial_status = CatalogueSyncStatus {
            status: effective_status,
            downloaded_count: total_items as usize,
            total_count: if stored_total > 0 { stored_total } else { total_items as usize },
            last_cursor: stored_cursor,
            last_synced_at,
            error: None,
            is_ready: effective_ready,
        };

        if let Ok(mut lock) = self.status.try_write() {
            *lock = initial_status;
        }
    }

    /// Returns the live snapshot of synchronization progress and ready state.
    pub async fn get_status(&self) -> CatalogueSyncStatus {
        let current = self.status.read().await.clone();
        if current.status == "IDLE" || current.status == "COMPLETED" {
            // Check fresh row count from SQLite
            let conn = self.db.get_connection();
            let total_items: i64 = conn
                .query_row("SELECT COUNT(*) FROM local_catalogue_cache_v1", [], |r| r.get(0))
                .unwrap_or(0);
            if total_items >= 100_000 && !current.is_ready {
                let mut updated = current;
                updated.downloaded_count = total_items as usize;
                updated.total_count = total_items as usize;
                updated.is_ready = true;
                updated.status = "COMPLETED".to_string();
                return updated;
            }
        }
        current
    }

    /// Triggers or resumes background synchronization against the configured backend URL.
    /// Resumes automatically from `last_cursor` stored in `catalogue_sync_metadata`.
    pub async fn start_sync(&self, backend_url_override: Option<String>) -> Result<CatalogueSyncStatus, String> {
        // Enforce single-flight: do not start concurrent duplicate sync jobs
        if self
            .is_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Ok(self.status.read().await.clone());
        }

        // Check if already completed and populated
        {
            let current = self.status.read().await;
            if current.is_ready && current.downloaded_count >= current.total_count && current.downloaded_count > 0 {
                self.is_running.store(false, Ordering::SeqCst);
                return Ok(current.clone());
            }
        }

        // Set status to SYNCING
        {
            let mut lock = self.status.write().await;
            lock.status = "SYNCING".to_string();
            lock.error = None;
        }

        let db = self.db.clone();
        let session_mgr = self.session_mgr.clone();
        let status_arc = self.status.clone();
        let is_running_arc = self.is_running.clone();

        tokio::spawn(async move {
            let res = Self::run_sync_worker(
                db,
                session_mgr,
                status_arc.clone(),
                backend_url_override,
            )
            .await;

            if let Err(e) = res {
                log::error!("[CatalogueSync] Sync process encountered error: {e}");
                let mut lock = status_arc.write().await;
                lock.status = "FAILED".to_string();
                lock.error = Some(e);
            }

            is_running_arc.store(false, Ordering::SeqCst);
        });

        Ok(self.status.read().await.clone())
    }

    async fn run_sync_worker(
        db: Arc<DatabaseManager>,
        session_mgr: Arc<SessionManager>,
        status_arc: Arc<RwLock<CatalogueSyncStatus>>,
        backend_url_override: Option<String>,
    ) -> Result<(), String> {
        let base_url = if let Some(u) = backend_url_override {
            u
        } else {
            crate::config::get_trusted_backend_url()?
        };

        let client = crate::config::create_secure_http_client(Duration::from_secs(30))?;

        // Retrieve access token
        let access_token = session_mgr
            .get_access_token()
            .ok_or_else(|| "No active authenticated session token available for catalogue sync".to_string())?;

        // Read saved resume cursor and initial count from SQLite metadata
        let (mut cursor, mut downloaded, total_estimate) = {
            let conn = db.get_connection();
            let c = DbOperations::get_catalogue_metadata(&conn, "catalogue_sync_cursor")
                .unwrap_or(None)
                .filter(|s| !s.trim().is_empty());

            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM local_catalogue_cache_v1", [], |r| r.get(0))
                .unwrap_or(0);

            let tot: usize = DbOperations::get_catalogue_metadata(&conn, "catalogue_sync_total")
                .unwrap_or(None)
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);

            (c, count as usize, tot)
        };

        log::info!(
            "[CatalogueSync] Starting catalogue download from '{}'. Current local items: {}, resume cursor: {:?}",
            base_url,
            downloaded,
            cursor
        );

        {
            let mut lock = status_arc.write().await;
            lock.downloaded_count = downloaded;
            lock.total_count = total_estimate;
            lock.last_cursor = cursor.clone();
        }

        let batch_limit = 250;
        #[allow(unused_assignments)]
        let mut total_records = total_estimate;

        loop {
            let mut feed_url = format!("{base_url}/catalogue/feed?limit={batch_limit}");
            if let Some(ref cur) = cursor {
                feed_url.push_str(&format!("&cursor={cur}"));
            }

            let resp = client
                .get(&feed_url)
                .bearer_auth(&access_token)
                .send()
                .await
                .map_err(|e| format!("HTTP network error fetching catalogue feed: {e}"))?;

            if !resp.status().is_success() {
                let code = resp.status();
                return Err(format!("Catalogue feed returned HTTP {code}"));
            }

            let feed_data = resp
                .json::<CatalogueFeedResponse>()
                .await
                .map_err(|e| format!("Failed to parse catalogue feed response: {e}"))?;

            total_records = feed_data.total;

            if feed_data.items.is_empty() {
                log::info!("[CatalogueSync] Feed returned 0 items; synchronization stream ended.");
                break;
            }

            let items_to_save: Vec<SaveCatalogueCacheItemArgs> = feed_data
                .items
                .into_iter()
                .map(|item| {
                    let strengths_str = match item.strengths {
                        Some(ref v) => v.to_string(),
                        None => "[]".to_string(),
                    };
                    SaveCatalogueCacheItemArgs {
                        id: item.id,
                        item_type: item.item_type,
                        name: item.name,
                        brand_name: item.brand_name,
                        generic_name: item.generic_name,
                        product_name: item.product_name,
                        dosage_form: item.dosage_form,
                        route: item.route,
                        active_ingredients_json: None,
                        strengths_json: strengths_str,
                        raw_strength_summary: item.raw_strength_summary.unwrap_or_default(),
                        is_combination: item.is_combination.unwrap_or(false),
                        is_verified: item.is_strength_verified.unwrap_or(true),
                        source_provenance: item.source_provenance,
                    }
                })
                .collect();

            // Save batch idempotently in SQLite transaction
            {
                let mut conn = db.get_connection();
                let saved = DbOperations::cache_catalogue_items(&mut conn, &items_to_save)
                    .map_err(|e| format!("Database error inserting catalogue batch: {e}"))?;
                downloaded += saved;

                // Persist progress and cursor in SQLite metadata
                let _ = DbOperations::set_catalogue_metadata(
                    &conn,
                    "catalogue_sync_cursor",
                    feed_data.next_cursor.as_deref().unwrap_or(""),
                );
                let _ = DbOperations::set_catalogue_metadata(
                    &conn,
                    "catalogue_sync_downloaded",
                    &downloaded.to_string(),
                );
                let _ = DbOperations::set_catalogue_metadata(
                    &conn,
                    "catalogue_sync_total",
                    &total_records.to_string(),
                );
                let _ = DbOperations::set_catalogue_metadata(
                    &conn,
                    "catalogue_sync_status",
                    "SYNCING",
                );
            }

            cursor = feed_data.next_cursor.clone();

            {
                let mut lock = status_arc.write().await;
                lock.downloaded_count = downloaded;
                lock.total_count = total_records;
                lock.last_cursor = cursor.clone();
            }

            if cursor.is_none() {
                log::info!("[CatalogueSync] Reached end of catalogue feed.");
                break;
            }
        }

        // Final verification & mark completed
        let now_iso = chrono::Utc::now().to_rfc3339();
        let actual_count = {
            let conn = db.get_connection();
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM local_catalogue_cache_v1", [], |r| r.get(0))
                .unwrap_or(0);

            let _ = DbOperations::set_catalogue_metadata(&conn, "catalogue_sync_status", "COMPLETED");
            let _ = DbOperations::set_catalogue_metadata(&conn, "catalogue_sync_cursor", "");
            let _ = DbOperations::set_catalogue_metadata(&conn, "catalogue_sync_last_synced_at", &now_iso);
            let _ = DbOperations::set_catalogue_metadata(&conn, "catalogue_sync_version", "CDCI_2026_V1");

            log::info!(
                "[CatalogueSync] Completed successfully! Verified local SQLite records: {}, total: {}",
                count,
                total_records
            );
            count
        };

        {
            let mut lock = status_arc.write().await;
            lock.status = "COMPLETED".to_string();
            lock.downloaded_count = actual_count as usize;
            lock.total_count = if total_records > 0 { total_records } else { actual_count as usize };
            lock.last_cursor = None;
            lock.last_synced_at = Some(now_iso);
            lock.error = None;
            lock.is_ready = actual_count > 0;
        }

        Ok(())
    }
}
