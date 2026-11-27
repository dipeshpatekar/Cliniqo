import mongoose, { type Schema } from "mongoose"
import { ConfigService } from "../config/config.service.js"
import { Doctor, DoctorSchema } from "../auth/schemas/doctor.schema.js"
import {
  RefreshSession,
  RefreshSessionSchema,
} from "../auth/schemas/refresh-session.schema.js"
import {
  PasswordResetToken,
  PasswordResetTokenSchema,
} from "../auth/schemas/password-reset.schema.js"
import {
  RateLimit,
  RateLimitSchema,
} from "../auth/schemas/rate-limit.schema.js"
import { Clinic, ClinicSchema } from "../clinic/schemas/clinic.schema.js"
import {
  ClinicMembership,
  ClinicMembershipSchema,
} from "../clinic/schemas/clinic-membership.schema.js"
import {
  ClinicInvitation,
  ClinicInvitationSchema,
} from "../clinic/schemas/clinic-invitation.schema.js"
import {
  InvitationOutbox,
  InvitationOutboxSchema,
} from "../clinic/schemas/invitation-outbox.schema.js"
import {
  ClinicAuditLog,
  ClinicAuditLogSchema,
} from "../clinic/schemas/clinic-audit-log.schema.js"
import {
  FormularyItem,
  FormularyItemSchema,
} from "../formulary/schemas/formulary-item.schema.js"
import {
  CatalogueBrand,
  CatalogueBrandSchema,
} from "../catalogue/schemas/catalogue-brand.schema.js"
import {
  CatalogueGeneric,
  CatalogueGenericSchema,
} from "../catalogue/schemas/catalogue-generic.schema.js"
import {
  CatalogueProduct,
  CatalogueProductSchema,
} from "../catalogue/schemas/catalogue-product.schema.js"
import {
  CatalogueImportJob,
  CatalogueImportJobSchema,
} from "../catalogue/schemas/catalogue-import-job.schema.js"

export const NON_CLINICAL_INDEXED_SCHEMAS: Array<{
  name: string
  schema: Schema
}> = [
  { name: Doctor.name, schema: DoctorSchema },
  { name: RefreshSession.name, schema: RefreshSessionSchema },
  { name: PasswordResetToken.name, schema: PasswordResetTokenSchema },
  { name: RateLimit.name, schema: RateLimitSchema },
  { name: Clinic.name, schema: ClinicSchema },
  { name: ClinicMembership.name, schema: ClinicMembershipSchema },
  { name: ClinicInvitation.name, schema: ClinicInvitationSchema },
  { name: InvitationOutbox.name, schema: InvitationOutboxSchema },
  { name: ClinicAuditLog.name, schema: ClinicAuditLogSchema },
  { name: FormularyItem.name, schema: FormularyItemSchema },
  { name: CatalogueBrand.name, schema: CatalogueBrandSchema },
  { name: CatalogueGeneric.name, schema: CatalogueGenericSchema },
  { name: CatalogueProduct.name, schema: CatalogueProductSchema },
  { name: CatalogueImportJob.name, schema: CatalogueImportJobSchema },
]

/**
 * Safely creates and verifies missing indexes on non-clinical MongoDB collections
 * without autoIndex overhead in production or destructive dropIndexes side-effects.
 */
export async function ensureNonClinicalProductionIndexes(): Promise<
  Array<{ model: string; indexCount: number }>
> {
  const configService = new ConfigService()
  const { uri, dbName } = configService.validateDatabaseConfig()
  const conn = await mongoose
    .createConnection(uri, { dbName, serverSelectionTimeoutMS: 30000 })
    .asPromise()

  try {
    const summary: Array<{ model: string; indexCount: number }> = []
    for (const entry of NON_CLINICAL_INDEXED_SCHEMAS) {
      const model = conn.model(entry.name, entry.schema)
      await model.createIndexes()
      const indexes = await model.listIndexes()
      summary.push({ model: entry.name, indexCount: indexes.length })
    }
    return summary
  } finally {
    await conn.close()
  }
}

const isDirectExecution =
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].endsWith("ensure-indexes.js")

if (isDirectExecution) {
  if (typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(".env")
    } catch {
      // Ignore missing .env
    }
  }
  ensureNonClinicalProductionIndexes()
    .then((summary) => {
      console.log(
        "Verified non-clinical production MongoDB indexes:",
        JSON.stringify(summary),
      )
      process.exit(0)
    })
    .catch((err) => {
      console.error("Failed to ensure MongoDB production indexes:", err)
      process.exit(1)
    })
}
