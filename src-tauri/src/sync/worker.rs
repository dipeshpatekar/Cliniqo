use std::sync::Arc;
use std::time::Duration;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::sync::{watch, Mutex, RwLock};
use crate::auth::SessionManager;
use crate::commands::RefreshCoordinator;
use crate::crypto::key_manager::KeyManager;
use crate::db::DatabaseManager;
use crate::db::operations::DbOperations;
use crate::db::schema::{DecryptedOutboxItem, SyncFeedChangeItem, SyncOutboxSummary};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncStatusInfo {
    pub active_clinic_id: Option<String>,
    pub status: String, // "IDLE" | "SYNCING" | "OFFLINE" | "ERROR"
    pub is_running: bool,
    pub last_synced_at: Option<String>,
    pub pending_mutations: i64,
    pub in_flight_mutations: i64,
    pub conflicts_count: i64,
    pub last_error: Option<String>,
}

impl Default for SyncStatusInfo {
    fn default() -> Self {
        Self {
            active_clinic_id: None,
            status: "IDLE".to_string(),
            is_running: false,
            last_synced_at: None,
            pending_mutations: 0,
            in_flight_mutations: 0,
            conflicts_count: 0,
            last_error: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Backend DTOs
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct SyncPushRequest<'a> {
    mutations: &'a [SyncMutationItem],
}

#[derive(Serialize)]
struct SyncMutationItem {
    #[serde(rename = "outboxId")]
    outbox_id: String,
    #[serde(rename = "entityType")]
    entity_type: String,
    action: String,
    #[serde(rename = "idempotencyKey")]
    idempotency_key: String,
    #[serde(rename = "entityId")]
    entity_id: String,
    #[serde(rename = "serverId", skip_serializing_if = "Option::is_none")]
    server_id: Option<String>,
    #[serde(rename = "clientVersion")]
    client_version: i64,
    payload: serde_json::Value,
}

#[derive(Deserialize)]
struct SyncPushResponseDto {
    #[serde(rename = "processedAt")]
    _processed_at: String,
    #[serde(rename = "clinicId")]
    _clinic_id: String,
    results: Vec<SyncMutationResultDto>,
}

#[derive(Deserialize)]
struct SyncMutationResultDto {
    #[serde(rename = "outboxId")]
    outbox_id: String,
    status: String, // "APPLIED" | "CONFLICT" | "REJECTED"
    #[serde(rename = "entityType")]
    entity_type: String,
    #[serde(rename = "entityId")]
    entity_id: String,
    #[serde(rename = "serverId")]
    server_id: Option<String>,
    #[serde(rename = "serverVersion")]
    server_version: Option<i64>,
    error: Option<String>,
    #[serde(rename = "conflictDetails")]
    conflict_details: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct SyncPullResponseDto {
    #[serde(rename = "clinicId")]
    _clinic_id: String,
    #[serde(rename = "sinceSeq")]
    _since_seq: i64,
    #[serde(rename = "currentSeq")]
    current_seq: i64,
    #[serde(rename = "hasMore")]
    has_more: bool,
    changes: Vec<SyncFeedChangeItem>,
}

// ---------------------------------------------------------------------------
// Sync Worker Handle
// ---------------------------------------------------------------------------

pub struct SyncWorkerHandle {
    cancel_tx: Arc<Mutex<Option<watch::Sender<bool>>>>,
    active_task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    status_info: Arc<RwLock<SyncStatusInfo>>,
}

impl Default for SyncWorkerHandle {
    fn default() -> Self {
        Self::new()
    }
}

impl SyncWorkerHandle {
    pub fn new() -> Self {
        Self {
            cancel_tx: Arc::new(Mutex::new(None)),
            active_task: Arc::new(Mutex::new(None)),
            status_info: Arc::new(RwLock::new(SyncStatusInfo::default())),
        }
    }

    /// Stops any running sync worker task cleanly and awaits full task termination.
    pub async fn stop(&self) {
        let handle = {
            let mut cancel_lock = self.cancel_tx.lock().await;
            if let Some(tx) = cancel_lock.take() {
                let _ = tx.send(true);
                log::info!("Sync worker cancellation signal dispatched.");
            }
            let mut task_lock = self.active_task.lock().await;
            task_lock.take()
        };

        if let Some(mut join_handle) = handle {
            if tokio::time::timeout(Duration::from_millis(500), &mut join_handle).await.is_err() {
                join_handle.abort();
                let _ = join_handle.await;
            }
            log::info!("Sync worker task successfully joined and terminated.");
        }

        let mut status = self.status_info.write().await;
        status.is_running = false;
        status.status = "IDLE".to_string();
    }

    /// Starts a new background sync worker for the given clinic tenancy.
    /// If an active worker exists for another clinic or session, it is cleanly cancelled and joined first.
    pub async fn start(
        &self,
        clinic_id: String,
        db: Arc<DatabaseManager>,
        session_mgr: Arc<SessionManager>,
        key_mgr: Arc<KeyManager>,
        refresh_coordinator: Arc<RefreshCoordinator>,
    ) {
        self.start_with_backend_url(clinic_id, db, session_mgr, key_mgr, refresh_coordinator, None).await;
    }

    /// Starts a sync worker with an optional custom backend URL (used by integration tests)
    pub async fn start_with_backend_url(
        &self,
        clinic_id: String,
        db: Arc<DatabaseManager>,
        session_mgr: Arc<SessionManager>,
        key_mgr: Arc<KeyManager>,
        refresh_coordinator: Arc<RefreshCoordinator>,
        backend_url_override: Option<String>,
    ) {
        self.stop().await;

        let (tx, rx) = watch::channel(false);
        {
            let mut lock = self.cancel_tx.lock().await;
            *lock = Some(tx);
        }

        {
            let mut status = self.status_info.write().await;
            status.active_clinic_id = Some(clinic_id.clone());
            status.is_running = true;
            status.status = "SYNCING".to_string();
            status.last_error = None;
        }

        let status_info = self.status_info.clone();
        let cid = clinic_id.clone();

        let task = tokio::spawn(async move {
            log::info!("Native sync worker started for clinic '{cid}'.");
            run_sync_loop(
                cid,
                db,
                session_mgr,
                key_mgr,
                refresh_coordinator,
                status_info,
                rx,
                backend_url_override,
            )
            .await;
        });

        {
            let mut task_lock = self.active_task.lock().await;
            *task_lock = Some(task);
        }
    }

    /// Returns a non-sensitive snapshot of the sync engine status for the UI
    pub async fn get_status(&self) -> SyncStatusInfo {
        self.status_info.read().await.clone()
    }
}

// ---------------------------------------------------------------------------
// Sync Loop Execution
// ---------------------------------------------------------------------------

async fn run_sync_loop(
    clinic_id: String,
    db: Arc<DatabaseManager>,
    session_mgr: Arc<SessionManager>,
    key_mgr: Arc<KeyManager>,
    refresh_coordinator: Arc<RefreshCoordinator>,
    status_info: Arc<RwLock<SyncStatusInfo>>,
    mut cancel_rx: watch::Receiver<bool>,
    backend_url_override: Option<String>,
) {
    let client = match crate::config::create_secure_http_client(Duration::from_secs(15)) {
        Ok(c) => c,
        Err(e) => {
            log::error!("Failed to create secure HTTP client for sync worker: {e}");
            let mut s = status_info.write().await;
            s.status = "ERROR".to_string();
            s.last_error = Some(format!("HTTP client error: {e}"));
            s.is_running = false;
            return;
        }
    };

    let base_url = if let Some(u) = backend_url_override {
        u
    } else {
        match crate::config::get_trusted_backend_url() {
            Ok(u) => u,
            Err(e) => {
                log::error!("Failed to resolve trusted backend URL: {e}");
                let mut s = status_info.write().await;
                s.status = "ERROR".to_string();
                s.last_error = Some(e);
                s.is_running = false;
                return;
            }
        }
    };

    // 1. Recover any abandoned in-flight jobs on startup
    {
        let mut conn = db.get_connection();
        if let Err(e) = DbOperations::recover_in_flight_jobs(&mut conn) {
            log::error!("Failed to recover in-flight sync jobs on startup: {e}");
        }
    }

    let min_interval = Duration::from_secs(5);
    let mut current_backoff = Duration::from_secs(1);
    let max_backoff = Duration::from_secs(30);

    loop {
        // Check for cancellation
        if *cancel_rx.borrow() {
            log::info!("Sync worker received termination signal, exiting.");
            break;
        }

        // Check and validate access token; refresh if expiring soon (< 120 seconds)
        let token_opt = session_mgr.get_access_token();
        let session_opt = session_mgr.get_session();

        let access_token = match (token_opt, session_opt) {
            (Some(token), Some(session)) => {
                let now_sec = chrono::Utc::now().timestamp();
                if session.expires_at - now_sec < 120 {
                    log::info!("Access token expiring soon ({}s), refreshing session via coordinator...", session.expires_at - now_sec);
                    match crate::commands::execute_refresh_session_with_db(&key_mgr, &session_mgr, &refresh_coordinator, None, Some(&db)).await {
                        Ok(_) => {
                            session_mgr.get_access_token().unwrap_or(token)
                        }
                        Err(e) => {
                            log::warn!("Background session refresh failed: {e}");
                            let mut s = status_info.write().await;
                            s.status = "ERROR".to_string();
                            s.last_error = Some(format!("Session refresh failed: {e}"));
                            current_backoff = std::cmp::min(current_backoff * 2, max_backoff);
                            tokio::select! {
                                _ = tokio::time::sleep(current_backoff) => continue,
                                _ = cancel_rx.changed() => break,
                            }
                        }
                    }
                } else {
                    token
                }
            }
            _ => {
                // If offline with no access token, attempt refresh via coordinator if refresh token exists
                if key_mgr.load_refresh_token().ok().flatten().is_some() {
                    match crate::commands::execute_refresh_session_with_db(&key_mgr, &session_mgr, &refresh_coordinator, None, Some(&db)).await {
                        Ok(_) => match session_mgr.get_access_token() {
                            Some(tok) => tok,
                            None => {
                                tokio::select! {
                                    _ = tokio::time::sleep(Duration::from_secs(3)) => continue,
                                    _ = cancel_rx.changed() => break,
                                }
                            }
                        },
                        Err(_) => {
                            tokio::select! {
                                _ = tokio::time::sleep(Duration::from_secs(3)) => continue,
                                _ = cancel_rx.changed() => break,
                            }
                        }
                    }
                } else {
                    log::warn!("No active session token available for sync worker, waiting...");
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_secs(3)) => continue,
                        _ = cancel_rx.changed() => break,
                    }
                }
            }
        };

        let mut had_push_activity = false;
        let mut had_pull_activity = false;
        let mut loop_error: Option<String> = None;

        // -------------------------------------------------------------------
        // Outbox Push Phase
        // -------------------------------------------------------------------
        let pending_batch: Result<Vec<DecryptedOutboxItem>, _> = {
            let mut conn = db.get_connection();
            let dek = db.get_dek();
            DbOperations::get_pending_outbox_batch(&mut conn, dek, &clinic_id, 25)
        };

        match pending_batch {
            Ok(batch) => {
                let non_clinical_batch: Vec<_> = batch
                    .into_iter()
                    .filter(|b| !matches!(b.entity_type.as_str(), "PATIENT" | "CONSULTATION" | "PRESCRIPTION" | "PRESCRIPTION_REVISION" | "INVOICE"))
                    .collect();

                if !non_clinical_batch.is_empty() {
                    had_push_activity = true;
                    let batch_ids: Vec<String> = non_clinical_batch.iter().map(|b| b.id.clone()).collect();
                    let mutation_items: Vec<SyncMutationItem> = non_clinical_batch
                        .iter()
                        .map(|b| SyncMutationItem {
                            outbox_id: b.id.clone(),
                            entity_type: b.entity_type.clone(),
                            action: b.action.clone(),
                            idempotency_key: b.idempotency_key.clone(),
                            entity_id: b.entity_id.clone(),
                            server_id: b.server_id.clone(),
                            client_version: b.client_version,
                            payload: b.payload.clone(),
                        })
                        .collect();

                let push_url = format!("{base_url}/sync/push");
                let push_req = client
                    .post(&push_url)
                    .bearer_auth(&access_token)
                    .header("x-clinic-id", &clinic_id)
                    .json(&SyncPushRequest {
                        mutations: &mutation_items,
                    })
                    .send();

                let push_res = tokio::select! {
                    res = push_req => res,
                    _ = cancel_rx.changed() => {
                        log::info!("Sync worker push cancelled mid-request for clinic '{clinic_id}'.");
                        let conn = db.get_connection();
                        let _ = DbOperations::revert_in_flight_to_pending(
                            &conn,
                            &batch_ids,
                            Some("Sync cancelled during push"),
                        );
                        break;
                    }
                };

                match push_res {
                    Ok(resp) if resp.status().is_success() => {
                        match resp.json::<SyncPushResponseDto>().await {
                            Ok(push_data) => {
                                let mut conn = db.get_connection();
                                for r in push_data.results {
                                    if let Err(e) = DbOperations::apply_push_mutation_result(
                                        &mut conn,
                                        &r.outbox_id,
                                        &r.status,
                                        &r.entity_type,
                                        &r.entity_id,
                                        r.server_id.as_deref(),
                                        r.server_version,
                                        r.error.as_deref(),
                                        r.conflict_details.as_ref(),
                                    ) {
                                        log::error!("Failed to apply push mutation result {}: {e}", r.outbox_id);
                                    }
                                }
                                current_backoff = Duration::from_secs(1);
                            }
                            Err(e) => {
                                log::error!("Failed to parse push response body: {e}");
                                let conn = db.get_connection();
                                let _ = DbOperations::revert_in_flight_to_pending(
                                    &conn,
                                    &batch_ids,
                                    Some("Invalid push response body from server"),
                                );
                                loop_error = Some(format!("Invalid push response: {e}"));
                            }
                        }
                    }
                    Ok(resp) => {
                        let status_code = resp.status();
                        let error_msg = format!("Sync push rejected with HTTP {status_code}");
                        log::warn!("{error_msg}");
                        let conn = db.get_connection();
                        let _ = DbOperations::revert_in_flight_to_pending(
                            &conn,
                            &batch_ids,
                            Some(&error_msg),
                        );
                        loop_error = Some(error_msg);
                        current_backoff = std::cmp::min(current_backoff * 2, max_backoff);
                    }
                    Err(e) => {
                        let error_msg = format!("Sync push network failure: {e}");
                        log::warn!("{error_msg}");
                        let conn = db.get_connection();
                        let _ = DbOperations::revert_in_flight_to_pending(
                            &conn,
                            &batch_ids,
                            Some(&error_msg),
                        );
                        loop_error = Some(error_msg);
                        current_backoff = std::cmp::min(current_backoff * 2, max_backoff);
                    }
                }
            }
        }
        Err(e) => {
                log::error!("Database error reading pending outbox batch: {e}");
                loop_error = Some(format!("Database error: {e}"));
            }
        }

        // Check cancellation between push and pull phases
        if *cancel_rx.borrow() {
            log::info!("Sync worker cancelled between push and pull for clinic '{clinic_id}'.");
            break;
        }

        // -------------------------------------------------------------------
        // Change Feed Pull Phase
        // -------------------------------------------------------------------
        let current_since_seq = {
            let conn = db.get_connection();
            DbOperations::get_sync_state(&conn, &clinic_id)
                .ok()
                .flatten()
                .map(|s| s.last_pulled_seq)
                .unwrap_or(0)
        };

        let pull_url = format!("{base_url}/sync/pull?sinceSeq={current_since_seq}&limit=50");
        let pull_req = client
            .get(&pull_url)
            .bearer_auth(&access_token)
            .header("x-clinic-id", &clinic_id)
            .send();

        let pull_res = tokio::select! {
            res = pull_req => res,
            _ = cancel_rx.changed() => {
                log::info!("Sync worker pull cancelled mid-request for clinic '{clinic_id}'.");
                break;
            }
        };

        let mut has_more_remote_changes = false;

        match pull_res {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<SyncPullResponseDto>().await {
                    Ok(pull_data) => {
                        has_more_remote_changes = pull_data.has_more;
                        if !pull_data.changes.is_empty() {
                            had_pull_activity = true;
                            let mut conn = db.get_connection();
                            let dek = db.get_dek();
                            if let Err(e) = DbOperations::apply_pull_feed_items(
                                &mut conn,
                                dek,
                                &clinic_id,
                                &pull_data.changes,
                                pull_data.current_seq,
                                pull_data.has_more,
                            ) {
                                log::error!("Failed to apply pulled change feed items: {e}");
                                loop_error = Some(format!("Database pull error: {e}"));
                            }
                        }
                        current_backoff = Duration::from_secs(1);
                    }
                    Err(e) => {
                        log::error!("Failed to parse sync pull response: {e}");
                        loop_error = Some(format!("Invalid pull response: {e}"));
                    }
                }
            }
            Ok(resp) => {
                let err_msg = format!("Sync pull HTTP error: {}", resp.status());
                log::warn!("{err_msg}");
                loop_error = Some(err_msg);
                current_backoff = std::cmp::min(current_backoff * 2, max_backoff);
            }
            Err(e) => {
                let err_msg = format!("Sync pull network failure: {e}");
                log::warn!("{err_msg}");
                loop_error = Some(err_msg);
                current_backoff = std::cmp::min(current_backoff * 2, max_backoff);
            }
        }

        // Check cancellation before writing status
        if *cancel_rx.borrow() {
            log::info!("Sync worker cancelled before status update for clinic '{clinic_id}'.");
            break;
        }

        // -------------------------------------------------------------------
        // Refresh Status Summary
        // -------------------------------------------------------------------
        let (outbox_summary, conflict_count) = {
            let conn = db.get_connection();
            let summary = DbOperations::get_outbox_summary(&conn, &clinic_id).unwrap_or(
                SyncOutboxSummary {
                    pending_count: 0,
                    in_flight_count: 0,
                    synced_count: 0,
                    conflict_count: 0,
                    failed_count: 0,
                },
            );
            let conflicts = DbOperations::get_conflicts_for_clinic(&conn, &clinic_id, Some("OPEN"))
                .map(|c| c.len() as i64)
                .unwrap_or(0);
            (summary, conflicts)
        };

        {
            let mut s = status_info.write().await;
            // Strictly check that this worker is still the active clinic before mutating status
            if s.active_clinic_id.as_deref() == Some(&clinic_id) {
                s.pending_mutations = outbox_summary.pending_count;
                s.in_flight_mutations = outbox_summary.in_flight_count;
                s.conflicts_count = conflict_count;

                if let Some(ref err) = loop_error {
                    if err.contains("network") || err.contains("unreachable") || err.contains("timed out") {
                        s.status = "OFFLINE".to_string();
                    } else {
                        s.status = "ERROR".to_string();
                    }
                    s.last_error = Some(err.clone());
                } else {
                    s.status = if had_push_activity || had_pull_activity || has_more_remote_changes {
                        "SYNCING".to_string()
                    } else {
                        "IDLE".to_string()
                    };
                    s.last_synced_at = Some(Utc::now().to_rfc3339());
                    s.last_error = None;
                }
            }
        }

        // Sleep or Yield to Next Iteration
        let sleep_duration = if loop_error.is_some() {
            current_backoff
        } else if has_more_remote_changes || had_push_activity {
            Duration::from_millis(100)
        } else {
            min_interval
        };

        tokio::select! {
            _ = tokio::time::sleep(sleep_duration) => {},
            _ = cancel_rx.changed() => {
                log::info!("Sync worker received termination signal during sleep, exiting.");
                break;
            }
        }
    }

    let mut s = status_info.write().await;
    if s.active_clinic_id.as_deref() == Some(&clinic_id) {
        s.is_running = false;
        s.status = "IDLE".to_string();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    #[tokio::test]
    async fn test_sync_worker_start_stop_lifecycle() {
        let temp_dir = std::env::temp_dir().join(format!("cliniqo_worker_test_{}", uuid::Uuid::new_v4()));
        let db = Arc::new(DatabaseManager::init(&temp_dir).unwrap());
        let key_mgr = Arc::new(KeyManager::new(&temp_dir));
        let session_mgr = Arc::new(SessionManager::with_default_public_key().unwrap());
        let coordinator = Arc::new(RefreshCoordinator::new());

        let handle = SyncWorkerHandle::new();
        let status = handle.get_status().await;
        assert!(!status.is_running);
        assert_eq!(status.status, "IDLE");

        handle.start(
            "clinic_test_1".to_string(),
            db.clone(),
            session_mgr.clone(),
            key_mgr.clone(),
            coordinator.clone(),
        ).await;

        let status_running = handle.get_status().await;
        assert!(status_running.is_running);
        assert_eq!(status_running.active_clinic_id.as_deref(), Some("clinic_test_1"));

        // Clean stop awaits join handle
        handle.stop().await;
        let status_stopped = handle.get_status().await;
        assert!(!status_stopped.is_running);
        assert_eq!(status_stopped.status, "IDLE");
    }

    #[tokio::test]
    async fn test_sync_worker_tenant_transition_cancels_previous() {
        let temp_dir = std::env::temp_dir().join(format!("cliniqo_worker_trans_{}", uuid::Uuid::new_v4()));
        let db = Arc::new(DatabaseManager::init(&temp_dir).unwrap());
        let key_mgr = Arc::new(KeyManager::new(&temp_dir));
        let session_mgr = Arc::new(SessionManager::with_default_public_key().unwrap());
        let coordinator = Arc::new(RefreshCoordinator::new());

        let handle = SyncWorkerHandle::new();

        // Start for clinic A
        handle.start(
            "clinic_A".to_string(),
            db.clone(),
            session_mgr.clone(),
            key_mgr.clone(),
            coordinator.clone(),
        ).await;

        let status_a = handle.get_status().await;
        assert_eq!(status_a.active_clinic_id.as_deref(), Some("clinic_A"));

        // Start for clinic B (should cancel worker for clinic A and switch)
        handle.start(
            "clinic_B".to_string(),
            db.clone(),
            session_mgr.clone(),
            key_mgr.clone(),
            coordinator.clone(),
        ).await;

        let status_b = handle.get_status().await;
        assert_eq!(status_b.active_clinic_id.as_deref(), Some("clinic_B"));
        assert!(status_b.is_running);

        handle.stop().await;
    }

    async fn setup_mock_server<F>(handler: F) -> (String, tokio::task::JoinHandle<()>)
    where
        F: Fn(&str, &str, &str) -> (u16, String) + Send + Sync + 'static,
    {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handler = Arc::new(handler);

        let server_handle = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let h = handler.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = [0u8; 8192];
                    if let Ok(n) = stream.read(&mut buf).await {
                        let req_str = String::from_utf8_lossy(&buf[..n]);
                        let (method, path) = if let Some(first_line) = req_str.lines().next() {
                            let parts: Vec<&str> = first_line.split_whitespace().collect();
                            (parts.get(0).copied().unwrap_or(""), parts.get(1).copied().unwrap_or(""))
                        } else {
                            ("", "")
                        };

                        let body = req_str.split("\r\n\r\n").nth(1).unwrap_or("");
                        let (status, resp_body) = h(method, path, body);

                        let status_text = match status {
                            200 => "200 OK",
                            401 => "401 Unauthorized",
                            409 => "409 Conflict",
                            500 => "500 Internal Server Error",
                            _ => "404 Not Found",
                        };

                        let response = format!(
                            "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            status_text,
                            resp_body.len(),
                            resp_body
                        );
                        let _ = stream.write_all(response.as_bytes()).await;
                    }
                });
            }
        });

        (format!("http://{}", addr), server_handle)
    }

    #[tokio::test]
    async fn test_sync_worker_http_success_push_and_pull() {
        let temp_dir = std::env::temp_dir().join(format!("cliniqo_http_succ_{}", uuid::Uuid::new_v4()));
        let db = Arc::new(DatabaseManager::init(&temp_dir).unwrap());
        let key_mgr = Arc::new(KeyManager::new(&temp_dir));
        let session_mgr = Arc::new(SessionManager::with_default_public_key().unwrap());
        let coordinator = Arc::new(RefreshCoordinator::new());
        let clinic_id = "clinic_http_ok";

        session_mgr.set_test_session(clinic_id, "doc_ok", "valid_jwt_token");

        // Enqueue a local patient
        let item_id = "prof_http_ok_1".to_string();
        let outbox_id = "outbox_prof_1".to_string();
        {
            let conn = db.get_connection();
            let dek = db.get_dek();
            let payload = serde_json::json!({ "name": "Test Clinic" });
            let (enc_payload, nonce) = crate::crypto::encrypt_payload(&dek.key, payload.to_string().as_bytes()).unwrap();
            conn.execute(
                "INSERT INTO local_sync_outbox (id, clinic_id, entity_type, entity_id, action, idempotency_key, encrypted_payload, nonce, sync_status) VALUES (?1, ?2, 'CLINIC_PROFILE', ?3, 'UPDATE', 'idem_prof_1', ?4, ?5, 'PENDING')",
                params![&outbox_id, clinic_id, &item_id, enc_payload, nonce],
            )
            .unwrap();
        }

        let item_id_clone = item_id.clone();
        let outbox_clone = outbox_id.clone();
        let (mock_url, server_handle) = setup_mock_server(move |method, path, _body| {
            if method == "POST" && path == "/sync/push" {
                let resp = serde_json::json!({
                    "processedAt": "2026-10-28T00:00:00Z",
                    "clinicId": "clinic_http_ok",
                    "results": [{
                        "outboxId": outbox_clone,
                        "status": "APPLIED",
                        "entityType": "CLINIC_PROFILE",
                        "entityId": item_id_clone,
                        "serverId": "srv_prof_1",
                        "serverVersion": 1
                    }]
                });
                (200, resp.to_string())
            } else if method == "GET" && path.starts_with("/sync/pull") {
                let resp = serde_json::json!({
                    "clinicId": "clinic_http_ok",
                    "sinceSeq": 0,
                    "changes": [],
                    "currentSeq": 5,
                    "hasMore": false
                });
                (200, resp.to_string())
            } else {
                (404, "{}".to_string())
            }
        }).await;

        let handle = SyncWorkerHandle::new();
        handle.start_with_backend_url(
            clinic_id.to_string(),
            db.clone(),
            session_mgr.clone(),
            key_mgr.clone(),
            coordinator.clone(),
            Some(mock_url),
        ).await;

        // Await worker processing
        tokio::time::sleep(Duration::from_millis(600)).await;
        handle.stop().await;
        server_handle.abort();

        // Verify outbox was processed to SYNCED
        let conn = db.get_connection();
        let summary = DbOperations::get_outbox_summary(&conn, clinic_id).unwrap();
        assert_eq!(summary.synced_count, 1);
        assert_eq!(summary.pending_count, 0);
    }

    #[tokio::test]
    async fn test_sync_worker_http_conflict_handling() {
        let temp_dir = std::env::temp_dir().join(format!("cliniqo_http_conf_{}", uuid::Uuid::new_v4()));
        let db = Arc::new(DatabaseManager::init(&temp_dir).unwrap());
        let key_mgr = Arc::new(KeyManager::new(&temp_dir));
        let session_mgr = Arc::new(SessionManager::with_default_public_key().unwrap());
        let coordinator = Arc::new(RefreshCoordinator::new());
        let clinic_id = "clinic_http_conflict";

        session_mgr.set_test_session(clinic_id, "doc_conflict", "valid_jwt_token");

        let item_id = "prof_http_conf_1".to_string();
        let outbox_id = "outbox_prof_conf_1".to_string();
        {
            let conn = db.get_connection();
            let dek = db.get_dek();
            let payload = serde_json::json!({ "name": "Conflicting Clinic" });
            let (enc_payload, nonce) = crate::crypto::encrypt_payload(&dek.key, payload.to_string().as_bytes()).unwrap();
            conn.execute(
                "INSERT INTO local_sync_outbox (id, clinic_id, entity_type, entity_id, action, idempotency_key, encrypted_payload, nonce, sync_status) VALUES (?1, ?2, 'CLINIC_PROFILE', ?3, 'UPDATE', 'idem_prof_conf_1', ?4, ?5, 'PENDING')",
                params![&outbox_id, clinic_id, &item_id, enc_payload, nonce],
            )
            .unwrap();
        }

        let item_id_clone = item_id.clone();
        let outbox_clone = outbox_id.clone();
        let (mock_url, server_handle) = setup_mock_server(move |method, path, _body| {
            if method == "POST" && path == "/sync/push" {
                let resp = serde_json::json!({
                    "processedAt": "2026-10-28T00:00:00Z",
                    "clinicId": "clinic_http_conflict",
                    "results": [{
                        "outboxId": outbox_clone,
                        "status": "CONFLICT",
                        "entityType": "CLINIC_PROFILE",
                        "entityId": item_id_clone,
                        "serverId": "srv_conf_1",
                        "serverVersion": 3,
                        "error": "Concurrent remote modification",
                        "conflictDetails": {
                            "client_version": 1,
                            "server_version": 3,
                            "conflict_reason": "CONCURRENT_MODIFICATION"
                        }
                    }]
                });
                (200, resp.to_string())
            } else {
                let resp = serde_json::json!({
                    "clinicId": "clinic_http_conflict",
                    "sinceSeq": 0,
                    "changes": [],
                    "currentSeq": 0,
                    "hasMore": false
                });
                (200, resp.to_string())
            }
        }).await;

        let handle = SyncWorkerHandle::new();
        handle.start_with_backend_url(
            clinic_id.to_string(),
            db.clone(),
            session_mgr.clone(),
            key_mgr.clone(),
            coordinator.clone(),
            Some(mock_url),
        ).await;

        tokio::time::sleep(Duration::from_millis(600)).await;
        handle.stop().await;
        server_handle.abort();

        // Verify conflict recorded durably
        let conn = db.get_connection();
        let conflicts = DbOperations::get_conflicts(&conn, None).unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].entity_id, item_id);
        assert_eq!(conflicts[0].conflict_reason, "CONCURRENT_MODIFICATION");
        assert_eq!(conflicts[0].status, "OPEN");
    }

    #[tokio::test]
    async fn test_sync_worker_http_unauthorized_401() {
        let temp_dir = std::env::temp_dir().join(format!("cliniqo_http_401_{}", uuid::Uuid::new_v4()));
        let db = Arc::new(DatabaseManager::init(&temp_dir).unwrap());
        let key_mgr = Arc::new(KeyManager::new(&temp_dir));
        let session_mgr = Arc::new(SessionManager::with_default_public_key().unwrap());
        let coordinator = Arc::new(RefreshCoordinator::new());
        let clinic_id = "clinic_http_401";

        session_mgr.set_test_session(clinic_id, "doc_401", "expired_token");

        {
            let conn = db.get_connection();
            conn.execute(
                "INSERT INTO local_sync_outbox (id, clinic_id, entity_type, entity_id, action, idempotency_key, encrypted_payload, nonce, sync_status) VALUES ('outbox_401_1', ?1, 'CLINIC_PROFILE', 'prof_401_1', 'UPDATE', 'idem_401_1', X'00', X'00', 'PENDING')",
                params![clinic_id],
            )
            .unwrap();
        }

        let (mock_url, server_handle) = setup_mock_server(|_method, _path, _body| {
            (401, r#"{"error":"Unauthorized: invalid or expired token"}"#.to_string())
        }).await;

        let handle = SyncWorkerHandle::new();
        handle.start_with_backend_url(
            clinic_id.to_string(),
            db.clone(),
            session_mgr.clone(),
            key_mgr.clone(),
            coordinator.clone(),
            Some(mock_url),
        ).await;

        tokio::time::sleep(Duration::from_millis(600)).await;
        handle.stop().await;
        server_handle.abort();

        // In-flight items must revert safely to PENDING
        let conn = db.get_connection();
        let summary = DbOperations::get_outbox_summary(&conn, clinic_id).unwrap();
        assert_eq!(summary.pending_count, 1);
        assert_eq!(summary.in_flight_count, 0);
    }

    #[tokio::test]
    async fn test_sync_worker_http_server_error_500() {
        let temp_dir = std::env::temp_dir().join(format!("cliniqo_http_500_{}", uuid::Uuid::new_v4()));
        let db = Arc::new(DatabaseManager::init(&temp_dir).unwrap());
        let key_mgr = Arc::new(KeyManager::new(&temp_dir));
        let session_mgr = Arc::new(SessionManager::with_default_public_key().unwrap());
        let coordinator = Arc::new(RefreshCoordinator::new());
        let clinic_id = "clinic_http_500";

        session_mgr.set_test_session(clinic_id, "doc_500", "valid_token");

        {
            let conn = db.get_connection();
            conn.execute(
                "INSERT INTO local_sync_outbox (id, clinic_id, entity_type, entity_id, action, idempotency_key, encrypted_payload, nonce, sync_status) VALUES ('outbox_500_1', ?1, 'CLINIC_PROFILE', 'prof_500_1', 'UPDATE', 'idem_500_1', X'00', X'00', 'PENDING')",
                params![clinic_id],
            )
            .unwrap();
        }

        let (mock_url, server_handle) = setup_mock_server(|_method, _path, _body| {
            (500, r#"{"error":"Internal Database Error"}"#.to_string())
        }).await;

        let handle = SyncWorkerHandle::new();
        handle.start_with_backend_url(
            clinic_id.to_string(),
            db.clone(),
            session_mgr.clone(),
            key_mgr.clone(),
            coordinator.clone(),
            Some(mock_url),
        ).await;

        tokio::time::sleep(Duration::from_millis(600)).await;
        handle.stop().await;
        server_handle.abort();

        // In-flight items must revert safely to PENDING
        let conn = db.get_connection();
        let summary = DbOperations::get_outbox_summary(&conn, clinic_id).unwrap();
        assert_eq!(summary.pending_count, 1);
        assert_eq!(summary.in_flight_count, 0);
    }

    #[tokio::test]
    async fn test_sync_worker_http_cancellation_during_in_flight() {
        let temp_dir = std::env::temp_dir().join(format!("cliniqo_http_cancel_{}", uuid::Uuid::new_v4()));
        let db = Arc::new(DatabaseManager::init(&temp_dir).unwrap());
        let key_mgr = Arc::new(KeyManager::new(&temp_dir));
        let session_mgr = Arc::new(SessionManager::with_default_public_key().unwrap());
        let coordinator = Arc::new(RefreshCoordinator::new());
        let clinic_id = "clinic_http_cancel";

        session_mgr.set_test_session(clinic_id, "doc_cancel", "valid_token");

        {
            let conn = db.get_connection();
            conn.execute(
                "INSERT INTO local_sync_outbox (id, clinic_id, entity_type, entity_id, action, idempotency_key, encrypted_payload, nonce, sync_status) VALUES ('outbox_cancel_1', ?1, 'CLINIC_PROFILE', 'prof_cancel_1', 'UPDATE', 'idem_cancel_1', X'00', X'00', 'PENDING')",
                params![clinic_id],
            )
            .unwrap();
        }

        // Mock server that hangs for 5 seconds
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server_handle = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    use tokio::io::AsyncReadExt;
                    let mut buf = [0u8; 1024];
                    let _ = stream.read(&mut buf).await;
                    tokio::time::sleep(Duration::from_secs(5)).await;
                });
            }
        });

        let handle = SyncWorkerHandle::new();
        handle.start_with_backend_url(
            clinic_id.to_string(),
            db.clone(),
            session_mgr.clone(),
            key_mgr.clone(),
            coordinator.clone(),
            Some(format!("http://{}", addr)),
        ).await;

        // Allow worker to send request and enter in-flight state
        tokio::time::sleep(Duration::from_millis(150)).await;

        // Cancel worker while HTTP request is in-flight
        let start_stop = std::time::Instant::now();
        handle.stop().await;
        let elapsed = start_stop.elapsed();

        // Must cancel immediately via tokio::select!, not hang for 5s
        assert!(elapsed < Duration::from_millis(1000), "Worker stop took too long: {:?}", elapsed);
        server_handle.abort();

        // Reverted outbox items must be back in PENDING
        let conn = db.get_connection();
        let summary = DbOperations::get_outbox_summary(&conn, clinic_id).unwrap();
        assert_eq!(summary.pending_count, 1);
        assert_eq!(summary.in_flight_count, 0);
    }
}
