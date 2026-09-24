/**
 * `calendar`: the NFL calendar as state (ENGINE-ARCHITECTURE.md §4.2, layer 3).
 *
 *   nfl.week     (entity week `<season>:<week>`)  per week of the latest season on the log:
 *                {season, week, games, finals, first_kickoff, last_kickoff, status, current}.
 *                status: 'final' when every game is final, 'in_progress' once any is final
 *                or the first kickoff has passed, else 'upcoming'. `current` marks the
 *                earliest week with a game not yet final, the rule tradeWeekContext uses
 *                (trade-engine.js:180: MIN(week) WHERE team_score IS NULL), without its
 *                NFL_WEEK override and without its "week 1" default when nothing is left.
 *   game.cutoff  (entity game `<season>:<week>:<home>`) {kickoff, basis}: the scheduled
 *                kickoff (gameday + gametime, New York time), or the end of the game day
 *                when only the date is known, as game-cutoff.js gameCutoff does. No date:
 *                typed absence 'unknown', never a guess.
 * Reads only `nfl.game` events (adapters/schedule.js). Cheap: runs whole every tick; write-
 * on-change keeps an unchanged schedule from adding rows. Nothing serves these fields yet.
 */
import { registerProducer } from '../registry.js';
import { nflKickoffDate } from '../../date-util.js';

const VERSION = 'ea02-1';
const WRITERS = registerProducer({
  name: 'calendar',
  active: VERSION,
  versions: { [VERSION]: { params: { current: 'min week with a game not final', cutoff: 'gameday+gametime ET' } } },
  fields: [
    { field: 'nfl.week', valueType: 'object', entityTypes: ['week'], maxAgeSec: 3600,
      replaces: ['trade-engine.js#tradeWeekContext'], description: 'One NFL week: games, finals, kickoffs, status, current' },
    { field: 'game.cutoff', valueType: 'object', entityTypes: ['game'], maxAgeSec: 86400,
      replaces: ['game-cutoff.js#gameCutoff'], description: 'A game\'s evidence cutoff: its scheduled kickoff' },
  ],
  inputs: { events: ['nfl.game'], fields: [], scope: 'global', schedule: 'tick', cost: 'cheap', budget_ms: 30000 },
});

/** The latest event per natural key. */
export function latestByKey(events) {
  const out = new Map();
  for (const e of events) if (!out.has(e.natural_key) || out.get(e.natural_key).id < e.id) out.set(e.natural_key, e);
  return [...out.values()];
}

function kickoffOf(p) {
  if (!p.gameday) return null;
  return nflKickoffDate(p.gameday, p.gametime || '23:59').toISOString();
}

function run(ctx) {
  const games = latestByKey(ctx.read.events({ types: ['nfl.game'] }));
  if (!games.length) return;
  const season = Math.max(...games.map(g => g.payload.season));
  const inSeason = games.filter(g => g.payload.season === season);
  const weeks = new Map();
  for (const g of inSeason) {
    const w = g.payload.week;
    if (!weeks.has(w)) weeks.set(w, []);
    weeks.get(w).push(g);
    const kickoff = kickoffOf(g.payload);
    const chain = { contributions: [{ source: 'nfl.game', kind: 'event', event_ids: [g.id], delta: null,
      text: kickoff ? (g.payload.gametime ? 'scheduled kickoff' : 'game day only: end of day ET') : 'no game day on the schedule' }] };
    ctx.write(WRITERS['game.cutoff'], { entityType: 'game', entityId: `${season}:${w}:${g.payload.home}`, field: 'game.cutoff',
      eventIds: [g.id], reasonChain: chain,
      ...(kickoff ? { value: { kickoff, basis: g.payload.gametime ? 'scheduled' : 'end_of_day' } }
        : { absence: { status: 'unknown', reason: 'the schedule has no game day for this game' } }) });
  }
  const open = [...weeks].filter(([, gs]) => gs.some(g => !g.payload.final)).map(([w]) => w);
  const current = open.length ? Math.min(...open) : null;
  for (const [w, gs] of [...weeks].sort((a, b) => a[0] - b[0])) {
    const kicks = gs.map(g => kickoffOf(g.payload)).filter(Boolean).sort();
    const finals = gs.filter(g => g.payload.final).length;
    const started = kicks.length && kicks[0] <= ctx.tick.as_of;
    const status = finals === gs.length ? 'final' : finals > 0 || started ? 'in_progress' : 'upcoming';
    const ids = gs.map(g => g.id).sort((a, b) => a - b);
    ctx.write(WRITERS['nfl.week'], { entityType: 'week', entityId: `${season}:${w}`, field: 'nfl.week', eventIds: ids,
      value: { season, week: w, games: gs.length, finals, first_kickoff: kicks[0] ?? null, last_kickoff: kicks.at(-1) ?? null,
        status, current: w === current },
      reasonChain: { contributions: [{ source: 'nfl.game', kind: 'event', event_ids: ids, delta: null,
        text: `${finals} of ${gs.length} games final${w === current ? '; the earliest week with a game left' : ''}` }] } });
  }
}

export const calendarProducer = Object.freeze({ name: 'calendar', run });
