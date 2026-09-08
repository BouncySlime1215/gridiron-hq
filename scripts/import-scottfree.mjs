#!/usr/bin/env node
/**
 * Import a Scottfree Sports historical odds/features CSV (see
 * server/migrations/022_scottfree_game_features.js for the full provenance
 * note — this is reconstructed vendor research data, not a captured pregame
 * feed, and every row mixes this game's own outcome with pre-row features).
 *
 * Currently NFL-only (nfl_scottfree_game_features); the same package ships a
 * CSV per sport (MLB/NBA/NHL/NCAAF/NCAAB) with an identical column shape —
 * extend OUTCOME_COLUMNS/table name if another sport is wired in later.
 *
 * Usage:
 *   node scripts/import-scottfree.mjs --csv /path/to/nfl_game_scores_*.csv
 *
 * Idempotent: source_game_key is (date, time_est, away_team, home_team) per
 * the vendor's own docs, PRIMARY KEY, INSERT OR REPLACE — re-running the same
 * or an updated CSV never duplicates a row.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { run } from '../server/db/index.js';
import { teamResolver } from '../server/services/team-codes.js';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const [k, v] = a.slice(2).split('=');
  args[k] = v ?? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true);
}
if (!args.csv) { console.error('usage: node scripts/import-scottfree.mjs --csv /path/to/file.csv'); process.exit(2); }

const csvPath = path.resolve(args.csv);
const raw = fs.readFileSync(csvPath, 'utf8');
const csvSha256 = crypto.createHash('sha256').update(raw).digest('hex');

// This game's own result. Kept in features_json for completeness (a training
// harness needs the label somewhere), but never promoted to a top-level
// pregame-feature column, and callers must exclude these explicitly — see the
// migration's provenance note.
const OUTCOME_COLUMNS = new Set(['total_points', 'point_margin_game', 'won_on_points', 'lost_on_points',
  'cover_margin_game', 'won_on_spread', 'lost_on_spread', 'overunder_margin', 'over', 'under',
  'home_score', 'away_score', 'home_total_points', 'away_total_points']);

const TOP_LEVEL = ['season', 'date', 'time_est', 'away_team', 'home_team',
  'away_score', 'home_score', 'away_point_spread', 'away_point_spread_line', 'away_money_line',
  'home_point_spread', 'home_point_spread_line', 'home_money_line',
  'over_under', 'over_line', 'under_line',
  'open_home_money_line', 'open_away_money_line', 'open_home_point_spread', 'open_away_point_spread',
  'open_over_under', 'total_points', 'point_margin_game', 'won_on_points', 'lost_on_points',
  'cover_margin_game', 'won_on_spread', 'lost_on_spread', 'overunder_margin', 'over', 'under'];

/** Minimal RFC 4180 CSV parser — no embedded newlines/commas-in-quotes in this vendor's format, but quoting is still honored. */
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.length);
  const header = splitLine(lines[0]);
  return lines.slice(1).map(line => {
    const cells = splitLine(line);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}
function splitLine(line) {
  const out = []; let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const numOrNull = v => v === '' || v == null ? null : Number(v);
const intOrNull = v => v === '' || v == null ? null : Math.trunc(Number(v));

const rows = parseCsv(raw);
const insert = `INSERT OR REPLACE INTO nfl_scottfree_game_features
  (source_game_key, event_key, season, date, time_est, away_team_raw, home_team_raw,
   away_team_abbr, home_team_abbr, away_score, home_score,
   away_point_spread, away_point_spread_line, away_money_line,
   home_point_spread, home_point_spread_line, home_money_line,
   over_under, over_line, under_line,
   open_home_money_line, open_away_money_line, open_home_point_spread, open_away_point_spread, open_over_under,
   total_points, point_margin_game, won_on_points, lost_on_points,
   cover_margin_game, won_on_spread, lost_on_spread, overunder_margin, over, under,
   features_json, source_release, csv_sha256, ingested_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

const resolve = teamResolver();
const ingestedAt = new Date().toISOString();
let imported = 0, unresolvedTeams = 0;

for (const r of rows) {
  const sourceGameKey = `${r.date}|${r.time_est}|${r.away_team}|${r.home_team}`;
  const away = resolve(r.away_team.replace(/_/g, ' '));
  const home = resolve(r.home_team.replace(/_/g, ' '));
  if (!away || !home) unresolvedTeams++;
  // Eastern-date event key, matching nfl-contract-key.js's own convention, so
  // this can eventually be joined against the quote tape's contract keys —
  // not attempted here, since this vendor's kickoff time is Eastern clock
  // time on the game date, not a UTC instant, and reconciling that safely is
  // a separate task, not assumed correct by this importer.
  const eventKey = away && home ? `nfl|${r.date}|${away.abbr}@${home.abbr}` : null;

  const featureRow = {};
  for (const [k, v] of Object.entries(r)) {
    if (TOP_LEVEL.includes(k)) continue;
    featureRow[k] = v === '' ? null : (isFinite(Number(v)) && v.trim() !== '' ? Number(v) : v);
  }

  run(insert,
    sourceGameKey, eventKey, r.season, r.date, r.time_est, r.away_team, r.home_team,
    away?.abbr ?? null, home?.abbr ?? null,
    intOrNull(r.away_score), intOrNull(r.home_score),
    numOrNull(r.away_point_spread), intOrNull(r.away_point_spread_line), intOrNull(r.away_money_line),
    numOrNull(r.home_point_spread), intOrNull(r.home_point_spread_line), intOrNull(r.home_money_line),
    numOrNull(r.over_under), intOrNull(r.over_line), intOrNull(r.under_line),
    intOrNull(r.open_home_money_line), intOrNull(r.open_away_money_line),
    numOrNull(r.open_home_point_spread), numOrNull(r.open_away_point_spread), numOrNull(r.open_over_under),
    intOrNull(r.total_points), intOrNull(r.point_margin_game), intOrNull(r.won_on_points), intOrNull(r.lost_on_points),
    numOrNull(r.cover_margin_game), intOrNull(r.won_on_spread), intOrNull(r.lost_on_spread),
    numOrNull(r.overunder_margin), intOrNull(r.over), intOrNull(r.under),
    JSON.stringify(featureRow), path.basename(csvPath), csvSha256, ingestedAt);
  imported++;
}

console.log(`Imported ${imported} rows from ${path.basename(csvPath)} (csv_sha256 ${csvSha256.slice(0, 12)}…).`);
if (unresolvedTeams) console.log(`${unresolvedTeams} rows had a team name that did not resolve — kept, event_key left null.`);
console.log('Reminder: home_score/away_score/point_margin_game/won_on_points/won_on_spread/'
  + 'over/under/total_points/cover_margin_game/overunder_margin/*_total_points are this game\'s '
  + 'own outcome. Never feed them into a pregame model as inputs — see the migration\'s provenance note.');
