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
import { row } from '../db/index.js';
import { deriveFormat } from './format.js';
import {
  assetUniverse, loadRosters, lineupSlots, bestLineup, tradeWeekContext, lineupDiff
} from './trade-engine.js';
import { vegasLift } from './waiver-brain.js';
import { regressionCandidates } from './td-regression.js';
import { fantasyContext } from './nfl-spread-context.js';
import { playerCase } from './player-case.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));

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
export function lineupCall(leagueId, { myTeamId = null, objective = 'mean' } = {}) {
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

    return {
      slot: s.slot,
      player: { name: p.name, position: p.position, team_abbr: p.team_abbr,
        adj_ppg: p.adj_ppg, week_points: p.week_points, bye: p.bye,
        injury: p.injury_status ?? null, active_probability: p.active_probability ?? null },
      over: alt ? { name: alt.name, position: alt.position, week_points: alt.week_points } : null,
      margin, confidence,
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
            'error, so this is a tie — start whichever you prefer and do not spend the afternoon on it.'
          : `${margin} points ahead of ${alt.name}${confidence === 'clear' ? ', comfortably' : ''}.`
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
      name: p.name, position: p.position, team_abbr: p.team_abbr,
      week_points: p.week_points, vegas: p.vegas?.reading ?? null
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
