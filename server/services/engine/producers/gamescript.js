/**
 * `gamescript`: game-script multipliers per game as state (ENGINE-ARCHITECTURE.md §4.2, layer 3).
 *
 *   game.script  (entity game `<season>:<week>:<home>`) {home, away, avg_total, fit}: per side
 *                {team, spread, total, pass_mult, rush_mult}, for every game of the current
 *                NFL week and later weeks of its season that has a line.
 *
 * The arithmetic is gameScriptFor's (gamescript.js:389): predicted attempts at the team's
 * spread and total over attempts at a neutral line (spread 0, the average total of every
 * line before that week, as modelAt computes it), clamped to [0.75, 1.3], 3 decimals.
 * The coefficients come from the fit store `gamescript_model` (ctx.fit, resolved by the
 * daemon at the start of each run and named in the reason chain by its fitted_at); modelAt
 * refits per week from raw stats, which a producer does not do, so values can differ from
 * gameScriptFor's for past weeks. No fit: typed absence 'not_measured'. A side without a
 * usable line (no spread or total): that side is null and the reason says so.
 *
 * Reads `market.game_line` events and the calendar's `nfl.week`. Cheap: every game every tick.
 * Nothing serves this field yet; season-sim.js still calls gameScriptFor.
 */
import { registerProducer } from '../registry.js';
import { latestByKey } from './calendar.js';

const VERSION = 'ea02-1';
const CLAMP = [0.75, 1.3];
const WRITERS = registerProducer({
  name: 'gamescript',
  active: VERSION,
  versions: { [VERSION]: { params: { clamp: CLAMP, neutral_spread: 0, neutral_total: 'mean of prior lines', decimals: 3 } } },
  fields: [
    { field: 'game.script', valueType: 'object', entityTypes: ['game'], maxAgeSec: 3600,
      replaces: ['gamescript.js#gameScriptFor'], description: 'Pass/rush volume multipliers per side of a game, from its line' },
  ],
  inputs: { events: ['market.game_line'], fields: ['nfl.week'], scope: 'global', schedule: 'tick', cost: 'cheap', budget_ms: 30000 },
});

/** The fit store: coefficients per target, and the fit's identity (latest fitted_at). */
function resolveFit(database) {
  const has = database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gamescript_model'`).get();
  if (!has) return null;
  const rows = database.prepare('SELECT target, b0, b_spread, b_total, fitted_at FROM gamescript_model').all();
  if (!rows.length) return null;
  return { coef: Object.fromEntries(rows.map(r => [r.target, { b0: r.b0, b_spread: r.b_spread, b_total: r.b_total }])),
    fitted_at: rows.map(r => r.fitted_at).filter(Boolean).sort().at(-1) ?? null };
}

const clamp = v => (v == null || !Number.isFinite(v) ? 1 : Math.max(CLAMP[0], Math.min(CLAMP[1], v)));

/** One side's multipliers, as gameScriptFor computes them. Exported for the parity test. */
export function sideMultipliers(coef, { spread, total }, avgTotal) {
  const predict = t => {
    const f = coef[t];
    if (!f) return null;
    const actual = f.b0 + f.b_spread * spread + f.b_total * total;
    const neutral = f.b0 + f.b_spread * 0 + f.b_total * avgTotal;
    return neutral > 0 ? actual / neutral : 1;
  };
  return { pass_mult: +clamp(predict('pass_att')).toFixed(3), rush_mult: +clamp(predict('rush_att')).toFixed(3) };
}

function run(ctx) {
  const current = ctx.read.latest('nfl.week', { entityType: 'week' }).find(r => r.value?.current);
  if (!current) return; // no NFL week yet: nothing is "this week or later"
  const { season, week } = current.value;
  const lines = latestByKey(ctx.read.events({ types: ['market.game_line'] }));
  const byKey = new Map(lines.map(e => [`${e.payload.season}:${e.payload.week}:${e.payload.team}`, e]));
  const priorMean = w => {
    const totals = lines.filter(e => e.payload.total != null
      && (e.payload.season < season || (e.payload.season === season && e.payload.week < w))).map(e => e.payload.total);
    return totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 44.5;
  };
  const fit = ctx.fit;
  const means = new Map();
  for (const home of lines) {
    const p = home.payload;
    if (p.season !== season || p.week < week || Number(p.home) !== 1) continue;
    const away = byKey.get(`${p.season}:${p.week}:${p.opponent}`) ?? null;
    const base = { entityType: 'game', entityId: `${p.season}:${p.week}:${p.team}`, field: 'game.script',
      stateIds: [current.id], eventIds: [home.id, ...(away ? [away.id] : [])] };
    const cite = text => ({ contributions: [{ source: 'market.game_line', kind: 'event', event_ids: base.eventIds,
      state_ids: [current.id], delta: null, text }] });
    if (!fit) {
      ctx.write(WRITERS['game.script'], { ...base, absence: { status: 'not_measured', reason: 'gamescript_model holds no fit' },
        reasonChain: cite('no game-script fit') });
      continue;
    }
    if (!means.has(p.week)) means.set(p.week, priorMean(p.week));
    const avgTotal = means.get(p.week);
    const side = e => {
      if (!e || e.payload.spread == null || e.payload.total == null) return null;
      return { team: e.payload.team, spread: e.payload.spread, total: e.payload.total,
        ...sideMultipliers(fit.coef, e.payload, avgTotal) };
    };
    const h = side(home); const a = side(away);
    if (!h && !a) {
      ctx.write(WRITERS['game.script'], { ...base, absence: { status: 'unknown', reason: 'no spread and total for either side' },
        reasonChain: cite('no usable line') });
      continue;
    }
    ctx.write(WRITERS['game.script'], { ...base,
      value: { home: h, away: a, avg_total: +avgTotal.toFixed(3), fit: { fitted_at: fit.fitted_at } },
      reasonChain: cite(`line vs a neutral game (spread 0, total ${avgTotal.toFixed(1)}); fit of ${fit.fitted_at ?? 'unknown date'}`
        + (h && a ? '' : `; ${h ? 'away' : 'home'} side has no usable line`)) });
  }
}

export const gamescriptProducer = Object.freeze({ name: 'gamescript', run, resolveFit });
