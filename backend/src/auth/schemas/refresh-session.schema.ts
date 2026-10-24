import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  Schema as MongooseSchema,
  type HydratedDocument,
  type Types,
} from 'mongoose';

export type RefreshSessionDocument = HydratedDocument<RefreshSession>;

@Schema({
  collection: 'refresh_sessions',
  timestamps: true,
})
export class RefreshSession {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Doctor',
    required: true,
  })
  doctorId!: Types.ObjectId;

  @Prop({
    required: true,
  })
  tokenHash!: string;

  @Prop({
    required: true,
  })
  familyId!: string;

  @Prop({
    type: Boolean,
    default: false,
  })
  isRevoked!: boolean;

  @Prop({
    type: Date,
    default: null,
  })
  revokedAt?: Date | null;

  @Prop({
    type: Date,
    required: true,
  })
  expiresAt!: Date;

  @Prop({
    type: String,
    trim: true,
    maxlength: 255,
    default: null,
  })
  userAgent?: string | null;

  @Prop({
    type: String,
    trim: true,
    maxlength: 45,
    default: null,
  })
  ipAddress?: string | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export const RefreshSessionSchema =
  SchemaFactory.createForClass(RefreshSession);

// Explicit database indexes
RefreshSessionSchema.index({ tokenHash: 1 }, { unique: true });
RefreshSessionSchema.index({ doctorId: 1, isRevoked: 1 });
RefreshSessionSchema.index({ familyId: 1 });
RefreshSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
