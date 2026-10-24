# Cliniqo — Secure Authentication Architecture

## 1. System Topology & Context

Cliniqo is a specialized Clinic Management System built for Windows desktop environments used by doctors. The system topology comprises:
- **Client**: Native Windows desktop application built with Tauri 2 (wrapping the verified React/Vite clinical UI).
- **Backend**: Modular, isolated NestJS application running Node.js in strict ESM mode.
- **Data Layer**: MongoDB Atlas replica set managed via Mongoose ODM.

---

## 2. Doctor Identity & Account Normalization

### Email as Primary Identifier
- Doctor accounts use an email address as the canonical unique identity.
- **Normalization Pipeline**: All email inputs are sanitized at the application boundary:
  1. Trim leading and trailing whitespace.
  2. Convert entirely to lowercase (`email.trim().toLowerCase()`).
  3. Validate against standard RFC 5322 format.
  4. Enforce RFC 5321 length limits (maximum 254 characters).

### Database-Level Uniqueness
Application-level validation checks alone cannot guarantee uniqueness under concurrent registration requests. Database integrity is guaranteed by:
- A unique index on `email` (`{ email: 1 }, { unique: true }`) defined in `DoctorSchema`.
- Safe error interception that catches MongoDB duplicate-key errors (`code === 11000`) and translates them into a generic, sanitized HTTP 409 `ConflictException`. Internal database metadata, key patterns, and schema collections are never leaked.

---

## 3. Account Lifecycle & Statuses

Doctor accounts progress through four explicit lifecycle states (`DoctorStatus`):

| State | Definition | Authentication Allowed | Session Behavior |
| :--- | :--- | :--- | :--- |
| `PENDING_VERIFICATION` | Account registered; awaiting email confirmation or administrative verification. | No | Cannot generate access or refresh tokens. |
| `ACTIVE` | Account fully verified and in good standing. | Yes | Authorized to issue and rotate sessions. |
| `DISABLED` | Account deactivated by administrative action, subscription hold, or security investigation. | No | Immediately revokes all active refresh sessions. |
| `LOCKED` | Account temporarily locked due to excessive failed authentication attempts (e.g., > 5 consecutive failures). | No | Cool-down period (15 minutes) or administrative unlock required. |

---

## 4. Password Security & Argon2id Hashing

### Cryptographic Standard
Cliniqo uses **Argon2id** (RFC 9106), the winner of the Password Hashing Competition (PHC) and the gold standard for password storage resistance against GPU/ASIC side-channel and trade-off attacks.
- Plaintext passwords and reversible encryption are strictly forbidden.
- Algorithm: `argon2.argon2id` (RFC 9106 hybrid mode).
- Target parameters (configurable via fail-closed environment variables):
  - **Memory cost**: 65,536 KiB (64 MB RAM per hash)
  - **Time cost**: 3 iterations
  - **Parallelism**: 4 threads
- Salting: Cryptographically secure random 16-byte salts are generated automatically by Argon2 per hash and embedded in the standard modular PHC output string (`$argon2id$v=19$m=...`).

### Safe Verification & Error Handling
- Constant-time verification is performed using `argon2.verify(hash, plaintext)`.
- Malformed hashes, empty passwords, or corrupted strings fail safely to `false` without throwing unhandled exceptions or triggering internal 500 errors.
- Automatic rehash detection (`needsRehash`) allows transparent password hash upgrading if cost parameters increase in future releases.

---

## 5. Token & Session Architecture (Phase 3B Implementation Plan)

### Short-Lived Access Tokens
- **Format**: Signed JSON Web Tokens (JWT).
- **Algorithm**: RS256 or HMAC-SHA256 (minimum 256-bit secret key).
- **Lifetime**: 15 minutes (`JWT_ACCESS_EXPIRES_IN=15m`).
- **Claims**: Minimal identity claims:
  - `sub`: Doctor UUID / ObjectId
  - `email`: Normalized email
  - `status`: Account status
  - `iat`, `exp`: Issued at / Expiration timestamps
  - `jti`: Unique token identifier for emergency revocation.

### Secure Refresh Sessions & Rotation
- **Token Format**: 256-bit cryptographically secure pseudo-random numbers (CSPRNG), hex-encoded opaque strings (never JWTs).
- **Database Storage**: Refresh tokens are **never stored in plaintext** in the database. Only their SHA-256 (or Argon2) hash is stored in a dedicated `refresh_sessions` collection.
- **Strict Rotation**: Each refresh request presents the current refresh token:
  1. The token hash is looked up.
  2. If valid and not expired, the existing session is consumed and invalidated.
  3. A new access token and a brand-new opaque refresh token are generated and returned.
- **Replay / Reuse Attack Detection**:
  - If an already-invalidated refresh token is presented, the system detects a potential token compromise and immediately revokes the **entire session family** for that doctor, requiring fresh credential re-authentication.

### Revocation Triggers
All active sessions for a doctor are instantly invalidated upon:
1. Explicit user logout.
2. Password modification or reset.
3. Transition of account status to `DISABLED` or `LOCKED`.
4. Detection of refresh token replay/theft.

---

## 6. Client Token Security (Windows Desktop)

### Elimination of Browser LocalStorage
- **Rule**: Access tokens, refresh tokens, and credentials must **never** be placed in browser `localStorage` or `sessionStorage`. Browser storage APIs are susceptible to script injection (XSS) and unencrypted file access on the host operating system.
- **Desktop Storage in Tauri 2**:
  - Short-lived access tokens reside purely **in memory** within the client process.
  - Refresh tokens are stored in the secure Windows Credential Manager or DPAPI-encrypted vaults using Tauri's native secure plugin (`tauri-plugin-stronghold` / Windows DPAPI).
  - Webview contexts cannot access sensitive tokens outside the isolated IPC bridge.

---

## 7. Server-Side Authorization & Future Clinic Isolation (Phase 3C Preview)

### Fail-Closed Server Authorization
- **Never Trust Client Data**: Client applications must never supply `doctorId`, `clinicId`, roles, or permission flags in query parameters or request bodies to authorize actions.
- Every authenticated request extracts the authenticated doctor identity exclusively from the validated access token claims.

### Clinic Isolation Strategy
- In Phase 3C, clinic multi-tenancy and isolation will be introduced.
- **No Leaky Global Plugins**: Rather than relying on a universal, opaque Mongoose tenant plugin that can silently drop filters or be bypassed by raw aggregation pipelines, Cliniqo will enforce explicit, compile-time and service-boundary clinic scoping:
  - Every clinical operation will resolve the doctor's authorized `clinicId` server-side from their verified account record.
  - Database queries and mutations will explicitly bind `{ clinicId }` at the service repository boundary.
  - Inter-clinic access attempts will fail closed with HTTP 403 `ForbiddenException` and security event logging.
