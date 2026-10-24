import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import {
  PatientService,
  normalizePhoneNumber,
  computeInitials,
  isCounterInitializationRace,
} from './patient.service.js';
import { PatientGender, PatientStatus } from './schemas/patient.schema.js';
import { ClinicAuditAction } from '../clinic/schemas/clinic-audit-log.schema.js';

describe('PatientService & Sequence Isolation (Unit)', () => {
  let service: PatientService;
  let mockPatientModel: any;
  let mockCounterModel: any;
  let mockAuditLogModel: any;
  let mockConnection: any;
  let mockSession: any;

  const clinicId = new Types.ObjectId();
  const doctorId = new Types.ObjectId();

  beforeEach(() => {
    mockSession = {
      startTransaction: vi.fn(),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      abortTransaction: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      inTransaction: vi.fn().mockReturnValue(true),
    };

    mockConnection = {
      startSession: vi.fn().mockResolvedValue(mockSession),
    };

    mockPatientModel = {
      create: vi.fn().mockImplementation((docs) =>
        Promise.resolve(
          docs.map((d: any) => ({
            _id: new Types.ObjectId(),
            ...d,
            toObject: function () {
              return { ...this };
            },
          })),
        ),
      ),
      find: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      }),
      findOne: vi.fn().mockReturnValue({
        session: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(null),
      }),
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      countDocuments: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue(0),
      }),
    };

    mockCounterModel = {
      findOneAndUpdate: vi.fn().mockResolvedValue({
        seq: 101,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    };

    mockAuditLogModel = {
      create: vi.fn().mockResolvedValue([{ _id: new Types.ObjectId() }]),
    };

    service = new PatientService(
      mockPatientModel,
      mockCounterModel,
      mockAuditLogModel,
      mockConnection,
    );
  });

  describe('Phone normalization & Initials utilities', () => {
    it('normalizes standard 10-digit phone', () => {
      expect(normalizePhoneNumber('9876543210')).toBe('9876543210');
      expect(normalizePhoneNumber(' 98765-43210 ')).toBe('9876543210');
    });

    it('normalizes +91 country prefix', () => {
      expect(normalizePhoneNumber('+91 9876543210')).toBe('9876543210');
      expect(normalizePhoneNumber('919876543210')).toBe('9876543210');
    });

    it('normalizes 0 leading prefix', () => {
      expect(normalizePhoneNumber('09876543210')).toBe('9876543210');
    });

    it('throws BadRequestException for invalid phone numbers', () => {
      expect(() => normalizePhoneNumber('12345')).toThrow(BadRequestException);
      expect(() => normalizePhoneNumber('abcdefghij')).toThrow(BadRequestException);
      expect(() => normalizePhoneNumber('')).toThrow(BadRequestException);
    });

    it('computes initials accurately', () => {
      expect(computeInitials('John Doe')).toBe('JD');
      expect(computeInitials('Ramesh Kumar Patel')).toBe('RP');
      expect(computeInitials('Priya')).toBe('PR');
      expect(computeInitials('A')).toBe('AX');
      expect(computeInitials('')).toBe('PT');
    });
  });

  describe('Counter race identification (isCounterInitializationRace)', () => {
    it('identifies E11000 error with sequenceName key as counter race', () => {
      const err = {
        code: 11000,
        keyPattern: { clinicId: 1, sequenceName: 1 },
      };
      expect(isCounterInitializationRace(err)).toBe(true);
    });

    it('identifies E11000 error mentioning clinic_counters index in message', () => {
      const err = {
        code: 11000,
        message: 'E11000 duplicate key error collection: cliniqo.clinic_counters index: clinicId_1_sequenceName_1 dup key',
      };
      expect(isCounterInitializationRace(err)).toBe(true);
    });

    it('does not treat other unique index collisions as counter races', () => {
      const patientPhoneErr = {
        code: 11000,
        keyPattern: { clinicId: 1, normalizedPhone: 1 },
        message: 'E11000 duplicate key error on patients.idx_patient_phone',
      };
      expect(isCounterInitializationRace(patientPhoneErr)).toBe(false);

      const generalErr = new Error('Generic database error');
      expect(isCounterInitializationRace(generalErr)).toBe(false);
    });
  });

  describe('Sequence generation & first registration', () => {
    it('generates P-00101 on first registration for a clinic', async () => {
      mockCounterModel.findOneAndUpdate.mockResolvedValueOnce({
        seq: 101,
      });

      const patientId = await service.generatePatientId(clinicId, mockSession);
      expect(patientId).toBe('P-00101');
      expect(mockCounterModel.findOneAndUpdate).toHaveBeenCalledWith(
        { clinicId, sequenceName: 'patient' },
        expect.any(Array),
        expect.objectContaining({ upsert: true, returnDocument: 'after' }),
      );
    });

    it('generates P-00102 for subsequent registration', async () => {
      mockCounterModel.findOneAndUpdate.mockResolvedValueOnce({
        seq: 102,
      });

      const patientId = await service.generatePatientId(clinicId, mockSession);
      expect(patientId).toBe('P-00102');
    });

    it('retries standalone counter generation if transient E11000 race occurs', async () => {
      const duplicateKeyErr = {
        code: 11000,
        keyPattern: { clinicId: 1, sequenceName: 1 },
        message: 'E11000 duplicate key on clinic_counters',
      };

      mockCounterModel.findOneAndUpdate
        .mockRejectedValueOnce(duplicateKeyErr)
        .mockResolvedValueOnce({ seq: 102 });

      const patientId = await service.generatePatientId(clinicId); // no session
      expect(patientId).toBe('P-00102');
      expect(mockCounterModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
    });

    it('bubbles up counter race error when inside a transaction session to let transaction helper retry atomically', async () => {
      const duplicateKeyErr = {
        code: 11000,
        keyPattern: { clinicId: 1, sequenceName: 1 },
      };

      mockCounterModel.findOneAndUpdate.mockRejectedValueOnce(duplicateKeyErr);

      await expect(service.generatePatientId(clinicId, mockSession)).rejects.toEqual(
        duplicateKeyErr,
      );
    });
  });

  describe('Patient creation (createPatient)', () => {
    it('creates patient with initials, normalized phone, version 1, and records audit log', async () => {
      mockCounterModel.findOneAndUpdate.mockResolvedValueOnce({ seq: 101 });

      const dto: any = {
        name: 'Sarah Connor',
        age: 35,
        gender: PatientGender.FEMALE,
        phone: '+91 98765 12345',
        allergies: ['Penicillin', 'Peanuts', ' Penicillin '],
        conditions: ['Asthma'],
      };

      const result = await service.createPatient(clinicId, dto, doctorId);

      expect(result.patientId).toBe('P-00101');
      expect(result.name).toBe('Sarah Connor');
      expect(result.initials).toBe('SC');
      expect(result.normalizedPhone).toBe('9876512345');
      expect(result.allergies).toEqual(['Penicillin', 'Peanuts']);
      expect(result.conditions).toEqual(['Asthma']);
      expect(result.version).toBe(1);

      // Verify audit log creation
      expect(mockAuditLogModel.create).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            clinicId,
            actorDoctorId: doctorId,
            action: ClinicAuditAction.PATIENT_CREATED,
            metadata: expect.objectContaining({
              patientId: 'P-00101',
              name: 'Sarah Connor',
              allergiesCount: 2,
              conditionsCount: 1,
            }),
          }),
        ],
        { session: mockSession },
      );
    });

    it('aborts transaction if patient creation fails', async () => {
      mockCounterModel.findOneAndUpdate.mockResolvedValueOnce({ seq: 101 });
      mockPatientModel.create.mockRejectedValueOnce(new Error('Write failure'));

      const dto: any = {
        name: 'John Doe',
        age: 40,
        gender: PatientGender.MALE,
        phone: '9876543210',
      };

      await expect(service.createPatient(clinicId, dto, doctorId)).rejects.toThrow();
      expect(mockSession.abortTransaction).toHaveBeenCalled();
    });
  });

  describe('Patient search & directory (searchPatients)', () => {
    it('enforces strict clinic isolation and status: ACTIVE', async () => {
      const mockList = [
        {
          _id: new Types.ObjectId(),
          clinicId,
          patientId: 'P-00101',
          name: 'Alice Wonder',
          allergies: ['Dust'],
          toObject: function () {
            return { ...this };
          },
        },
      ];

      mockPatientModel.find.mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(mockList),
      });
      mockPatientModel.countDocuments.mockReturnValue({
        exec: vi.fn().mockResolvedValue(1),
      });

      const res = await service.searchPatients(clinicId, {
        query: 'Alice',
        page: 1,
        limit: 10,
      });

      expect(res.total).toBe(1);
      expect(res.patients[0].hasAllergyWarning).toBe(true);
      expect(mockPatientModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          clinicId,
          status: PatientStatus.ACTIVE,
        }),
      );
    });
  });

  describe('Single patient lookup (getPatientById)', () => {
    it('returns patient with hasAllergyWarning flag when found', async () => {
      const patientDoc = {
        _id: new Types.ObjectId(),
        clinicId,
        patientId: 'P-00101',
        name: 'Bob Ross',
        allergies: ['Latex'],
        toObject: function () {
          return { ...this };
        },
      };

      mockPatientModel.findOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue(patientDoc),
      });

      const res = await service.getPatientById(clinicId, 'P-00101');
      expect(res.patientId).toBe('P-00101');
      expect(res.hasAllergyWarning).toBe(true);
    });

    it('throws NotFoundException when patient not found in clinic', async () => {
      mockPatientModel.findOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      });

      await expect(service.getPatientById(clinicId, 'P-99999')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('Patient update & archive', () => {
    it('updates patient details, increments version, and writes audit log', async () => {
      const existingDoc = {
        _id: new Types.ObjectId(),
        clinicId,
        patientId: 'P-00101',
        name: 'John Doe',
        version: 1,
      };

      const updatedDoc = {
        ...existingDoc,
        name: 'John Jonathan Doe',
        initials: 'JD',
        version: 2,
        toObject: () => ({ ...existingDoc, version: 2 }),
      };

      mockPatientModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue(existingDoc),
      });
      mockPatientModel.findOneAndUpdate.mockResolvedValue(updatedDoc);

      const res = await service.updatePatient(
        clinicId,
        'P-00101',
        { name: 'John Jonathan Doe' },
        doctorId,
      );

      expect(res.version).toBe(2);
      expect(mockAuditLogModel.create).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            clinicId,
            action: ClinicAuditAction.PATIENT_UPDATED,
          }),
        ],
        { session: mockSession },
      );
    });

    it('soft-archives patient and writes audit log without hard delete', async () => {
      const existingDoc = {
        _id: new Types.ObjectId(),
        clinicId,
        patientId: 'P-00101',
        status: PatientStatus.ACTIVE,
        save: vi.fn().mockResolvedValue(undefined),
      };

      mockPatientModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue(existingDoc),
      });

      const res = await service.archivePatient(clinicId, 'P-00101', doctorId);

      expect(res.success).toBe(true);
      expect(existingDoc.status).toBe(PatientStatus.ARCHIVED);
      expect(existingDoc.save).toHaveBeenCalled();
      expect(mockAuditLogModel.create).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            clinicId,
            action: ClinicAuditAction.PATIENT_ARCHIVED,
          }),
        ],
        { session: mockSession },
      );
    });
  });

  describe('Duplicate phone check (checkDuplicatePhone)', () => {
    it('returns exists: true when phone matches active patient', async () => {
      const matches = [
        {
          patientId: 'P-00101',
          name: 'Jane Smith',
          phone: '9876543210',
          age: 28,
          gender: PatientGender.FEMALE,
        },
      ];

      mockPatientModel.find.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(matches),
      });

      const res = await service.checkDuplicatePhone(clinicId, '+91 98765-43210');
      expect(res.exists).toBe(true);
      expect(res.matches).toHaveLength(1);
      expect(res.matches[0].patientId).toBe('P-00101');
    });

    it('returns exists: false when phone does not match any active patient', async () => {
      mockPatientModel.find.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      });

      const res = await service.checkDuplicatePhone(clinicId, '9123456789');
      expect(res.exists).toBe(false);
      expect(res.matches).toHaveLength(0);
    });
  });
});
