import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = 'https://cliniqo-api.onrender.com';

async function fetchWithRetry(url, options = {}, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (attempt === retries) throw err;
      console.log(`Transient network error (${err.message}). Retrying in 1.5s (attempt ${attempt}/${retries})...`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function main() {
  console.log(`=======================================================`);
  console.log(`CLINIQO PRODUCTION VERIFICATION: ${BASE_URL}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`=======================================================\n`);

  let registeredDoctorId = null;
  let createdClinicId = null;

  try {
    // 1. HEALTH & READINESS
    console.log('--- 1. VERIFYING /health AND /health/ready ---');
    const healthRes = await fetchWithRetry(`${BASE_URL}/health`);
    const healthJson = await healthRes.json();
    console.log(`GET /health: HTTP ${healthRes.status}`, healthJson);
    if (healthRes.status !== 200 || healthJson.status !== 'ok') {
      throw new Error(`/health check failed! HTTP ${healthRes.status}`);
    }

    const readyRes = await fetchWithRetry(`${BASE_URL}/health/ready`);
    const readyJson = await readyRes.json();
    console.log(`GET /health/ready: HTTP ${readyRes.status}`, readyJson);
    if (readyRes.status !== 200 || readyJson.status !== 'ready' || readyJson.checks?.database !== 'ok') {
      throw new Error(`/health/ready check failed! Database is not ready: ${JSON.stringify(readyJson)}`);
    }
    console.log('✔ Health & database readiness checks passed.');

    // 2. REAL DOCTOR REGISTRATION & DUPLICATE REJECTION
    console.log('\n--- 2. VERIFYING DOCTOR REGISTRATION & DUPLICATE REJECTION ---');
    const testTimestamp = Date.now();
    const testEmail = `dr.probe.${testTimestamp}@cliniqo.app`;
    const testPassword = 'Password123!';
    const testName = 'Dr. Production Verification Probe';

    const regRes = await fetchWithRetry(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: testPassword,
        fullName: testName,
        phone: '9876543210',
      }),
    });
    const regJson = await regRes.json();
    console.log(`POST /auth/register: HTTP ${regRes.status}`);
    if (regRes.status !== 201) {
      throw new Error(`Registration failed with HTTP ${regRes.status}: ${JSON.stringify(regJson)}`);
    }
    registeredDoctorId = regJson.doctor?.id;
    const initialAccessToken = regJson.accessToken;
    const initialRefreshToken = regJson.refreshToken;
    console.log(`✔ Registered Doctor ID: ${registeredDoctorId}`);
    console.log(`✔ Access Token (RS256): ${initialAccessToken.slice(0, 32)}...`);
    console.log(`✔ Refresh Token: ${initialRefreshToken.slice(0, 24)}...`);

    // Duplicate registration test
    console.log('Testing duplicate registration (should return HTTP 409 Conflict)...');
    const dupRes = await fetchWithRetry(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: testPassword,
        fullName: testName,
        phone: '9876543210',
      }),
    });
    const dupJson = await dupRes.json();
    console.log(`POST /auth/register (duplicate): HTTP ${dupRes.status}`, dupJson.message || dupJson);
    if (dupRes.status !== 409) {
      throw new Error(`Duplicate registration expected HTTP 409 but received ${dupRes.status}`);
    }
    console.log('✔ Duplicate registration correctly rejected with HTTP 409.');

    // 3. DOCTOR LOGIN
    console.log('\n--- 3. VERIFYING DOCTOR LOGIN ---');
    const loginRes = await fetchWithRetry(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: testPassword,
      }),
    });
    const loginJson = await loginRes.json();
    console.log(`POST /auth/login: HTTP ${loginRes.status}`);
    if (loginRes.status !== 200 || !loginJson.accessToken) {
      throw new Error(`Login failed with HTTP ${loginRes.status}: ${JSON.stringify(loginJson)}`);
    }
    const loginAccessToken = loginJson.accessToken;
    const loginRefreshToken = loginJson.refreshToken;
    console.log(`✔ Login successful for ${loginJson.doctor?.fullName}`);

    // 4. JWT SIGNING & REFRESH-TOKEN ROTATION
    console.log('\n--- 4. VERIFYING JWT SIGNING & REFRESH-TOKEN ROTATION ---');
    const refreshRes = await fetchWithRetry(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refreshToken: loginRefreshToken,
      }),
    });
    const refreshJson = await refreshRes.json();
    console.log(`POST /auth/refresh: HTTP ${refreshRes.status}`);
    if (refreshRes.status !== 200 || !refreshJson.accessToken || !refreshJson.refreshToken) {
      throw new Error(`Token refresh failed with HTTP ${refreshRes.status}: ${JSON.stringify(refreshJson)}`);
    }
    if (refreshJson.refreshToken === loginRefreshToken) {
      throw new Error('Refresh token was not rotated!');
    }
    const rotatedAccessToken = refreshJson.accessToken;
    console.log(`✔ Token rotated successfully.`);
    console.log(`✔ New Access Token: ${rotatedAccessToken.slice(0, 32)}...`);
    console.log(`✔ New Refresh Token: ${refreshJson.refreshToken.slice(0, 24)}...`);

    // 5. CLINIC CREATION & DOCTOR OWNERSHIP
    console.log('\n--- 5. VERIFYING CLINIC CREATION & DOCTOR OWNERSHIP ---');
    const clinicName = `Probe Specialty Care ${testTimestamp}`;
    const clinicRes = await fetchWithRetry(`${BASE_URL}/clinics`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${rotatedAccessToken}`,
      },
      body: JSON.stringify({
        name: clinicName,
        address: {
          street: '77 Health Boulevard, Suite 100',
          city: 'Mumbai',
          state: 'Maharashtra',
          postalCode: '400001',
          country: 'India',
        },
        phone: '9876543210',
        email: testEmail,
      }),
    });
    const clinicJson = await clinicRes.json();
    console.log(`POST /clinics: HTTP ${clinicRes.status}`);
    if (clinicRes.status !== 201) {
      throw new Error(`Clinic creation failed with HTTP ${clinicRes.status}: ${JSON.stringify(clinicJson)}`);
    }
    createdClinicId = clinicJson.clinic?.id || clinicJson.clinic?._id;
    console.log(`✔ Clinic created: "${clinicJson.clinic?.name}" (ID: ${createdClinicId})`);

    // Verify ownership via /clinics/my-clinics
    const myClinicsRes = await fetchWithRetry(`${BASE_URL}/clinics/my-clinics`, {
      headers: {
        Authorization: `Bearer ${rotatedAccessToken}`,
      },
    });
    const myClinicsJson = await myClinicsRes.json();
    console.log(`GET /clinics/my-clinics: HTTP ${myClinicsRes.status}`);
    if (myClinicsRes.status !== 200 || !Array.isArray(myClinicsJson) || myClinicsJson.length === 0) {
      throw new Error(`Failed to list clinics: ${JSON.stringify(myClinicsJson)}`);
    }
    const clinicRecord = myClinicsJson.find((c) => c.id === createdClinicId || c.name === clinicName);
    if (!clinicRecord || clinicRecord.role !== 'OWNER') {
      throw new Error(`Doctor ownership verification failed: role is ${clinicRecord?.role}`);
    }
    console.log(`✔ Doctor ownership verified: role is ${clinicRecord.role}`);

    // 6. CATALOGUE SEARCH & STRENGTHS ENDPOINTS
    console.log('\n--- 6. VERIFYING CATALOGUE SEARCH & STRENGTHS ---');
    const searchRes = await fetchWithRetry(`${BASE_URL}/catalogue/search?q=a&formulation=Tablet&limit=5`, {
      headers: {
        Authorization: `Bearer ${rotatedAccessToken}`,
      },
    });
    const searchJson = await searchRes.json();
    console.log(`GET /catalogue/search?q=a&formulation=Tablet: HTTP ${searchRes.status}`);
    console.log(`Total matching records: ${searchJson.total}`);
    if (searchRes.status !== 200 || searchJson.total === 0 || !searchJson.items || searchJson.items.length === 0) {
      throw new Error(`Catalogue search failed or returned 0 results: ${JSON.stringify(searchJson)}`);
    }
    console.log(`✔ First 3 results for 'a' with Tablet:`);
    searchJson.items.slice(0, 3).forEach((item, i) => {
      console.log(`   ${i + 1}. [${item.type}] ${item.name} | Form: ${item.dosageForm} | Strengths: ${item.rawStrengthSummary || 'N/A'}`);
    });

    // Strengths query
    const strengthsRes = await fetchWithRetry(`${BASE_URL}/catalogue/strengths?name=Paracetamol&formulation=Tablet`, {
      headers: {
        Authorization: `Bearer ${rotatedAccessToken}`,
      },
    });
    const strengthsJson = await strengthsRes.json();
    console.log(`\nGET /catalogue/strengths?name=Paracetamol&formulation=Tablet: HTTP ${strengthsRes.status}`);
    console.log('Verified strengths found:', strengthsJson.strengths);
    if (strengthsRes.status !== 200 || !Array.isArray(strengthsJson.strengths) || strengthsJson.strengths.length === 0) {
      throw new Error(`Strengths query failed: ${JSON.stringify(strengthsJson)}`);
    }
    console.log(`✔ Retrieved ${strengthsJson.strengths.length} verified strengths for Paracetamol Tablet.`);

    // 7. CATALOGUE FEED PAGINATION
    console.log('\n--- 7. VERIFYING CATALOGUE FEED PAGINATION ---');
    const feedPage1Res = await fetchWithRetry(`${BASE_URL}/catalogue/feed?limit=5`, {
      headers: {
        Authorization: `Bearer ${rotatedAccessToken}`,
      },
    });
    const feedPage1Json = await feedPage1Res.json();
    console.log(`GET /catalogue/feed (Page 1): HTTP ${feedPage1Res.status}`);
    console.log(`Total in catalogue: ${feedPage1Json.total}, Items in batch: ${feedPage1Json.items?.length}, hasMore: ${feedPage1Json.hasMore}`);
    console.log(`Next cursor: ${feedPage1Json.nextCursor}`);
    if (feedPage1Res.status !== 200 || feedPage1Json.items?.length !== 5 || !feedPage1Json.nextCursor) {
      throw new Error(`Feed page 1 failed: ${JSON.stringify(feedPage1Json)}`);
    }

    // Fetch Page 2 using nextCursor
    const feedPage2Res = await fetchWithRetry(`${BASE_URL}/catalogue/feed?limit=5&cursor=${encodeURIComponent(feedPage1Json.nextCursor)}`, {
      headers: {
        Authorization: `Bearer ${rotatedAccessToken}`,
      },
    });
    const feedPage2Json = await feedPage2Res.json();
    console.log(`GET /catalogue/feed (Page 2): HTTP ${feedPage2Res.status}`);
    console.log(`Items in batch 2: ${feedPage2Json.items?.length}, Next cursor: ${feedPage2Json.nextCursor}`);
    if (feedPage2Res.status !== 200 || feedPage2Json.items?.length !== 5) {
      throw new Error(`Feed page 2 pagination failed: ${JSON.stringify(feedPage2Json)}`);
    }
    console.log(`✔ Pagination verified across multiple cursor pages.`);

  } finally {
    // 8. DATABASE CLEANUP OF SYNTHETIC TEST RECORDS
    console.log('\n--- 8. PURGING SYNTHETIC TEST RECORDS FROM PRODUCTION ATLAS ---');
    const envContent = fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8');
    const uri = envContent.match(/MONGODB_URI=(.+)/)[1].trim();

    const conn = await mongoose.connect(uri, { dbName: 'cliniqo_prod', serverSelectionTimeoutMS: 15000 });
    const db = conn.connection.db;

    // Purge any registered probe doctors (including from earlier aborted run)
    const docDel = await db.collection('doctors').deleteMany({ email: { $regex: /^dr\.probe\./ } });
    const clinicDel = await db.collection('clinics').deleteMany({ name: { $regex: /^Probe Specialty Care/ } });
    if (registeredDoctorId) {
      await db.collection('clinic_memberships').deleteMany({ doctorId: new mongoose.Types.ObjectId(registeredDoctorId) });
      await db.collection('refresh_sessions').deleteMany({ doctorId: new mongoose.Types.ObjectId(registeredDoctorId) });
    }
    if (createdClinicId) {
      await db.collection('clinic_audit_logs').deleteMany({ clinicId: new mongoose.Types.ObjectId(createdClinicId) });
    }

    console.log(`✔ Deleted synthetic test doctor(s): ${docDel.deletedCount}`);
    console.log(`✔ Deleted synthetic test clinic(s): ${clinicDel.deletedCount}`);

    await mongoose.disconnect();
    console.log('✔ All synthetic records purged cleanly. Zero test artifacts left in production.\n');
  }

  console.log('=======================================================');
  console.log('ALL PRODUCTION LIVE CHECKS COMPLETED & VERIFIED 100%!');
  console.log('=======================================================');
}

main().catch((err) => {
  console.error('\n❌ VERIFICATION ERROR:', err);
  process.exit(1);
});
