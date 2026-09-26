#!/usr/bin/env node
/**
 * DAILY DIGEST (Batch D item 34): the 9 AM Eastern summary. Logic in
 * server/services/campaign/daily-digest.js; this file does the reading and writing.
 *
 * The refresh loop (scripts/refresh-live-data.mjs, step `daily_digest`) runs it with --apply every
 * tick while GRIDIRON_DAILY_DIGEST=1; it acts once, in the first tick inside the 9 AM ET hour.
 *
 * Files (local, outside the repo, next to the plans file unless the env names another path):
 *   plans file                 input   warroom-flag.js#warRoomPlansPath()
 *   GRIDIRON_DIGEST_STATE      in/out  digest-state.json: { day, at, leagues: { id: snapshot } }
 *   GRIDIRON_WARROOM_PUSHES    output  pushes.jsonl, the existing push path: one { kind: 'daily_digest' } row
 *
 * Usage:
 *   node scripts/campaign/daily-digest.mjs                    # dry run: prints what it would send
 *   node scripts/campaign/daily-digest.mjs --apply            # writes the outbox row and the state
 *   node scripts/campaign/daily-digest.mjs --now 2026-09-27T13:05:00Z   # as of another instant
 * Prints one summary line: `daily_digest: <status> ...`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildDigest, digestFlag, digestRow, DIGEST_FLAG_ENV } from '../../server/services/campaign/daily-digest.js';
import { warRoomPlansPath, WARROOM_PLANS_ENV } from '../../server/services/warroom-flag.js';

const sibling = (env, key, name, plans) => path.resolve(env[key] || path.join(path.dirname(plans), name));

export function digestArgs(argv) {
  const at = argv.indexOf('--now');
  return { apply: argv.includes('--apply'), now: at > -1 ? new Date(argv[at + 1]) : new Date() };
}

/** A JSON file, or null when absent. A file that is present but unreadable throws (never read as empty). */
function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * One digest check. deps: { loadOffers() -> { rows, reason }, gateFor(leagueId) } (the real ones
 * open the app DB; tests pass fakes). -> { status, line, digest }.
 */
export async function runDigest({ argv = [], env = process.env, deps = null, log = console.log } = {}) {
  if (!digestFlag(env)) return { status: 'off', line: `daily_digest: off (${DIGEST_FLAG_ENV} is not 1)` };
  const { apply, now } = digestArgs(argv);
  if (Number.isNaN(now.getTime())) throw new Error('--now is not a date');
  const plansFile = env[WARROOM_PLANS_ENV]?.trim() || warRoomPlansPath();
  const stateFile = sibling(env, 'GRIDIRON_DIGEST_STATE', 'digest-state.json', plansFile);
  const outbox = sibling(env, 'GRIDIRON_WARROOM_PUSHES', 'pushes.jsonl', plansFile);
  const plans = readJson(plansFile);
  if (!plans) return { status: 'no_plans', line: `daily_digest: no_plans (${path.basename(plansFile)} not written yet)` };
  const state = readJson(stateFile);
  const d = deps ?? await realDeps(env, plansFile);
  // Offers are read only when a digest could go out (inside the window, not done today).
  const lazy = { rows: [], reason: null };
  let offers = lazy;
  const probe = buildDigest({ plans, state, offers: lazy, gateFor: () => null, now });
  if (probe.status !== 'closed' && probe.status !== 'done_today') {
    try { offers = d.loadOffers(); } catch (e) { offers = { rows: [], reason: `offers unreadable: ${e.message}` }; }
  }
  const digest = buildDigest({ plans, state, offers, gateFor: d.gateFor, now });
  const mode = apply ? 'applied' : 'dry run';
  if (digest.status === 'send') {
    log(digest.text);
    if (apply) fs.appendFileSync(outbox, JSON.stringify(digestRow(digest, now)) + '\n');
  }
  if (digest.state && apply) {
    const tmp = `${stateFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(digest.state));
    fs.renameSync(tmp, stateFile);
  }
  const notes = [...digest.errors, ...(offers.reason ? [offers.reason] : [])];
  const line = `daily_digest: ${digest.status} (${mode}) lines ${digest.lines.length}`
    + (notes.length ? ` | ${notes.join('; ').slice(0, 240)}` : '');
  return { status: digest.status, line, digest };
}

/** The real dependencies: the app DB, the decided-offers producer and the ONE rule gate. */
async function realDeps(env, plansFile) {
  const [{ db, row, rows }, { loadDecidedOffers }, { ruleGate }] = await Promise.all([
    import('../../server/db/index.js'), import('../../server/services/eval/decided-offers.js'),
    import('../../server/services/campaign/never-give.js'),
  ]);
  return {
    loadOffers: () => {
      const built = loadDecidedOffers(db);
      return { rows: [...built.offers, ...built.orphans], reason: built.reason };
    },
    gateFor: leagueId => ruleGate({ row, rows }, { leagueId, plansPath: plansFile, env }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runDigest({ argv: process.argv.slice(2) })
    .then(r => console.log(r.line))
    .catch(e => { console.error(`daily_digest: ERROR ${e.stack ?? e}`); process.exit(1); });
}
