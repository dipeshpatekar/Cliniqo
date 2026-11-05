import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { DoctorSchema } from './doctor.schema.js';
import { DoctorStatus } from '../auth.constants.js';

describe('DoctorSchema', () => {
  it('should define required fields and default values correctly', () => {
    const paths: Record<string, any> = DoctorSchema.paths;

    expect(paths.email).toBeDefined();
    expect(paths.passwordHash).toBeDefined();
    expect(paths.fullName).toBeDefined();
    expect(paths.status).toBeDefined();
    expect(paths.failedLoginAttempts).toBeDefined();

    // Default status should be PENDING_VERIFICATION
    expect(paths.status.defaultValue).toBe(DoctorStatus.PENDING_VERIFICATION);
    // Default failedLoginAttempts should be 0
    expect(paths.failedLoginAttempts.defaultValue).toBe(0);
  });

  it('should normalize email to lowercase and trim whitespace in schema definition', () => {
    const emailPath = DoctorSchema.paths.email as any;
    expect(emailPath.options.trim).toBe(true);
    expect(emailPath.options.lowercase).toBe(true);
    expect(emailPath.options.required).toBe(true);
  });

  it('should omit passwordHash and __v when converted to JSON', () => {
    // Instantiate a Mongoose model using the schema
    const DoctorModel = mongoose.model(
      'TestDoctorForJsonTransform',
      DoctorSchema,
    );

    const doctorDoc = new DoctorModel({
      email: 'doctor@example.com',
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$someSalt$someHash',
      fullName: 'Dr. Jane Smith',
      status: DoctorStatus.ACTIVE,
    });

    const json = doctorDoc.toJSON();

    expect(json.email).toBe('doctor@example.com');
    expect(json.fullName).toBe('Dr. Jane Smith');
    expect(json.status).toBe(DoctorStatus.ACTIVE);
    expect(json.passwordHash).toBeUndefined();
    expect(json.__v).toBeUndefined();
  });

  it('should omit passwordHash and __v when converted to Object', () => {
    const DoctorModel = mongoose.model(
      'TestDoctorForObjectTransform',
      DoctorSchema,
    );

    const doctorDoc = new DoctorModel({
      email: 'doctor2@example.com',
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$someSalt$someHash',
      fullName: 'Dr. John Doe',
    });

    const obj = doctorDoc.toObject();

    expect(obj.email).toBe('doctor2@example.com');
    expect(obj.passwordHash).toBeUndefined();
    expect(obj.__v).toBeUndefined();
  });

  it('should register explicit indexes for unique email and account status', () => {
    const indexes = DoctorSchema.indexes();

    const emailIndex = indexes.find((idx) => (idx[0] as any).email === 1);
    expect(emailIndex).toBeDefined();
    expect((emailIndex![1] as any)?.unique).toBe(true);

    const statusIndex = indexes.find((idx) => (idx[0] as any).status === 1);
    expect(statusIndex).toBeDefined();
  });
});
