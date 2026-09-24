/**
 * `league`: each fantasy league's own clock as state (ENGINE-ARCHITECTURE.md §4.2, layer 3).
 *
 *   league.week  (entity league `<id>`) {season, week, basis}: the league's current scoring
 *                period. From the log: the highest scoring period in the league's live
 *                lineup captures of its latest season (the roster collector captures the
 *                period ESPN is on), capped at 18 as leagueCurrentWeek (league-week.js:12)
 *                caps it; basis 'lineups'. Written for every league with a lineup capture
 *                in the last 200 days; a league with none gets no row (its clock is not
 *                on the log), never a guessed week.
 * `league.rules` and `league.deadline` wait for the `league.settings` events (EA-04); this
 * producer does not declare them until something can write them.
 * Cheap: every league, every tick. Nothing serves this field yet.
 */
import { registerProducer } from '../registry.js';

const VERSION = 'ea02-1';
const LOOKBACK_DAYS = 200;
const WRITERS = registerProducer({
  name: 'league',
  active: VERSION,
  versions: { [VERSION]: { params: { basis: 'lineups', cap: 18, lookback_days: LOOKBACK_DAYS } } },
  fields: [
    { field: 'league.week', valueType: 'object', entityTypes: ['league'], maxAgeSec: 3600,
      replaces: ['league-week.js#leagueCurrentWeek'], description: 'A league\'s current scoring period' },
  ],
  inputs: { events: ['league.lineup'], fields: [], scope: 'league', schedule: 'tick', cost: 'cheap', budget_ms: 30000 },
});

function run(ctx) {
  const from = new Date(Date.parse(ctx.tick.as_of) - LOOKBACK_DAYS * 86400000).toISOString();
  const lineups = ctx.read.events({ types: ['league.lineup'], from });
  const byLeague = new Map();
  for (const e of lineups) {
    if (!(e.league_id > 0)) continue;
    const l = byLeague.get(e.league_id) ?? { season: -Infinity, rows: [] };
    l.rows.push(e);
    l.season = Math.max(l.season, Number(e.payload.season));
    byLeague.set(e.league_id, l);
  }
  for (const league of [...byLeague.keys()].sort((a, b) => a - b)) {
    const l = byLeague.get(league);
    const inSeason = l.rows.filter(e => Number(e.payload.season) === l.season);
    const live = inSeason.filter(e => e.payload.snapshot === 'live');
    const pool = live.length ? live : inSeason;
    // The first capture of the highest period, so later captures of the same period cite the
    // same event and write-on-change writes nothing until the period moves.
    const period = e => Number(e.payload.scoring_period_id);
    const top = pool.reduce((a, e) => (period(e) > period(a) || (period(e) === period(a) && e.id < a.id) ? e : a));
    const week = Math.min(18, Number(top.payload.scoring_period_id));
    // TODO(FIX-242-2): do not compute league.week here. Wrap #283's week.js (the one
    // nfl.week / league.week producer every caller reads, BROKEN-D) once it lands.
    ctx.write(WRITERS['league.week'], { entityType: 'league', entityId: String(league), leagueId: league, field: 'league.week',
      value: { season: l.season, week, basis: 'lineups' }, eventIds: [top.id],
      reasonChain: { contributions: [{ source: 'league.lineup', kind: 'event', event_ids: [top.id], delta: null,
        text: `highest ${live.length ? 'live ' : ''}lineup capture: scoring period ${top.payload.scoring_period_id}` }] } });
  }
}

export const leagueProducer = Object.freeze({ name: 'league', run });
