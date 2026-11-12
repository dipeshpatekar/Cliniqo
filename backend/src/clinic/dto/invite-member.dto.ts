import { IsEmail, IsEnum } from "class-validator"

export enum InvitableRole {
  DOCTOR = "DOCTOR",
  STAFF = "STAFF",
}

export class InviteMemberDto {
  @IsEmail({}, { message: "Must provide a valid invitee email address" })
  inviteeEmail: string

  @IsEnum(InvitableRole, {
    message:
      "Role must be either DOCTOR or STAFF. Invitations cannot grant OWNER privileges.",
  })
  role: InvitableRole
}
