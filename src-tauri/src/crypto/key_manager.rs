use std::fs;
use std::path::{Path, PathBuf};
use aes_gcm::aead::OsRng;
use aes_gcm::aead::rand_core::RngCore;
use zeroize::{Zeroize, ZeroizeOnDrop};
use super::CryptoError;

/// Database Encryption Key wrapper that zeroes memory on drop
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct DatabaseEncryptionKey {
    pub key: [u8; 32],
}

impl DatabaseEncryptionKey {
    pub fn new(key: [u8; 32]) -> Self {
        Self { key }
    }
}

pub struct KeyManager {
    key_dir: PathBuf,
}

impl KeyManager {
    pub fn new(app_data_dir: &Path) -> Self {
        let key_dir = app_data_dir.join("keys");
        Self { key_dir }
    }

    /// Retrieves existing DEK or generates and protects a new one
    pub fn get_or_create_dek(&self) -> Result<DatabaseEncryptionKey, CryptoError> {
        fs::create_dir_all(&self.key_dir)
            .map_err(|e| CryptoError::KeyStoreError(format!("Failed to create key directory: {e}")))?;

        let key_file = self.key_dir.join("dek.protected");

        if key_file.exists() {
            let protected_bytes = fs::read(&key_file)
                .map_err(|e| CryptoError::KeyStoreError(format!("Failed to read protected key file: {e}")))?;
            self.unprotect_dek(&protected_bytes)
        } else {
            let mut raw_key = [0u8; 32];
            OsRng.fill_bytes(&mut raw_key);

            let protected_bytes = self.protect_dek(&raw_key)?;

            fs::write(&key_file, &protected_bytes)
                .map_err(|e| CryptoError::KeyStoreError(format!("Failed to persist protected key: {e}")))?;

            let dek = DatabaseEncryptionKey::new(raw_key);
            raw_key.zeroize();
            Ok(dek)
        }
    }

    /// Protects 32-byte DEK
    pub fn protect_dek(&self, raw_key: &[u8; 32]) -> Result<Vec<u8>, CryptoError> {
        self.protect_data(raw_key)
    }

    /// Unprotects 32-byte DEK
    pub fn unprotect_dek(&self, protected_bytes: &[u8]) -> Result<DatabaseEncryptionKey, CryptoError> {
        let mut unprotected = self.unprotect_data(protected_bytes)?;
        if unprotected.len() != 32 {
            unprotected.zeroize();
            return Err(CryptoError::KeyStoreError(format!(
                "Unprotected key length mismatch: expected 32 bytes, got {}",
                unprotected.len()
            )));
        }

        let mut key = [0u8; 32];
        key.copy_from_slice(&unprotected);
        unprotected.zeroize();
        Ok(DatabaseEncryptionKey::new(key))
    }

    /// Securely persists an opaque refresh token using atomic temporary file write,
    /// fsync, and atomic rename. Also keeps a previous copy in .bak for crash recovery.
    pub fn save_refresh_token(&self, refresh_token: &str) -> Result<(), CryptoError> {
        let trimmed = refresh_token.trim();
        if trimmed.is_empty() {
            return Err(CryptoError::KeyStoreError(
                "Cannot persist empty refresh token".to_string(),
            ));
        }

        fs::create_dir_all(&self.key_dir)
            .map_err(|e| CryptoError::KeyStoreError(format!("Failed to create key directory: {e}")))?;

        let token_file = self.key_dir.join("refresh_token.protected");
        let backup_file = self.key_dir.join("refresh_token.protected.bak");
        let protected_bytes = self.protect_data(trimmed.as_bytes())?;

        // 1. If existing protected token file exists, backup before replacement
        if token_file.exists() {
            let _ = fs::copy(&token_file, &backup_file);
        }

        // 2. Write to atomic temporary file in same directory
        let tmp_filename = format!("refresh_token.tmp.{}", uuid::Uuid::new_v4());
        let tmp_path = self.key_dir.join(&tmp_filename);

        {
            use std::io::Write;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp_path)
                .map_err(|e| CryptoError::KeyStoreError(format!("Failed to create temp token file: {e}")))?;

            file.write_all(&protected_bytes)
                .map_err(|e| CryptoError::KeyStoreError(format!("Failed to write to temp token file: {e}")))?;

            file.sync_all()
                .map_err(|e| CryptoError::KeyStoreError(format!("Failed to flush temp token file: {e}")))?;
        }

        // 3. Atomic rename to destination
        fs::rename(&tmp_path, &token_file)
            .map_err(|e| CryptoError::KeyStoreError(format!("Failed to atomically replace protected token file: {e}")))?;

        log::info!("Opaque refresh token successfully persisted to secure DPAPI store via atomic crash-safe write.");
        Ok(())
    }

    /// Loads and decrypts the persisted refresh token, with automatic recovery from .bak if .protected is corrupted
    pub fn load_refresh_token(&self) -> Result<Option<String>, CryptoError> {
        let token_file = self.key_dir.join("refresh_token.protected");
        let backup_file = self.key_dir.join("refresh_token.protected.bak");

        let try_load_file = |path: &Path| -> Result<Option<String>, CryptoError> {
            if !path.exists() {
                return Ok(None);
            }
            let protected_bytes = fs::read(path)
                .map_err(|e| CryptoError::KeyStoreError(format!("Failed to read file {}: {e}", path.display())))?;
            let mut unprotected = self.unprotect_data(&protected_bytes)?;
            let token_str = String::from_utf8(unprotected.clone()).map_err(|_| {
                unprotected.zeroize();
                CryptoError::KeyStoreError("Corrupted refresh token: invalid UTF-8 encoding".to_string())
            })?;
            unprotected.zeroize();
            Ok(Some(token_str))
        };

        // Try primary token file
        let primary_res = try_load_file(&token_file);
        if let Ok(Some(tok)) = &primary_res {
            if !tok.trim().is_empty() {
                return Ok(Some(tok.clone()));
            }
        }

        // If primary was corrupted or missing, attempt recovery from backup store
        if backup_file.exists() {
            if let Ok(Some(bak_tok)) = try_load_file(&backup_file) {
                if !bak_tok.trim().is_empty() {
                    log::info!("Successfully recovered valid refresh token from backup store.");
                    let _ = fs::copy(&backup_file, &token_file);
                    return Ok(Some(bak_tok));
                }
            }
        }

        // If primary failed with corruption/decryption error and backup recovery failed, fail closed
        if let Err(e) = primary_res {
            log::error!("Primary refresh token corrupted and backup recovery failed: {e}");
            return Err(e);
        }

        Ok(None)
    }

    /// Returns the stable device identifier for this installation, generating one if not present
    pub fn get_or_create_device_id(&self) -> Result<String, CryptoError> {
        fs::create_dir_all(&self.key_dir)
            .map_err(|e| CryptoError::KeyStoreError(format!("Failed to create key directory: {e}")))?;

        let id_file = self.key_dir.join("device_id.txt");
        if id_file.exists() {
            if let Ok(content) = fs::read_to_string(&id_file) {
                let trimmed = content.trim();
                if !trimmed.is_empty() {
                    return Ok(trimmed.to_string());
                }
            }
        }

        let new_id = uuid::Uuid::new_v4().to_string();
        let tmp_file = self.key_dir.join(format!("device_id.tmp.{}", uuid::Uuid::new_v4()));
        {
            use std::io::Write;
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp_file)
                .map_err(|e| CryptoError::KeyStoreError(format!("Failed to create temp device_id file: {e}")))?;
            f.write_all(new_id.as_bytes())
                .map_err(|e| CryptoError::KeyStoreError(format!("Failed to write temp device_id: {e}")))?;
            f.sync_all()
                .map_err(|e| CryptoError::KeyStoreError(format!("Failed to flush temp device_id: {e}")))?;
        }
        fs::rename(&tmp_file, &id_file)
            .map_err(|e| CryptoError::KeyStoreError(format!("Failed to atomically save device_id: {e}")))?;

        Ok(new_id)
    }

    /// Securely zeroes and removes persisted refresh token and active clinic context upon logout
    pub fn clear_refresh_token(&self) -> Result<(), CryptoError> {
        let token_file = self.key_dir.join("refresh_token.protected");
        let backup_file = self.key_dir.join("refresh_token.protected.bak");

        for file in [&token_file, &backup_file] {
            if file.exists() {
                // Overwrite file with zeroes before deletion to prevent remnant recovery
                if let Ok(metadata) = fs::metadata(file) {
                    let len = metadata.len() as usize;
                    let zeroes = vec![0u8; len];
                    let _ = fs::write(file, &zeroes);
                }
                let _ = fs::remove_file(file);
            }
        }

        // Clean up any stray temporary files
        if let Ok(entries) = fs::read_dir(&self.key_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("refresh_token.tmp.") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }

        log::info!("Persisted refresh token securely zeroized and removed.");
        let _ = self.clear_active_clinic_id();
        Ok(())
    }

    /// Persists the active clinic ID to local secure key directory
    pub fn save_active_clinic_id(&self, clinic_id: &str) -> Result<(), CryptoError> {
        let trimmed = clinic_id.trim();
        if trimmed.is_empty() {
            return Err(CryptoError::KeyStoreError("Cannot persist empty clinic ID".to_string()));
        }
        fs::create_dir_all(&self.key_dir)
            .map_err(|e| CryptoError::KeyStoreError(format!("Failed to create key directory: {e}")))?;
        let clinic_file = self.key_dir.join("active_clinic.id");
        fs::write(&clinic_file, trimmed.as_bytes())
            .map_err(|e| CryptoError::KeyStoreError(format!("Failed to persist active clinic ID: {e}")))?;
        Ok(())
    }

    /// Loads the active clinic ID from local secure key directory
    pub fn load_active_clinic_id(&self) -> Result<Option<String>, CryptoError> {
        let clinic_file = self.key_dir.join("active_clinic.id");
        if !clinic_file.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(&clinic_file)
            .map_err(|e| CryptoError::KeyStoreError(format!("Failed to read active clinic ID: {e}")))?;
        let trimmed = content.trim();
        if trimmed.is_empty() {
            Ok(None)
        } else {
            Ok(Some(trimmed.to_string()))
        }
    }

    /// Clears active clinic ID from local key directory
    pub fn clear_active_clinic_id(&self) -> Result<(), CryptoError> {
        let clinic_file = self.key_dir.join("active_clinic.id");
        if clinic_file.exists() {
            let _ = fs::remove_file(&clinic_file);
        }
        Ok(())
    }

    /// Securely persists cached backend public key PEM and version using DPAPI protection
    pub fn save_backend_public_key(&self, version: u32, pem: &str) -> Result<(), CryptoError> {
        let trimmed = pem.trim();
        if trimmed.is_empty() {
            return Err(CryptoError::KeyStoreError(
                "Cannot persist empty public key PEM".to_string(),
            ));
        }

        fs::create_dir_all(&self.key_dir)
            .map_err(|e| CryptoError::KeyStoreError(format!("Failed to create key directory: {e}")))?;

        let key_file = self.key_dir.join("backend_pubkey.protected");
        let payload = serde_json::json!({
            "version": version,
            "pem": trimmed,
        })
        .to_string();
        let protected_bytes = self.protect_data(payload.as_bytes())?;

        fs::write(&key_file, &protected_bytes)
            .map_err(|e| CryptoError::KeyStoreError(format!("Failed to persist protected public key: {e}")))?;

        Ok(())
    }

    /// Loads cached backend public key version and PEM, returning None if absent
    pub fn load_backend_public_key(&self) -> Result<Option<(u32, String)>, CryptoError> {
        let key_file = self.key_dir.join("backend_pubkey.protected");
        if !key_file.exists() {
            return Ok(None);
        }

        let protected_bytes = fs::read(&key_file)
            .map_err(|e| CryptoError::KeyStoreError(format!("Failed to read protected public key: {e}")))?;

        let mut unprotected = self.unprotect_data(&protected_bytes)?;
        let payload_str = String::from_utf8(unprotected.clone()).map_err(|_| {
            unprotected.zeroize();
            CryptoError::KeyStoreError("Corrupted public key: invalid UTF-8 encoding".to_string())
        })?;

        unprotected.zeroize();

        // Parse structured JSON payload: {"version": u32, "pem": String}
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&payload_str) {
            if let (Some(v), Some(p)) = (
                parsed.get("version").and_then(|v| v.as_u64()),
                parsed.get("pem").and_then(|p| p.as_str()),
            ) {
                return Ok(Some((v as u32, p.to_string())));
            }
        }

        // Fallback for legacy raw PEM format with default version 1
        if payload_str.contains("BEGIN PUBLIC KEY") {
            return Ok(Some((1, payload_str)));
        }

        Err(CryptoError::KeyStoreError(
            "Corrupted public key metadata format".to_string(),
        ))
    }

    #[cfg(windows)]
    pub fn protect_data(&self, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
        use std::ptr::null_mut;
        use windows_sys::Win32::Security::Cryptography::{
            CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        };
        use windows_sys::Win32::Foundation::LocalFree;

        let mut data_in = CRYPT_INTEGER_BLOB {
            cbData: plaintext.len() as u32,
            pbData: plaintext.as_ptr() as *mut u8,
        };
        let mut data_out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: null_mut(),
        };

        unsafe {
            let success = CryptProtectData(
                &mut data_in,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut data_out,
            );

            if success == 0 {
                return Err(CryptoError::KeyStoreError(
                    "Windows DPAPI CryptProtectData failed to protect data".to_string(),
                ));
            }

            let slice = std::slice::from_raw_parts(data_out.pbData, data_out.cbData as usize);
            let protected_vec = slice.to_vec();

            // Zeroize ciphertext buffer before freeing
            let slice_mut = std::slice::from_raw_parts_mut(data_out.pbData, data_out.cbData as usize);
            slice_mut.zeroize();
            LocalFree(data_out.pbData as _);

            Ok(protected_vec)
        }
    }

    #[cfg(windows)]
    pub fn unprotect_data(&self, protected_bytes: &[u8]) -> Result<Vec<u8>, CryptoError> {
        use std::ptr::null_mut;
        use windows_sys::Win32::Security::Cryptography::{
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        };
        use windows_sys::Win32::Foundation::LocalFree;

        let mut data_in = CRYPT_INTEGER_BLOB {
            cbData: protected_bytes.len() as u32,
            pbData: protected_bytes.as_ptr() as *mut u8,
        };
        let mut data_out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: null_mut(),
        };

        unsafe {
            let success = CryptUnprotectData(
                &mut data_in,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut data_out,
            );

            if success == 0 {
                return Err(CryptoError::KeyStoreError(
                    "Windows DPAPI CryptUnprotectData failed to unprotect data".to_string(),
                ));
            }

            let slice = std::slice::from_raw_parts(data_out.pbData, data_out.cbData as usize);
            let unprotected_vec = slice.to_vec();

            // Volatile zeroization of DPAPI allocated plaintext buffer before freeing
            let slice_mut = std::slice::from_raw_parts_mut(data_out.pbData, data_out.cbData as usize);
            slice_mut.zeroize();
            LocalFree(data_out.pbData as _);

            Ok(unprotected_vec)
        }
    }

    #[cfg(not(windows))]
    pub fn protect_data(&self, _plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
        // Enforce that release builds on non-Windows cannot silently fall back to plaintext
        #[cfg(not(debug_assertions))]
        {
            return Err(CryptoError::KeyStoreError(
                "Plaintext key/token storage fallback is strictly forbidden in production release builds on non-Windows platforms. Windows DPAPI is required."
                    .to_string(),
            ));
        }

        #[cfg(debug_assertions)]
        {
            let mut obfuscated = Vec::with_capacity(4 + _plaintext.len());
            obfuscated.extend_from_slice(b"DPAP");
            obfuscated.extend_from_slice(_plaintext);
            Ok(obfuscated)
        }
    }

    #[cfg(not(windows))]
    pub fn unprotect_data(&self, _protected_bytes: &[u8]) -> Result<Vec<u8>, CryptoError> {
        #[cfg(not(debug_assertions))]
        {
            return Err(CryptoError::KeyStoreError(
                "Plaintext key/token storage fallback is strictly forbidden in production release builds on non-Windows platforms. Windows DPAPI is required."
                    .to_string(),
            ));
        }

        #[cfg(debug_assertions)]
        {
            if _protected_bytes.len() < 4 || &_protected_bytes[..4] != b"DPAP" {
                return Err(CryptoError::KeyStoreError(
                    "Invalid protected data format: missing mock DPAPI envelope".to_string(),
                ));
            }

            Ok(_protected_bytes[4..].to_vec())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_key_manager_create_and_load_roundtrip() {
        let temp_dir = std::env::temp_dir().join(format!("cliniqo_test_key_{}", uuid::Uuid::new_v4()));
        let key_mgr = KeyManager::new(&temp_dir);

        // 1. Initial generation
        let dek1 = key_mgr.get_or_create_dek().expect("first DEK generation succeeds");
        assert_ne!(dek1.key, [0u8; 32]);

        // 2. Load existing
        let dek2 = key_mgr.get_or_create_dek().expect("second load succeeds");
        assert_eq!(dek1.key, dek2.key);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_corrupt_key_fails_closed() {
        let temp_dir = std::env::temp_dir().join(format!("cliniqo_test_corrupt_key_{}", uuid::Uuid::new_v4()));
        let keys_dir = temp_dir.join("keys");
        fs::create_dir_all(&keys_dir).unwrap();

        // Write corrupt/truncated bytes
        fs::write(keys_dir.join("dek.protected"), b"corrupted_garbage_bytes").unwrap();

        let key_mgr = KeyManager::new(&temp_dir);
        let result = key_mgr.get_or_create_dek();

        assert!(result.is_err(), "Corrupt key must fail closed and never overwrite");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_invalid_length_key_fails() {
        let temp_dir = std::env::temp_dir().join(format!("cliniqo_test_len_key_{}", uuid::Uuid::new_v4()));
        let key_mgr = KeyManager::new(&temp_dir);

        // Under mock DPAPI, format requires prefix + 32 bytes
        let short_key = b"DPAPshort";
        let result = key_mgr.unprotect_dek(short_key);
        assert!(result.is_err());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_refresh_token_persistence_lifecycle() {
        let temp_dir = std::env::temp_dir().join(format!("cliniqo_test_token_{}", uuid::Uuid::new_v4()));
        let key_mgr = KeyManager::new(&temp_dir);

        // 1. Initially absent
        let absent = key_mgr.load_refresh_token().expect("load on empty store succeeds");
        assert_eq!(absent, None);

        // 2. Save 64-char hex refresh token
        let raw_token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        key_mgr.save_refresh_token(raw_token).expect("save token succeeds");

        // 3. Load persisted token
        let loaded = key_mgr.load_refresh_token().expect("load succeeds");
        assert_eq!(loaded.as_deref(), Some(raw_token));

        // 4. Token rotation: save a newly rotated token
        let rotated_token = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
        key_mgr.save_refresh_token(rotated_token).expect("save rotated token succeeds");

        let loaded_rotated = key_mgr.load_refresh_token().expect("load rotated token succeeds");
        assert_eq!(loaded_rotated.as_deref(), Some(rotated_token));

        // 5. Logout: safely zeroes and removes token
        key_mgr.clear_refresh_token().expect("clear token succeeds");
        let after_logout = key_mgr.load_refresh_token().expect("load after logout succeeds");
        assert_eq!(after_logout, None);

        // 6. Idempotent clear when file absent
        assert!(key_mgr.clear_refresh_token().is_ok());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_corrupt_refresh_token_fails_closed() {
        let temp_dir = std::env::temp_dir().join(format!("cliniqo_test_corrupt_tok_{}", uuid::Uuid::new_v4()));
        let keys_dir = temp_dir.join("keys");
        fs::create_dir_all(&keys_dir).unwrap();

        // Write corrupt garbage bytes (missing valid DPAPI header)
        fs::write(keys_dir.join("refresh_token.protected"), b"corrupted_garbage_bytes").unwrap();

        let key_mgr = KeyManager::new(&temp_dir);
        let result = key_mgr.load_refresh_token();
        assert!(result.is_err(), "Corrupt refresh token must fail closed");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_empty_refresh_token_rejected() {
        let temp_dir = std::env::temp_dir().join(format!("cliniqo_test_empty_tok_{}", uuid::Uuid::new_v4()));
        let key_mgr = KeyManager::new(&temp_dir);

        let result = key_mgr.save_refresh_token("   ");
        assert!(result.is_err(), "Empty refresh token must be rejected");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_backend_public_key_persistence_lifecycle() {
        let temp_dir = std::env::temp_dir().join(format!("cliniqo_test_pubkey_{}", uuid::Uuid::new_v4()));
        let key_mgr = KeyManager::new(&temp_dir);

        let pem = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...\n-----END PUBLIC KEY-----";
        key_mgr.save_backend_public_key(2, pem).expect("save public key succeeds");

        let loaded = key_mgr.load_backend_public_key().expect("load public key succeeds");
        assert_eq!(loaded, Some((2, pem.to_string())));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_refresh_token_backup_recovery_on_corruption() {
        let temp_dir = std::env::temp_dir().join(format!("cliniqo_test_bak_rec_{}", uuid::Uuid::new_v4()));
        let key_mgr = KeyManager::new(&temp_dir);

        // 1. Save first valid token
        key_mgr.save_refresh_token("token_alpha_1").expect("save token alpha succeeds");

        // 2. Save second token - this promotes alpha to .protected.bak
        key_mgr.save_refresh_token("token_beta_2").expect("save token beta succeeds");

        let keys_dir = temp_dir.join("keys");
        let token_file = keys_dir.join("refresh_token.protected");
        let backup_file = keys_dir.join("refresh_token.protected.bak");
        assert!(token_file.exists());
        assert!(backup_file.exists());

        // 3. Corrupt primary token file
        fs::write(&token_file, b"corrupted_primary_data").unwrap();

        // 4. load_refresh_token should automatically recover alpha from backup
        let recovered = key_mgr.load_refresh_token().expect("recovery from backup succeeds");
        assert_eq!(recovered, Some("token_alpha_1".to_string()));

        // 5. Subsequent load should find restored primary file
        let reloaded = key_mgr.load_refresh_token().expect("load from restored file succeeds");
        assert_eq!(reloaded, Some("token_alpha_1".to_string()));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_device_id_generation_and_persistence() {
        let temp_dir = std::env::temp_dir().join(format!("cliniqo_test_dev_id_{}", uuid::Uuid::new_v4()));
        let key_mgr = KeyManager::new(&temp_dir);

        // 1. Initial generation
        let id1 = key_mgr.get_or_create_device_id().expect("generate device id");
        assert!(!id1.trim().is_empty());
        assert!(uuid::Uuid::parse_str(&id1).is_ok(), "device id must be valid UUID");

        // 2. Subsequent load must return identical stable device ID
        let id2 = key_mgr.get_or_create_device_id().expect("read existing device id");
        assert_eq!(id1, id2, "device id must remain stable across calls");

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
