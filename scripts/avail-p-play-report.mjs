#!/usr/bin/env node
/**
 * BROKEN-E: how many players this week are served a chance to play the engine
 * never measured, and what the fitted prior for them is. Read-only.
 *
 *   node scripts/avail-p-play-report.mjs [season] [week]
 *   node scripts/avail-p-play-report.mjs --league 4 [season] [week]
 *
 * Defaults to trade-engine.js#tradeWeekContext (the week the trade engine prices).
 * With --league (FIX-285-3), also: that league's rostered players this week, how many
 * are unknown, and which prior source each unknown one is priced from (player and team
 * ids only).
 */
import { availPPlayWeek } from '../server/services/avail-p-play.js';
import { tradeWeekContext, assetUniverse, loadRosters } from '../server/services/trade-engine.js';
import { deriveFormat } from '../server/services/format.js';
import { row as dbRow } from '../server/db/index.js';

const args = process.argv.slice(2);
const leagueAt = args.indexOf('--league');
const leagueId = leagueAt >= 0 ? Number(args[leagueAt + 1]) : null;
if (leagueAt >= 0) args.splice(leagueAt, 2);
if (leagueAt >= 0 && !Number.isInteger(leagueId)) {
  console.error('avail-p-play-report: --league needs a league id');
  process.exit(1);
}
const ctx = tradeWeekContext();
const season = Number(args[0]) || ctx.season;
const week = Number(args[1]) || ctx.week;
const w = availPPlayWeek(season, week);

const byReason = {};
const byPos = {};
let old092 = 0;
for (const [id, row] of w.rows) {
  const out = w.of(id, row.position);
  const key = out.status === 'ok' ? 'ok' : out.reason;
  byReason[key] = (byReason[key] ?? 0) + 1;
  if (out.status === 'unknown') {
    byPos[row.position] ??= out.prior;
    if (row.active_probability === 0.92) old092++;
  }
}
let league = null;
if (leagueId != null) {
  const lg = dbRow('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!lg?.payload) {
    league = { league_id: leagueId, error: 'league not found or not synced' };
  } else {
    const teams = loadRosters(lg, assetUniverse(lg, deriveFormat(lg).formatKey, { season, week }));
    const rostered = teams.flatMap(t => t.players.map(p => ({ team_id: t.roster_id, p })));
    const unknown = [];
    const byPriorSource = {};
    const byUnknownReason = {};
    for (const { team_id, p } of rostered) {
      const out = w.of(p.id, p.position);
      if (out.status !== 'unknown') continue;
      byUnknownReason[out.reason] = (byUnknownReason[out.reason] ?? 0) + 1;
      byPriorSource[out.prior.source] = (byPriorSource[out.prior.source] ?? 0) + 1;
      unknown.push({ team_id, player_id: p.id, position: p.position, reason: out.reason,
        prior_value: out.prior.value, prior_fitted: out.prior.fitted, prior_n: out.prior.n });
    }
    league = { league_id: leagueId, teams: teams.length, rostered: rostered.length, unknown: unknown.length,
      unknown_by_reason: byUnknownReason, unknown_by_prior_source: byPriorSource, unknown_players: unknown };
  }
}
console.log(JSON.stringify({
  season, week, rows: w.rows.size, by_status: byReason,
  unknown_served_092_on_old_path: old092,
  prior_by_position: byPos,
  kicker_prior: w.of(-1, 'K').prior,
  ...(league ? { league } : {})
}, null, 2));
