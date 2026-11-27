pub mod auth;
pub mod commands;
pub mod config;
pub mod crypto;
pub mod db;
pub mod sync;
pub mod updater;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Manager;
use auth::SessionManager;
use commands::{AppState, RefreshCoordinator};
use crypto::key_manager::KeyManager;
use db::DatabaseManager;
use sync::SyncWorkerHandle;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Resolve platform-safe app local data directory
            // (e.g. %LOCALAPPDATA%/com.cliniqo.desktop on Windows, ~/Library/Application Support/... on macOS)
            let app_data_dir = app
                .path()
                .app_local_data_dir()
                .expect("Failed to resolve app local data directory");

            log::info!("Cliniqo local app data directory: {:?}", app_data_dir);

            // Initialize encrypted SQLite database with WAL and migrations
            let db_manager = DatabaseManager::init(&app_data_dir)
                .expect("Failed to initialize local encrypted database");

            let key_manager = KeyManager::new(&app_data_dir);

            // Initialize SessionManager: fail-closed with pinned default unless dynamic rotation is active
            let session_manager = if SessionManager::DYNAMIC_KEY_ROTATION_ENABLED {
                match key_manager.load_backend_public_key() {
                    Ok(Some((version, ref pem))) => match SessionManager::new_with_version(pem, version) {
                        Ok(mgr) => {
                            log::info!("Loaded verified cached backend public key v{} from secure store.", version);
                            mgr
                        }
                        Err(e) => {
                            log::warn!(
                                "Corrupted cached backend public key ({e}), falling back to pinned default."
                            );
                            SessionManager::with_default_public_key()
                                .expect("Failed to initialize session manager with default public key")
                        }
                    },
                    _ => SessionManager::with_default_public_key()
                        .expect("Failed to initialize session manager with default public key"),
                }
            } else {
                SessionManager::with_default_public_key()
                    .expect("Failed to initialize session manager with default public key")
            };

            let sync_handle = Arc::new(SyncWorkerHandle::new());
            let refresh_coordinator = Arc::new(RefreshCoordinator::new());
            let http_client = config::create_shared_http_client()
                .expect("Failed to initialize shared HTTP client");
            let db_arc = Arc::new(db_manager);
            let session_arc = Arc::new(session_manager);
            let key_arc = Arc::new(key_manager);
            let catalogue_sync = Arc::new(crate::sync::CatalogueSyncManager::new(
                db_arc.clone(),
                session_arc.clone(),
                key_arc.clone(),
                refresh_coordinator.clone(),
            ));
            let consultation_active = Arc::new(AtomicBool::new(false));

            // Background local encrypted auto-backup scheduler (100% local, zero cloud upload)
            {
                let bg_db = db_arc.clone();
                let bg_session = session_arc.clone();
                let bg_active = consultation_active.clone();
                let bg_data_dir = app_data_dir.clone();
                let bg_docs_dir = app.path().document_dir().ok();
                tauri::async_runtime::spawn(async move {
                    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(600));
                    ticker.tick().await;
                    loop {
                        ticker.tick().await;
                        if bg_active.load(Ordering::Acquire) {
                            continue;
                        }
                        if let Some(sess) = bg_session.get_session() {
                            if !sess.clinic_id.trim().is_empty() {
                                let cid = sess.clinic_id;
                                let db_clone = bg_db.clone();
                                let dir_clone = bg_data_dir.clone();
                                let docs_clone = bg_docs_dir.clone();
                                let active_flag = bg_active.load(Ordering::Acquire);
                                let _ = tokio::task::spawn_blocking(move || {
                                    if let Err(err) = crate::db::backup::BackupManager::run_auto_backup_with_dirs(
                                        &db_clone,
                                        &cid,
                                        &dir_clone,
                                        docs_clone.as_deref(),
                                        active_flag,
                                        false,
                                    ) {
                                        log::warn!("Scheduled local auto-backup note: {err}");
                                    }
                                })
                                .await;
                            }
                        }
                    }
                });
            }

            app.manage(AppState {
                db: db_arc,
                session_mgr: session_arc,
                key_mgr: key_arc,
                sync_handle,
                refresh_coordinator,
                catalogue_sync,
                http_client,
                consultation_active,
                app_data_dir,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_desktop_info,
            commands::get_trusted_api_url,
            commands::register_desktop,
            commands::create_clinic_desktop,
            commands::login_desktop,
            commands::login_desktop_session,
            commands::refresh_desktop_session,
            commands::restore_offline_desktop_session,
            commands::logout_desktop_session,
            commands::get_desktop_session,
            commands::has_persisted_refresh_token,
            commands::get_sync_status,
            commands::switch_active_clinic,
            commands::get_next_patient_code,
            commands::save_local_patient,
            commands::delete_local_patient,
            commands::get_local_patients,
            commands::get_local_patients_page,
            commands::get_local_patient_by_id,
            commands::get_dashboard_summary,
            commands::save_local_consultation,
            commands::save_local_consultation_draft,
            commands::update_local_consultation,
            commands::get_local_consultations,
            commands::save_local_prescription,
            commands::update_local_prescription,
            commands::revise_local_prescription,
            commands::get_local_prescriptions,
            commands::get_sync_outbox_summary,
            commands::get_sync_state,
            commands::get_sync_conflicts,
            commands::resolve_sync_conflict,
            commands::save_local_invoice,
            commands::get_next_invoice_number,
            commands::get_local_invoices,
            commands::get_local_invoice_by_id,
            commands::finalize_local_invoice,
            commands::save_local_formulary_item,
            commands::get_local_formulary,
            commands::delete_local_formulary_item,
            commands::import_inventory_stock,
            commands::get_inventory_stock,
            commands::get_inventory_stock_summary,
            commands::import_clinical_library,
            commands::rollback_clinical_library_batch,
            commands::get_clinical_library_items,
            commands::get_clinical_library_batches,
            commands::save_clinical_library_item,
            commands::archive_clinical_library_item,
            commands::search_catalogue_cache,
            commands::get_catalogue_strengths_cache,
            commands::save_catalogue_cache,
            commands::get_catalogue_cache_stats,
            commands::seed_catalogue_cache,
            commands::get_catalogue_sync_status,
            commands::start_catalogue_sync,
            commands::get_clinic_profile,
            commands::save_clinic_profile,
            commands::get_doctor_profile,
            commands::save_doctor_profile,
            commands::export_encrypted_backup,
            commands::restore_encrypted_backup,
            commands::set_consultation_active_state,
            commands::get_auto_backup_status,
            commands::update_auto_backup_config,
            commands::run_auto_backup_now,
            commands::run_database_diagnostics,
            commands::check_app_update,
            commands::download_and_verify_update,
            commands::install_staged_update,
            commands::download_and_launch_update,
            commands::get_update_completion_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}

