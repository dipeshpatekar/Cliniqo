import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClinicModule } from '../clinic/clinic.module.js';
import { AuthModule } from '../auth/auth.module.js';
import {
  FormularyItem,
  FormularyItemSchema,
} from './schemas/formulary-item.schema.js';
import { FormularyService } from './formulary.service.js';
import { FormularyController } from './formulary.controller.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: FormularyItem.name, schema: FormularyItemSchema },
    ]),
    ClinicModule,
    AuthModule,
  ],
  controllers: [FormularyController],
  providers: [FormularyService],
  exports: [FormularyService, MongooseModule],
})
export class FormularyModule {}
