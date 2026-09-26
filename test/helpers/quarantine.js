/**
 * The flaky-test register (test/flaky-register.json) and the one way to quarantine a
 * test from it. Rules and history: test/flaky-register.test.js.
 *
 * Usage, only for an entry the register marks quarantined:
 *   test('name', quarantine('some-id'), () => { ... });
 * With GRIDIRON_QUARANTINE off (the default, and CI) this returns {} and the test runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'flaky-register.json');
export const STATUSES = ['suspected', 'proven-flaky', 'fixed', 'not-a-flake'];
// Words that describe a symptom, not a cause. CLAUDE.md: "no API key" is not a cause.
const NOT_A_CAUSE = /^\s*(flak(e|y)\b|.*\bno api key\b|.*\bmissing \w*api_key\b)/i;

export function loadRegister(file = REGISTER) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Every rule the register breaks, as readable strings; [] when it is clean. */
export function validateRegister(reg, { root }) {
  const errs = [];
  const seen = new Set();
  for (const e of reg.entries ?? []) {
    const at = e.id || '(no id)';
    if (!e.id) errs.push('an entry has no id');
    else if (seen.has(e.id)) errs.push(`duplicate id ${e.id}`);
    seen.add(e.id);
    if (!STATUSES.includes(e.status)) errs.push(`${at}: status ${e.status} is not one of ${STATUSES.join(', ')}`);
    if (!e.owner?.trim()) errs.push(`${at}: no owner`);
    if (!e.file || !fs.existsSync(path.join(root, e.file))) errs.push(`${at}: ${e.file} does not exist`);
    if (e.cause && NOT_A_CAUSE.test(e.cause)) errs.push(`${at}: "${e.cause}" is not a cause; name what actually fails`);
    if (e.quarantined) {
      if (e.status !== 'proven-flaky') errs.push(`${at}: quarantined but status is ${e.status}; only a proven flake can be`);
      if (!e.cause?.trim()) errs.push(`${at}: quarantine needs a cause`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e.review_by ?? '')) errs.push(`${at}: quarantine needs a review_by date (YYYY-MM-DD)`);
    }
  }
  return errs;
}

/** Test options for a registered test: a skip only when quarantined AND the flag is on. */
export function quarantine(id, { register = loadRegister(), env = process.env } = {}) {
  const e = (register.entries ?? []).find(x => x.id === id);
  if (!e) throw new Error(`quarantine('${id}'): ${id} is not in test/flaky-register.json`);
  if (env.GRIDIRON_QUARANTINE !== '1' || !e.quarantined) return {};
  return { skip: `quarantined (${e.cause}); owner ${e.owner}; review by ${e.review_by}` };
}
