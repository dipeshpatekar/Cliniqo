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
use crate::commands::RefreshCoordinator;
use crate::crypto::key_manager::KeyManager;
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
    key_mgr: Arc<KeyManager>,
    refresh_coordinator: Arc<RefreshCoordinator>,
    status: Arc<RwLock<CatalogueSyncStatus>>,
    is_running: Arc<AtomicBool>,
}

impl CatalogueSyncManager {
    pub fn new(
        db: Arc<DatabaseManager>,
        session_mgr: Arc<SessionManager>,
        key_mgr: Arc<KeyManager>,
        refresh_coordinator: Arc<RefreshCoordinator>,
    ) -> Self {
        let manager = Self {
            db,
            session_mgr,
            key_mgr,
            refresh_coordinator,
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
        let key_mgr = self.key_mgr.clone();
        let refresh_coordinator = self.refresh_coordinator.clone();
        let status_arc = self.status.clone();
        let is_running_arc = self.is_running.clone();

        tokio::spawn(async move {
            let res = Self::run_sync_worker(
                db,
                session_mgr,
                key_mgr,
                refresh_coordinator,
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
        key_mgr: Arc<KeyManager>,
        refresh_coordinator: Arc<RefreshCoordinator>,
        status_arc: Arc<RwLock<CatalogueSyncStatus>>,
        backend_url_override: Option<String>,
    ) -> Result<(), String> {
        let base_url = if let Some(ref u) = backend_url_override {
            u.trim_end_matches('/').to_string()
        } else {
            crate::config::get_trusted_backend_url()?
        };

        let client = crate::config::create_secure_http_client(Duration::from_secs(30))?;

        // Retrieve initial access token from canonical SessionManager
        let mut access_token = session_mgr
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

            // Retry loop for the current batch: if HTTP 401 is received, refresh session once and retry
            let mut refresh_attempts = 0;
            let feed_data = loop {
                let resp = client
                    .get(&feed_url)
                    .bearer_auth(&access_token)
                    .send()
                    .await
                    .map_err(|e| format!("HTTP network error fetching catalogue feed: {e}"))?;

                let status = resp.status();
                if status == reqwest::StatusCode::UNAUTHORIZED {
                    if refresh_attempts >= 1 {
                        return Err(
                            "Catalogue feed returned HTTP 401 even after session refresh. Terminal authentication error."
                                .to_string(),
                        );
                    }
                    refresh_attempts += 1;
                    log::warn!(
                        "[CatalogueSync] Received HTTP 401 Unauthorized during feed sync. Refreshing native session..."
                    );

                    // Invoke existing native refresh-session mechanism
                    crate::commands::execute_refresh_session_with_url(
                        &key_mgr,
                        &session_mgr,
                        &refresh_coordinator,
                        backend_url_override.as_deref(),
                    )
                    .await
                    .map_err(|e| format!("Catalogue sync session refresh failed: {e}"))?;

                    // Obtain refreshed access token securely from the canonical SessionManager
                    access_token = session_mgr
                        .get_access_token()
                        .ok_or_else(|| "No refreshed access token found in session manager".to_string())?;

                    log::info!(
                        "[CatalogueSync] Session successfully refreshed. Retrying feed batch at cursor: {:?}",
                        cursor
                    );
                    continue;
                }

                if !status.is_success() {
                    return Err(format!("Catalogue feed returned HTTP {status}"));
                }

                let data = resp
                    .json::<CatalogueFeedResponse>()
                    .await
                    .map_err(|e| format!("Failed to parse catalogue feed response: {e}"))?;

                break data;
            };

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::tests::{generate_test_rs256_jwt, TEST_BACKEND_PRIVATE_KEY_PEM};

    async fn setup_test_server<F>(handler: F) -> (String, tokio::task::JoinHandle<()>)
    where
        F: Fn(&str, &str, &str, Option<&str>) -> (u16, String) + Send + Sync + 'static,
    {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handler = Arc::new(handler);

        let handle = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let h = handler.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buffer = Vec::new();
                    let mut temp_buf = [0u8; 4096];

                    loop {
                        match stream.read(&mut temp_buf).await {
                            Ok(0) => return,
                            Ok(n) => {
                                buffer.extend_from_slice(&temp_buf[..n]);
                                if buffer.windows(4).any(|w| w == b"\r\n\r\n") {
                                    break;
                                }
                            }
                            Err(_) => return,
                        }
                    }

                    let header_end = buffer.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
                    let header_str = String::from_utf8_lossy(&buffer[..header_end]);

                    let (method, path) = if let Some(first_line) = header_str.lines().next() {
                        let parts: Vec<&str> = first_line.split_whitespace().collect();
                        (parts.get(0).copied().unwrap_or(""), parts.get(1).copied().unwrap_or(""))
                    } else {
                        ("", "")
                    };

                    let auth_header = header_str
                        .lines()
                        .find(|l| l.to_lowercase().starts_with("authorization: bearer "))
                        .map(|l| l[22..].trim().to_string());

                    let content_length: usize = header_str
                        .lines()
                        .find(|l| l.to_lowercase().starts_with("content-length:"))
                        .and_then(|l| l.split(':').nth(1))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);

                    let mut body_bytes = buffer[header_end + 4..].to_vec();
                    while body_bytes.len() < content_length {
                        match stream.read(&mut temp_buf).await {
                            Ok(0) => break,
                            Ok(n) => body_bytes.extend_from_slice(&temp_buf[..n]),
                            Err(_) => break,
                        }
                    }

                    let body_str = String::from_utf8_lossy(&body_bytes);
                    let (status, resp_body) = h(method, path, &body_str, auth_header.as_deref());

                    let status_text = match status {
                        200 => "200 OK",
                        401 => "401 Unauthorized",
                        404 => "404 Not Found",
                        500 => "500 Internal Server Error",
                        _ => "200 OK",
                    };

                    let response = format!(
                        "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        status_text,
                        resp_body.len(),
                        resp_body
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });

        (format!("http://{}", addr), handle)
    }

    fn create_test_manager() -> (
        Arc<DatabaseManager>,
        Arc<SessionManager>,
        Arc<KeyManager>,
        Arc<RefreshCoordinator>,
        std::path::PathBuf,
    ) {
        let temp_dir = std::env::temp_dir().join(format!("cliniqo_cat_test_{}", uuid::Uuid::new_v4()));
        let db = Arc::new(DatabaseManager::init(&temp_dir).unwrap());
        let key_mgr = Arc::new(KeyManager::new(&temp_dir));
        let session_mgr = Arc::new(SessionManager::with_default_public_key().unwrap());
        let coordinator = Arc::new(RefreshCoordinator::new());
        (db, session_mgr, key_mgr, coordinator, temp_dir)
    }

    #[tokio::test]
    async fn test_catalogue_sync_normal_success_without_token_expiry() {
        let (db, session_mgr, key_mgr, coordinator, _dir) = create_test_manager();
        let valid_jwt = generate_test_rs256_jwt(
            TEST_BACKEND_PRIVATE_KEY_PEM,
            "doc_cat_ok",
            "doctor@cliniqo.app",
            3600,
            None,
            None,
            None,
        );
        session_mgr.set_test_session("clinic_1", "doc_cat_ok", &valid_jwt);

        let valid_jwt_clone = valid_jwt.clone();
        let (mock_url, _server) = setup_test_server(move |method, path, _body, auth| {
            assert_eq!(auth, Some(valid_jwt_clone.as_str()));
            if method == "GET" && path.starts_with("/catalogue/feed") {
                if !path.contains("cursor=") {
                    let resp = serde_json::json!({
                        "items": [
                            {
                                "id": "med_1",
                                "type": "BRAND",
                                "name": "Paracetamol 500",
                                "brandName": "Paracetamol 500",
                                "genericName": "Paracetamol",
                                "dosageForm": "Tablet",
                                "strengths": [{"raw_strength": "500 mg"}],
                                "rawStrengthSummary": "500 mg",
                                "isCombination": false,
                                "isStrengthVerified": true
                            },
                            {
                                "id": "med_2",
                                "type": "BRAND",
                                "name": "Amoxicillin 250",
                                "brandName": "Amoxicillin 250",
                                "genericName": "Amoxicillin",
                                "dosageForm": "Capsule",
                                "strengths": [{"raw_strength": "250 mg"}],
                                "rawStrengthSummary": "250 mg",
                                "isCombination": false,
                                "isStrengthVerified": true
                            }
                        ],
                        "nextCursor": "cur_batch_2",
                        "total": 4,
                        "attribution": "CDCI"
                    });
                    (200, resp.to_string())
                } else if path.contains("cursor=cur_batch_2") {
                    let resp = serde_json::json!({
                        "items": [
                            {
                                "id": "med_3",
                                "type": "GENERIC",
                                "name": "Cetirizine 10",
                                "genericName": "Cetirizine",
                                "dosageForm": "Tablet",
                                "strengths": [{"raw_strength": "10 mg"}],
                                "rawStrengthSummary": "10 mg",
                                "isCombination": false,
                                "isStrengthVerified": true
                            },
                            {
                                "id": "med_4",
                                "type": "BRAND",
                                "name": "Azithromycin 500",
                                "brandName": "Azithromycin 500",
                                "genericName": "Azithromycin",
                                "dosageForm": "Tablet",
                                "strengths": [{"raw_strength": "500 mg"}],
                                "rawStrengthSummary": "500 mg",
                                "isCombination": false,
                                "isStrengthVerified": true
                            }
                        ],
                        "nextCursor": null,
                        "total": 4,
                        "attribution": "CDCI"
                    });
                    (200, resp.to_string())
                } else {
                    (404, "{}".to_string())
                }
            } else {
                (404, "{}".to_string())
            }
        }).await;

        let manager = CatalogueSyncManager::new(db.clone(), session_mgr.clone(), key_mgr.clone(), coordinator.clone());
        let _ = manager.start_sync(Some(mock_url)).await.unwrap();

        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            let status = manager.get_status().await;
            if status.status != "SYNCING" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        let final_status = manager.get_status().await;
        assert_eq!(final_status.status, "COMPLETED");
        assert_eq!(final_status.downloaded_count, 4);
        assert_eq!(final_status.total_count, 4);
        assert!(final_status.is_ready);
        assert!(final_status.error.is_none());

        let conn = db.get_connection();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM local_catalogue_cache_v1", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 4);
    }

    #[tokio::test]
    async fn test_catalogue_sync_token_expires_triggers_refresh_and_resumes_cursor() {
        let (db, session_mgr, key_mgr, coordinator, _dir) = create_test_manager();

        // 1. Setup initial (expiring) access token and valid refresh token
        let initial_jwt = generate_test_rs256_jwt(
            TEST_BACKEND_PRIVATE_KEY_PEM,
            "doc_cat_exp",
            "doctor@cliniqo.app",
            3600,
            None,
            None,
            None,
        );
        let refreshed_jwt = generate_test_rs256_jwt(
            TEST_BACKEND_PRIVATE_KEY_PEM,
            "doc_cat_exp",
            "doctor@cliniqo.app",
            7200,
            None,
            None,
            None,
        );
        let valid_rt = "a".repeat(64);
        let rotated_rt = "b".repeat(64);

        key_mgr.save_refresh_token(&valid_rt).unwrap();
        session_mgr.set_test_session("clinic_exp", "doc_cat_exp", &initial_jwt);

        let initial_jwt_clone = initial_jwt.clone();
        let refreshed_jwt_clone = refreshed_jwt.clone();
        let rotated_rt_clone = rotated_rt.clone();

        let refresh_called = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let refresh_called_clone = refresh_called.clone();

        let (mock_url, _server) = setup_test_server(move |method, path, body, auth| {
            if method == "POST" && path == "/auth/refresh" {
                refresh_called_clone.fetch_add(1, Ordering::SeqCst);
                let parsed: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
                assert_eq!(parsed["refreshToken"], valid_rt.as_str());

                let resp = serde_json::json!({
                    "accessToken": refreshed_jwt_clone,
                    "refreshToken": rotated_rt_clone
                });
                (200, resp.to_string())
            } else if method == "GET" && path == "/clinics/my-clinics" {
                (200, "[]".to_string())
            } else if method == "GET" && path.starts_with("/catalogue/feed") {
                if !path.contains("cursor=") {
                    // Batch 1 succeeds with initial token
                    assert_eq!(auth, Some(initial_jwt_clone.as_str()));
                    let resp = serde_json::json!({
                        "items": [
                            {
                                "id": "med_1",
                                "type": "BRAND",
                                "name": "Paracetamol 500",
                                "brandName": "Paracetamol 500",
                                "genericName": "Paracetamol",
                                "dosageForm": "Tablet",
                                "strengths": [{"raw_strength": "500 mg"}],
                                "rawStrengthSummary": "500 mg",
                                "isCombination": false,
                                "isStrengthVerified": true
                            },
                            {
                                "id": "med_2",
                                "type": "BRAND",
                                "name": "Amoxicillin 250",
                                "brandName": "Amoxicillin 250",
                                "genericName": "Amoxicillin",
                                "dosageForm": "Capsule",
                                "strengths": [{"raw_strength": "250 mg"}],
                                "rawStrengthSummary": "250 mg",
                                "isCombination": false,
                                "isStrengthVerified": true
                            }
                        ],
                        "nextCursor": "cur_batch_2",
                        "total": 4,
                        "attribution": "CDCI"
                    });
                    (200, resp.to_string())
                } else if path.contains("cursor=cur_batch_2") {
                    // If called with expired initial token, return 401
                    if auth == Some(initial_jwt_clone.as_str()) {
                        (401, serde_json::json!({"statusCode": 401, "message": "Unauthorized"}).to_string())
                    } else if auth == Some(refreshed_jwt_clone.as_str()) {
                        // Successfully retried with refreshed token!
                        let resp = serde_json::json!({
                            "items": [
                                {
                                "id": "med_3",
                                "type": "GENERIC",
                                "name": "Cetirizine 10",
                                "genericName": "Cetirizine",
                                "dosageForm": "Tablet",
                                "strengths": [{"raw_strength": "10 mg"}],
                                "rawStrengthSummary": "10 mg",
                                "isCombination": false,
                                "isStrengthVerified": true
                                },
                                {
                                "id": "med_4",
                                "type": "BRAND",
                                "name": "Azithromycin 500",
                                "brandName": "Azithromycin 500",
                                "genericName": "Azithromycin",
                                "dosageForm": "Tablet",
                                "strengths": [{"raw_strength": "500 mg"}],
                                "rawStrengthSummary": "500 mg",
                                "isCombination": false,
                                "isStrengthVerified": true
                                }
                            ],
                            "nextCursor": null,
                            "total": 4,
                            "attribution": "CDCI"
                        });
                        (200, resp.to_string())
                    } else {
                        (401, "{}".to_string())
                    }
                } else {
                    (404, "{}".to_string())
                }
            } else {
                (404, "{}".to_string())
            }
        }).await;

        let manager = CatalogueSyncManager::new(db.clone(), session_mgr.clone(), key_mgr.clone(), coordinator.clone());
        let _ = manager.start_sync(Some(mock_url)).await.unwrap();

        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            let status = manager.get_status().await;
            if status.status != "SYNCING" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        let final_status = manager.get_status().await;
        assert_eq!(final_status.status, "COMPLETED");
        assert_eq!(final_status.downloaded_count, 4);
        assert_eq!(final_status.total_count, 4);
        assert!(final_status.is_ready);
        assert!(final_status.error.is_none());

        // Refresh was called exactly once
        assert_eq!(refresh_called.load(Ordering::SeqCst), 1);

        // Verify SQLite data integrity and lack of duplicates
        let conn = db.get_connection();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM local_catalogue_cache_v1", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 4);

        // Verify all 4 specific medicine IDs exist in SQLite
        for expected_id in &["med_1", "med_2", "med_3", "med_4"] {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM local_catalogue_cache_v1 WHERE id = ?1)",
                    rusqlite::params![expected_id],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(exists, "Item {} must be durably present", expected_id);
        }
    }

    #[tokio::test]
    async fn test_catalogue_sync_refresh_failure_terminates_safely() {
        let (db, session_mgr, key_mgr, coordinator, _dir) = create_test_manager();
        let initial_jwt = generate_test_rs256_jwt(
            TEST_BACKEND_PRIVATE_KEY_PEM,
            "doc_cat_fail",
            "doctor@cliniqo.app",
            3600,
            None,
            None,
            None,
        );
        let valid_rt = "a".repeat(64);
        key_mgr.save_refresh_token(&valid_rt).unwrap();
        session_mgr.set_test_session("clinic_fail", "doc_cat_fail", &initial_jwt);

        let refresh_attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let refresh_attempts_clone = refresh_attempts.clone();

        let (mock_url, _server) = setup_test_server(move |method, path, _body, _auth| {
            if method == "POST" && path == "/auth/refresh" {
                refresh_attempts_clone.fetch_add(1, Ordering::SeqCst);
                // Auth server rejects the refresh token
                (401, serde_json::json!({"statusCode": 401, "message": "Refresh token expired or revoked"}).to_string())
            } else if method == "GET" && path.starts_with("/catalogue/feed") {
                // Returns 401 Unauthorized
                (401, serde_json::json!({"statusCode": 401, "message": "Unauthorized"}).to_string())
            } else {
                (404, "{}".to_string())
            }
        }).await;

        let manager = CatalogueSyncManager::new(db.clone(), session_mgr.clone(), key_mgr.clone(), coordinator.clone());
        let _ = manager.start_sync(Some(mock_url)).await.unwrap();

        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            let status = manager.get_status().await;
            if status.status != "SYNCING" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        let final_status = manager.get_status().await;
        assert_eq!(final_status.status, "FAILED");
        assert!(final_status.error.is_some());
        let err_msg = final_status.error.unwrap();
        assert!(
            err_msg.contains("Catalogue sync session refresh failed")
                || err_msg.contains("Refresh token rejected or expired"),
            "Error was: {}",
            err_msg
        );

        // Terminated safely without infinite loop
        assert_eq!(refresh_attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn test_catalogue_sync_terminal_401_after_refresh_prevents_loop() {
        let (db, session_mgr, key_mgr, coordinator, _dir) = create_test_manager();
        let initial_jwt = generate_test_rs256_jwt(
            TEST_BACKEND_PRIVATE_KEY_PEM,
            "doc_cat_term",
            "doctor@cliniqo.app",
            3600,
            None,
            None,
            None,
        );
        let refreshed_jwt = generate_test_rs256_jwt(
            TEST_BACKEND_PRIVATE_KEY_PEM,
            "doc_cat_term",
            "doctor@cliniqo.app",
            3600,
            None,
            None,
            None,
        );
        let valid_rt = "a".repeat(64);
        key_mgr.save_refresh_token(&valid_rt).unwrap();
        session_mgr.set_test_session("clinic_term", "doc_cat_term", &initial_jwt);

        let refreshed_jwt_clone = refreshed_jwt.clone();
        let (mock_url, _server) = setup_test_server(move |method, path, _body, _auth| {
            if method == "POST" && path == "/auth/refresh" {
                (200, serde_json::json!({
                    "accessToken": refreshed_jwt_clone,
                    "refreshToken": "c".repeat(64)
                }).to_string())
            } else if method == "GET" && path == "/clinics/my-clinics" {
                (200, "[]".to_string())
            } else if method == "GET" && path.starts_with("/catalogue/feed") {
                // Feed returns 401 continuously (even with the refreshed token)
                (401, serde_json::json!({"statusCode": 401, "message": "Unauthorized"}).to_string())
            } else {
                (404, "{}".to_string())
            }
        }).await;

        let manager = CatalogueSyncManager::new(db.clone(), session_mgr.clone(), key_mgr.clone(), coordinator.clone());
        let _ = manager.start_sync(Some(mock_url)).await.unwrap();

        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            let status = manager.get_status().await;
            if status.status != "SYNCING" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        let final_status = manager.get_status().await;
        assert_eq!(final_status.status, "FAILED");
        assert!(final_status.error.is_some());
        let err_msg = final_status.error.unwrap();
        assert!(
            err_msg.contains("Terminal authentication error"),
            "Error was: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn test_catalogue_sync_cursor_resumes_from_stored_metadata() {
        let (db, session_mgr, key_mgr, coordinator, _dir) = create_test_manager();
        let valid_jwt = generate_test_rs256_jwt(
            TEST_BACKEND_PRIVATE_KEY_PEM,
            "doc_cat_resume",
            "doctor@cliniqo.app",
            3600,
            None,
            None,
            None,
        );
        session_mgr.set_test_session("clinic_resume", "doc_cat_resume", &valid_jwt);

        // Pre-insert two existing items in SQLite and pre-seed cursor
        {
            let mut conn = db.get_connection();
            let pre_items = vec![
                SaveCatalogueCacheItemArgs {
                    id: "pre_1".to_string(),
                    item_type: "BRAND".to_string(),
                    name: "Pre Existing 1".to_string(),
                    brand_name: Some("Pre 1".to_string()),
                    generic_name: None,
                    product_name: None,
                    dosage_form: None,
                    route: None,
                    active_ingredients_json: None,
                    strengths_json: "[]".to_string(),
                    raw_strength_summary: "".to_string(),
                    is_combination: false,
                    is_verified: true,
                    source_provenance: None,
                },
                SaveCatalogueCacheItemArgs {
                    id: "pre_2".to_string(),
                    item_type: "BRAND".to_string(),
                    name: "Pre Existing 2".to_string(),
                    brand_name: Some("Pre 2".to_string()),
                    generic_name: None,
                    product_name: None,
                    dosage_form: None,
                    route: None,
                    active_ingredients_json: None,
                    strengths_json: "[]".to_string(),
                    raw_strength_summary: "".to_string(),
                    is_combination: false,
                    is_verified: true,
                    source_provenance: None,
                },
            ];
            DbOperations::cache_catalogue_items(&mut conn, &pre_items).unwrap();
            DbOperations::set_catalogue_metadata(&conn, "catalogue_sync_cursor", "saved_cur_step_2").unwrap();
            DbOperations::set_catalogue_metadata(&conn, "catalogue_sync_downloaded", "2").unwrap();
            DbOperations::set_catalogue_metadata(&conn, "catalogue_sync_total", "4").unwrap();
        }

        let (mock_url, _server) = setup_test_server(move |method, path, _body, _auth| {
            if method == "GET" && path.starts_with("/catalogue/feed") {
                // Must resume from saved_cur_step_2
                assert!(
                    path.contains("cursor=saved_cur_step_2"),
                    "Request must resume using saved cursor, but path was: {}",
                    path
                );
                let resp = serde_json::json!({
                    "items": [
                        {
                            "id": "post_3",
                            "type": "GENERIC",
                            "name": "Post Resume 3",
                            "genericName": "Post 3",
                            "dosageForm": "Tablet",
                            "strengths": [],
                            "rawStrengthSummary": "",
                            "isCombination": false,
                            "isStrengthVerified": true
                        },
                        {
                            "id": "post_4",
                            "type": "GENERIC",
                            "name": "Post Resume 4",
                            "genericName": "Post 4",
                            "dosageForm": "Tablet",
                            "strengths": [],
                            "rawStrengthSummary": "",
                            "isCombination": false,
                            "isStrengthVerified": true
                        }
                    ],
                    "nextCursor": null,
                    "total": 4,
                    "attribution": "CDCI"
                });
                (200, resp.to_string())
            } else {
                (404, "{}".to_string())
            }
        }).await;

        let manager = CatalogueSyncManager::new(db.clone(), session_mgr.clone(), key_mgr.clone(), coordinator.clone());
        let _ = manager.start_sync(Some(mock_url)).await.unwrap();

        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            let status = manager.get_status().await;
            if status.status != "SYNCING" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        let final_status = manager.get_status().await;
        assert_eq!(final_status.status, "COMPLETED");
        assert_eq!(final_status.downloaded_count, 4);

        let conn = db.get_connection();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM local_catalogue_cache_v1", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 4);
    }
}
