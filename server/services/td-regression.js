/**
 * Who is about to get better or worse for reasons that have nothing to do with
 * how good they are.
 *
 * Touchdown rate is the least stable number in football. Target share correlates
 * around 0.70 year to year; touchdowns per opportunity correlates with almost
 * nothing, because a touchdown is a coin flip conditioned on being near the goal
 * line and there are only a handful of those chances per player per month.
 *
 * Fantasy markets price on fantasy points, and fantasy points are roughly
 * "usage plus six times a coin flip". So the most reliable inefficiency in the
 * sport is the gap between the two:
 *
 *   A player with elite opportunity and no touchdowns is cheap and about to stop
 *   being cheap. His owner is frustrated, the box scores are ugly, and none of
 *   that says anything about next month.
 *
 *   A player with modest opportunity and five touchdowns is expensive and about
 *   to stop being expensive. This is the profitable half, and almost nobody
 *   plays it, because selling a player who just scored twice feels insane.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE RATES ARE FITTED AND NOT ASSUMED
 *
 * The obvious implementation compares a player's touchdowns to his own season
 * average, which measures nothing — it regresses him to himself, so a player who
 * has been lucky all year looks perfectly normal. Expected touchdowns have to
 * come from OPPORTUNITY priced at a league-wide rate.
 *
 * The rates below are fitted from this database rather than quoted from an
 * article, so they follow the league as it changes and cannot silently rot. Each
 * opportunity class is priced separately because they are wildly different
 * events: a goal-line carry converts several times more often than a red-zone
 * carry, which converts several times more often than a carry between the
 * twenties. Averaging them into one "carries" rate is the error that makes this
 * kind of model useless — it hands a workhorse back with no goal-line role the
 * same expectation as a short-yardage specialist.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HONEST LIMIT
 *
 * This predicts the touchdown component and nothing else. A player can be a
 * genuine positive-regression candidate and still be a bad hold because his role
 * is shrinking — which `weekly-trends.js` measures and this deliberately does
 * not. The two are meant to be read together, and where they disagree the usage
 * trend is the more reliable of the two.
 */
import { rows, row } from '../db/index.js';
import { deriveFormat } from './format.js';
import { assetUniverse, loadRosters, tradeWeekContext } from './trade-engine.js';
import { cached, fingerprint } from './compute-cache.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/**
 * Opportunity classes, most valuable first.
 *
 * Order matters: each class subtracts the ones above it so an opportunity is
 * counted exactly once. A goal-line carry is also a red-zone carry is also a
 * carry, and pricing all three would treble-count the most valuable touches a
 * player gets — inflating expected touchdowns for exactly the backs whose whole
 * value is that they get them.
 */
const RUSH_CLASSES = [
  { key: 'goal_line_carries', label: 'goal-line carries', subtractFrom: null },
  { key: 'red_zone_carries', label: 'other red-zone carries', subtractFrom: 'goal_line_carries' },
  { key: 'carries', label: 'carries outside the red zone', subtractFrom: 'red_zone_carries' }
];
const REC_CLASSES = [
  { key: 'end_zone_targets', label: 'end-zone targets', subtractFrom: null },
  { key: 'red_zone_targets', label: 'other red-zone targets', subtractFrom: 'end_zone_targets' },
  { key: 'targets', label: 'targets outside the red zone', subtractFrom: 'red_zone_targets' }
];

/**
 * League-wide conversion rate for each opportunity class, fitted from history.
 *
 * Cached on a fingerprint of the tables it reads: these move slowly and the fit
 * walks 16,000 player-weeks, so recomputing per request is pure waste.
 */
export function touchdownRates({ seasons = null } = {}) {
  const yrs = seasons ?? availableSeasons();
  return cached(
    `td-rates:${yrs.join(',')}`,
    fingerprint([{ table: 'nfl_player_week_features', stamp: 'week' },
      { table: 'player_week_usage', stamp: 'week' }], yrs.join(',')),
    () => fitRates(yrs));
}

function availableSeasons() {
  return rows(`SELECT DISTINCT season FROM nfl_player_week_features ORDER BY season`)
    .map(r => r.season).slice(-3);
}

function fitRates(seasons) {
  const placeholders = seasons.map(() => '?').join(',');
  const feats = rows(
    `SELECT season, week, player_id, position, features
     FROM nfl_player_week_features WHERE season IN (${placeholders})`, ...seasons);
  // Touchdowns come out of the same blob as the opportunities.
  //
  // The first version joined to `player_week_usage` for them, which silently
  // matched nothing: that table keys on an internal integer id while the weekly
  // feature table keys on a GSIS string ("00-0023459"). Zero rows overlapped, so
  // every player was credited with zero touchdowns, every fitted rate kept its
  // seed value, and the whole board filled with "due to score" — a model
  // reporting that every star in the league was unlucky, which is the shape of a
  // broken join rather than a finding.

  // Rates are fitted per POSITION GROUP, not league-wide.
  //
  // A league-wide rate says Josh Allen scored 14 rushing touchdowns on 5.79
  // expected and is therefore wildly lucky. He is not: a quarterback sneak from
  // the one converts at a completely different rate from a running back's carry,
  // and designed goal-line quarterback runs are a repeatable role rather than a
  // coin flip. Pricing every goal-line carry identically labels every mobile
  // quarterback in the league as due to collapse, every year, which is a model
  // that is wrong about the same players forever.
  const groupOf = pos => (pos === 'QB' ? 'QB' : pos === 'RB' ? 'RB' : 'REC');
  const GROUPS = ['QB', 'RB', 'REC'];
  const blank = classes => Object.fromEntries(classes.map(c => [c.key, { opp: 0, td: 0 }]));
  const rush = Object.fromEntries(GROUPS.map(g => [g, blank(RUSH_CLASSES)]));
  const rec = Object.fromEntries(GROUPS.map(g => [g, blank(REC_CLASSES)]));

  // A single week cannot attribute which specific carry scored, so rates are
  // fitted by pooling: total touchdowns across all players, allocated to classes
  // in proportion to exposure, solved by iteration. Two passes is enough — the
  // classes are far apart in rate, so it converges immediately.
  const seedRush = { goal_line_carries: 0.15, red_zone_carries: 0.06, carries: 0.01 };
  const seedRec = { end_zone_targets: 0.30, red_zone_targets: 0.12, targets: 0.03 };
  let rushRate = Object.fromEntries(GROUPS.map(g => [g, { ...seedRush }]));
  let recRate = Object.fromEntries(GROUPS.map(g => [g, { ...seedRec }]));

  for (let iter = 0; iter < 12; iter++) {
    for (const g of GROUPS) {
      for (const k of Object.keys(rush[g])) { rush[g][k].opp = 0; rush[g][k].td = 0; }
      for (const k of Object.keys(rec[g])) { rec[g][k].opp = 0; rec[g][k].td = 0; }
    }

    for (const f of feats) {
      const x = JSON.parse(f.features);
      const g = groupOf(f.position);
      const actual = { rushing_tds: x.rushing_tds ?? 0, receiving_tds: x.receiving_tds ?? 0 };

      const rushOpp = exclusive(x, RUSH_CLASSES);
      const recOpp = exclusive(x, REC_CLASSES);

      const rushExp = RUSH_CLASSES.reduce((s, c) => s + rushOpp[c.key] * rushRate[g][c.key], 0);
      const recExp = REC_CLASSES.reduce((s, c) => s + recOpp[c.key] * recRate[g][c.key], 0);

      // Allocate the player's actual touchdowns across classes in proportion to
      // each class's share of his expected total. With no expectation there is
      // nothing to allocate and the week contributes exposure only.
      for (const c of RUSH_CLASSES) {
        rush[g][c.key].opp += rushOpp[c.key];
        if (rushExp > 0) {
          rush[g][c.key].td += actual.rushing_tds * (rushOpp[c.key] * rushRate[g][c.key]) / rushExp;
        }
      }
      for (const c of REC_CLASSES) {
        rec[g][c.key].opp += recOpp[c.key];
        if (recExp > 0) {
          rec[g][c.key].td += actual.receiving_tds * (recOpp[c.key] * recRate[g][c.key]) / recExp;
        }
      }
    }

    // A group with too little exposure keeps its seed rather than adopting a
    // rate fitted on a handful of plays — quarterbacks barely appear in the
    // receiving classes, and a two-catch sample would otherwise set their rate.
    const MIN_EXPOSURE = 200;
    rushRate = Object.fromEntries(GROUPS.map(g => [g, Object.fromEntries(RUSH_CLASSES.map(c =>
      [c.key, rush[g][c.key].opp >= MIN_EXPOSURE
        ? rush[g][c.key].td / rush[g][c.key].opp : rushRate[g][c.key]]))]));
    recRate = Object.fromEntries(GROUPS.map(g => [g, Object.fromEntries(REC_CLASSES.map(c =>
      [c.key, rec[g][c.key].opp >= MIN_EXPOSURE
        ? rec[g][c.key].td / rec[g][c.key].opp : recRate[g][c.key]]))]));
  }

  return {
    seasons,
    groupOf,
    rush: Object.fromEntries(GROUPS.map(g => [g, Object.fromEntries(RUSH_CLASSES.map(c =>
      [c.key, { label: c.label, rate: r4(rushRate[g][c.key]), opportunities: Math.round(rush[g][c.key].opp) }]))])),
    receiving: Object.fromEntries(GROUPS.map(g => [g, Object.fromEntries(REC_CLASSES.map(c =>
      [c.key, { label: c.label, rate: r4(recRate[g][c.key]), opportunities: Math.round(rec[g][c.key].opp) }]))])),
    note: 'Rates are fitted by expectation-maximisation over player-weeks rather than assumed: a week ' +
      'records a player\'s touchdowns but not which carry scored, so touchdowns are allocated across ' +
      'opportunity classes in proportion to exposure and the rates re-solved until they settle.'
  };
}

/** Opportunity counts with each class made exclusive of the one above it. */
function exclusive(f, classes) {
  const out = {};
  for (const c of classes) {
    const raw = f[c.key] ?? 0;
    const above = c.subtractFrom ? (f[c.subtractFrom] ?? 0) : 0;
    out[c.key] = Math.max(0, raw - above);
  }
  return out;
}

/**
 * Expected versus actual touchdowns for every player in a season.
 *
 * @returns players sorted by the size of the gap, in fantasy points.
 */
export function regressionCandidates({ season = null, throughWeek = null, minOpportunities = 20 } = {}) {
  const yr = season ?? row(`SELECT MAX(season) AS s FROM nfl_player_week_features`)?.s;
  if (!yr) return { error: 'no weekly player features on record' };
  const rates = touchdownRates();

  const feats = rows(
    `SELECT week, player_id, player_name, position, team, features
     FROM nfl_player_week_features
     WHERE season = ? ${throughWeek ? 'AND week <= ?' : ''}`,
    yr, ...(throughWeek ? [throughWeek] : []));
  const byPlayer = new Map();
  for (const f of feats) {
    const x = JSON.parse(f.features);
    const rushOpp = exclusive(x, RUSH_CLASSES);
    const recOpp = exclusive(x, REC_CLASSES);

    const key = f.player_id;
    if (!byPlayer.has(key)) {
      byPlayer.set(key, {
        player_id: key, name: f.player_name, position: f.position, team: f.team,
        weeks: 0, expected: 0, actual: 0, opportunities: 0,
        goal_line: 0, end_zone: 0, red_zone: 0
      });
    }
    const p = byPlayer.get(key);
    p.weeks++;
    p.team = f.team ?? p.team;
    const g = rates.groupOf(f.position);
    for (const c of RUSH_CLASSES) {
      p.expected += rushOpp[c.key] * (rates.rush[g]?.[c.key]?.rate ?? 0);
      p.opportunities += rushOpp[c.key];
    }
    for (const c of REC_CLASSES) {
      p.expected += recOpp[c.key] * (rates.receiving[g]?.[c.key]?.rate ?? 0);
      p.opportunities += recOpp[c.key];
    }
    p.goal_line += rushOpp.goal_line_carries ?? 0;
    p.end_zone += recOpp.end_zone_targets ?? 0;
    p.red_zone += (rushOpp.red_zone_carries ?? 0) + (recOpp.red_zone_targets ?? 0);
    p.actual += (x.rushing_tds ?? 0) + (x.receiving_tds ?? 0);
  }

  const all = [...byPlayer.values()]
    .filter(p => p.opportunities >= minOpportunities)
    .map(p => {
      const gap = p.actual - p.expected;
      // Six points a touchdown, spread over the weeks played, which is the unit
      // every other page in this app already speaks.
      const ppgSwing = p.weeks > 0 ? (gap * 6) / p.weeks : 0;
      // A gap is only interesting relative to how many chances produced it: two
      // touchdowns over expectation on eight opportunities is noise, and the
      // same gap on eighty is a real rate difference. Poisson standard error on
      // the expected count is the right scale for a count of rare events.
      const se = Math.sqrt(Math.max(0.5, p.expected));
      return {
        ...p,
        expected: r2(p.expected), actual: p.actual,
        gap: r2(gap), z: r2(gap / se),
        ppg_swing: r2(ppgSwing),
        direction: gap > 0 ? 'due to cool off' : 'due to score',
        confidence: Math.abs(gap / se) >= 2 ? 'strong' : Math.abs(gap / se) >= 1.2 ? 'moderate' : 'weak'
      };
    })
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));

  return {
    season: yr, through_week: throughWeek,
    rates_fitted_on: rates.seasons,
    rates: { rush: rates.rush, receiving: rates.receiving },
    positive_regression: all.filter(p => p.gap < 0 && Math.abs(p.z) >= 1.2).slice(0, 25),
    negative_regression: all.filter(p => p.gap > 0 && Math.abs(p.z) >= 1.2).slice(0, 25),
    all: all.slice(0, 120),
    note: 'Expected touchdowns are opportunity priced at league rates, not a player regressed to his ' +
      'own average — that would regress a lucky player to his own luck. Gaps are scaled by the Poisson ' +
      'error on the expected count, so two touchdowns over expectation means something different on ' +
      'eight opportunities than on eighty.'
  };
}

/**
 * The same read, narrowed to players you can actually do something about.
 *
 * Everything else in this file is league-wide and therefore mostly about players
 * on rosters you will never touch. This is the join.
 */
export function regressionForLeague(leagueId, { myTeamId = null, season = null, throughWeek = null } = {}) {
  const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!lg?.payload) return { error: 'league not synced yet' };

  const base = regressionCandidates({ season, throughWeek });
  if (base.error) return base;

  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const me = teams.find(t => t.roster_id === String(myTeamId ?? lg.my_team_id)) ?? teams[0];
  if (!me) return { error: 'your roster could not be resolved from the league sync' };

  // Names are the only key shared between the weekly feature tables and the
  // league roster, so matching is normalised on both sides.
  const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const mine = new Map(me.players.map(p => [norm(p.name), p]));
  const owners = new Map();
  for (const t of teams) for (const p of t.players) owners.set(norm(p.name), t.owner);

  const decorate = list => list.map(p => {
    const key = norm(p.name);
    const owner = owners.get(key) ?? null;
    const isMine = mine.has(key);
    return {
      ...p,
      owned_by: owner ?? 'free agent',
      is_mine: isMine,
      action: p.gap > 0
        ? (isMine ? 'sell' : owner ? 'do not buy' : 'ignore')
        : (isMine ? 'hold' : owner ? 'buy low' : 'claim'),
      why: p.gap > 0
        ? `${p.actual} touchdowns on ${p.expected} expected from ${p.opportunities} opportunities. ` +
          `That is worth about ${Math.abs(p.ppg_swing)} points a week he is unlikely to keep — ` +
          'touchdown rate is the least stable number in football and it does not carry.'
        : `${p.actual} touchdowns on ${p.expected} expected from ${p.opportunities} opportunities, ` +
          `including ${p.goal_line} goal-line carries and ${p.end_zone} end-zone targets. ` +
          `He is roughly ${Math.abs(p.ppg_swing)} points a week light on the same usage, and his ` +
          'price reflects the box scores rather than the chances.'
    };
  });

  const positive = decorate(base.positive_regression);
  const negative = decorate(base.negative_regression);

  return {
    league: lg.name, season: base.season,
    rates_fitted_on: base.rates_fitted_on,
    // Ordered by what you can act on rather than by size of gap.
    sell: negative.filter(p => p.is_mine),
    buy: positive.filter(p => !p.is_mine && p.owned_by !== 'free agent'),
    claim: positive.filter(p => p.owned_by === 'free agent'),
    hold: positive.filter(p => p.is_mine),
    avoid: negative.filter(p => !p.is_mine && p.owned_by !== 'free agent'),
    rates: base.rates,
    note: base.note
  };
}
