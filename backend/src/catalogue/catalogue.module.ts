import { Module } from "@nestjs/common"
import { MongooseModule } from "@nestjs/mongoose"
import {
  CatalogueGeneric,
  CatalogueGenericSchema,
} from "./schemas/catalogue-generic.schema.js"
import {
  CatalogueBrand,
  CatalogueBrandSchema,
} from "./schemas/catalogue-brand.schema.js"
import {
  CatalogueProduct,
  CatalogueProductSchema,
} from "./schemas/catalogue-product.schema.js"
import {
  CatalogueImportJob,
  CatalogueImportJobSchema,
} from "./schemas/catalogue-import-job.schema.js"
import { CatalogueService } from "./catalogue.service.js"
import { CatalogueImportService } from "./catalogue-import.service.js"
import { CatalogueController } from "./catalogue.controller.js"
import { AuthModule } from "../auth/auth.module.js"

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CatalogueGeneric.name, schema: CatalogueGenericSchema },
      { name: CatalogueBrand.name, schema: CatalogueBrandSchema },
      { name: CatalogueProduct.name, schema: CatalogueProductSchema },
      { name: CatalogueImportJob.name, schema: CatalogueImportJobSchema },
    ]),
    AuthModule,
  ],
  controllers: [CatalogueController],
  providers: [CatalogueService, CatalogueImportService],
  exports: [CatalogueService, CatalogueImportService],
})
export class CatalogueModule {}
