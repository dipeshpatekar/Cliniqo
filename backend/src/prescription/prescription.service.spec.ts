import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import {
  PrescriptionService,
  isCounterInitializationRace,
  computePatientCurrentAge,
} from './prescription.service.js';
import { PrescriptionStatus } from './schemas/prescription.schema.js';
import {
  MedicineFormulation,
  MedicineRoute,
  DoseUnit,
  TimingType,
  FrequencyCode,
  FoodInstruction,
} from './schemas/prescription-item.schema.js';
import { validatePrescriptionItem } from './validators/formulation-route.validator.js';
import { ClinicRole } from '../clinic/schemas/clinic-membership.schema.js';
import { ClinicAuditAction } from '../clinic/schemas/clinic-audit-log.schema.js';
import { ConsultationStatus } from '../consultation/schemas/consultation.schema.js';

describe('PrescriptionService (Unit Tests)', () => {
  let service: PrescriptionService;

  let mockPrescriptionModel: any;
  let mockRevisionModel: any;
  let mockConsultationModel: any;
  let mockPatientModel: any;
  let mockCounterModel: any;
  let mockAuditLogModel: any;
  let mockIdempotencyModel: any;
  let mockConnection: any;

  const clinicId = new Types.ObjectId('672bb0000000000000000001');
  const doctorId = new Types.ObjectId('672aa0000000000000000002');
  const otherDoctorId = new Types.ObjectId('672aa0000000000000000099');
  const ownerId = new Types.ObjectId('672aa0000000000000000003');
  const patientId = new Types.ObjectId('672cc0000000000000000001');
  const consultationId = new Types.ObjectId('672dd0000000000000000001');

  const validAugmentinItem: any = {
    name: 'Augmentin 625 Duo',
    genericName: 'Amoxicillin and Potassium Clavulanate',
    formulation: MedicineFormulation.TABLET,
    strength: {
      components: [
        { ingredientName: 'Amoxicillin Trihydrate', amount: 500, unit: 'mg' },
        { ingredientName: 'Potassium Clavulanate', amount: 125, unit: 'mg' },
      ],
      perDenominator: 'tablet',
      display: 'Amoxicillin 500 mg + Clavulanic Acid 125 mg / tablet',
    },
    administeredDose: {
      magnitude: 1,
      unit: DoseUnit.TABLET,
    },
    route: MedicineRoute.ORAL,
    frequency: {
      timingType: TimingType.STANDARD,
      frequencyCode: FrequencyCode.BD,
      scheduleLabel: '1-0-1',
    },
    duration: { value: 5, unit: 'DAYS' },
    dispenseQuantity: { count: 10, packageDescription: '10 Tablets' },
    foodInstruction: FoodInstruction.WITH_MEALS,
    instructions: 'Complete full 5-day course',
  };

  beforeEach(() => {
    mockPrescriptionModel = {
      findOne: vi.fn(),
      find: vi.fn(),
      findOneAndUpdate: vi.fn(),
      create: vi.fn(),
      countDocuments: vi.fn(),
    };

    mockRevisionModel = {
      findOne: vi.fn(),
      find: vi.fn(),
      create: vi.fn(),
    };

    mockConsultationModel = {
      findOne: vi.fn(),
      updateOne: vi.fn(),
    };

    mockPatientModel = {
      findOne: vi.fn(),
    };

    mockCounterModel = {
      findOneAndUpdate: vi.fn(),
    };

    mockAuditLogModel = {
      create: vi.fn().mockResolvedValue([]),
    };

    mockIdempotencyModel = {
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
      updateOne: vi.fn(),
      create: vi.fn(),
    };

    const mockSession = {
      startTransaction: vi.fn(),
      commitTransaction: vi.fn(),
      abortTransaction: vi.fn(),
      endSession: vi.fn(),
      inTransaction: vi.fn().mockReturnValue(true),
    };

    mockConnection = {
      startSession: vi.fn().mockResolvedValue(mockSession),
    };

    service = new PrescriptionService(
      mockPrescriptionModel,
      mockRevisionModel,
      mockConsultationModel,
      mockPatientModel,
      mockCounterModel,
      mockAuditLogModel,
      mockIdempotencyModel,
      mockConnection,
    );
  });

  describe('isCounterInitializationRace (Predicate Narrowing)', () => {
    it('returns true strictly when E11000 error matches clinic_counters keyPattern and collection', () => {
      const counterError = {
        code: 11000,
        keyPattern: { clinicId: 1, sequenceName: 1 },
        message: 'E11000 duplicate key error collection: cliniqo.clinic_counters index: clinicId_1_sequenceName_1 dup key',
      };
      expect(isCounterInitializationRace(counterError)).toBe(true);
    });

    it('returns false for unrelated E11000 duplicate key errors (e.g. duplicate active prescription)', () => {
      const prescriptionIndexError = {
        code: 11000,
        keyPattern: { clinicId: 1, consultationId: 1 },
        message: 'E11000 duplicate key error collection: cliniqo.prescriptions index: uniq_active_prescription_per_consultation',
      };
      expect(isCounterInitializationRace(prescriptionIndexError)).toBe(false);
    });

    it('returns false for non-11000 errors', () => {
      expect(isCounterInitializationRace(new Error('Connection dropped'))).toBe(false);
    });
  });

  describe('computePatientCurrentAge (Intl.DateTimeFormat.formatToParts)', () => {
    it('accurately derives patient age across calendar boundaries in Asia/Kolkata', () => {
      const patient = {
        age: 30,
        dateOfBirth: new Date('1995-10-26T18:30:00.000Z'), // Oct 27 in IST
      };

      // Reference date: Oct 26, 2026 in IST -> Birthday not reached yet in 2026
      const refBeforeBday = new Date('2026-10-25T18:30:00.000Z'); // Oct 26 in IST
      expect(computePatientCurrentAge(patient, 'Asia/Kolkata', refBeforeBday)).toBe(30);

      // Reference date: Oct 27, 2026 in IST -> Birthday reached
      const refOnBday = new Date('2026-10-26T20:00:00.000Z'); // Oct 27 in IST
      expect(computePatientCurrentAge(patient, 'Asia/Kolkata', refOnBday)).toBe(31);
    });

    it('falls back to patient.age when dateOfBirth is not populated', () => {
      const patient = { age: 42, dateOfBirth: null };
      expect(computePatientCurrentAge(patient)).toBe(42);
    });
  });

  describe('validatePrescriptionItem (Formulation, Route, Strength & Cross-Field Validation)', () => {
    it('accepts valid multi-ingredient solid tablet with distinct amounts', () => {
      expect(() => validatePrescriptionItem(validAugmentinItem)).not.toThrow();
    });

    it('accepts valid percentage concentration topical cream (Betnovate-N)', () => {
      const creamItem: any = {
        name: 'Betnovate-N',
        formulation: MedicineFormulation.CREAM,
        strength: {
          components: [
            { ingredientName: 'Betamethasone Valerate', amount: 0.1, unit: '% w/w' },
            { ingredientName: 'Neomycin Sulfate', amount: 0.5, unit: '% w/w' },
          ],
          display: '0.1% w/w Betamethasone + 0.5% w/w Neomycin',
        },
        administeredDose: { magnitude: 1, unit: DoseUnit.APPLICATION },
        route: MedicineRoute.TOPICAL,
        frequency: {
          timingType: TimingType.STANDARD,
          frequencyCode: FrequencyCode.BD,
          scheduleLabel: 'Apply thin layer twice daily',
        },
        duration: { value: 10, unit: 'DAYS' },
        dispenseQuantity: { count: 1, packageDescription: '1 Tube (20g)' },
        foodInstruction: FoodInstruction.IRRELEVANT,
      };

      expect(() => validatePrescriptionItem(creamItem)).not.toThrow();
    });

    it('rejects ingredient amount <= 0, NaN, or Infinity', () => {
      const testItem = JSON.parse(JSON.stringify(validAugmentinItem));

      testItem.strength.components[0].amount = 0;
      expect(() => validatePrescriptionItem(testItem)).toThrow(BadRequestException);

      testItem.strength.components[0].amount = -500;
      expect(() => validatePrescriptionItem(testItem)).toThrow(BadRequestException);

      testItem.strength.components[0].amount = NaN;
      expect(() => validatePrescriptionItem(testItem)).toThrow(BadRequestException);

      testItem.strength.components[0].amount = Infinity;
      expect(() => validatePrescriptionItem(testItem)).toThrow(BadRequestException);
    });

    it('allows null amount for unquantified herbal/active base', () => {
      const testItem = JSON.parse(JSON.stringify(validAugmentinItem));
      testItem.strength.components[0].amount = null;
      expect(() => validatePrescriptionItem(testItem)).not.toThrow();
    });

    it('enforces cross-field INTERVAL validation', () => {
      const testItem = JSON.parse(JSON.stringify(validAugmentinItem));
      testItem.frequency = {
        timingType: TimingType.INTERVAL,
        intervalHours: null, // Missing!
      };
      expect(() => validatePrescriptionItem(testItem)).toThrow(
        /INTERVAL timing requires intervalHours between 1 and 168/,
      );

      testItem.frequency.intervalHours = 8;
      testItem.frequency.prnIndication = 'not allowed';
      expect(() => validatePrescriptionItem(testItem)).toThrow(
        /prnIndication is not permitted with INTERVAL timing/,
      );
    });

    it('enforces cross-field PRN_AS_NEEDED validation', () => {
      const testItem = JSON.parse(JSON.stringify(validAugmentinItem));
      testItem.frequency = {
        timingType: TimingType.PRN_AS_NEEDED,
        prnIndication: '', // Empty!
      };
      expect(() => validatePrescriptionItem(testItem)).toThrow(
        /PRN_AS_NEEDED timing requires a non-empty prnIndication/,
      );

      testItem.frequency.prnIndication = 'for severe pain';
      testItem.frequency.intervalHours = 6;
      expect(() => validatePrescriptionItem(testItem)).toThrow(
        /intervalHours is not permitted with PRN_AS_NEEDED timing/,
      );
    });

    it('enforces bidirectional STAT timing and duration consistency', () => {
      const testItem = JSON.parse(JSON.stringify(validAugmentinItem));
      testItem.frequency = { timingType: TimingType.STAT };
      testItem.duration = { value: 5, unit: 'DAYS' }; // Inconsistent!
      expect(() => validatePrescriptionItem(testItem)).toThrow(
        /STAT timing requires duration unit to be 'STAT' with value 1/,
      );

      testItem.frequency = { timingType: TimingType.STANDARD, frequencyCode: FrequencyCode.OD };
      testItem.duration = { value: 1, unit: 'STAT' }; // Inconsistent!
      expect(() => validatePrescriptionItem(testItem)).toThrow(
        /Duration unit 'STAT' requires timingType to be 'STAT'/,
      );
    });

    it('enforces formulation-route-doseUnit compatibility matrix', () => {
      const tabletWithInhalation = JSON.parse(JSON.stringify(validAugmentinItem));
      tabletWithInhalation.route = MedicineRoute.INHALATION;
      expect(() => validatePrescriptionItem(tabletWithInhalation)).toThrow(
        /Formulation "TABLET" is incompatible with route "INHALATION"/,
      );

      const tabletWithLiquidUnit = JSON.parse(JSON.stringify(validAugmentinItem));
      tabletWithLiquidUnit.administeredDose.unit = DoseUnit.ML;
      expect(() => validatePrescriptionItem(tabletWithLiquidUnit)).toThrow(
        /Formulation "TABLET" requires dose unit TABLET or CAPSULE/,
      );

      const creamWithFoodInstruction = JSON.parse(JSON.stringify(validAugmentinItem));
      creamWithFoodInstruction.formulation = MedicineFormulation.CREAM;
      creamWithFoodInstruction.route = MedicineRoute.TOPICAL;
      creamWithFoodInstruction.administeredDose.unit = DoseUnit.APPLICATION;
      creamWithFoodInstruction.foodInstruction = FoodInstruction.BEFORE_MEALS;
      expect(() => validatePrescriptionItem(creamWithFoodInstruction)).toThrow(
        /Topical formulation "CREAM" cannot mandate oral food instructions/,
      );
    });
  });

  describe('Prescription Number Generation (Sequence RX-00101)', () => {
    it('formats initial seq 101 as RX-00101', async () => {
      mockCounterModel.findOneAndUpdate.mockResolvedValue({ seq: 101 });
      const num = await service.generatePrescriptionNumber(clinicId);
      expect(num).toBe('RX-00101');
    });

    it('formats subsequent seq 102 as RX-00102', async () => {
      mockCounterModel.findOneAndUpdate.mockResolvedValue({ seq: 102 });
      const num = await service.generatePrescriptionNumber(clinicId);
      expect(num).toBe('RX-00102');
    });

    it('throws when counter document is missing or invalid', async () => {
      mockCounterModel.findOneAndUpdate.mockResolvedValue(null);
      await expect(service.generatePrescriptionNumber(clinicId)).rejects.toThrow();

      mockCounterModel.findOneAndUpdate.mockResolvedValue({ seq: 'invalid' });
      await expect(service.generatePrescriptionNumber(clinicId)).rejects.toThrow();
    });
  });

  describe('createPrescription (Initial Issuance & Consultation Integrity)', () => {
    it('rejects prescription issuance if consultation is in DRAFT status', async () => {
      mockConsultationModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          _id: consultationId,
          clinicId,
          status: ConsultationStatus.DRAFT,
        }),
      });

      await expect(
        service.createPrescription(clinicId, consultationId.toString(), {
          items: [validAugmentinItem],
        }, doctorId),
      ).rejects.toThrow(/Prescriptions can only be issued for finalized consultations/);
    });

    it('rejects prescription issuance if consultation is not found', async () => {
      mockConsultationModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue(null),
      });

      await expect(
        service.createPrescription(clinicId, consultationId.toString(), {
          items: [validAugmentinItem],
        }, doctorId),
      ).rejects.toThrow(NotFoundException);
    });

    it('successfully issues prescription against finalized consultation with in-session snapshot and RX-00101', async () => {
      const mockConsultation = {
        _id: consultationId,
        clinicId,
        patientId,
        patientCode: 'P-00101',
        doctorId,
        status: ConsultationStatus.FINALIZED,
        consultationDate: new Date('2026-10-24T10:00:00.000Z'),
        chiefComplaint: 'Bacterial sinusitis',
        diagnosis: 'Acute bacterial rhinosinusitis',
        vitals: { systolic: 120, diastolic: 80 },
        provisionalMedicines: [],
      };

      mockConsultationModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue(mockConsultation),
      });
      mockPrescriptionModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue(null), // No active prescription
      });
      mockCounterModel.findOneAndUpdate.mockResolvedValue({ seq: 101 });

      const newPrescriptionObj = {
        _id: new Types.ObjectId(),
        clinicId,
        prescriptionNumber: 'RX-00101',
        status: PrescriptionStatus.ACTIVE,
        currentRevisionNumber: 1,
        toObject: () => ({
          _id: 'new-rx-id',
          prescriptionNumber: 'RX-00101',
          status: PrescriptionStatus.ACTIVE,
        }),
      };
      mockPrescriptionModel.create.mockResolvedValue([newPrescriptionObj]);

      const newRevisionObj = {
        _id: new Types.ObjectId(),
        revisionNumber: 1,
        reasonForRevision: 'Initial prescription issuance',
        toObject: () => ({
          revisionNumber: 1,
          reasonForRevision: 'Initial prescription issuance',
        }),
      };
      mockRevisionModel.create.mockResolvedValue([newRevisionObj]);

      mockConsultationModel.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

      const result = await service.createPrescription(
        clinicId,
        consultationId.toString(),
        { items: [validAugmentinItem] },
        doctorId,
      );

      expect(result).toBeDefined();
      expect(result.prescriptionNumber).toBe('RX-00101');
      expect(result.latestRevision.revisionNumber).toBe(1);

      // Verify audit log
      expect(mockAuditLogModel.create).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            action: ClinicAuditAction.PRESCRIPTION_ISSUED,
            actorDoctorId: doctorId,
          }),
        ]),
        expect.anything(),
      );
    });

    it('rejects issuance when an active prescription already exists for the consultation', async () => {
      mockConsultationModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          _id: consultationId,
          clinicId,
          status: ConsultationStatus.FINALIZED,
        }),
      });
      mockPrescriptionModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          _id: new Types.ObjectId(),
          status: PrescriptionStatus.ACTIVE,
        }),
      });

      await expect(
        service.createPrescription(clinicId, consultationId.toString(), {
          items: [validAugmentinItem],
        }, doctorId),
      ).rejects.toThrow(/An active prescription already exists for this consultation/);
    });
  });

  describe('createPrescription (Atomic Replacement Workflow)', () => {
    const oldPrescriptionId = new Types.ObjectId('672ee0000000000000000001');

    it('rejects replacement if the old prescription is still in ACTIVE status', async () => {
      mockConsultationModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          _id: consultationId,
          clinicId,
          status: ConsultationStatus.FINALIZED,
        }),
      });

      mockPrescriptionModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          _id: oldPrescriptionId,
          clinicId,
          consultationId,
          status: PrescriptionStatus.ACTIVE, // ACTIVE!
        }),
      });

      await expect(
        service.createPrescription(clinicId, consultationId.toString(), {
          replacesPrescriptionId: oldPrescriptionId.toString(),
          items: [validAugmentinItem],
        }, doctorId),
      ).rejects.toThrow(/Cannot replace an active prescription/);
    });

    it('rejects replacement if old prescription belongs to a different consultation', async () => {
      const differentConsultationId = new Types.ObjectId('672dd9999999999999999999');
      mockConsultationModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          _id: consultationId,
          clinicId,
          status: ConsultationStatus.FINALIZED,
        }),
      });

      mockPrescriptionModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          _id: oldPrescriptionId,
          clinicId,
          consultationId: differentConsultationId, // Mismatch!
          status: PrescriptionStatus.DISCONTINUED,
        }),
      });

      await expect(
        service.createPrescription(clinicId, consultationId.toString(), {
          replacesPrescriptionId: oldPrescriptionId.toString(),
          items: [validAugmentinItem],
        }, doctorId),
      ).rejects.toThrow(/The replaced prescription does not belong to this consultation/);
    });

    it('rejects replacement if old prescription has already been replaced', async () => {
      mockConsultationModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          _id: consultationId,
          clinicId,
          status: ConsultationStatus.FINALIZED,
        }),
      });

      mockPrescriptionModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          _id: oldPrescriptionId,
          clinicId,
          consultationId,
          status: PrescriptionStatus.DISCONTINUED,
          replacedByPrescriptionId: new Types.ObjectId(), // Already replaced!
        }),
      });

      await expect(
        service.createPrescription(clinicId, consultationId.toString(), {
          replacesPrescriptionId: oldPrescriptionId.toString(),
          items: [validAugmentinItem],
        }, doctorId),
      ).rejects.toThrow(/Target prescription has already been replaced/);
    });

    it('successfully replaces discontinued prescription, creating Revision 1 and bidirectional links', async () => {
      mockConsultationModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          _id: consultationId,
          clinicId,
          patientId,
          patientCode: 'P-00101',
          doctorId,
          status: ConsultationStatus.FINALIZED,
        }),
      });

      mockPrescriptionModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          _id: oldPrescriptionId,
          clinicId,
          consultationId,
          prescriptionNumber: 'RX-00101',
          status: PrescriptionStatus.DISCONTINUED,
          replacedByPrescriptionId: null,
          version: 2,
        }),
      });

      mockCounterModel.findOneAndUpdate.mockResolvedValue({ seq: 102 });

      const newPrescriptionObj = {
        _id: new Types.ObjectId(),
        clinicId,
        prescriptionNumber: 'RX-00102',
        replacesPrescriptionId: oldPrescriptionId,
        toObject: () => ({ prescriptionNumber: 'RX-00102' }),
      };
      mockPrescriptionModel.create.mockResolvedValue([newPrescriptionObj]);

      const newRevisionObj = {
        _id: new Types.ObjectId(),
        revisionNumber: 1,
        reasonForRevision: 'Replacement for RX-00101',
        toObject: () => ({ revisionNumber: 1, reasonForRevision: 'Replacement for RX-00101' }),
      };
      mockRevisionModel.create.mockResolvedValue([newRevisionObj]);

      mockPrescriptionModel.findOneAndUpdate.mockResolvedValue({ _id: oldPrescriptionId }); // Old update succeeds
      mockConsultationModel.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

      const res = await service.createPrescription(
        clinicId,
        consultationId.toString(),
        {
          replacesPrescriptionId: oldPrescriptionId.toString(),
          items: [validAugmentinItem],
        },
        doctorId,
      );

      expect(res.prescriptionNumber).toBe('RX-00102');
      expect(mockAuditLogModel.create).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            action: ClinicAuditAction.PRESCRIPTION_REPLACED,
          }),
        ]),
        expect.anything(),
      );
    });
  });

  describe('revisePrescription (Optimistic Locking & Revision Reason)', () => {
    it('rejects revision with mismatched expectedRevisionNumber with 409 Conflict', async () => {
      const rxId = new Types.ObjectId();
      mockPrescriptionModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          _id: rxId,
          clinicId,
          status: PrescriptionStatus.ACTIVE,
          currentRevisionNumber: 2, // Current is 2
          version: 1,
        }),
      });

      await expect(
        service.revisePrescription(clinicId, rxId.toString(), {
          expectedRevisionNumber: 1, // Stale!
          expectedVersion: 1,
          reasonForRevision: 'Dose adjusted for better tolerance',
          items: [validAugmentinItem],
        }, doctorId),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects revision on discontinued or cancelled prescriptions with 409 Conflict', async () => {
      const rxId = new Types.ObjectId();
      mockPrescriptionModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          _id: rxId,
          clinicId,
          status: PrescriptionStatus.DISCONTINUED,
          currentRevisionNumber: 1,
          version: 1,
        }),
      });

      await expect(
        service.revisePrescription(clinicId, rxId.toString(), {
          expectedRevisionNumber: 1,
          expectedVersion: 1,
          reasonForRevision: 'Dose adjusted',
          items: [validAugmentinItem],
        }, doctorId),
      ).rejects.toThrow(/Cannot revise a discontinued prescription/);
    });

    it('successfully appends Revision 2 and updates parent revision number and latestRevisionId', async () => {
      const rxId = new Types.ObjectId();
      const parentRx = {
        _id: rxId,
        clinicId,
        consultationId,
        patientId,
        status: PrescriptionStatus.ACTIVE,
        currentRevisionNumber: 1,
        version: 1,
        prescriptionNumber: 'RX-00101',
      };

      mockPrescriptionModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue(parentRx),
      });

      mockRevisionModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          revisionNumber: 1,
          clinicalSnapshot: { diagnosis: 'Sinusitis' },
        }),
      });

      const newRevId = new Types.ObjectId();
      mockRevisionModel.create.mockResolvedValue([
        {
          _id: newRevId,
          revisionNumber: 2,
          reasonForRevision: 'Changed duration to 7 days',
          toObject: () => ({ revisionNumber: 2 }),
        },
      ]);

      mockPrescriptionModel.findOneAndUpdate.mockResolvedValue({
        _id: rxId,
        currentRevisionNumber: 2,
        latestRevisionId: newRevId,
        version: 2,
        toObject: () => ({ currentRevisionNumber: 2, version: 2 }),
      });

      const result = await service.revisePrescription(
        clinicId,
        rxId.toString(),
        {
          expectedRevisionNumber: 1,
          expectedVersion: 1,
          reasonForRevision: 'Changed duration to 7 days',
          items: [validAugmentinItem],
        },
        doctorId,
      );

      expect(result.currentRevisionNumber).toBe(2);
      expect(result.latestRevision.revisionNumber).toBe(2);
      expect(mockAuditLogModel.create).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            action: ClinicAuditAction.PRESCRIPTION_REVISED,
            actorDoctorId: doctorId,
          }),
        ]),
        expect.anything(),
      );
    });
  });

  describe('cancelPrescription (Authorization Order & OWNER Attribution)', () => {
    const rxId = new Types.ObjectId();

    it('rejects unauthorized doctor with 403 Forbidden on active prescription', async () => {
      mockPrescriptionModel.findOne.mockResolvedValue({
        _id: rxId,
        clinicId,
        prescribedBy: doctorId, // Issued by doctorId
        status: PrescriptionStatus.ACTIVE,
      });

      await expect(
        service.cancelPrescription(
          clinicId,
          rxId.toString(),
          otherDoctorId, // Different doctor!
          ClinicRole.DOCTOR,
          { cancellationReason: 'Wrong patient' },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects unauthorized doctor with 403 Forbidden on ALREADY-CANCELLED prescription (verifying authorization is checked BEFORE status inspection)', async () => {
      mockPrescriptionModel.findOne.mockResolvedValue({
        _id: rxId,
        clinicId,
        prescribedBy: doctorId,
        status: PrescriptionStatus.CANCELLED, // Already cancelled!
      });

      await expect(
        service.cancelPrescription(
          clinicId,
          rxId.toString(),
          otherDoctorId, // Unauthorized!
          ClinicRole.DOCTOR,
          { cancellationReason: 'Attempt cancel' },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('returns already-cancelled message when authorized prescribing doctor calls cancel on cancelled prescription', async () => {
      mockPrescriptionModel.findOne.mockResolvedValue({
        _id: rxId,
        clinicId,
        prescribedBy: doctorId,
        status: PrescriptionStatus.CANCELLED,
      });

      const res = await service.cancelPrescription(
        clinicId,
        rxId.toString(),
        doctorId, // Authorized!
        ClinicRole.DOCTOR,
        { cancellationReason: 'Double cancel' },
      );

      expect(res.message).toBe('Prescription is already cancelled.');
    });

    it('allows clinic OWNER who is not the prescribing doctor to cancel, attributing owner and targetDoctorId in audit log', async () => {
      mockPrescriptionModel.findOne.mockResolvedValue({
        _id: rxId,
        clinicId,
        prescribedBy: doctorId, // Issued by doctorId
        prescriptionNumber: 'RX-00101',
        status: PrescriptionStatus.ACTIVE,
      });

      mockPrescriptionModel.findOneAndUpdate.mockResolvedValue({
        _id: rxId,
        status: PrescriptionStatus.CANCELLED,
      });

      const res = await service.cancelPrescription(
        clinicId,
        rxId.toString(),
        ownerId, // Owner!
        ClinicRole.OWNER,
        { cancellationReason: 'Administrative clinic override' },
      );

      expect(res.message).toBe('Prescription successfully cancelled.');

      expect(mockAuditLogModel.create).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            actorDoctorId: ownerId,
            targetDoctorId: doctorId, // Original prescribing doctor
            role: ClinicRole.OWNER,
            action: ClinicAuditAction.PRESCRIPTION_CANCELLED,
            reason: 'Administrative clinic override',
          }),
        ]),
        expect.anything(),
      );
    });
  });

  describe('Idempotency Key Payload Mismatch Protection', () => {
    it('throws 422 Unprocessable Entity when same key is sent with different request payload', async () => {
      mockIdempotencyModel.create.mockRejectedValue({ code: 11000 });
      mockIdempotencyModel.findOne.mockResolvedValue({
        clinicId,
        key: 'idempotent-key-1',
        requestFingerprint: 'existing-hash-abc', // Different!
        status: 'PROCESSING',
      });

      await expect(
        service.createPrescription(
          clinicId,
          consultationId.toString(),
          { items: [validAugmentinItem] },
          doctorId,
          'idempotent-key-1',
        ),
      ).rejects.toThrow(UnprocessableEntityException);
    });
  });
});
