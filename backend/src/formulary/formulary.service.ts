import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  FormularyItem,
  FormularyItemDocument,
} from './schemas/formulary-item.schema.js';
import { CreateFormularyItemDto } from './dto/create-formulary-item.dto.js';
import { UpdateFormularyItemDto } from './dto/update-formulary-item.dto.js';
import { QueryFormularyDto } from './dto/query-formulary.dto.js';
import {
  MedicineFormulation,
  MedicineRoute,
  FoodInstruction,
} from '../prescription/schemas/prescription-item.schema.js';

@Injectable()
export class FormularyService {
  constructor(
    @InjectModel(FormularyItem.name)
    private readonly formularyModel: Model<FormularyItemDocument>,
  ) {}

  /**
   * Adds a new medicine entry to the clinic formulary catalogue.
   * Enforces tenancy and prevents duplicate formulations.
   */
  async createItem(
    clinicId: Types.ObjectId,
    doctorId: Types.ObjectId,
    dto: CreateFormularyItemDto,
  ): Promise<FormularyItemDocument> {
    this.validateFormulationRoute(dto.formulation, dto.defaultRoute, dto.defaultFoodInstruction);

    const existing = await this.formularyModel.findOne({
      clinicId,
      name: { $regex: new RegExp(`^${this.escapeRegex(dto.name.trim())}$`, 'i') },
      formulation: dto.formulation,
      strength: dto.strength.trim(),
      isActive: true,
    });

    if (existing) {
      throw new ConflictException(
        `Medicine "${dto.name}" (${dto.formulation} ${dto.strength}) already exists in this clinic's formulary.`,
      );
    }

    const item = new this.formularyModel({
      clinicId,
      name: dto.name.trim(),
      activeIngredient: dto.activeIngredient?.trim() || null,
      formulation: dto.formulation,
      strength: dto.strength.trim(),
      defaultDose: dto.defaultDose?.trim() || null,
      defaultRoute: dto.defaultRoute || null,
      defaultFrequency: dto.defaultFrequency?.trim() || null,
      defaultDuration: dto.defaultDuration?.trim() || null,
      defaultFoodInstruction: dto.defaultFoodInstruction || FoodInstruction.IRRELEVANT,
      defaultDirections: dto.defaultDirections?.trim() || null,
      isActive: true,
      createdBy: doctorId,
      version: 1,
    });

    return item.save();
  }

  /**
   * Searches and retrieves active formulary medicines for the clinic.
   */
  async getItems(
    clinicId: Types.ObjectId,
    query: QueryFormularyDto,
  ): Promise<{ items: FormularyItemDocument[]; total: number; page: number; limit: number }> {
    const filter: Record<string, any> = { clinicId, isActive: true };

    if (query.formulation) {
      filter.formulation = query.formulation;
    }

    if (query.search && query.search.trim()) {
      const escaped = this.escapeRegex(query.search.trim());
      filter.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { activeIngredient: { $regex: escaped, $options: 'i' } },
      ];
    }

    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 100) : 50;
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.formularyModel
        .find(filter)
        .sort({ name: 1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.formularyModel.countDocuments(filter),
    ]);

    return { items, total, page, limit };
  }

  /**
   * Gets a specific formulary entry with clinic tenancy boundary check.
   */
  async getItemById(
    clinicId: Types.ObjectId,
    itemId: string,
  ): Promise<FormularyItemDocument> {
    if (!Types.ObjectId.isValid(itemId)) {
      throw new BadRequestException('Invalid formulary item ID.');
    }

    const item = await this.formularyModel.findOne({
      _id: new Types.ObjectId(itemId),
      clinicId,
    });

    if (!item) {
      throw new NotFoundException('Formulary item not found in this clinic.');
    }

    return item;
  }

  /**
   * Updates an existing formulary entry.
   */
  async updateItem(
    clinicId: Types.ObjectId,
    itemId: string,
    dto: UpdateFormularyItemDto,
  ): Promise<FormularyItemDocument> {
    const item = await this.getItemById(clinicId, itemId);

    const targetFormulation = dto.formulation || item.formulation;
    const targetRoute = dto.defaultRoute !== undefined ? dto.defaultRoute : item.defaultRoute;
    const targetFood = dto.defaultFoodInstruction || item.defaultFoodInstruction;

    this.validateFormulationRoute(targetFormulation, targetRoute, targetFood);

    if (dto.name !== undefined) item.name = dto.name.trim();
    if (dto.activeIngredient !== undefined) item.activeIngredient = dto.activeIngredient.trim() || null;
    if (dto.formulation !== undefined) item.formulation = dto.formulation;
    if (dto.strength !== undefined) item.strength = dto.strength.trim();
    if (dto.defaultDose !== undefined) item.defaultDose = dto.defaultDose.trim() || null;
    if (dto.defaultRoute !== undefined) item.defaultRoute = dto.defaultRoute;
    if (dto.defaultFrequency !== undefined) item.defaultFrequency = dto.defaultFrequency.trim() || null;
    if (dto.defaultDuration !== undefined) item.defaultDuration = dto.defaultDuration.trim() || null;
    if (dto.defaultFoodInstruction !== undefined) item.defaultFoodInstruction = dto.defaultFoodInstruction;
    if (dto.defaultDirections !== undefined) item.defaultDirections = dto.defaultDirections.trim() || null;
    if (dto.isActive !== undefined) item.isActive = dto.isActive;

    item.version += 1;
    return item.save();
  }

  /**
   * Soft-deletes / archives a formulary item to preserve historical references.
   */
  async archiveItem(
    clinicId: Types.ObjectId,
    itemId: string,
  ): Promise<FormularyItemDocument> {
    const item = await this.getItemById(clinicId, itemId);
    item.isActive = false;
    item.version += 1;
    return item.save();
  }

  /**
   * Seeds standard formulary medicines if the clinic formulary is currently empty.
   */
  async seedStandardFormulary(
    clinicId: Types.ObjectId,
    doctorId: Types.ObjectId,
  ): Promise<number> {
    const count = await this.formularyModel.countDocuments({ clinicId });
    if (count > 0) return 0;

    const standardMedicines: Array<{
      name: string;
      activeIngredient: string;
      formulation: MedicineFormulation;
      strength: string;
      defaultDose: string;
      defaultRoute: MedicineRoute;
      defaultFrequency: string;
      defaultDuration: string;
      defaultFoodInstruction: FoodInstruction;
    }> = [
      {
        name: 'Paracetamol',
        activeIngredient: 'Acetaminophen',
        formulation: MedicineFormulation.TABLET,
        strength: '650 mg',
        defaultDose: '1 tablet',
        defaultRoute: MedicineRoute.ORAL,
        defaultFrequency: 'TID',
        defaultDuration: '3 days',
        defaultFoodInstruction: FoodInstruction.AFTER_MEALS,
      },
      {
        name: 'Amoxicillin',
        activeIngredient: 'Amoxicillin Trihydrate',
        formulation: MedicineFormulation.CAPSULE,
        strength: '500 mg',
        defaultDose: '1 capsule',
        defaultRoute: MedicineRoute.ORAL,
        defaultFrequency: 'TID',
        defaultDuration: '5 days',
        defaultFoodInstruction: FoodInstruction.AFTER_MEALS,
      },
      {
        name: 'Azithromycin',
        activeIngredient: 'Azithromycin Dihydrate',
        formulation: MedicineFormulation.TABLET,
        strength: '500 mg',
        defaultDose: '1 tablet',
        defaultRoute: MedicineRoute.ORAL,
        defaultFrequency: 'OD',
        defaultDuration: '3 days',
        defaultFoodInstruction: FoodInstruction.AFTER_MEALS,
      },
      {
        name: 'Cetirizine',
        activeIngredient: 'Cetirizine Dihydrochloride',
        formulation: MedicineFormulation.TABLET,
        strength: '10 mg',
        defaultDose: '1 tablet',
        defaultRoute: MedicineRoute.ORAL,
        defaultFrequency: 'BEDTIME',
        defaultDuration: '5 days',
        defaultFoodInstruction: FoodInstruction.AFTER_MEALS,
      },
      {
        name: 'Metformin',
        activeIngredient: 'Metformin Hydrochloride',
        formulation: MedicineFormulation.TABLET,
        strength: '500 mg',
        defaultDose: '1 tablet',
        defaultRoute: MedicineRoute.ORAL,
        defaultFrequency: 'BD',
        defaultDuration: '30 days',
        defaultFoodInstruction: FoodInstruction.WITH_MEALS,
      },
      {
        name: 'Pantoprazole',
        activeIngredient: 'Pantoprazole Sodium',
        formulation: MedicineFormulation.TABLET,
        strength: '40 mg',
        defaultDose: '1 tablet',
        defaultRoute: MedicineRoute.ORAL,
        defaultFrequency: 'OD',
        defaultDuration: '14 days',
        defaultFoodInstruction: FoodInstruction.EMPTY_STOMACH,
      },
      {
        name: 'Amoxicillin Syrup',
        activeIngredient: 'Amoxicillin Trihydrate',
        formulation: MedicineFormulation.SYRUP,
        strength: '125 mg/5 mL',
        defaultDose: '5 mL',
        defaultRoute: MedicineRoute.ORAL,
        defaultFrequency: 'TID',
        defaultDuration: '5 days',
        defaultFoodInstruction: FoodInstruction.AFTER_MEALS,
      },
      {
        name: 'Salbutamol Inhaler',
        activeIngredient: 'Albuterol Sulfate',
        formulation: MedicineFormulation.INHALER,
        strength: '100 mcg/puff',
        defaultDose: '2 puffs',
        defaultRoute: MedicineRoute.INHALATION,
        defaultFrequency: 'PRN',
        defaultDuration: '30 days',
        defaultFoodInstruction: FoodInstruction.IRRELEVANT,
      },
    ];

    const docs = standardMedicines.map((m) => ({
      clinicId,
      name: m.name,
      activeIngredient: m.activeIngredient,
      formulation: m.formulation,
      strength: m.strength,
      defaultDose: m.defaultDose,
      defaultRoute: m.defaultRoute,
      defaultFrequency: m.defaultFrequency,
      defaultDuration: m.defaultDuration,
      defaultFoodInstruction: m.defaultFoodInstruction,
      isActive: true,
      createdBy: doctorId,
      version: 1,
    }));

    await this.formularyModel.insertMany(docs);
    return docs.length;
  }

  private validateFormulationRoute(
    formulation: MedicineFormulation,
    route?: MedicineRoute | null,
    food?: FoodInstruction | null,
  ): void {
    if (!route) return;

    if (
      (formulation === MedicineFormulation.CREAM ||
        formulation === MedicineFormulation.OINTMENT ||
        formulation === MedicineFormulation.GEL ||
        formulation === MedicineFormulation.LOTION) &&
      (food === FoodInstruction.BEFORE_MEALS || food === FoodInstruction.WITH_MEALS)
    ) {
      throw new BadRequestException(
        `Topical formulation "${formulation}" cannot mandate oral food instructions.`,
      );
    }

    if (
      (formulation === MedicineFormulation.TABLET || formulation === MedicineFormulation.CAPSULE) &&
      route !== MedicineRoute.ORAL &&
      route !== MedicineRoute.SUBLINGUAL
    ) {
      throw new BadRequestException(
        `Solid oral formulation "${formulation}" is incompatible with route "${route}".`,
      );
    }

    if (
      (formulation === MedicineFormulation.SYRUP || formulation === MedicineFormulation.SUSPENSION) &&
      route !== MedicineRoute.ORAL
    ) {
      throw new BadRequestException(
        `Liquid oral formulation "${formulation}" requires ORAL route.`,
      );
    }
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
