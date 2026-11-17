import fs from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import crypto from 'node:crypto';
import { AUTHORIZED_TEAMS } from '../functions/src/authorizedTeams';
import { hashRegistrationCode } from '../server/auth';

const uri = process.env.MONGODB_URI;
const authPepper = process.env.INNOHACK_AUTH_PEPPER;
if (!authPepper || authPepper.length < 32) throw new Error('Set a strong INNOHACK_AUTH_PEPPER (at least 32 characters) before migration.');
if (!uri) throw new Error('Set MONGODB_URI before running the migration.');

const filePath = path.resolve(process.cwd(), 'server/data/store.json');
if (!fs.existsSync(filePath)) {
  throw new Error(`Source JSON was not found: ${filePath}`);
}

const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const teamCount = Object.keys(state?.teams || {}).length;
const credentialCount = Object.keys(state?.teamCredentials || {}).length;
if (teamCount !== 30 || credentialCount !== 30 || !state.groups || !state.eventSettings || AUTHORIZED_TEAMS.length !== 30) {
  throw new Error(`Unexpected source data. Expected 30 teams, 30 credential records and 30 private seed accounts; found ${teamCount} and ${credentialCount}.`);
}

// Re-key every registration-code hash with the new production pepper. The plaintext seed file
// is used only by this one-time local migration script and is never needed by the deployed API.
for (const seed of AUTHORIZED_TEAMS) {
  const current = state.teamCredentials[seed.teamId];
  if (!current || current.studentId !== seed.studentId) throw new Error(`Credential seed mismatch for ${seed.teamId}.`);
  const salt = crypto.randomBytes(16).toString('hex');
  current.salt = salt;
  current.registrationCodeHash = hashRegistrationCode(seed.studentId, seed.registrationCode, salt);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
try {
  await client.connect();
  const db = client.db(process.env.MONGODB_DATABASE || 'innohack');
  const collection = db.collection('portalState');
  const existing = await collection.findOne({ _id: 'innohack-primary-state' });
  if (existing) {
    throw new Error('MongoDB already contains portal state. Migration stopped to prevent overwriting live data.');
  }
  await collection.insertOne({
    _id: 'innohack-primary-state',
    state,
    updatedAt: new Date(),
    migratedFrom: 'server/data/store.json',
  });
  console.log(`Migration successful: ${teamCount} teams, ${credentialCount} credential hashes, ${Object.keys(state.drawQueue || {}).length} queue entries, ${(state.drawHistory || []).length} draw records.`);
  console.log('Credential hashes were re-keyed. Do not deploy or commit functions/src/authorizedTeams.ts; keep it as a private local migration input only.');
  console.log('Keep the original JSON file as a private backup until production verification is complete.');
} finally {
  await client.close();
}
