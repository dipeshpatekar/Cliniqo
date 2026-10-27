pub mod auth;
pub mod commands;
pub mod crypto;
pub mod db;

use std::sync::Arc;
use tauri::Manager;
use auth::SessionManager;
use commands::AppState;
use db::DatabaseManager;

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

            let session_manager = SessionManager::with_default_secret();

            app.manage(AppState {
                db: Arc::new(db_manager),
                session_mgr: Arc::new(session_manager),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_desktop_info,
            commands::login_desktop_session,
            commands::logout_desktop_session,
            commands::get_desktop_session,
            commands::save_local_patient,
            commands::get_local_patients,
            commands::save_local_consultation,
            commands::get_local_consultations,
            commands::save_local_prescription,
            commands::get_local_prescriptions,
            commands::get_sync_outbox_summary,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
