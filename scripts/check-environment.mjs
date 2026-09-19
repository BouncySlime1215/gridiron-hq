#!/usr/bin/env node
/**
 * Preflight for a machine that is not Nick's laptop.
 *
 * The repository is the whole build; the data it runs on is not in it. Four
 * things live only on the Mac (`.gitignore` says so in as many words): the app
 * database with the ESPN cookies in it, the private league-chat corpus, the two
 * research archives, and `.env`. A cloud box starts with none of them, and the
 * failure mode that wastes an afternoon is the quiet one — the engine comes up,
 * answers every question, and prices trades with the counterparty read silently
 * switched off.
 *
 * So this names what is missing, what each missing thing costs, and how to get
 * it, and it exits non-zero when something the engine genuinely cannot run
 * without is absent. It reads nothing sensitive: keys are reported present or
 * absent, never printed.
 *
 * Usage:  node scripts/check-environment.mjs [--json]
 *
 * See docs/CLOUD-MIGRATION.md for the move itself.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_OUT = process.argv.includes('--json');

const c = {
  g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`,
  y: s => `\x1b[33m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`,
};

const mb = bytes => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;

/**
 * `blocking` means the engine cannot do its job without it and this script
 * exits 1. `degrades` means it runs and something specific stops working —
 * named here rather than left for someone to discover from a wrong number.
 */
const FILES = [
  { path: 'server/data.sqlite', level: 'blocking',
    what: 'the app database: leagues, rosters, projections, manager profiles, ESPN cookies',
    without: 'nothing to serve — every league surface is empty',
    fix: 'on the Mac: connect ESPN in Settings (bookmarklet), then node scripts/bootstrap-data.mjs. '
      + 'A Claude cloud session has no browser-reachable URL, so the bookmarklet cannot reach it '
      + 'there — expected in a build-only box, see docs/CLOUD-MIGRATION.md' },
  { path: 'data/derived/league_chat.sqlite', level: 'degrades',
    what: 'the private iMessage league corpus (sentiment, negotiation profiles, bluff reads)',
    without: 'the Trade Brain loses its whole counterparty half — every ladder falls back to '
      + '"priced on our numbers only", no sell-the-crush, no buy-the-sour, no timing read',
    fix: 'on the Mac: pull it with the League chat button in Settings. To move it here, get the '
      + 'file into this box and run: node scripts/import-league-chat.mjs <path>' },
  { path: 'data/line-history/nflverse.sqlite', level: 'degrades',
    what: 'the nflverse research archive (roster status 2016-2026, injuries, play-by-play, QBR)',
    without: 'the injury-return model (WO / O2) and the historical studies have no history to fit on; '
      + 'the weekly engine is unaffected',
    fix: 'rebuild from the public feeds rather than copying 2.1 GB — see docs/CLOUD-MIGRATION.md' },
  { path: 'data/line-history/line_history.sqlite', level: 'degrades',
    what: 'the 21 GB betting line archive',
    without: 'the betting-side research cannot run; the fantasy engine never reads it',
    fix: 'leave it on the Mac — it is betting-side only and too large for a session box' },
];

/**
 * A key is `blocking` only when its absence stops the fantasy engine itself.
 * Everything that merely turns an optional feed off is `degrades`, and says
 * which feed, because "leave unset and this integration no-ops" (.env.example)
 * is only safe when somebody knows it happened.
 */
const KEYS = [
  { name: 'GRIDIRON_ANTHROPIC_API_KEY', aliases: ['ANTHROPIC_API_KEY'], level: 'blocking',
    what: 'the Coach, the AI proposal pass, and the chat classifier',
    without: 'every LLM path fails on the call, as a connection error rather than a clear refusal',
    note: 'in a Claude Code cloud box use GRIDIRON_ANTHROPIC_API_KEY — the platform refuses to pass a '
      + 'variable named ANTHROPIC_API_KEY through to the process. ANTHROPIC_API_KEY still works '
      + 'everywhere else, and app_settings is read as a last resort, so pasting it in Settings also works' },
  { name: 'ODDS_API_KEY', level: 'degrades', what: 'The Odds API', without: 'odds fall back to model-only output' },
  { name: 'PARLAY_API_KEY', level: 'degrades', what: 'ParlayAPI, the second odds feed', without: 'that feed no-ops' },
  { name: 'CFBD_API_KEY', level: 'degrades', what: 'CollegeFootballData rookie signals', without: 'that signal no-ops' },
  { name: 'PFF_API_TOKEN', level: 'degrades', what: 'PFF grades', without: 'PFF-derived features are unavailable' },
  { name: 'SPORTSGAMEODDS_API_KEY', level: 'degrades', what: 'the SportsGameOdds feed', without: 'that feed no-ops' },
  { name: 'TWITTERAPI_IO_KEY', level: 'degrades', what: 'the news/beat-reporter feed', without: 'news signals thin out' },
];

const fileRow = f => {
  const abs = path.join(ROOT, f.path);
  const present = existsSync(abs);
  return { ...f, present, size: present ? statSync(abs).size : 0 };
};
// A key may be accepted under more than one variable name (see the note on
// GRIDIRON_ANTHROPIC_API_KEY), so presence is "any of them is set", and the
// row reports which name actually carried it rather than just "set".
const keyRow = k => {
  const names = [k.name, ...(k.aliases ?? [])];
  const found = names.find(name => !!process.env[name]) ?? null;
  return { ...k, present: !!found, found_as: found };
};

const files = FILES.map(fileRow);
const keys = KEYS.map(keyRow);
const missingBlocking = [...files, ...keys].filter(x => !x.present && x.level === 'blocking');
const missingDegrades = [...files, ...keys].filter(x => !x.present && x.level === 'degrades');

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: missingBlocking.length === 0, files, keys }, null, 2));
  process.exit(missingBlocking.length ? 1 : 0);
}

console.log(c.b('\nData files\n'));
for (const f of files) {
  const mark = f.present ? c.g('  present') : f.level === 'blocking' ? c.r('  MISSING') : c.y('  missing');
  console.log(`${mark}  ${f.path}${f.present ? c.dim(`  (${mb(f.size)})`) : ''}`);
  console.log(`           ${c.dim(f.what)}`);
  if (!f.present) {
    console.log(`           ${c.dim('without it: ')}${f.without}`);
    console.log(`           ${c.dim('to get it:  ')}${f.fix}`);
  }
}

console.log(c.b('\nAPI keys') + c.dim('  (presence only — no value is ever printed)\n'));
for (const k of keys) {
  const mark = k.present ? c.g('  set    ') : k.level === 'blocking' ? c.r('  UNSET  ') : c.y('  unset  ');
  const via = k.present && k.found_as !== k.name ? c.dim(`  (as ${k.found_as})`) : '';
  console.log(`${mark}  ${k.name}${via}${c.dim(`  — ${k.what}`)}`);
  if (!k.present) {
    console.log(`           ${c.dim('without it: ')}${k.without}`);
    if (k.note) console.log(`           ${c.dim('note:       ')}${k.note}`);
  }
}

console.log('');
if (missingBlocking.length) {
  console.log(c.r(c.b(`Not ready to SERVE: ${missingBlocking.length} required item(s) missing`)));
  console.log(c.dim('  (A Claude cloud session is a build machine — repo work, tests and builds only'));
  console.log(c.dim('   need the keys. server/data.sqlite missing here is expected, not a fault.)'));
  for (const m of missingBlocking) console.log(c.r(`  - ${m.path ?? m.name}`));
} else {
  console.log(c.g(c.b('Ready — everything the engine requires is here.')));
}
if (missingDegrades.length) {
  console.log(c.y(`\nRunning degraded: ${missingDegrades.map(m => m.path ?? m.name).join(', ')}`));
  console.log(c.dim('Each line above says exactly what stops working. Nothing fails silently.'));
}
console.log(c.dim('\nThe move itself: docs/CLOUD-MIGRATION.md\n'));

process.exit(missingBlocking.length ? 1 : 0);
