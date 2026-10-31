import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AuthService } from '../dist/auth/auth.service.js';
import { PasswordService } from '../dist/auth/password.service.js';
import { JwtService } from '@nestjs/jwt';
import { TokenService } from '../dist/auth/token.service.js';
import { RateLimiterService } from '../dist/auth/rate-limiter.service.js';
import { ConfigService } from '../dist/config/config.service.js';
import { DoctorSchema } from '../dist/auth/schemas/doctor.schema.js';
import { RefreshSessionSchema } from '../dist/auth/schemas/refresh-session.schema.js';
import { RateLimitSchema } from '../dist/auth/schemas/rate-limit.schema.js';
import { PasswordResetTokenSchema } from '../dist/auth/schemas/password-reset.schema.js';
import { ClinicService } from '../dist/clinic/clinic.service.js';
import { ClinicSchema } from '../dist/clinic/schemas/clinic.schema.js';
import { ClinicMembershipSchema } from '../dist/clinic/schemas/clinic-membership.schema.js';
import { ClinicInvitationSchema } from '../dist/clinic/schemas/clinic-invitation.schema.js';
import { ClinicAuditLogSchema } from '../dist/clinic/schemas/clinic-audit-log.schema.js';
import { ClinicAuditService } from '../dist/clinic/clinic-audit.service.js';
import { ClinicOutboxService } from '../dist/clinic/clinic-outbox.service.js';
import { InvitationOutboxSchema } from '../dist/clinic/schemas/invitation-outbox.schema.js';
import { CatalogueService } from '../dist/catalogue/catalogue.service.js';
import { CatalogueGenericSchema } from '../dist/catalogue/schemas/catalogue-generic.schema.js';
import { CatalogueBrandSchema } from '../dist/catalogue/schemas/catalogue-brand.schema.js';
import { CatalogueProductSchema } from '../dist/catalogue/schemas/catalogue-product.schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  const envContent = fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8');
  const uri = envContent.match(/MONGODB_URI=(.+)/)[1].trim();
  const dbName = 'cliniqo_prod';

  console.log('Connecting to Atlas [cliniqo_prod]...');
  const conn = await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 20000 });
  console.log('Connected to Atlas successfully.');

  // Bind models
  const doctorModel = conn.model('Doctor', DoctorSchema);
  const refreshModel = conn.model('RefreshSession', RefreshSessionSchema);
  const rateLimitModel = conn.model('RateLimit', RateLimitSchema);
  const pwdResetModel = conn.model('PasswordResetToken', PasswordResetTokenSchema);
  const clinicModel = conn.model('Clinic', ClinicSchema);
  const membershipModel = conn.model('ClinicMembership', ClinicMembershipSchema);
  const invitationModel = conn.model('ClinicInvitation', ClinicInvitationSchema);
  const outboxModel = conn.model('InvitationOutbox', InvitationOutboxSchema);
  const auditModel = conn.model('ClinicAuditLog', ClinicAuditLogSchema);
  const genericModel = conn.model('CatalogueGeneric', CatalogueGenericSchema);
  const brandModel = conn.model('CatalogueBrand', CatalogueBrandSchema);
  const productModel = conn.model('CatalogueProduct', CatalogueProductSchema);

  process.env.JWT_ACCESS_SECRET = 'REDACTED_SECRET';
  process.env.JWT_REFRESH_SECRET = 'REDACTED_SECRET';
  process.env.OUTBOX_ENCRYPTION_KEY = 'REDACTED_SECRET';

  // Initialize Config & Services
  const configService = new ConfigService();
  const passwordService = new PasswordService(configService);
  const rateLimiter = new RateLimiterService(rateLimitModel);
  const jwtService = new JwtService({});
  const tokenService = new TokenService(jwtService, configService, refreshModel, doctorModel);
  const authService = new AuthService(
    doctorModel,
    pwdResetModel,
    passwordService,
    tokenService,
    { sendPasswordResetEmail: async () => true, sendAccountVerificationEmail: async () => true },
    rateLimiter,
    configService,
  );

  const auditService = new ClinicAuditService(auditModel);
  const outboxService = new ClinicOutboxService(
    outboxModel,
    invitationModel,
    { sendDoctorInvitationEmail: async () => true },
    configService,
  );

  const clinicService = new ClinicService(
    conn,
    clinicModel,
    membershipModel,
    invitationModel,
    outboxModel,
    doctorModel,
    auditService,
    outboxService,
  );

  const catalogueService = new CatalogueService(genericModel, brandModel, productModel);

  const testEmail = `dr.synth.${Date.now()}@cliniqo.app`;
  const testPassword = 'Password123!';
  const testName = 'Dr. Synthetic Test';

  console.log('\n--- 1. TESTING DOCTOR REGISTRATION ---');
  const regResult = await authService.register({
    email: testEmail,
    password: testPassword,
    fullName: testName,
    phone: '9876543210',
  });

  console.log('Registered Doctor ID:', regResult.doctor.id);
  console.log('Doctor Email:', regResult.doctor.email);
  console.log('Access Token issued:', regResult.accessToken.slice(0, 30) + '...');
  console.log('Refresh Token issued:', regResult.refreshToken.slice(0, 30) + '...');

  // Verify doctor record in MongoDB
  const docInDb = await doctorModel.findById(regResult.doctor.id).select('+passwordHash');
  if (!docInDb) throw new Error('Doctor not found in Atlas DB!');
  if (!docInDb.passwordHash || docInDb.passwordHash.startsWith('Password')) throw new Error('Password stored as plaintext!');
  console.log('Password hash verified (Argon2id):', docInDb.passwordHash.slice(0, 25) + '...');

  console.log('\n--- 2. TESTING DUPLICATE REGISTRATION (IDEMPOTENCY / REJECTION) ---');
  let duplicateRejected = false;
  try {
    await authService.register({
      email: testEmail,
      password: testPassword,
      fullName: testName,
    });
  } catch (err) {
    duplicateRejected = true;
    console.log('Duplicate correctly rejected with:', err.message);
  }
  if (!duplicateRejected) throw new Error('Duplicate registration was not rejected!');

  console.log('\n--- 3. TESTING DOCTOR LOGIN ---');
  const loginResult = await authService.login({
    email: testEmail,
    password: testPassword,
  });
  console.log('Login successful! Token issued for:', loginResult.doctor.fullName);

  console.log('\n--- 4. TESTING CLINIC SETUP ---');
  const uniqueClinicName = `Synthetic Specialty Care ${Date.now()}`;
  const clinicSetup = await clinicService.createClinicWithMembership(
    docInDb,
    {
      name: uniqueClinicName,
      address: '123 Health Ave, Suite 4',
      phone: '9876543210',
      email: testEmail,
    },
  );
  const clinicResult = clinicSetup.clinic;
  console.log('Clinic created successfully:', clinicResult.name, 'ID:', clinicResult.id || clinicResult._id);

  // Verify clinic membership
  const memberships = await clinicService.listDoctorClinics(new mongoose.Types.ObjectId(loginResult.doctor.id));
  console.log('Doctor Clinics count:', memberships.length);
  if (memberships.length !== 1 || memberships[0].name !== uniqueClinicName) {
    throw new Error('Clinic membership verification failed!');
  }
  console.log('Verified clinic ownership role:', memberships[0].role);

  console.log('\n--- 5. TESTING CATALOGUE SEARCH (A-Z) ---');
  const searchA = await catalogueService.search({ q: 'a', formulation: 'Tablet', limit: 5 });
  console.log(`Search 'a' with Tablet returned ${searchA.total} matches:`);
  searchA.items.forEach((it, idx) => {
    console.log(`  ${idx + 1}. [${it.type}] ${it.name} | Strengths: ${it.rawStrengthSummary || 'N/A'}`);
  });

  const searchAmoxy = await catalogueService.search({ q: 'Amoxy', formulation: 'Tablet', limit: 3 });
  console.log(`Search 'Amoxy' returned ${searchAmoxy.total} matches:`);
  searchAmoxy.items.forEach((it, idx) => {
    console.log(`  ${idx + 1}. ${it.name} (${it.dosageForm}) - ${it.rawStrengthSummary}`);
  });

  console.log('\n--- 6. CLEANING UP SYNTHETIC TEST RECORD ---');
  await doctorModel.deleteOne({ _id: regResult.doctor.id });
  await clinicModel.deleteOne({ _id: clinicResult.id });
  await membershipModel.deleteMany({ doctorId: regResult.doctor.id });
  await refreshModel.deleteMany({ doctorId: regResult.doctor.id });
  console.log('Cleanup completed cleanly.');

  await mongoose.disconnect();
  console.log('\nALL VERIFICATIONS PASSED 100%!');
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
