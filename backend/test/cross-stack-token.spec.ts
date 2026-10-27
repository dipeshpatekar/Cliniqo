import { describe, it, expect, beforeAll } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { JwtService } from '@nestjs/jwt';
import { Types } from 'mongoose';
import { TokenService } from '../src/auth/token.service.js';
import { ConfigService } from '../src/config/config.service.js';
import { DoctorStatus } from '../src/auth/auth.constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Cross-Stack JWT Security Verification (Backend NestJS -> Rust Tauri)', () => {
  let rsaKeyPair: { publicKey: string; privateKey: string };
  let configService: ConfigService;
  let jwtService: JwtService;
  let tokenService: TokenService;
  let hasCargo = false;
  const cargoManifestPath = path.resolve(__dirname, '../../src-tauri/Cargo.toml');

  function runVerifier(inputPayload: string): { status: number | null; stdout: string; stderr: string } {
    const exeName = process.platform === 'win32' ? 'verify_token.exe' : 'verify_token';
    const directBinPath = path.resolve(__dirname, '../../src-tauri/target/debug', exeName);

    if (fs.existsSync(directBinPath)) {
      return spawnSync(directBinPath, [], {
        input: inputPayload,
        encoding: 'utf8',
        timeout: 30_000,
      });
    }

    return spawnSync(
      'cargo',
      ['run', '--quiet', '--bin', 'verify_token', '--manifest-path', cargoManifestPath],
      {
        input: inputPayload,
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
  }

  beforeAll(() => {
    // Generate valid RSA 2048-bit keypair for test configuration
    rsaKeyPair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    configService = new ConfigService({
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: 'x'.repeat(32),
      JWT_REFRESH_SECRET: 'y'.repeat(32),
      JWT_ACCESS_EXPIRES_IN: '15m',
      JWT_REFRESH_EXPIRES_IN: '7d',
      JWT_ISSUER: 'cliniqo-backend',
      JWT_AUDIENCE: 'cliniqo-client',
      JWT_PRIVATE_KEY: rsaKeyPair.privateKey,
      JWT_PUBLIC_KEY: rsaKeyPair.publicKey,
    });

    jwtService = new JwtService();

    const mockSessionModel = {
      create: () => Promise.resolve({}),
      findOne: () => Promise.resolve(null),
    } as any;

    const mockDoctorModel = {
      findById: () => Promise.resolve(null),
    } as any;

    tokenService = new TokenService(
      jwtService,
      configService,
      mockSessionModel,
      mockDoctorModel,
    );

    // Check if cargo is available in current PATH
    const checkCargo = spawnSync('cargo', ['--version'], { stdio: 'ignore' });
    hasCargo = checkCargo.status === 0;

    // Ensure verify_token binary is compiled once before running tests
    const exeName = process.platform === 'win32' ? 'verify_token.exe' : 'verify_token';
    const directBinPath = path.resolve(__dirname, '../../src-tauri/target/debug', exeName);
    if (hasCargo && !fs.existsSync(directBinPath)) {
      spawnSync(
        'cargo',
        ['build', '--quiet', '--bin', 'verify_token', '--manifest-path', cargoManifestPath],
        { stdio: 'ignore', timeout: 120_000 },
      );
    }
  }, 120_000);

  it('generates a token conforming strictly to desktop RS256 and claim requirements', async () => {
    const doctorId = new Types.ObjectId().toString();
    const token = await tokenService.generateAccessToken({
      _id: doctorId,
      email: 'dr.cross@cliniqo.app',
      fullName: 'Dr. Cross Verifier',
      status: DoctorStatus.ACTIVE,
    });

    expect(token).toBeDefined();
    expect(token.split('.')).toHaveLength(3);

    // Decode header & claims
    const header = JSON.parse(
      Buffer.from(token.split('.')[0], 'base64url').toString('utf8'),
    );
    expect(header.alg).toBe('RS256');

    const claims = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    );
    expect(claims.sub).toBe(doctorId);
    expect(claims.email).toBe('dr.cross@cliniqo.app');
    expect(claims.fullName).toBe('Dr. Cross Verifier');
    expect(claims.type).toBe('access'); // Mandatory 'type: access'
    expect(claims.iss).toBe('cliniqo-backend');
    expect(claims.aud).toBe('cliniqo-client');
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('proves a token signed by TokenService is accepted by the Rust verifier using the configured public key', async () => {
    if (!hasCargo) {
      console.warn('Skipping native cargo execution: cargo toolchain not found in environment.');
      return;
    }

    const doctorId = new Types.ObjectId().toString();
    const token = await tokenService.generateAccessToken({
      _id: doctorId,
      email: 'dr.accepted@cliniqo.app',
      fullName: 'Dr. Rust Accepted',
      status: DoctorStatus.ACTIVE,
    });

    const inputPayload = JSON.stringify({
      public_key_pem: rsaKeyPair.publicKey,
      token,
      clinic_id: 'clinic_cross_001',
      role: 'DOCTOR',
    });

    const result = runVerifier(inputPayload);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.success).toBe(true);
    expect(parsed.session.doctor_id).toBe(doctorId);
    expect(parsed.session.clinic_id).toBe('clinic_cross_001');
    expect(parsed.session.doctor_email).toBe('dr.accepted@cliniqo.app');
    expect(parsed.session.role).toBe('DOCTOR');
  }, 30_000);

  it('proves that a tampered token is rejected by the Rust verifier', async () => {
    if (!hasCargo) return;

    const doctorId = new Types.ObjectId().toString();
    const token = await tokenService.generateAccessToken({
      _id: doctorId,
      email: 'dr.tamper@cliniqo.app',
      fullName: 'Dr. Tamper Test',
      status: DoctorStatus.ACTIVE,
    });

    // Tamper token payload by replacing base64 segment
    const parts = token.split('.');
    parts[1] = Buffer.from(
      JSON.stringify({
        sub: 'attacker_id',
        email: 'attacker@evil.com',
        type: 'access',
        iss: 'cliniqo-backend',
        aud: 'cliniqo-client',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');
    const tamperedToken = parts.join('.');

    const inputPayload = JSON.stringify({
      public_key_pem: rsaKeyPair.publicKey,
      token: tamperedToken,
      clinic_id: 'clinic_cross_001',
      role: 'DOCTOR',
    });

    const result = runVerifier(inputPayload);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Login failed');
  }, 30_000);

  it('proves that a token verified against an unrelated public key is rejected by the Rust verifier', async () => {
    if (!hasCargo) return;

    const doctorId = new Types.ObjectId().toString();
    const token = await tokenService.generateAccessToken({
      _id: doctorId,
      email: 'dr.wrongkey@cliniqo.app',
      fullName: 'Dr. Wrong Key',
      status: DoctorStatus.ACTIVE,
    });

    // Generate an unrelated RSA 2048 keypair
    const wrongKeyPair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const inputPayload = JSON.stringify({
      public_key_pem: wrongKeyPair.publicKey,
      token,
      clinic_id: 'clinic_cross_001',
      role: 'DOCTOR',
    });

    const result = runVerifier(inputPayload);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Login failed');
  }, 30_000);
});
