import { BadRequestException } from "@nestjs/common"
import {
  MedicineFormulation,
  MedicineRoute,
  DoseUnit,
  TimingType,
  FoodInstruction,
} from "../schemas/prescription-item.schema.js"
import type { PrescriptionItemDto } from "../dto/prescription-item.dto.js"

export function validatePrescriptionItem(item: PrescriptionItemDto): void {
  // 1. Validate Ingredient Components Strength
  if (!item.strength?.components || item.strength.components.length === 0) {
    throw new BadRequestException(
      `Medicine "${item.name}": At least one ingredient component is required.`,
    )
  }

  for (const comp of item.strength.components) {
    if (comp.amount !== null && comp.amount !== undefined) {
      if (
        typeof comp.amount !== "number" ||
        !Number.isFinite(comp.amount) ||
        comp.amount <= 0
      ) {
        throw new BadRequestException(
          `Medicine "${item.name}": Ingredient "${comp.ingredientName}" amount must be a finite positive number (> 0). Received: ${comp.amount}`,
        )
      }
    }
  }

  // 2. Validate Administered Dose
  if (
    typeof item.administeredDose?.magnitude !== "number" ||
    !Number.isFinite(item.administeredDose.magnitude) ||
    item.administeredDose.magnitude <= 0
  ) {
    throw new BadRequestException(
      `Medicine "${item.name}": Administered dose magnitude must be a finite positive number (> 0).`,
    )
  }

  // 3. Validate Timing & Cross-Field Frequency
  const freq = item.frequency
  if (!freq) {
    throw new BadRequestException(
      `Medicine "${item.name}": Frequency is required.`,
    )
  }

  switch (freq.timingType) {
    case TimingType.INTERVAL:
      if (
        typeof freq.intervalHours !== "number" ||
        !Number.isInteger(freq.intervalHours) ||
        freq.intervalHours < 1 ||
        freq.intervalHours > 168
      ) {
        throw new BadRequestException(
          `Medicine "${item.name}": INTERVAL timing requires intervalHours between 1 and 168.`,
        )
      }
      if (freq.prnIndication) {
        throw new BadRequestException(
          `Medicine "${item.name}": prnIndication is not permitted with INTERVAL timing.`,
        )
      }
      break

    case TimingType.PRN_AS_NEEDED:
      if (
        !freq.prnIndication ||
        typeof freq.prnIndication !== "string" ||
        freq.prnIndication.trim().length < 2
      ) {
        throw new BadRequestException(
          `Medicine "${item.name}": PRN_AS_NEEDED timing requires a non-empty prnIndication (min 2 characters).`,
        )
      }
      if (freq.intervalHours) {
        throw new BadRequestException(
          `Medicine "${item.name}": intervalHours is not permitted with PRN_AS_NEEDED timing.`,
        )
      }
      break

    case TimingType.STANDARD:
      if (
        !freq.frequencyCode &&
        (!freq.scheduleLabel || !freq.scheduleLabel.trim())
      ) {
        throw new BadRequestException(
          `Medicine "${item.name}": STANDARD timing requires a valid frequencyCode or a non-empty scheduleLabel.`,
        )
      }
      if (freq.intervalHours) {
        throw new BadRequestException(
          `Medicine "${item.name}": intervalHours is not permitted with STANDARD timing.`,
        )
      }
      if (freq.prnIndication) {
        throw new BadRequestException(
          `Medicine "${item.name}": prnIndication is not permitted with STANDARD timing.`,
        )
      }
      break

    case TimingType.STAT:
      if (item.duration.unit !== "STAT" || item.duration.value !== 1) {
        throw new BadRequestException(
          `Medicine "${item.name}": STAT timing requires duration unit to be 'STAT' with value 1.`,
        )
      }
      break

    default:
      throw new BadRequestException(
        `Medicine "${item.name}": Invalid or unsupported timingType: ${(freq as any).timingType}`,
      )
  }

  // Bidirectional STAT check
  if (item.duration.unit === "STAT" && freq.timingType !== TimingType.STAT) {
    throw new BadRequestException(
      `Medicine "${item.name}": Duration unit 'STAT' requires timingType to be 'STAT'.`,
    )
  }

  // 4. Formulation-Route & Dose Unit Compatibility Matrix
  validateFormulationRouteCompatibility(item)
}

function validateFormulationRouteCompatibility(
  item: PrescriptionItemDto,
): void {
  const form = item.formulation
  const route = item.route
  const unit = item.administeredDose.unit

  switch (form) {
    case MedicineFormulation.TABLET:
    case MedicineFormulation.CAPSULE: {
      const allowedRoutes = [MedicineRoute.ORAL, MedicineRoute.SUBLINGUAL]
      if (!allowedRoutes.includes(route)) {
        throw new BadRequestException(
          `Medicine "${item.name}": Formulation "${form}" is incompatible with route "${route}". Allowed routes: ${allowedRoutes.join(", ")}.`,
        )
      }
      const allowedUnits = [DoseUnit.TABLET, DoseUnit.CAPSULE]
      if (!allowedUnits.includes(unit)) {
        throw new BadRequestException(
          `Medicine "${item.name}": Formulation "${form}" requires dose unit TABLET or CAPSULE. Received: "${unit}".`,
        )
      }
      break
    }

    case MedicineFormulation.SYRUP:
    case MedicineFormulation.SUSPENSION: {
      if (route !== MedicineRoute.ORAL) {
        throw new BadRequestException(
          `Medicine "${item.name}": Formulation "${form}" requires route ORAL. Received: "${route}".`,
        )
      }
      const allowedUnits = [DoseUnit.ML, DoseUnit.TEASPOON, DoseUnit.TABLESPOON]
      if (!allowedUnits.includes(unit)) {
        throw new BadRequestException(
          `Medicine "${item.name}": Formulation "${form}" requires liquid dose unit (ML, TEASPOON, TABLESPOON). Received: "${unit}".`,
        )
      }
      break
    }

    case MedicineFormulation.INHALER:
    case MedicineFormulation.SPRAY: {
      const allowedRoutes = [MedicineRoute.INHALATION, MedicineRoute.NASAL]
      if (!allowedRoutes.includes(route)) {
        throw new BadRequestException(
          `Medicine "${item.name}": Formulation "${form}" is incompatible with route "${route}". Allowed routes: INHALATION, NASAL.`,
        )
      }
      const allowedUnits = [
        DoseUnit.PUFF,
        DoseUnit.ACTUATION,
        DoseUnit.DROP, // for nasal spray/drops
      ]
      if (!allowedUnits.includes(unit)) {
        throw new BadRequestException(
          `Medicine "${item.name}": Formulation "${form}" requires dose unit PUFF, ACTUATION, or DROP. Received: "${unit}".`,
        )
      }
      break
    }

    case MedicineFormulation.DROPS: {
      const allowedRoutes = [
        MedicineRoute.OPHTHALMIC,
        MedicineRoute.OTIC,
        MedicineRoute.NASAL,
        MedicineRoute.ORAL,
      ]
      if (!allowedRoutes.includes(route)) {
        throw new BadRequestException(
          `Medicine "${item.name}": Formulation "${form}" is incompatible with route "${route}". Allowed routes: OPHTHALMIC, OTIC, NASAL, ORAL.`,
        )
      }
      if (unit !== DoseUnit.DROP) {
        throw new BadRequestException(
          `Medicine "${item.name}": Formulation "${form}" requires dose unit DROP. Received: "${unit}".`,
        )
      }
      break
    }

    case MedicineFormulation.CREAM:
    case MedicineFormulation.OINTMENT:
    case MedicineFormulation.GEL:
    case MedicineFormulation.LOTION: {
      const allowedRoutes = [MedicineRoute.TOPICAL, MedicineRoute.RECTAL]
      if (!allowedRoutes.includes(route)) {
        throw new BadRequestException(
          `Medicine "${item.name}": Formulation "${form}" is incompatible with route "${route}". Allowed routes: TOPICAL, RECTAL.`,
        )
      }
      const allowedUnits = [DoseUnit.APPLICATION, DoseUnit.G]
      if (!allowedUnits.includes(unit)) {
        throw new BadRequestException(
          `Medicine "${item.name}": Formulation "${form}" requires dose unit APPLICATION or G. Received: "${unit}".`,
        )
      }
      if (
        item.foodInstruction === FoodInstruction.BEFORE_MEALS ||
        item.foodInstruction === FoodInstruction.WITH_MEALS
      ) {
        throw new BadRequestException(
          `Medicine "${item.name}": Topical formulation "${form}" cannot mandate oral food instructions (BEFORE_MEALS or WITH_MEALS).`,
        )
      }
      break
    }

    case MedicineFormulation.INJECTION: {
      const allowedRoutes = [
        MedicineRoute.INTRAVENOUS,
        MedicineRoute.INTRAMUSCULAR,
        MedicineRoute.SUBCUTANEOUS,
      ]
      if (!allowedRoutes.includes(route)) {
        throw new BadRequestException(
          `Medicine "${item.name}": Formulation "${form}" is incompatible with route "${route}". Allowed routes: INTRAVENOUS, INTRAMUSCULAR, SUBCUTANEOUS.`,
        )
      }
      const allowedUnits = [
        DoseUnit.ML,
        DoseUnit.MG,
        DoseUnit.MCG,
        DoseUnit.VIAL,
        DoseUnit.AMPOULE,
        DoseUnit.INTERNATIONAL_UNIT,
      ]
      if (!allowedUnits.includes(unit)) {
        throw new BadRequestException(
          `Medicine "${item.name}": Formulation "${form}" requires injectable dose unit. Received: "${unit}".`,
        )
      }
      break
    }

    case MedicineFormulation.PATCH: {
      const allowedRoutes = [MedicineRoute.TRANSDERMAL, MedicineRoute.TOPICAL]
      if (!allowedRoutes.includes(route)) {
        throw new BadRequestException(
          `Medicine "${item.name}": Formulation "${form}" requires route TRANSDERMAL or TOPICAL. Received: "${route}".`,
        )
      }
      if (unit !== DoseUnit.PATCH) {
        throw new BadRequestException(
          `Medicine "${item.name}": Formulation "${form}" requires dose unit PATCH. Received: "${unit}".`,
        )
      }
      break
    }

    case MedicineFormulation.POWDER: {
      const allowedRoutes = [MedicineRoute.ORAL, MedicineRoute.TOPICAL]
      if (!allowedRoutes.includes(route)) {
        throw new BadRequestException(
          `Medicine "${item.name}": Formulation "${form}" requires route ORAL or TOPICAL. Received: "${route}".`,
        )
      }
      const allowedUnits = [DoseUnit.SACHET, DoseUnit.G]
      if (!allowedUnits.includes(unit)) {
        throw new BadRequestException(
          `Medicine "${item.name}": Formulation "${form}" requires dose unit SACHET or G. Received: "${unit}".`,
        )
      }
      break
    }

    case MedicineFormulation.SUPPOSITORY: {
      if (route !== MedicineRoute.RECTAL) {
        throw new BadRequestException(
          `Medicine "${item.name}": Formulation "${form}" requires route RECTAL. Received: "${route}".`,
        )
      }
      if (unit !== DoseUnit.SUPPOSITORY) {
        throw new BadRequestException(
          `Medicine "${item.name}": Formulation "${form}" requires dose unit SUPPOSITORY. Received: "${unit}".`,
        )
      }
      break
    }

    case MedicineFormulation.OTHER:
      // Validated for valid enums; doctor clinical discretion permitted
      break
  }
}
