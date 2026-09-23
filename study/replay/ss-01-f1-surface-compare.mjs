/**
 * SS-01-F1 liveness check: for every synced ESPN league, the dead starters each surface
 * reports on the same database and the same instant.
 *   League Hub  trade-engine.js#lineupDiff().flagged_starters
 *   Start/Sit   lineup-brain.js#lineupCall().dead_starters.items
 *   Signals     manager-signals.js#rosterSignals() lineup_dead_starters (ESPN-only count)
 * Prints league ids, positions and reasons only (the repo is public: no names).
 *
 *   SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<copy> node study/replay/ss-01-f1-surface-compare.mjs
 */
const { rows } = await import('../../server/db/index.js');
const { lineupDiff } = await import('../../server/services/trade-engine.js');
const { lineupCall } = await import('../../server/services/lineup-brain.js');
const signals = await import('../../server/services/manager-signals.js');

const now = Date.now();
const leagues = rows(`SELECT id, platform, my_team_id, payload FROM leagues
                      WHERE platform = 'espn' AND payload IS NOT NULL AND my_team_id IS NOT NULL ORDER BY id`);
const key = x => `${x.position}:${x.reason}`;
let hubTotal = 0, sitTotal = 0, disagree = 0;
for (const lg of leagues) {
  const full = rows('SELECT * FROM leagues WHERE id = ?', lg.id)[0];
  const hub = lineupDiff(full, lg.my_team_id, { now });
  const sit = lineupCall(lg.id, { now });
  const hubIds = (hub.flagged_starters ?? []).map(f => f.id).sort();
  const sitIds = (sit.dead_starters?.items ?? []).map(i => i.player.id).sort();
  const sig = typeof signals.rosterSignals === 'function'
    ? signals.rosterSignals(JSON.parse(lg.payload), lg.my_team_id).find(s => s.metric === 'lineup_dead_starters')?.value
    : 'n/a (not exported on this tree)';
  const same = JSON.stringify(hubIds) === JSON.stringify(sitIds);
  if (!same) disagree++;
  hubTotal += hubIds.length; sitTotal += sitIds.length;
  console.log(JSON.stringify({
    league: lg.id, week: sit.week,
    hub: hub.error ? `error: ${hub.error}` : (hub.flagged_starters ?? []).map(f => `${f.position}:${f.dead_reason ?? f.reason}`),
    startsit: sit.error ? `error: ${sit.error}` : (sit.dead_starters?.items ?? []).map(i => key({ position: i.player.position, reason: i.reason })),
    signals_count: sig, same_players: same
  }));
}
console.log(JSON.stringify({ leagues: leagues.length, hub_total: hubTotal, startsit_total: sitTotal, leagues_disagreeing: disagree }));
