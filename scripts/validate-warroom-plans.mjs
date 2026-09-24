#!/usr/bin/env node
/**
 * Check a War Room plans file against the shared contract before anything reads it.
 *
 *   npm run check:warroom-plans -- <plans.json>
 *
 * Exit 0: the file matches server/services/campaign/plans-schema.js.
 * Exit 1: it does not; every problem is printed with its path.
 * Exit 2: no file given, or it cannot be read or parsed.
 * The campaign producer runs this on its output before it replaces the live file.
 */
import fs from 'node:fs';
import { validatePlans, SCHEMA_VERSION } from '../server/services/campaign/plans-schema.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run check:warroom-plans -- <plans.json>');
  process.exit(2);
}
let doc;
try {
  doc = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`cannot read the plans file: ${e.code ?? e.name}: ${e.message}`);
  process.exit(2);
}
const { ok, errors } = validatePlans(doc);
if (ok) {
  console.log(`ok: ${doc.leagues.length} league(s) match ${SCHEMA_VERSION}`);
  process.exit(0);
}
for (const e of errors) console.log(`${e.path}: ${e.message}`);
console.log(`${errors.length} problem(s); the file does not match ${SCHEMA_VERSION}`);
process.exit(1);
