import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Types } from 'mongoose';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { FormularyService } from './formulary.service.js';
import {
  MedicineFormulation,
  MedicineRoute,
  FoodInstruction,
} from '../prescription/schemas/prescription-item.schema.js';

describe('FormularyService', () => {
  let service: FormularyService;
  let mockFormularyModel: any;

  const clinicId = new Types.ObjectId();
  const doctorId = new Types.ObjectId();

  beforeEach(() => {
    function MockModel(this: any, doc: any) {
      Object.assign(this, doc);
      this._id = new Types.ObjectId();
      this.save = vi.fn().mockResolvedValue(this);
    }
    MockModel.findOne = vi.fn();
    MockModel.find = vi.fn();
    MockModel.countDocuments = vi.fn();
    MockModel.insertMany = vi.fn();

    mockFormularyModel = MockModel as any;

    service = new FormularyService(mockFormularyModel);
  });

  describe('createItem', () => {
    it('successfully creates a valid formulary item', async () => {
      mockFormularyModel.findOne.mockResolvedValue(null);

      const dto = {
        name: 'Paracetamol',
        activeIngredient: 'Acetaminophen',
        formulation: MedicineFormulation.TABLET,
        strength: '650 mg',
        defaultDose: '1 tablet',
        defaultRoute: MedicineRoute.ORAL,
        defaultFoodInstruction: FoodInstruction.AFTER_MEALS,
      };

      const result = await service.createItem(clinicId, doctorId, dto);
      expect(result).toBeDefined();
      expect(result.clinicId).toBe(clinicId);
      expect(result.name).toBe('Paracetamol');
      expect(result.activeIngredient).toBe('Acetaminophen');
      expect(result.formulation).toBe(MedicineFormulation.TABLET);
      expect(result.strength).toBe('650 mg');
      expect(result.isActive).toBe(true);
      expect(result.createdBy).toBe(doctorId);
      expect(result.version).toBe(1);
    });

    it('rejects duplicate formulation within the same clinic', async () => {
      mockFormularyModel.findOne.mockResolvedValue({ _id: new Types.ObjectId() });

      const dto = {
        name: 'Paracetamol',
        formulation: MedicineFormulation.TABLET,
        strength: '650 mg',
      };

      await expect(service.createItem(clinicId, doctorId, dto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('rejects oral food instruction for topical formulations', async () => {
      const dto = {
        name: 'Hydrocortisone Cream',
        formulation: MedicineFormulation.CREAM,
        strength: '1%',
        defaultRoute: MedicineRoute.TOPICAL,
        defaultFoodInstruction: FoodInstruction.BEFORE_MEALS,
      };

      await expect(service.createItem(clinicId, doctorId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects incompatible route for solid oral medications', async () => {
      const dto = {
        name: 'Metformin',
        formulation: MedicineFormulation.TABLET,
        strength: '500 mg',
        defaultRoute: MedicineRoute.INTRAVENOUS,
      };

      await expect(service.createItem(clinicId, doctorId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('getItems', () => {
    it('searches by name or active ingredient', async () => {
      const mockQuery = {
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([
          { name: 'Paracetamol', activeIngredient: 'Acetaminophen' },
        ]),
      };
      mockFormularyModel.find.mockReturnValue(mockQuery);
      mockFormularyModel.countDocuments.mockResolvedValue(1);

      const result = await service.getItems(clinicId, { search: 'Acetaminophen' });
      expect(result.items).toHaveLength(1);
      expect(mockFormularyModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          clinicId,
          isActive: true,
          $or: [
            { name: { $regex: 'Acetaminophen', $options: 'i' } },
            { activeIngredient: { $regex: 'Acetaminophen', $options: 'i' } },
          ],
        }),
      );
    });
  });

  describe('getItemById', () => {
    it('throws NotFoundException if item does not belong to clinic', async () => {
      mockFormularyModel.findOne.mockResolvedValue(null);

      const itemId = new Types.ObjectId().toHexString();
      await expect(service.getItemById(clinicId, itemId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('archiveItem', () => {
    it('soft deletes by setting isActive to false and incrementing version', async () => {
      const existingDoc = {
        _id: new Types.ObjectId(),
        clinicId,
        name: 'Old Medicine',
        isActive: true,
        version: 1,
        save: vi.fn().mockImplementation(function (this: any) {
          return Promise.resolve(this);
        }),
      };
      mockFormularyModel.findOne.mockResolvedValue(existingDoc);

      const result = await service.archiveItem(clinicId, existingDoc._id.toHexString());
      expect(result.isActive).toBe(false);
      expect(result.version).toBe(2);
      expect(existingDoc.save).toHaveBeenCalled();
    });
  });

  describe('seedStandardFormulary', () => {
    it('seeds default medicines only when clinic formulary is empty', async () => {
      mockFormularyModel.countDocuments.mockResolvedValue(0);
      mockFormularyModel.insertMany.mockResolvedValue([]);

      const count = await service.seedStandardFormulary(clinicId, doctorId);
      expect(count).toBeGreaterThan(0);
      expect(mockFormularyModel.insertMany).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            clinicId,
            name: 'Paracetamol',
            activeIngredient: 'Acetaminophen',
          }),
        ]),
      );
    });

    it('does not re-seed when clinic formulary already contains medicines', async () => {
      mockFormularyModel.countDocuments.mockResolvedValue(5);

      const count = await service.seedStandardFormulary(clinicId, doctorId);
      expect(count).toBe(0);
      expect(mockFormularyModel.insertMany).not.toHaveBeenCalled();
    });
  });
});
