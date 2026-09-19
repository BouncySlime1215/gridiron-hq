/**
 * The layer that decides what to actually do about your league.
 *
 * Every piece this needs already existed and none of them talked to each other.
 * The projection model knows who scores. `selfScout` knows where your roster is
 * thin. `findTrades` can enumerate deals. The news pipeline knows who just got
 * hurt. What was missing is the part that holds all four at once and answers the
 * only question that matters: given where I sit, which single move most improves
 * my chance of winning this league, and will the other guy actually sign it?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CORRECTION THAT MOTIVATES THIS FILE
 *
 * Every trade tool here — and everywhere — ranks deals by how much they help
 * you. That ranking is wrong, and wrong in a way that wastes entire seasons: it
 * puts the best deals at the top precisely because they are lopsided, which is
 * exactly why nobody accepts them. The list is sorted by unacceptability.
 *
 * The honest objective is expected value, not value:
 *
 *      E[gain] = P(they accept) × Δ(my title odds)
 *
 * A deal worth +4% that nobody signs is worth nothing. A deal worth +1.2% that
 * a specific manager signs today is worth +1.2%. Sorting by the product changes
 * the recommendations completely, and it is the whole point of this module.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE GAME THEORY IS REAL, AND WHERE IT WOULD BE DECORATION
 *
 * Fantasy trading is a bilateral bargaining problem with private valuations and
 * no side payments. Three results from that literature apply cleanly here, and
 * they are the three things this file computes:
 *
 *  1. GAINS FROM TRADE EXIST ONLY WHERE ENDOWMENTS DIFFER (Edgeworth).
 *     Two teams both thin at RB have nothing to discuss no matter how much they
 *     like each other. The search should never have looked there. `complement()`
 *     scores my-surplus-against-their-deficit in both directions and multiplies:
 *     a one-way match scores zero, because a trade needs two willing sides.
 *
 *  2. THE SPLIT THAT GETS SIGNED IS THE ONE THAT LOOKS FAIR (Nash bargaining).
 *     The Nash solution maximises the product of both parties' surpluses, not
 *     the sum — which is a formal way of saying a deal collapses when one side
 *     gets nearly everything, even if the total is huge. `nashProduct()` is
 *     literally that product, and it is what ranks packages inside a pairing.
 *
 *  3. THE GAME IS ZERO-SUM IN A LEAGUE, NOT JUST POSITIVE-SUM IN A TRADE.
 *     One champion. Helping the team you are chasing costs you even when the
 *     deal helps you in isolation, and taking a piece the leader needs helps you
 *     twice. `denialValue()` prices that, and it is why this will sometimes
 *     recommend the second-best deal with a weak team over the best deal with
 *     the strongest one.
 *
 * What is deliberately NOT here: equilibrium solving, regret minimisation, or
 * any multi-round game. Fantasy managers are not strategic agents converging on
 * a fixed point; they are nine busy people who answer texts. Modelling them as
 * anything more would be theatre that reads as rigour.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ON P(ACCEPT), WHICH IS THE SOFTEST NUMBER IN THE FILE
 *
 * It is elicited, not learned. There is no trade history in this database to fit
 * on — most leagues produce a dozen trades a year, which is nowhere near enough
 * to estimate a per-manager acceptance curve. Pretending otherwise would be the
 * worst kind of false precision, so instead you tell it what you already know
 * about your league ("Dave has never accepted a trade in four years") and the
 * curve is a stated assumption you can see and change.
 *
 * That is a real limitation and it is surfaced in the output rather than hidden.
 */
import { rows, row, run } from '../db/index.js';
import { deriveFormat } from './format.js';
import { assetUniverse, loadRosters, lineupSlots, bestLineup, selfScout } from './trade-engine.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));
const SKILL = ['QB', 'RB', 'WR', 'TE'];

/**
 * How willing each manager is, and what that does to a deal.
 *
 * These three tiers are the ones that actually describe a fantasy league. The
 * numbers attached to them are assumptions, stated here in one place so they can
 * be argued with rather than discovered later inside a formula.
 *
 *   never  Drafts and sits. Four years, zero trades. Any deal sent here is a
 *          lottery ticket, and the correct amount of time to spend building one
 *          is none — which is why the planner skips them entirely rather than
 *          ranking them last.
 *   hard   Answers, counters, usually passes. Needs to be visibly winning the
 *          deal before it gets signed, so only lopsided-toward-them packages
 *          have a real chance.
 *   fair   Will trade, reads the deal properly, and says no to anything that
 *          looks like a fleece. The Nash region is where these get signed —
 *          which, counterintuitively, makes this the most valuable tier: it is
 *          the only one where a mutually-good deal reliably closes.
 */
export const TRADEABILITY = {
  never: {
    label: 'Never trades',
    /**
     * Ceiling on acceptance, not a floor.
     *
     * This started as `base + weight × attractiveness`, which had the property
     * that a "fair" manager accepted at least 35% of everything — including a
     * deal that measurably made their team worse. An additive floor says "this
     * manager sometimes says yes regardless of the offer", which is not how
     * anybody trades. Multiplying instead means a bad deal is refused by every
     * tier, and the tier only decides how good an offer has to be.
     */
    responsiveness: 0.03,
    plan: 'Skip. Spend the effort on someone who answers.'
  },
  hard: {
    label: 'Hard to trade with',
    responsiveness: 0.35,
    plan: 'Only worth approaching with a deal that visibly favours them.'
  },
  fair: {
    label: 'Will trade if it is fair',
    responsiveness: 0.75,
    plan: 'Send a near-even deal that fixes a hole on both sides.'
  }
};

/** Stored tiers for a league, defaulting anyone unset to 'fair'. */
export function managerProfiles(leagueId) {
  const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!lg?.payload) return { error: 'league not synced yet' };
  const { formatKey } = deriveFormat(lg);
  const teams = loadRosters(lg, assetUniverse(lg, formatKey));
  const saved = new Map(
    rows('SELECT * FROM manager_profiles WHERE league_id = ?', leagueId)
      .map(p => [p.roster_id, p]));

  return {
    league: lg.name,
    my_roster_id: String(lg.my_team_id ?? ''),
    tiers: Object.entries(TRADEABILITY).map(([id, t]) => ({ id, ...t })),
    managers: teams.map(t => {
      const p = saved.get(t.roster_id);
      return {
        roster_id: t.roster_id, owner: t.owner,
        tradeability: p?.tradeability ?? 'fair',
        notes: p?.notes ?? null,
        is_set: !!p,
        updated_at: p?.updated_at ?? null
      };
    }),
    note: 'Anyone not set is assumed tradeable on a fair deal. Marking a manager ' +
      '"never" removes them from planning entirely rather than ranking them last — ' +
      'a plan built around someone who does not answer is not a plan.'
  };
}

/** Record what you know about a manager. */
export function setManagerProfile(leagueId, rosterId, { tradeability, notes = null, owner = null }) {
  const id = String(rosterId ?? '').trim();
  if (!id) return { error: 'roster id is required' };
  if (!TRADEABILITY[tradeability]) {
    return { error: `unknown tier "${tradeability}" — expected one of ${Object.keys(TRADEABILITY).join(', ')}` };
  }
  const profiles = managerProfiles(leagueId);
  if (profiles.error) return profiles;
  if (!profiles.managers.some(manager => String(manager.roster_id) === id)) {
    return { error: 'roster is not part of this synced league' };
  }
  const cleanNotes = notes == null ? null : String(notes).trim();
  const cleanOwner = owner == null ? null : String(owner).trim();
  if (cleanNotes && cleanNotes.length > 500) return { error: 'notes must be 500 characters or fewer' };
  if (cleanOwner && cleanOwner.length > 160) return { error: 'owner must be 160 characters or fewer' };
  run(`INSERT INTO manager_profiles (league_id, roster_id, owner, tradeability, notes, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(league_id, roster_id) DO UPDATE SET
         tradeability = excluded.tradeability, notes = excluded.notes,
         owner = COALESCE(excluded.owner, manager_profiles.owner),
         updated_at = excluded.updated_at`,
  leagueId, id, cleanOwner || null, tradeability, cleanNotes || null, new Date().toISOString());
  return { ok: true, roster_id: id, tradeability };
}


/**
 * RETIRED 2026-09-18 (trade-engine-correctness, GATE G7).
 *
 * `enumerateDeals`, `acceptProbability`, `pitchFor` and `brainPlan` lived here:
 * a SECOND trade enumerator, a second acceptance model (a tier-based logistic)
 * and a second pitch writer, none of which had a caller outside the orphaned
 * `/brain/plan` route. They disagreed with the trade engine by construction —
 * they never read the counterparty layer (chat sentiment, talk-vs-model,
 * declaration credibility, real accept rates) and were never horizon-weighted,
 * so the same league got two different answers to "what trade should I send".
 *
 * Trade ideas now have ONE source: `trade-engine.js#tradeIdeas` (see its header).
 * The ranked weekly plan across lineup, waivers and trades is being rebuilt as a
 * deterministic service on the Decision Inbox (master plan 00 section D5); it
 * reads `waiver-wire.js#waiverBoard` and `tradeIdeas`, not this file.
 *
 * What stays here, because nothing duplicates it: `brainState` (where you stand),
 * the `TRADEABILITY` tiers and their read/write helpers (the only writer of
 * `manager_profiles`), and `recordNote`.
 */

/**
 * Need per position, on a continuous 0–1 scale rather than a three-way label.
 *
 * `selfScout` buckets a position as strength / average / weakness, which is the
 * right summary for a human reading a page and the wrong input for a search: a
 * good team frequently has no position tagged "weakness" at all, and a planner
 * keyed on that label returns nothing while the same team's own summary says to
 * go and upgrade. That is exactly the failure this replaces.
 *
 * Rank within the league is the honest measure. Fourth of ten at RB is a real
 * need even when fourth of ten is above average, because the three teams ahead
 * of you are the ones you have to beat.
 */
function needProfile(positions) {
  const out = {};
  for (const pos of SKILL) {
    const p = positions?.[pos];
    if (!p || !p.of) continue;
    // 0 = best in the league at this position, 1 = worst.
    const byRank = (p.rank - 1) / Math.max(1, p.of - 1);
    // Ratio to league average, folded in so a league where one position is
    // uniformly flat does not manufacture need out of rank noise alone.
    const byLevel = p.ratio != null ? Math.max(0, Math.min(1, (1.15 - p.ratio) / 0.5)) : byRank;
    out[pos] = {
      need: r3(0.65 * byRank + 0.35 * byLevel),
      rank: p.rank, of: p.of, ratio: p.ratio, status: p.status,
      injury_dropoff: p.injury_dropoff
    };
  }
  return out;
}



/**
 * Where you stand, in one object.
 *
 * Deliberately separate from the plan: "what is wrong with my team" is a
 * question worth answering on its own, and the planner consumes the same answer
 * rather than recomputing a private version of it that can drift.
 */
export function brainState(leagueId, myTeamId = null) {
  const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!lg?.payload) return { error: 'league not synced yet' };

  const scout = selfScout(lg, myTeamId);
  if (scout.error) return scout;

  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  if (!teams.length) return { error: 'league sync contains no rosters yet' };
  const slots = lineupSlots(lg);
  const me = teams.find(t => t.roster_id === String(myTeamId ?? lg.my_team_id)) ?? teams[0];
  if (!me) return { error: 'your roster could not be resolved from the league sync' };

  // League-wide positional scarcity: a weakness at a position everyone is deep
  // at is cheap to fix, and one at a scarce position is not. Same deficit, very
  // different plans, and this is the number that separates them.
  const scarcity = {};
  for (const pos of SKILL) {
    const perTeam = teams.map(t =>
      bestLineup(t.players, slots).slots.filter(s => s.player?.position === pos)
        .reduce((a, s) => a + s.player.adj_ppg, 0));
    const mean = perTeam.reduce((a, b) => a + b, 0) / (perTeam.length || 1);
    const sd = Math.sqrt(perTeam.reduce((a, b) => a + (b - mean) ** 2, 0) / (perTeam.length || 1));
    // Spread relative to level: high means the position separates teams, which
    // is exactly when acquiring it moves your standing.
    scarcity[pos] = { mean: r2(mean), sd: r2(sd), separation: mean ? r3(sd / mean) : 0 };
  }

  const myPoints = bestLineup(me.players, slots).points;
  const ranked = teams.map(t => ({ roster_id: t.roster_id, owner: t.owner,
    points: bestLineup(t.players, slots).points }))
    .sort((a, b) => b.points - a.points);
  const myRank = ranked.findIndex(t => t.roster_id === me.roster_id) + 1;

  // Every position, ranked — not just the ones that tripped a label. A team can
  // be fourth of ten at running back with no "weakness" tag anywhere, and a
  // summary that shows a dash for three of four positions tells you nothing.
  const needs = needProfile(scout.positions ?? {});
  const positionRanks = SKILL.map(pos => ({
    position: pos,
    rank: needs[pos]?.rank ?? null,
    of: needs[pos]?.of ?? null,
    need: needs[pos]?.need ?? null,
    status: needs[pos]?.status ?? 'unknown',
    separation: scarcity[pos].separation,
    injury_dropoff: needs[pos]?.injury_dropoff ?? null
  })).sort((a, b) => (b.need ?? 0) - (a.need ?? 0));

  const weaknesses = SKILL.filter(p => scout.positions?.[p]?.status === 'weakness')
    .map(p => ({ position: p, ...scout.positions[p], separation: scarcity[p].separation }))
    .sort((a, b) => b.separation - a.separation);
  const strengths = SKILL.filter(p => scout.positions?.[p]?.status === 'strength')
    .map(p => ({ position: p, ...scout.positions[p] }));

  return {
    league: lg.name, owner: me.owner, roster_id: me.roster_id,
    model_context: assets.context,
    lineup_points: r2(myPoints), rank: myRank, of: teams.length,
    gap_to_first: r2((ranked[0]?.points ?? myPoints) - myPoints),
    standings: ranked.map((t, i) => ({ ...t, rank: i + 1, points: r2(t.points),
      is_me: t.roster_id === me.roster_id })),
    weaknesses, strengths, scarcity,
    position_ranks: positionRanks,
    /** The position to go shopping for: worst rank, broken by what it buys you. */
    biggest_need: positionRanks[0]?.position ?? null,
    bye_risk: scout.bye_risk ?? [],
    // The honest read, assembled rather than templated, so it changes when the
    // roster does instead of being a sentence someone wrote once.
    summary: weaknesses.length
      ? `You are ${myRank} of ${teams.length}. The gap is at ${weaknesses.map(w => w.position).join(' and ')}` +
        `, and ${weaknesses[0].position} is the one worth paying for — it is the position that most ` +
        `separates good teams from bad ones in this league.`
      : `You are ${myRank} of ${teams.length} with no position below league average, so this is an ` +
        `upgrade problem rather than a patch job. Your softest spot is ${positionRanks[0]?.position} ` +
        `(${positionRanks[0]?.rank} of ${positionRanks[0]?.of}) — above average, and still the place ` +
        `where the teams ahead of you are ahead.`
  };
}



/**
 * The record behind the player a move brings in, as a trailing sentence: the
 * career headline and last season's weekly floor/ceiling when there is one.
 * Empty string when the evidence layers had nothing — the note reads as before.
 */
export function recordNote(move) {
  const p = move?.you_get?.[0];
  const ev = p?.evidence;
  if (!ev) return '';
  const bits = [];
  if (ev.headline) bits.push(ev.headline);
  if (ev.weekly?.floor != null) {
    bits.push(`last year ${ev.weekly.games_15plus} of ${ev.weekly.games} weeks at 15+, ` +
      `floor ${ev.weekly.floor} / ceiling ${ev.weekly.ceiling}`);
  }
  if (ev.preseason?.p20 != null) bits.push(`preseason band ${Math.round(ev.preseason.p20)}–${Math.round(ev.preseason.p80)} pts`);
  if (ev.offseason?.risk) bits.push(`offseason read is a risk (${ev.offseason.drivers?.[0] ?? 'opportunity down'})`);
  return bits.length ? ` The record on ${p.name}: ${bits.join('; ')}.` : '';
}

