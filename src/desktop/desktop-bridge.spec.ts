import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isTauriDesktop,
  getApiBaseUrl,
  getDesktopInfo,
  getLocalPatients,
  saveLocalPatient,
  getSyncOutboxSummary,
  loginDesktopSession,
  logoutDesktopSession,
  getDesktopSession,
} from './desktop-bridge';

describe('Desktop Bridge (Tauri 2 Frontend Integration)', () => {
  const win = typeof window !== 'undefined' ? (window as any) : (globalThis as any);
  const originalTauri = win.__TAURI_INTERNALS__;

  beforeEach(() => {
    delete win.__TAURI_INTERNALS__;
    (globalThis as any).window = win;
  });

  afterEach(() => {
    if (originalTauri !== undefined) {
      win.__TAURI_INTERNALS__ = originalTauri;
    } else {
      delete win.__TAURI_INTERNALS__;
    }
  });

  it('detects standard web browser mode when Tauri internals are absent', () => {
    expect(isTauriDesktop()).toBe(false);
  });

  it('detects desktop mode when __TAURI_INTERNALS__ is present on window', () => {
    win.__TAURI_INTERNALS__ = {};
    expect(isTauriDesktop()).toBe(true);
  });

  it('returns valid API base URL without exposing backend secrets', () => {
    const url = getApiBaseUrl();
    expect(url).toBeDefined();
    expect(url).toMatch(/^https?:\/\//);
    expect(url).not.toContain('mongodb');
    expect(url).not.toContain('password');
  });

  it('safely returns null/empty array in web browser mode without throwing errors', async () => {
    const info = await getDesktopInfo();
    expect(info).toBeNull();

    const session = await getDesktopSession();
    expect(session).toBeNull();

    const loginRes = await loginDesktopSession('dummy_token', 'clinic_1', 'DOCTOR');
    expect(loginRes).toBeNull();

    await expect(logoutDesktopSession()).resolves.toBeUndefined();

    const patients = await getLocalPatients('clinic_test_1');
    expect(patients).toEqual([]);

    const patientId = await saveLocalPatient({
      clinic_id: 'clinic_test_1',
      patient_code: 'P-00101',
      name: 'Rohan Sharma',
      phone: '9876543210',
      gender: 'MALE',
      age: 40,
      allergies: [],
      conditions: [],
    });
    expect(patientId).toBeNull();

    const summary = await getSyncOutboxSummary('clinic_test_1');
    expect(summary).toBeNull();
  });
});
