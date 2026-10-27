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

    #[cfg(windows)]
    pub fn protect_dek(&self, raw_key: &[u8; 32]) -> Result<Vec<u8>, CryptoError> {
        use std::ptr::null_mut;
        use windows_sys::Win32::Security::Cryptography::{
            CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        };
        use windows_sys::Win32::Foundation::LocalFree;

        let mut data_in = CRYPT_INTEGER_BLOB {
            cbData: raw_key.len() as u32,
            pbData: raw_key.as_ptr() as *mut u8,
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
                    "Windows DPAPI CryptProtectData failed to protect DEK".to_string(),
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
    pub fn unprotect_dek(&self, protected_bytes: &[u8]) -> Result<DatabaseEncryptionKey, CryptoError> {
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
                    "Windows DPAPI CryptUnprotectData failed to unprotect DEK".to_string(),
                ));
            }

            if data_out.cbData != 32 {
                // Volatile zeroization before freeing on error path
                let slice = std::slice::from_raw_parts_mut(data_out.pbData, data_out.cbData as usize);
                slice.zeroize();
                LocalFree(data_out.pbData as _);

                return Err(CryptoError::KeyStoreError(format!(
                    "Unprotected key length mismatch: expected 32 bytes, got {}",
                    data_out.cbData
                )));
            }

            let mut key = [0u8; 32];
            std::ptr::copy_nonoverlapping(data_out.pbData, key.as_mut_ptr(), 32);

            // Volatile zeroization of DPAPI allocated plaintext buffer before freeing
            let slice = std::slice::from_raw_parts_mut(data_out.pbData, 32);
            slice.zeroize();
            LocalFree(data_out.pbData as _);

            Ok(DatabaseEncryptionKey::new(key))
        }
    }

    #[cfg(not(windows))]
    pub fn protect_dek(&self, raw_key: &[u8; 32]) -> Result<Vec<u8>, CryptoError> {
        // Enforce that release builds on non-Windows cannot silently fall back to plaintext
        #[cfg(not(debug_assertions))]
        {
            return Err(CryptoError::KeyStoreError(
                "Plaintext key storage fallback is strictly forbidden in production release builds on non-Windows platforms. Windows DPAPI is required."
                    .to_string(),
            ));
        }

        #[cfg(debug_assertions)]
        {
            let mut obfuscated = Vec::with_capacity(36);
            obfuscated.extend_from_slice(b"DPAP");
            obfuscated.extend_from_slice(raw_key);
            Ok(obfuscated)
        }
    }

    #[cfg(not(windows))]
    pub fn unprotect_dek(&self, protected_bytes: &[u8]) -> Result<DatabaseEncryptionKey, CryptoError> {
        #[cfg(not(debug_assertions))]
        {
            return Err(CryptoError::KeyStoreError(
                "Plaintext key storage fallback is strictly forbidden in production release builds on non-Windows platforms. Windows DPAPI is required."
                    .to_string(),
            ));
        }

        #[cfg(debug_assertions)]
        {
            if protected_bytes.len() != 36 || &protected_bytes[..4] != b"DPAP" {
                return Err(CryptoError::KeyStoreError(
                    "Invalid protected key format: expected 36-byte mock DPAPI envelope".to_string(),
                ));
            }

            let mut key = [0u8; 32];
            key.copy_from_slice(&protected_bytes[4..36]);
            Ok(DatabaseEncryptionKey::new(key))
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
}
