#!/usr/bin/env node
/**
 * R&D analysis for RL-10-2: from espn-projection-poller.mjs's JSONL, measure when
 * ESPN's stored feed "flips" a rostered player (projection drops below 1, or an
 * out status under either definition below) relative to that player's kickoff
 * minus 90 minutes. Flip times are payload fetch times (source_fetched_at), so
 * each flip is bracketed by [last_unflipped_ts, flip_ts] at sync resolution.
 *
 * Pre-registered metric: docs/tdd/2026-09-23-espn-flip-timing-poller.tdd.md
 * ("Pre-registration"). This script only measures; it does not decide ship/kill —
 * that verdict is written by hand into the evidence file per the pre-registered rule.
 *
 * lag_minutes = minutes(first flip timestamp) - minutes(kickoff - 90m)
 *   lag <= 0  -> flipped at or before kickoff-90m (the SS-01 hook's target window)
 *   lag  > 0  -> flipped after kickoff-90m (too late for that window)
 *   flipped:false -> never flipped in the observed window
 *
 * Usage:
 *   node scripts/rnd/espn-flip-timing-analysis.mjs <jsonl-file> --kickoffs <kickoffs.json>
 *
 * kickoffs.json: { "<espn player_id>": "<kickoff ISO-8601 instant>", ... }
 * (for a real run, kickoffs come from `game_lines.gameday`/`gametime` for the
 * player's `pro_team_id` — season/week join documented, not yet automated here;
 * building that join is out of scope for this dry-run/fixture-proving unit).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESPN_AVAILABLE } from '../../server/services/espn-status.js';

/**
 * Two definitions of "ESPN says he is out", reported side by side because the app's
 * producers disagree on DOUBTFUL:
 *  - canonical (PRIMARY, pre-registered 2026-09-23 amendment): a status outside
 *    player-availability.js's ESPN_AVAILABLE (server/services/espn-status.js) — DOUBTFUL
 *    is "available". SS-01 must use this one (one availability producer).
 *  - r10 (SECONDARY): {OUT, DOUBTFUL, INJURY_RESERVE}, the r10 doc's set and
 *    manager-signals.js:312's dead-starter set.
 * Both also flip on a sub-1 projection.
 */
const R10_STATUSES = new Set(['OUT', 'DOUBTFUL', 'INJURY_RESERVE']);
export const DEFINITIONS = ['canonical', 'r10'];

export function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text.split('\n').filter(l => l.trim().length).map(l => JSON.parse(l));
}

/** True once ESPN's stored feed reads as an in-progress or confirmed scratch. */
export function isFlipped(row, definition = 'canonical') {
  if (Number.isFinite(row.projected_points) && row.projected_points < 1) return true;
  const st = row.injury_status;
  if (definition === 'r10') return R10_STATUSES.has(st);
  if (definition === 'canonical') return st != null && !ESPN_AVAILABLE.has(st);
  throw new Error(`unknown flip definition: ${definition}`);
}

/** When ESPN's feed said this: the payload fetch time when recorded, else the poll time. */
const observedAt = r => r.source_fetched_at ?? r.ts;

/**
 * For each player_id present in `jsonlRows` and in `kickoffs`, find the first row
 * (by `ts`, ascending) where `isFlipped` is true, and its lag in minutes against
 * kickoff - 90m. Players with no kickoff entry are skipped (not "never flipped");
 * that keeps an incomplete kickoff map from being silently read as a KILL result.
 */
export function flipLags(jsonlRows, kickoffs, { definition = 'canonical' } = {}) {
  const byPlayer = new Map();
  for (const r of jsonlRows) {
    const list = byPlayer.get(r.player_id) ?? [];
    list.push(r);
    byPlayer.set(r.player_id, list);
  }
  const out = [];
  for (const [playerId, list] of byPlayer) {
    const kickoffIso = kickoffs[playerId] ?? kickoffs[String(playerId)];
    if (!kickoffIso) continue;
    const kickoffMs = Date.parse(kickoffIso);
    if (!Number.isFinite(kickoffMs)) continue;
    const sorted = [...list].sort((a, b) => observedAt(a).localeCompare(observedAt(b)));
    const idx = sorted.findIndex(r => isFlipped(r, definition));
    const flip = idx === -1 ? null : sorted[idx];
    const before = idx === -1 ? sorted : sorted.slice(0, idx);
    const lastUnflipped = before.length ? before[before.length - 1] : null;
    const t90 = kickoffMs - 90 * 60 * 1000;
    const lag = t => Math.round((Date.parse(t) - t90) / 60000);
    out.push({
      player_id: playerId,
      rows_seen: sorted.length,
      flipped: Boolean(flip),
      // Upper bound: the first fetch that showed the flip (the flip happened at or before it).
      flip_ts: flip ? observedAt(flip) : null,
      lag_minutes: flip ? lag(observedAt(flip)) : null,
      // Lower bound: the last fetch before it that did not show the flip.
      last_unflipped_ts: lastUnflipped ? observedAt(lastUnflipped) : null,
      lag_lower_minutes: flip && lastUnflipped ? lag(observedAt(lastUnflipped)) : null,
    });
  }
  return out.sort((a, b) => String(a.player_id).localeCompare(String(b.player_id)));
}

export function summarize(results) {
  const withKickoff = results.length;
  const flipped = results.filter(r => r.flipped);
  const flippedByT90 = flipped.filter(r => r.lag_minutes <= 0).length;
  return {
    players_with_kickoff: withKickoff,
    players_flipped: flipped.length,
    flipped_at_or_before_t90: flippedByT90,
    // CONFIRM/KILL is read against the pre-registered rule in the evidence file, by hand.
  };
}

export function main(argv = process.argv.slice(2)) {
  const file = argv.find(a => !a.startsWith('--'));
  const kIdx = argv.indexOf('--kickoffs');
  if (!file || kIdx === -1) {
    console.error('usage: espn-flip-timing-analysis.mjs <jsonl-file> --kickoffs <kickoffs.json>');
    return 1;
  }
  const jsonlRows = readJsonl(file);
  const kickoffs = JSON.parse(fs.readFileSync(argv[kIdx + 1], 'utf8'));
  const report = {};
  for (const definition of DEFINITIONS) {
    const results = flipLags(jsonlRows, kickoffs, { definition });
    report[definition] = { results, summary: summarize(results) };
  }
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (invokedDirectly) process.exit(main());
