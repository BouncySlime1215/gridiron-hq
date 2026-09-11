#!/usr/bin/env node
/**
 * Import one alternate-spread capture run produced by `live_odds.py --json`.
 *
 * The scraper renders a table and exits; nothing it reads has ever been stored.
 * This is the other end of that pipe. See
 * `server/services/alt-spread-import.js` for the JSON contract, the per-book
 * response shapes it was derived from, and — importantly — an honest account of
 * how far an alternate-spread price actually substitutes for a real teaser
 * price.
 *
 * THESE ARE NOT TEASER PRICES. They land in `nfl_alt_spread_quotes`. Nothing
 * here touches `nfl_teaser_price_ledger`, and migration 035 makes an attempt to
 * file an alt-derived number there abort at the database.
 *
 * Usage:
 *   node scripts/import-alt-spreads.mjs --file capture.json
 *   live_odds.py --once --json /dev/stdout | node scripts/import-alt-spreads.mjs
 *
 * Options:
 *   --file PATH      the capture to import; omit to read stdin
 *   --allow-partial  import the sound games and list the malformed ones instead
 *                    of refusing the whole capture (default: refuse)
 *   --dry-run        validate and report, write nothing
 *   --note TEXT      free text recorded on the capture row
 *   --json           machine-readable result on stdout
 *
 * Exit codes: 0 imported (or already imported), 1 rejected, 2 bad invocation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runMigrations } from '../server/db/migrate.js';
import {
  importAltSpreadCapture, validateAltSpreadCapture, altParlayEquivalent,
  AltSpreadCaptureError, ALT_SPREAD_CAPTURE_SCHEMA
} from '../server/services/alt-spread-import.js';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const [k, v] = a.slice(2).split('=');
  const next = process.argv[i + 1];
  args[k] = v ?? (next && !next.startsWith('--') ? process.argv[++i] : true);
}

const USAGE = `
Import one alternate-spread capture run (live_odds.py --json).

  node scripts/import-alt-spreads.mjs --file capture.json
  live_odds.py --once --json /dev/stdout | node scripts/import-alt-spreads.mjs

  --file PATH      the capture to import; omit to read stdin
  --allow-partial  import the sound games and list the malformed ones
                   instead of refusing the whole capture (default: refuse)
  --dry-run        validate and report, write nothing
  --note TEXT      free text recorded on the capture row
  --json           machine-readable result on stdout

Alternate-spread quotes are NOT teaser prices; they land in
nfl_alt_spread_quotes. nfl_teaser_price_ledger is never written.
`.trim();

if (args.help) { console.log(USAGE); process.exit(0); }

async function readStdin() {
  if (process.stdin.isTTY) { console.error(USAGE); process.exit(2); }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const raw = args.file
  ? fs.readFileSync(path.resolve(String(args.file)), 'utf8')
  : await readStdin();

let payload;
try {
  payload = JSON.parse(raw);
} catch (error) {
  console.error(`Not JSON: ${error.message}`);
  console.error(`Expected a "${ALT_SPREAD_CAPTURE_SCHEMA}" capture — see ALT_SPREAD_CAPTURE_CONTRACT in ` +
    'server/services/alt-spread-import.js for the shape and for the exact snippet to add to live_odds.py.');
  process.exit(1);
}

// The importer needs migration 035's tables. Running migrations here (rather
// than assuming the server has been started once) is what makes this usable as
// a standalone tool.
await runMigrations();

const emitJson = Boolean(args.json);
const fmt = n => (n > 0 ? `+${n}` : String(n));
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

function reportRejection(error) {
  if (emitJson) {
    console.log(JSON.stringify({ ok: false, error: error.message, errors: error.errors ?? [] }, null, 2));
  } else {
    console.error(`\nREJECTED — ${error.message}\n`);
    for (const reason of error.errors ?? []) console.error(`  · ${reason}`);
    console.error('');
  }
  process.exit(1);
}

if (args['dry-run']) {
  let normalised;
  try {
    normalised = validateAltSpreadCapture(payload);
  } catch (error) {
    if (error instanceof AltSpreadCaptureError) reportRejection(error);
    throw error;
  }
  if (emitJson) { console.log(JSON.stringify({ ok: true, dry_run: true, ...normalised }, null, 2)); process.exit(0); }
  console.log(`\nDRY RUN — nothing written.  captured_at ${normalised.captured_at}  source ${normalised.source}`);
  for (const block of normalised.books) {
    console.log(`\n  ${block.book}: ${block.games.length} game(s) with alt legs, ` +
      `${block.without_alt.length} without`);
    for (const game of block.games) {
      const teaserLegs = game.legs.filter(l => l.equivalence.same_leg_a_teaser_produces);
      console.log(`    ${game.event_key}  main ${game.away} ${fmt(game.main.away.line)} ` +
        `(${fmt(game.main.away.price)})  teaser-equivalent legs: ${teaserLegs.length}` +
        `${game.schedule_source === 'book_reported' ? '  [no scheduled game matched on the team pair]' : ''}`);
      for (const leg of game.legs) {
        const e = leg.equivalence;
        console.log(`      ${leg.key.padEnd(12)} ${String(fmt(leg.line)).padStart(6)} @ ${String(fmt(leg.price)).padStart(6)}` +
          `   moved ${fmt(e.observed_move)}` +
          `${e.move_is_exactly_six ? '' : '  <- NOT a six-point move'}` +
          `${e.same_leg_a_teaser_produces ? '  <- same leg the teaser produces' : ''}`);
      }
    }
  }
  if (normalised.errors.length) {
    console.log(`\n  ${normalised.errors.length} problem(s) — this capture would be REFUSED without --allow-partial:`);
    for (const reason of normalised.errors) console.log(`    · ${reason}`);
  }
  console.log('');
  process.exit(0);
}

let result;
try {
  result = importAltSpreadCapture(payload, {
    allowPartial: Boolean(args['allow-partial']),
    note: typeof args.note === 'string' ? args.note : null
  });
} catch (error) {
  if (error instanceof AltSpreadCaptureError) reportRejection(error);
  throw error;
}

if (emitJson) {
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  process.exit(0);
}

console.log(`\nIMPORTED  captured_at ${result.captured_at}  imported_at ${result.imported_at}`);
console.log(`          source ${result.source}  provenance ${result.provenance}  (${result.importer_version})`);

for (const capture of result.captures) {
  if (capture.already_imported) {
    console.log(`\n  ${capture.book}: already imported — capture ${capture.capture_id} is byte-identical, ` +
      'nothing written (these tables are append-only)');
    continue;
  }
  console.log(`\n  ${capture.book}: ${capture.quotes} quote(s) across ${capture.games} game(s)  ` +
    `[capture ${capture.capture_id}]`);
  console.log(`      teaser-equivalent legs (main line in the eight, moved exactly six): ${capture.teaser_equivalent_legs}`);
  if (capture.games_without_alt) {
    console.log(`      ${capture.games_without_alt} game(s) carried no alt pair at all — the scraper's ` +
      'event-page fetch returns nothing on failure, so this is normal and is counted, not hidden');
  }
  for (const off of capture.off_six_point_legs ?? []) {
    console.log(`      NOT SIX POINTS: ${off.leg} main ${fmt(off.main_line)} -> alt ${fmt(off.alt_line)} ` +
      `is a ${fmt(off.observed_move)}-point move; find_pair() substituted a neighbouring line. ` +
      'This is a different bet from a six-point teaser leg.');
  }
  for (const unscheduled of capture.unscheduled_games ?? []) {
    console.log(`      NO SCHEDULE MATCH: ${unscheduled.event_key} (${unscheduled.reason}) — keyed off the ` +
      "book's own kickoff, so it may not join game_lines");
  }
}

if (result.rejected.length) {
  console.log(`\n  ${result.rejected.length} game(s) rejected and NOT imported:`);
  for (const reason of result.rejected) console.log(`    · ${reason}`);
}

// The whole point of the capture, shown rather than left to a follow-up query.
const bestLegs = [];
for (const capture of result.captures) {
  if (capture.already_imported || !capture.teaser_equivalent_legs) continue;
  bestLegs.push(capture.book);
}
if (bestLegs.length) {
  const example = altParlayEquivalent({ legAPrice: -250, legBPrice: -250 });
  console.log(`\n  Next: compare a parlay of two teaser-equivalent alt legs against the recorded teaser price.`);
  console.log(`  For scale, two legs at -250 parlay to ${round(example.american, 2)} American ` +
    `(profit multiple ${round(example.profit_multiple, 4)}, i.e. ${round(example.profit_per_100, 2)} per 100 staked),`);
  console.log('  which sits beside a +100 teaser (multiple 1.0000). See altTeaserEquivalentBoard() for the real pairs.');
}

console.log('\n  These are alternate-spread quotes, not teaser prices. nfl_teaser_price_ledger is untouched.\n');
