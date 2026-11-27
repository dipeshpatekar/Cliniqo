pub mod key_manager;

use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use aes_gcm::aead::rand_core::RngCore;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use thiserror::Error;
use zeroize::Zeroize;

type HmacSha256 = Hmac<Sha256>;
const PHONE_HMAC_SUBKEY_DOMAIN: &[u8] = b"cliniqo:v14:patient_phone_hmac_subkey_v1";

#[derive(Error, Debug)]
pub enum CryptoError {
    #[error("Encryption failed: {0}")]
    EncryptionFailed(String),

    #[error("Decryption failed: {0}")]
    DecryptionFailed(String),

    #[error("Key store error: {0}")]
    KeyStoreError(String),

    #[error("Invalid nonce length: expected 12 bytes, got {0}")]
    InvalidNonceLength(usize),
}

/// Encrypts plaintext data using AES-256-GCM with a freshly generated 96-bit nonce.
/// Returns a tuple of (ciphertext, nonce).
pub fn encrypt_payload(dek: &[u8; 32], plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>), CryptoError> {
    let cipher = Aes256Gcm::new_from_slice(dek)
        .map_err(|e| CryptoError::EncryptionFailed(format!("Invalid key length: {e}")))?;

    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| CryptoError::EncryptionFailed(format!("AEAD encryption error: {e}")))?;

    Ok((ciphertext, nonce_bytes.to_vec()))
}

/// Decrypts AES-256-GCM ciphertext using the provided DEK and 96-bit nonce.
pub fn decrypt_payload(
    dek: &[u8; 32],
    ciphertext: &[u8],
    nonce_bytes: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    if nonce_bytes.len() != 12 {
        return Err(CryptoError::InvalidNonceLength(nonce_bytes.len()));
    }

    let cipher = Aes256Gcm::new_from_slice(dek)
        .map_err(|e| CryptoError::DecryptionFailed(format!("Invalid key length: {e}")))?;

    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| CryptoError::DecryptionFailed(format!("AEAD decryption or authentication error: {e}")))?;

    Ok(plaintext)
}

/// Extracts digits from a phone string and normalizes valid 10+ digit phone numbers
/// to their canonical trailing 10 digits for blind-index duplicate detection.
/// Returns `None` for empty, missing, or malformed (< 10 digit) values.
pub fn normalize_phone_digits(phone: &str) -> Option<String> {
    let digits: String = phone.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 10 {
        return None;
    }
    Some(digits[digits.len() - 10..].to_string())
}

/// Derives a dedicated 32-byte phone blind-index HMAC subkey from the existing DEK
/// hierarchy using domain-separated HMAC-SHA256.
pub fn derive_phone_hmac_key(dek: &[u8; 32]) -> Result<[u8; 32], CryptoError> {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(dek)
        .map_err(|e| CryptoError::EncryptionFailed(format!("HMAC key derivation failed: {e}")))?;
    mac.update(PHONE_HMAC_SUBKEY_DOMAIN);
    let tag = mac.finalize().into_bytes();
    let mut subkey = [0u8; 32];
    subkey.copy_from_slice(&tag);
    Ok(subkey)
}

/// Computes a keyed HMAC-SHA256 blind index over normalized phone numbers for O(1)
/// duplicate detection without storing plaintext phone numbers in SQLite indexes.
/// Returns `Ok(None)` for empty or malformed (< 10 digit) phone values.
pub fn compute_phone_hmac(dek: &[u8; 32], phone: &str) -> Result<Option<Vec<u8>>, CryptoError> {
    let Some(norm_phone) = normalize_phone_digits(phone) else {
        return Ok(None);
    };

    let mut subkey = derive_phone_hmac_key(dek)?;
    let mut mac = <HmacSha256 as Mac>::new_from_slice(&subkey)
        .map_err(|e| CryptoError::EncryptionFailed(format!("Phone HMAC init failed: {e}")))?;
    mac.update(norm_phone.as_bytes());
    let digest = mac.finalize().into_bytes().to_vec();
    subkey.zeroize();
    Ok(Some(digest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let key = [42u8; 32];
        let original_data = b"Sensitive clinical findings: patient allergic to penicillin";

        let (ciphertext, nonce) = encrypt_payload(&key, original_data).expect("encryption succeeds");
        assert_ne!(ciphertext, original_data);
        assert_eq!(nonce.len(), 12);

        let decrypted = decrypt_payload(&key, &ciphertext, &nonce).expect("decryption succeeds");
        assert_eq!(decrypted, original_data);
    }

    #[test]
    fn test_tamper_detection_fails_decryption() {
        let key = [99u8; 32];
        let original_data = b"Prescription: 500mg Augmentin BD";

        let (mut ciphertext, nonce) = encrypt_payload(&key, original_data).expect("encryption succeeds");
        // Tamper with one byte of ciphertext
        ciphertext[0] ^= 0xFF;

        let result = decrypt_payload(&key, &ciphertext, &nonce);
        assert!(result.is_err(), "Tampered ciphertext must fail AEAD verification");
    }

    #[test]
    fn test_invalid_nonce_length_rejected() {
        let key = [1u8; 32];
        let result = decrypt_payload(&key, b"data", b"short");
        assert!(matches!(result, Err(CryptoError::InvalidNonceLength(_))));
    }

    #[test]
    fn test_phone_hmac_normalization_key_separation_and_stability() {
        use sha2::Digest;

        let dek_a = [0x11u8; 32];
        let dek_b = [0x22u8; 32];

        let h1 = compute_phone_hmac(&dek_a, "9876543210").unwrap().unwrap();
        let h2 = compute_phone_hmac(&dek_a, "+91 98765-43210").unwrap().unwrap();
        let h3 = compute_phone_hmac(&dek_a, "09876543210").unwrap().unwrap();
        assert_eq!(h1, h2);
        assert_eq!(h1, h3);
        assert_eq!(h1.len(), 32);

        // Must differ across DEKs and must not match unsalted SHA-256
        let h_other = compute_phone_hmac(&dek_b, "9876543210").unwrap().unwrap();
        assert_ne!(h1, h_other);
        let raw_sha = Sha256::digest(b"9876543210").to_vec();
        assert_ne!(h1, raw_sha);

        // Empty or malformed phones safely yield None
        assert_eq!(compute_phone_hmac(&dek_a, "").unwrap(), None);
        assert_eq!(compute_phone_hmac(&dek_a, "12345").unwrap(), None);
        assert_eq!(compute_phone_hmac(&dek_a, "abc-not-a-phone").unwrap(), None);
    }
}

