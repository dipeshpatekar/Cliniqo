import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export type RateLimitDocument = HydratedDocument<RateLimit>;

@Schema({
  collection: 'rate_limits',
  timestamps: true,
})
export class RateLimit {
  @Prop({
    required: true,
  })
  key!: string;

  @Prop({
    type: Number,
    required: true,
    default: 1,
    min: 0,
  })
  points!: number;

  @Prop({
    type: Date,
    required: true,
  })
  expiresAt!: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export const RateLimitSchema = SchemaFactory.createForClass(RateLimit);

// Explicit database indexes
RateLimitSchema.index({ key: 1 }, { unique: true });
RateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
