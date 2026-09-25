/**
 * RULES-EVERYWHERE fixture: what Nick's rule gate (campaign/never-give.js#ruleGate) reads, for a made-up
 * league, so a test about something else is not emptied by the gate:
 *   - FantasyCalc values (player_metrics source 'fc_value'): Nick's players low, everyone else high, so
 *     every idea passes the value rules (no fc_value fails closed, and Nick may not overpay);
 *   - a served blue-chip board (the War Room plans file's blue_chips) scoring every player 90, so every
 *     get clears the 83+ floor (an unscored get fails closed).
 * The rules themselves are covered by test/rules-everywhere.test.js. Made-up values only.
 *
 * The board goes into the plans file GRIDIRON_WARROOM_PLANS names (merged into it when it exists; a
 * temp file is created and the variable set when it is unset, so a test never reads this machine's
 * real plans). db: the app's DatabaseSync handle (server/db/index.js `db`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blueChipsSection } from '../../server/services/campaign/view.js';

let bump = Date.now() / 1000;
const boards = new Map();

/** Score every id 90 on league `leagueId`'s served board, in the plans file the gate reads. */
export function scoreForRules(leagueId, ids, score = 90) {
  if (!process.env.GRIDIRON_WARROOM_PLANS) {
    process.env.GRIDIRON_WARROOM_PLANS = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rule-gate-plans-')), 'plans.json');
  }
  const file = process.env.GRIDIRON_WARROOM_PLANS;
  const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { schema: 'warroom-plans/1', leagues: [] };
  doc.leagues ??= [];
  let entry = doc.leagues.find(l => String(l.league) === String(leagueId));
  if (!entry) { entry = { league: Number(leagueId) }; doc.leagues.push(entry); }
  // A contract-valid section (plans-schema.js), built by the producer's own view (campaign/view.js#blueChipsSection)
  // so a test that validates the plans file (Coach, the War Room) still reads it.
  if (entry.blue_chips?.status !== 'ok') boards.delete(String(leagueId));
  const board = boards.get(String(leagueId)) ?? new Map();
  for (const id of ids) board.set(String(id), score);
  boards.set(String(leagueId), board);
  entry.blue_chips = blueChipsSection({
    status: 'ok', weights: { pick: 0.5, production: 0.5, basis: 'rule-gate fixture' }, labels: ['Blue chip'],
    rows: [...board].map(([player, sc]) => ({ player, name: `P${player}`, position: 'WR', mine: false, score: sc, label: 'Blue chip',
      hurt: false, parts: { pick_pct: 90, prod_basis: 'season_ppg', prod_pct: 90, games: 2, team_games: 2, missed: 0 },
      model_value: 1000, gaps: [], protected: false })),
    coverage: { rostered: board.size, board: board.size, score: 1, model_value: 1, fp_ros_rank: 0 },
    fp: { status: 'unknown', sync: 'not_run', reason: 'fixture' }, draft: { season: 2026, picks: 0 },
  }, {});
  fs.writeFileSync(file, JSON.stringify(doc));
  // A strictly later mtime every write, so the gate's cached read of the plans file never serves an old board.
  bump = Math.max(bump + 2, Date.now() / 1000);
  fs.utimesSync(file, bump, bump);
}

export function priceForRules(db, { mine = [], theirs = [], mineValue = 1, theirValue = 1000, leagueId = null } = {}) {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    const put = db.prepare(`INSERT INTO player_metrics (player_id, source, value) VALUES (?, 'fc_value', ?)
                            ON CONFLICT(player_id, source) DO UPDATE SET value = excluded.value`);
    for (const id of theirs) put.run(Number(id), theirValue);
    for (const id of mine) put.run(Number(id), mineValue);
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  if (leagueId != null) scoreForRules(leagueId, [...mine, ...theirs]);
}

/**
 * Price a whole ESPN-payload league: the players on the league's own team (my_team_id), matched by
 * name as the fixtures build them, low; every other player in `players` high; every player scored.
 */
export function priceLeagueForRules(db, lg) {
  const payload = typeof lg.payload === 'string' ? JSON.parse(lg.payload) : lg.payload;
  const team = (payload?.teams ?? []).find(t => String(t.id) === String(lg.my_team_id));
  const names = (team?.roster?.entries ?? []).map(e => e?.playerPoolEntry?.player?.fullName).filter(Boolean);
  const byName = db.prepare('SELECT id FROM players WHERE name = ?');
  const mine = names.flatMap(n => byName.all(n).map(r => r.id));
  const theirs = db.prepare('SELECT id FROM players').all().map(r => r.id).filter(id => !mine.includes(id));
  priceForRules(db, { mine, theirs, leagueId: lg.id });
}
