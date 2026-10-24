import { IsMongoId, IsNotEmpty } from 'class-validator';

export class TransferOwnershipDto {
  @IsNotEmpty({ message: 'Target doctor ID is required' })
  @IsMongoId({ message: 'Target doctor ID must be a valid MongoDB ObjectId' })
  newOwnerDoctorId: string;
}
