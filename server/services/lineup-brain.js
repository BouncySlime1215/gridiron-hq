/**
 * Who to start this week, and how sure that is.
 *
 * The single most-used decision in fantasy football, and until now the only
 * major one with no page. The pieces existed and answered narrower questions:
 * `bestLineup` solves the optimum, `lineupDiff` compares it to what you
 * submitted, `gameScriptFor` prices the betting market's view, `weekly-trends`
 * measures role changes, `td-regression` measures scoring luck. None of them
 * met.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A RANKING IS NOT AN ANSWER
 *
 * Every start/sit tool ranks players by projected points and calls the top N
 * your lineup. That is right on average and it hides the only thing a manager
 * actually needs, which is how close the call was. Starting an 11.4 over an 11.2
 * and starting a 16.0 over a 6.0 are rendered identically, and they are not the
 * same decision: the first is a coin flip where the projection's own error
 * dwarfs the gap, and treating it as a real edge is how people talk themselves
 * into agonising over noise.
 *
 * So every call here carries a margin and an honest confidence derived from it,
 * and the near-ties are labelled as ties rather than dressed up as decisions.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE VARIANCE POINT, which most tools get backwards
 *
 * The highest-expectation lineup is not always the right lineup. If you are a
 * heavy underdog this week, playing the safe option maximises your average score
 * and your average score is not what you need — you need a tail. If you are a
 * heavy favourite the reverse holds: variance can only hurt you. `ceiling-lineup`
 * already implements this properly and nothing surfaced it, so the objective is
 * exposed here as a choice with the reason attached.
 */
import { row, rows } from '../db/index.js';
import { deriveFormat } from './format.js';
import {
  assetUniverse, loadRosters, lineupSlots, bestLineup, tradeWeekContext, lineupDiff
} from './trade-engine.js';
import { vegasLift } from './waiver-brain.js';
import { regressionCandidates } from './td-regression.js';
import { fantasyContext } from './nfl-spread-context.js';
import { playerCase } from './player-case.js';
import { careerLine } from './player-career.js';
import { preseasonProjection } from './preseason-model.js';
import { offseasonAdjustment } from './offseason-model.js';

const r1 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(1));
const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));

/* ───────────────────────────────────────────────────────────────────────────
 * PLAYER EVIDENCE
 *
 * The weekly number that decides a start/sit is `week_points`, and it stays the
 * coordinator's validated projection. What was missing is the record behind the
 * two names: how often each man actually posted a startable week last season,
 * where his floor sits, what his career says, what the preseason model's band
 * is, and whether his situation changed over the summer. None of that
 * re-projects anything — it explains a margin and flags a risk.
 *
 * Every source is optional and every read is guarded. A missing module, a
 * missing table or a player with no record degrades to null for that layer,
 * never to a broken lineup.
 * ────────────────────────────────────────────────────────────────────────── */

/** The fewest recorded weeks before a floor/ceiling means anything. */
export const MIN_WEEKS = 4;
/** A "startable" week: the line most managers use for a starter's floor. */
export const STARTABLE_WEEK = 15;

/** Linear-interpolated quantile of an ascending array. */
export function quantile(sorted, q) {
  const n = sorted.length;
  if (!n) return null;
  if (n === 1) return sorted[0];
  const idx = q * (n - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * The shape of one season's weekly scoring, from `player_gamelog`.
 *
 * Floor and ceiling are the 20th and 80th percentile weeks rather than the
 * single worst and best: a one-off injury week or a 40-point outlier is not the
 * floor or the ceiling a manager should plan around. `games_15plus` is the count
 * that most directly answers "how often was he a starter".
 */
export function weeklyShape(playerId, season) {
  if (playerId == null || !Number.isFinite(Number(season))) return null;
  let pts;
  try {
    pts = rows(`SELECT fantasy_points FROM player_gamelog WHERE player_id = ? AND season = ? ORDER BY week`,
      playerId, season).filter(r => r.fantasy_points != null).map(r => Number(r.fantasy_points)).filter(Number.isFinite);
  } catch { return null; }   // table absent — it is created lazily by the edge routes
  if (pts.length < MIN_WEEKS) return null;
  const sorted = [...pts].sort((a, b) => a - b);
  return {
    season,
    games: pts.length,
    ppg: r1(pts.reduce((s, v) => s + v, 0) / pts.length),
    floor: r1(quantile(sorted, 0.2)),
    ceiling: r1(quantile(sorted, 0.8)),
    games_15plus: pts.filter(v => v >= STARTABLE_WEEK).length,
    worst: r1(sorted[0]),
    best: r1(sorted[sorted.length - 1])
  };
}

/**
 * The live sources. Injectable so a caller (or a test) can swap any of them for
 * a stub or for null and prove the page still renders.
 */
export const DEFAULT_PROVIDERS = Object.freeze({
  career: (id, season) => careerLine(id, { season }),
  preseason: (id, season) => preseasonProjection(id, season),
  offseason: (id, season) => offseasonAdjustment(id, season),
  weekly: (id, season) => weeklyShape(id, season - 1)
});

/** A meaningful offseason read: it either has drivers or moved the multiplier. */
const offseasonMatters = o =>
  !!o && ((o.drivers?.length ?? 0) > 0 || Math.abs((o.opportunity_multiplier ?? 1) - 1) >= 0.05);

/**
 * The one-line, number-first case. Same construction as the draft room's
 * `evidenceHeadline` (draft-assist.js), rebuilt here rather than imported
 * because that module pulls in route files this service should not depend on.
 */
export function statHeadline({ career, preseason, offseason }) {
  const bits = [];
  if (career?.headline) bits.push(career.headline);
  else if (career?.streaks?.length) {
    const s = career.streaks[0];
    bits.push(`${Number(s.threshold).toLocaleString('en-US')}+ ${String(s.stat).replace('_', ' ')} × ${s.seasons} straight`);
  }
  if (preseason?.drivers?.length) bits.push(preseason.drivers[0]);
  if (offseason?.drivers?.length && Math.abs((offseason.opportunity_multiplier ?? 1) - 1) >= 0.08) bits.push(offseason.drivers[0]);
  return bits.join(' · ') || null;
}

const SEASON_KEYS = ['season', 'games', 'ppr_points', 'ppg', 'pos_rank', 'rush_att', 'rush_yds', 'rush_td',
  'targets', 'rec', 'rec_yds', 'rec_td', 'pass_att', 'pass_yds', 'pass_td', 'int'];
const pickSeason = s => {
  const out = {};
  for (const k of SEASON_KEYS) if (s[k] != null) out[k] = s[k];
  // The draft components read `carries`; the career line calls it rush_att.
  if (s.rush_att != null) out.carries = s.rush_att;
  return out;
};

/**
 * Everything the page can say about one player, from whichever layers answer.
 *
 * Returns null when no layer has anything — a rookie with no gamelog, no career
 * and no projection renders nothing rather than a strip of dashes.
 */
export function candidateEvidence(playerId, season, providers = DEFAULT_PROVIDERS) {
  if (playerId == null) return null;
  const safe = fn => { try { return fn() ?? null; } catch { return null; } };
  const career = safe(() => providers.career?.(playerId, season));
  const preseason = safe(() => providers.preseason?.(playerId, season));
  const offseasonRaw = safe(() => providers.offseason?.(playerId, season));
  const weekly = safe(() => providers.weekly?.(playerId, season));
  const offseason = offseasonMatters(offseasonRaw) ? offseasonRaw : null;

  const last = career?.seasons?.[0] ?? null;
  const headline = statHeadline({ career, preseason, offseason });
  const out = {
    headline,
    career: career?.seasons?.length ? {
      headline: career.headline ?? null,
      seasons: career.seasons.slice(0, 3).map(pickSeason),
      consistency: career.consistency ?? null,
      streaks: (career.streaks ?? []).filter(s => (s.seasons ?? 0) >= 2).slice(0, 4),
      trend: career.trend ?? null
    } : null,
    last_season: last ? {
      season: last.season, games: last.games ?? null, points: r1(last.ppr_points),
      ppg: r1(last.ppg), pos_rank: last.pos_rank ?? null
    } : null,
    weekly,
    preseason: preseason?.points != null ? {
      points: r1(preseason.points), ppg: r2(preseason.ppg),
      expected_games: r1(preseason.expected_games),
      p20: r1(preseason.p20), p80: r1(preseason.p80),
      drivers: (preseason.drivers ?? []).slice(0, 3)
    } : null,
    // Evidence and a risk flag only. The offseason multiplier is documented as
    // not additive over a depth-aware projection, so it is never multiplied
    // into week_points here — it is shown, with its confidence, and that is all.
    offseason: offseason ? {
      opportunity_multiplier: r2(offseason.opportunity_multiplier),
      confidence: offseason.confidence ?? null,
      drivers: (offseason.drivers ?? []).slice(0, 3),
      risk: (offseason.opportunity_multiplier ?? 1) < 0.92
    } : null
  };
  if (!out.headline && !out.career && !out.last_season && !out.weekly && !out.preseason && !out.offseason) return null;
  return out;
}

/** The evidence without the season table — for lists that show many players. */
export function compactEvidence(ev) {
  if (!ev) return null;
  const { career, ...rest } = ev;
  return {
    ...rest,
    consistency: career?.consistency
      ? { seasons_counted: career.consistency.seasons_counted ?? null,
        seasons_top24: career.consistency.seasons_top24 ?? null,
        seasons_top12: career.consistency.seasons_top12 ?? null }
      : null
  };
}

/**
 * The number that decides it, as a sentence: "Last year A hit 15+ in 12 of 17
 * games (floor 8.1) vs B 6 of 16 (floor 4.3)." Falls back through the layers
 * so two players with no gamelog are still compared on something real, and
 * says nothing rather than something vague when there is nothing to compare.
 */
export function deciderText(a, b, nameA, nameB) {
  if (!a || !b) return null;
  if (a.weekly && b.weekly) {
    return `Last year ${nameA} hit ${STARTABLE_WEEK}+ in ${a.weekly.games_15plus} of ${a.weekly.games} games ` +
      `(floor ${a.weekly.floor}) vs ${nameB} ${b.weekly.games_15plus} of ${b.weekly.games} (floor ${b.weekly.floor}).`;
  }
  if (a.preseason?.p20 != null && b.preseason?.p20 != null) {
    return `Preseason range ${Math.round(a.preseason.p20)}–${Math.round(a.preseason.p80)} pts for ${nameA} ` +
      `vs ${Math.round(b.preseason.p20)}–${Math.round(b.preseason.p80)} for ${nameB}.`;
  }
  if (a.last_season?.ppg != null && b.last_season?.ppg != null) {
    return `${nameA} ${a.last_season.ppg} ppg over ${a.last_season.games} games last year vs ` +
      `${nameB} ${b.last_season.ppg} over ${b.last_season.games}.`;
  }
  return null;
}

/** One evidence lookup per player per call, however many slots he appears in. */
export function evidenceCache(season, providers = DEFAULT_PROVIDERS) {
  const memo = new Map();
  return id => {
    if (id == null) return null;
    if (!memo.has(id)) memo.set(id, candidateEvidence(id, season, providers));
    return memo.get(id);
  };
}

/**
 * How much two projections have to differ before the difference is real.
 *
 * Weekly fantasy projections carry a mean absolute error in the region of five
 * to six points for a starter. A gap of a point and a half is inside that noise
 * by any reading, and calling it a decision is false precision. This is not
 * fitted — it is a judgement, stated here in one place so it can be argued with
 * rather than buried inside a comparison.
 */
const TIE_THRESHOLD = 1.5;
const CLEAR_THRESHOLD = 4.0;

/**
 * The week's lineup, with every call explained and graded by how close it was.
 *
 * @param objective 'mean' for the highest average, 'ceiling' when you need a
 *   tail because you are an underdog, 'floor' when you are favoured and only
 *   variance can hurt you.
 */
export function lineupCall(leagueId, { myTeamId = null, objective = 'mean', providers = DEFAULT_PROVIDERS } = {}) {
  const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!lg?.payload) return { error: 'league not synced yet' };

  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  if (!teams.length) return { error: 'league sync contains no rosters yet' };
  const slots = lineupSlots(lg);
  const me = teams.find(t => t.roster_id === String(myTeamId ?? lg.my_team_id)) ?? teams[0];
  if (!me) return { error: 'your roster could not be resolved from the league sync' };

  const { season, week } = tradeWeekContext();

  // Annotate every player with this week's market view before solving. The
  // betting model already prices how much volume a team's game script implies,
  // and a start/sit call is exactly the horizon where that matters most — it is
  // a decision about one Sunday, which is the only thing a single week's line
  // describes.
  const annotated = me.players.map(p => {
    const lift = vegasLift(p, season, week);
    const base = p.adj_ppg ?? p.ppg ?? 0;
    return {
      ...p,
      vegas: lift,
      // Unlike the trade horizon, this is the full multiplier: the whole
      // decision IS this week.
      week_points: r2(base * (lift.applied ? lift.multiplier : 1))
    };
  });

  const key = objective === 'ceiling' ? 'ceiling' : objective === 'floor' ? 'floor' : 'week_points';
  const usable = annotated.filter(p => Number.isFinite(p[key]));
  const optimal = bestLineup(usable.length === annotated.length ? annotated : annotated, slots,
    // Fall back to the week projection when a roster has no floor/ceiling
    // distribution recorded — better than solving on undefined and returning an
    // empty lineup, which is what an unguarded key swap does here.
    usable.length === annotated.length ? key : 'week_points');

  const startingIds = new Set(optimal.slots.map(s => s.player?.id).filter(Boolean));
  // The alternative must come from the pool the solver could actually have
  // chosen from. `bestLineup` excludes anyone flagged unavailable — season-ending
  // injury, released — and the first version of this did not, so it offered an
  // out-for-the-year running back as the man being beaten and printed NEGATIVE
  // margins: "Tony Pollard over Jonathan Taylor by -2.56", which reads as the
  // optimiser contradicting itself when it was right all along.
  const startable = annotated.filter(p => p.available !== false);
  const bench = startable.filter(p => !startingIds.has(p.id) && (p.week_points ?? 0) > 0)
    .sort((a, b) => b.week_points - a.week_points);
  // Kept separately and reported, because "why is my best back on the bench" is
  // the first question this page has to answer.
  const unavailable = annotated
    .filter(p => p.available === false && (p.adj_ppg ?? 0) > 4)
    .map(p => ({ name: p.name, position: p.position, team_abbr: p.team_abbr,
      adj_ppg: p.adj_ppg, injury: p.injury_status ?? null,
      why: 'Flagged out for the season or released, so the solver will not start him.' }));

  // Evidence from the other models, keyed by name.
  const evidence = new Map();
  try {
    const reg = regressionCandidates({ season });
    for (const p of reg.negative_regression ?? []) {
      evidence.set(norm(p.name), { kind: 'hot', text:
        `${p.actual} touchdowns on ${p.expected} expected — running hot, and touchdown rate does not carry` });
    }
    for (const p of reg.positive_regression ?? []) {
      evidence.set(norm(p.name), { kind: 'cold', text:
        `${p.actual} touchdowns on ${p.expected} expected — due to score` });
    }
  } catch { /* the call stands without it */ }

  // Situational context per team, computed once rather than per player.
  //
  // This is the same module the betting audit reads, pointed at a lineup. Wind
  // above about 15 mph is the clearest example of why it belongs here: it moves
  // passing volume enough to change a start/sit and barely moves a spread,
  // because the market prices it into the total while the fantasy projection
  // never saw it at all.
  const teamCtx = new Map();
  for (const p of annotated) {
    if (!p.team_abbr || teamCtx.has(p.team_abbr)) continue;
    try { teamCtx.set(p.team_abbr, fantasyContext(p.team_abbr, season, week)); }
    catch { teamCtx.set(p.team_abbr, null); }
  }

  // Every start, with what it beat and by how much.
  // One failure must not take the lineup down with it — a missing opponent or a
  // thin week should cost the football case, not the page.
  const safeCase = (p, yr, wk) => {
    try { return playerCase(p, yr, wk); } catch { return null; }
  };

  // The record behind each name — career, last season's weekly shape, the
  // preseason band, the offseason read. Looked up once per player.
  const record = evidenceCache(season, providers);

  const calls = optimal.slots.filter(s => s.player).map(s => {
    const p = s.player;
    // The best benched player who could legally fill this slot.
    const alt = bench.find(b => slotAccepts(s.slot, b.position));
    const margin = alt ? r2((p[key] ?? p.week_points) - (alt[key] ?? alt.week_points)) : null;
    const confidence = margin == null ? 'only option'
      : margin >= CLEAR_THRESHOLD ? 'clear'
        : margin >= TIE_THRESHOLD ? 'lean'
          : 'coin flip';
    const ev = evidence.get(norm(p.name));
    const mine = record(p.id);
    const theirs = alt ? record(alt.id) : null;
    const decider = alt ? deciderText(mine, theirs, p.name, alt.name) : null;

    return {
      slot: s.slot,
      player: { id: p.id, name: p.name, position: p.position, team_abbr: p.team_abbr,
        adj_ppg: p.adj_ppg, week_points: p.week_points, bye: p.bye,
        injury: p.injury_status ?? null, active_probability: p.active_probability ?? null,
        evidence: mine },
      over: alt ? { id: alt.id, name: alt.name, position: alt.position, week_points: alt.week_points,
        evidence: theirs } : null,
      margin, confidence,
      // The deciding number, stated separately so the UI can set it apart from
      // the margin sentence and so a test can check it without parsing prose.
      decider,
      vegas: p.vegas?.reading ?? null,
      vegas_multiplier: p.vegas?.applied ? p.vegas.multiplier : null,
      // The football case: who is throwing, what defence he faces, what his own
      // staff calls, who else is hurt, the weather, his usage trend and his
      // touchdown luck — ordered by how much each actually moves the decision.
      // The whole reason this page was shallow is that it had none of this.
      football: safeCase(p, season, week),
      // Only flags that touch this player's position, so a receiver is not told
      // about a running back's game script.
      conditions: (teamCtx.get(p.team_abbr)?.flags ?? [])
        .filter(f => f.affects === 'everyone' || f.affects === p.position
          || (f.affects === 'passing' && ['QB', 'WR', 'TE'].includes(p.position)))
        .map(f => ({ kind: f.kind, severity: f.severity, note: f.note })),
      caution: ev?.kind === 'hot' ? ev.text : null,
      upside: ev?.kind === 'cold' ? ev.text : null,
      why: margin == null
        ? `Nobody else on the roster can fill ${s.slot}.`
        : confidence === 'coin flip'
          ? `Only ${margin} points ahead of ${alt.name}. That gap is inside the projection's own ` +
            'error, so this is a tie — start whichever you prefer and do not spend the afternoon on it.' +
            (decider ? ` If you want a tiebreaker, the record is the honest one: ${decider}` : '')
          : `${margin} points ahead of ${alt.name}${confidence === 'clear' ? ', comfortably' : ''}.` +
            (decider ? ` ${decider}` : '')
    };
  });

  const coinFlips = calls.filter(c => c.confidence === 'coin flip');
  const risky = calls.filter(c => (c.player.active_probability ?? 1) < 0.75 || c.player.bye === week);

  // What you actually submitted, when the platform exposes it.
  let submitted = null;
  try { const d = lineupDiff(lg, myTeamId ?? lg.my_team_id); if (!d.error) submitted = d; }
  catch { /* ESPN only, and not always readable */ }

  return {
    league: lg.name, owner: me.owner, season, week, objective,
    projected_points: r2(optimal.points),
    lineup: calls,
    bench: bench.slice(0, 8).map(p => ({
      id: p.id, name: p.name, position: p.position, team_abbr: p.team_abbr,
      week_points: p.week_points, vegas: p.vegas?.reading ?? null,
      evidence: compactEvidence(record(p.id))
    })),
    submitted,
    unavailable,
    team_conditions: [...teamCtx.entries()]
      .filter(([, c]) => c && !c.insufficient && c.flags.length)
      .map(([team, c]) => ({ team, opponent: c.opponent, home: c.home,
        market: c.market, conditions: c.conditions, flags: c.flags })),
    coin_flips: coinFlips.length,
    warnings: risky.map(c => ({
      player: c.player.name,
      issue: c.player.bye === week ? 'on bye this week'
        : `only plays about ${Math.round((c.player.active_probability ?? 0.9) * 100)}% of weeks`,
      slot: c.slot
    })),
    objectives: [
      { id: 'mean', label: 'Highest average',
        when: 'The default, and right when the matchup is close.' },
      { id: 'ceiling', label: 'Chase the ceiling',
        when: 'You are a heavy underdog. Your average score is not what you need — you need a tail, ' +
          'and the safe lineup maximises exactly the wrong thing.' },
      { id: 'floor', label: 'Protect the floor',
        when: 'You are a heavy favourite. Variance can only cost you the game from here.' }
    ],
    note: coinFlips.length
      ? `${coinFlips.length} of these calls are inside the projection's own error and are labelled ` +
        'as ties rather than dressed up as decisions. Weekly projections miss by five or six points ' +
        'on a starter; a gap of one is not a finding.'
      : 'Every call this week has a real margin behind it.'
  };
}

/** Which positions a slot will accept, matching the solver's own rules. */
function slotAccepts(slot, position) {
  const s = String(slot).toUpperCase();
  if (s === position) return true;
  if (s === 'FLEX' || s === 'W/R/T') return ['RB', 'WR', 'TE'].includes(position);
  if (s === 'W/R') return ['RB', 'WR'].includes(position);
  if (s === 'W/T') return ['WR', 'TE'].includes(position);
  if (s === 'SUPERFLEX' || s === 'OP') return ['QB', 'RB', 'WR', 'TE'].includes(position);
  return false;
}

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');
