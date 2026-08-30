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
import {
  assetUniverse, loadRosters, lineupSlots, bestLineup, evaluate, selfScout
} from './trade-engine.js';
import { waiverUpgrades, sellHigh } from './waiver-brain.js';

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
 * Chance this manager signs this deal.
 *
 * `theirEdgePct` is how much the deal favours them in market value, as a share
 * of the total value crossing the table: 0 is dead even, +20 means they clearly
 * win it, −20 means they are clearly being fleeced.
 *
 * The curve is a logistic centred slightly on their side of even, because a deal
 * that is exactly even by our numbers reads as slightly-losing to the person
 * being asked — endowment effect is the most reliably observed bias in this
 * setting, and ignoring it is why "objectively fair" offers get declined.
 */
export function acceptProbability(tier, { theirEdgePct = 0, theirPpgDelta = 0 } = {}) {
  const t = TRADEABILITY[tier] ?? TRADEABILITY.fair;
  const edge = Number.isFinite(theirEdgePct) ? theirEdgePct : 0;
  const ppg = Number.isFinite(theirPpgDelta) ? theirPpgDelta : 0;

  // Both halves of how a manager reads an offer, on one scale.
  //
  // Value alone is not enough, and using it alone produced the bug this replaced:
  // a package that handed the other side 5.7% more market value while costing
  // their starting lineup a point a week was scored at 62% acceptance. Nobody
  // accepts that; they look at their lineup, see it got worse, and stop reading.
  //
  // The 8× converts points-per-week into the same units as percent-of-value.
  // It is a judgement, not a measurement: it says a full point a week of lineup
  // change weighs about as much as an 8% swing in value. That is roughly the
  // exchange rate implied by the trade engine's own accept/reject thresholds
  // elsewhere in this codebase, and it is stated here so it can be argued with.
  const attractiveness = edge + 8 * ppg;

  // Centred at +6: a deal that is exactly even by our numbers still reads as
  // slightly losing to the person being asked, which is the endowment effect and
  // the most reliable bias in this setting.
  const shaped = 1 / (1 + Math.exp(-(attractiveness - 6) / 12));
  // Market value cannot buy back a lineup crater. This was the exact defect
  // that put Chase Brown -> Joe Burrow first: +38% of abstract value was scored
  // as 67% acceptance even though the recipient lost 0.91 starter points/week.
  // Below zero, consent falls exponentially; positive lineup impact is unchanged.
  const lineupConsent = ppg < 0 ? Math.exp(ppg * 3.2) : 1;
  return r3(Math.max(t.responsiveness * 0.02,
    Math.min(0.97, t.responsiveness * shaped * lineupConsent)));
}

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
 * How much deeper the other side has to be before a position is worth asking for.
 *
 * Stated as a gap between the two teams rather than as two absolute cut-offs
 * ("I am bottom-half AND they are top-third"). The absolute version reads well
 * but is far too strict once need is a continuous estimate with noise in it: on
 * a real ten-team league it left three viable partners and a single candidate
 * deal, because it demanded both teams sit in specific thirds of the league at
 * the same position. What actually matters is simply that they have more of it
 * than I do, by enough that the difference is not measurement noise.
 */
const GAP = 0.15;

/**
 * Do these two rosters have anything to talk about?
 *
 * Multiplied rather than added, deliberately: a trade needs a want on both
 * sides, so a perfect one-way match scores zero rather than scoring half.
 */
function complement(mine, theirs) {
  let iWant = 0, theyWant = 0;
  const wantList = [], giveList = [];
  for (const pos of SKILL) {
    const m = mine[pos], t = theirs[pos];
    if (!m || !t) continue;
    // They are meaningfully deeper here than I am…
    if (m.need - t.need >= GAP) { iWant += m.need - t.need; wantList.push(pos); }
    // …and somewhere else I am deeper than they are, which is what makes it a
    // trade rather than a request.
    if (t.need - m.need >= GAP) { theyWant += t.need - m.need; giveList.push(pos); }
  }
  return {
    i_want: r2(iWant), they_want: r2(theyWant),
    i_want_positions: wantList, they_want_positions: giveList,
    score: r2(Math.sqrt(Math.max(0, iWant) * Math.max(0, theyWant)))
  };
}

/**
 * The Nash bargaining objective: the product of both surpluses.
 *
 * Sum would rank a deal that gives one side everything above a balanced one of
 * the same total. The product will not, which is the whole reason this is the
 * standard solution concept for two-party bargaining — and it matches how a real
 * manager reads an offer.
 */
function nashProduct(myGain, theirGain) {
  if (myGain <= 0 || theirGain <= 0) return 0;   // no deal without mutual surplus
  return r3(myGain * theirGain);
}

/**
 * What taking this player away from this rival is worth beyond my own gain.
 *
 * A league has one winner, so a rival's loss is my gain — but only in proportion
 * to how likely that rival was to beat me. Hurting the last-place team is worth
 * approximately nothing, and every "hurt their weak RB room" suggestion that
 * ignores this is noise dressed as strategy.
 */
function denialValue(theirLineupLoss, theirStrengthRank, teamCount) {
  if (!(theirLineupLoss > 0)) return 0;
  // Linear in threat: the top team gets full weight, the bottom gets none.
  const threat = Math.max(0, (teamCount - theirStrengthRank) / Math.max(1, teamCount - 1));
  return r3(theirLineupLoss * threat);
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
 * The plan: who to target, what to send, and why that person specifically.
 *
 * Ranked by expected value — acceptance probability times what the deal is worth
 * — rather than by what the deal is worth. See the header; this is the point.
 */
export function brainPlan(leagueId, { myTeamId = null, limit = 8 } = {}) {
  const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!lg?.payload) return { error: 'league not synced yet' };

  const state = brainState(leagueId, myTeamId);
  if (state.error) return state;

  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const slots = lineupSlots(lg);
  const me = teams.find(t => t.roster_id === state.roster_id) ?? teams[0];

  const profiles = new Map(
    rows('SELECT * FROM manager_profiles WHERE league_id = ?', leagueId)
      .map(p => [p.roster_id, p]));
  const tierOf = rid => profiles.get(rid)?.tradeability ?? 'fair';

  // Each rival's positional profile, on the same scale as mine, so
  // complementarity is measured rather than asserted.
  const scoutOf = new Map();
  for (const t of teams) {
    const s = selfScout(lg, t.roster_id);
    if (!s.error) scoutOf.set(t.roster_id, needProfile(s.positions ?? {}));
  }
  const strengthRank = new Map(state.standings.map(s => [s.roster_id, s.rank]));

  const partners = [];
  for (const them of teams) {
    if (them.roster_id === me.roster_id) continue;
    const tier = tierOf(them.roster_id);
    const fit = complement(scoutOf.get(me.roster_id) ?? {}, scoutOf.get(them.roster_id) ?? {});
    partners.push({
      roster_id: them.roster_id, owner: them.owner, tier,
      tier_label: TRADEABILITY[tier].label,
      complement: fit,
      rank: strengthRank.get(them.roster_id) ?? null,
      skip: tier === 'never',
      reason: tier === 'never'
        ? TRADEABILITY.never.plan
        : fit.score <= 0
          ? 'No overlap — you are deep and thin in the same places, so there is nothing to swap.'
          : `You want their ${fit.i_want_positions.join('/')}; they want your ${fit.they_want_positions.join('/')}.`
    });
  }

  // Only build packages where a deal could actually happen. This is the Edgeworth
  // filter doing real work: it removes most of the search space before the
  // expensive part, and everything it removes was unsignable anyway.
  const viable = partners.filter(p => !p.skip && p.complement.score > 0)
    .sort((a, b) => b.complement.score - a.complement.score);

  const moves = [];
  const rejected = [];
  for (const p of viable) {
    const them = teams.find(t => t.roster_id === p.roster_id);
    const deals = enumerateDeals(me, them, slots, scoutOf, 2);
    for (const d of deals) {
      const theirNeeds = new Set(SKILL.filter(position => (scoutOf.get(them.roster_id)?.[position]?.need ?? 0) >= 0.55));
      const ev = evaluate({ team: me, gives: d.mine }, { team: them, gives: d.theirs }, slots, { theirNeeds });
      const myGain = ev.me.ppg_delta;
      const theirGain = ev.them.ppg_delta;
      // `their_value_pct` is already the share of crossing value they gain, on
      // exactly the scale acceptProbability expects.
      const theirEdgePct = ev.their_value_pct ?? 0;
      // Rejections are recorded, not discarded.
      //
      // These gates are individually sensible and collectively severe: on a real
      // ten-team league they took 324 candidate one-for-ones down to zero, and a
      // planner that renders an empty page every week is not trustworthy, it is
      // just silent. The honest fix is not to loosen the thresholds until
      // something appears — that would be tuning until the answer is the one we
      // wanted. It is to say what was considered and why each was refused, which
      // is more useful than a recommendation anyway: "nothing qualified, and
      // here are the three that came closest, and what stopped them."
      const near = (reason, detail) => {
        rejected.push({
          partner: p.owner, tier: p.tier,
          you_send: d.mine.map(x => ({ name: x.name, position: x.position })),
          you_get: d.theirs.map(x => ({ name: x.name, position: x.position })),
          my_ppg_gain: r2(myGain), their_ppg_gain: r2(theirGain),
          their_value_edge_pct: r2(theirEdgePct),
          blocked_by: reason, detail
        });
      };

      if (myGain < 0.5) { near('too small for you', `Worth ${r2(myGain)} ppg — under the half-point floor where a trade stops being worth the effort.`); continue; }
      // The engine's own plausibility check already rules out packages that gut
      // the other roster; no reason to re-derive that judgement here.
      if (!ev.plausible) { near('would gut their roster', 'The trade engine rates this implausible for them regardless of price.'); continue; }
      if (ev.red_flags.length) { near('red flag', ev.red_flags.join('; ')); continue; }
      // A recommendation must improve both optimal lineups. Value-only
      // sweeteners are useful as negotiation pieces, but they are not a
      // sendable top-level trade when the other manager gets worse on Sunday.
      if (theirGain <= 0.05) { near('makes their lineup worse', `They lose ${r2(-theirGain)} ppg on Sunday, so this is an ask rather than a trade.`); continue; }
      if (theirEdgePct > 18) { near('you would be overpaying', `They gain ${r2(theirEdgePct)}% of the crossing value — buying a yes rather than earning one.`); continue; }

      // Every player in a recommended package must change at least one side's
      // optimal lineup. This strips the cosmetic throw-ins that made the old
      // page show Waddle + Addison when Waddle alone produced the exact same
      // result, and the equally fake request for a bench player who changes none.
      const removable = [
        ...d.mine.map(player => ({ side: 'mine', player })),
        ...d.theirs.map(player => ({ side: 'theirs', player }))
      ].some(({ side, player }) => {
        const leanMine = side === 'mine' ? d.mine.filter(x => x.id !== player.id) : d.mine;
        const leanTheirs = side === 'theirs' ? d.theirs.filter(x => x.id !== player.id) : d.theirs;
        if (!leanMine.length || !leanTheirs.length) return false;
        const lean = evaluate({ team: me, gives: leanMine }, { team: them, gives: leanTheirs }, slots);
        return lean.me.ppg_delta >= myGain - 0.05 && lean.them.ppg_delta >= theirGain - 0.05;
      });
      if (removable) { near('has a pointless piece', 'One player in this package changes neither lineup, so the same deal works without them.'); continue; }

      const pAccept = acceptProbability(p.tier, { theirEdgePct, theirPpgDelta: theirGain });
      const nash = nashProduct(myGain, theirGain);
      const threat = Math.max(0, (teams.length - (p.rank ?? teams.length)) / Math.max(1, teams.length - 1));
      const rivalTax = r3(theirGain * threat * 0.35);
      // Helping a contender is not free. Rank on expected net lineup gain after
      // charging part of their gain back to us, then use mutual surplus and our
      // raw gain as deterministic tie-breakers below.
      const expected = r3(pAccept * Math.max(0, myGain - rivalTax));
      if (expected < 0.15) {
        near(pAccept < 0.25 ? 'they will not sign it' : 'helps a contender too much',
          pAccept < 0.25
            ? `${p.owner} accepts this about ${Math.round(pAccept * 100)}% of the time, which leaves too little expected value to chase.`
            : `Charging back part of their gain — they are ${p.rank} of ${teams.length} and you have to catch them — leaves only ${expected} ppg expected.`);
        continue;
      }

      moves.push({
        partner: p.owner, partner_roster_id: p.roster_id,
        tier: p.tier, tier_label: p.tier_label,
        you_send: d.mine.map(x => ({ name: x.name, position: x.position, value: x.value })),
        you_get: d.theirs.map(x => ({ name: x.name, position: x.position, value: x.value })),
        my_ppg_gain: r2(myGain), their_ppg_gain: r2(theirGain),
        their_value_edge_pct: r2(theirEdgePct),
        accept_probability: pAccept,
        nash_product: nash,
        rival_tax: rivalTax,
        expected_value: expected,
        grade: expected >= 0.7 && pAccept >= 0.45 ? 'SMASH' : expected >= 0.35 ? 'STRONG' : 'VIABLE',
        pitch: pitchFor(p, d, myGain, theirGain, theirEdgePct)
      });
    }
  }

  moves.sort((a, b) => b.expected_value - a.expected_value
    || b.nash_product - a.nash_product || b.my_ppg_gain - a.my_ppg_gain);

  // At most two offers per manager in the shortlist. Without this one partner
  // whose roster happens to fit yours takes every slot, and a plan that says
  // "text the same guy seven times" is not a plan — the point of ranking by
  // acceptance is to spread the asking across people who might say yes.
  const perPartner = new Map();
  const seenTargetIdeas = new Set();
  const spread = moves.filter(m => {
    const idea = `${m.partner_roster_id}|${m.you_get.map(player => player.name).sort().join('+')}`;
    if (seenTargetIdeas.has(idea)) return false;
    const n = perPartner.get(m.partner_roster_id) ?? 0;
    if (n >= 2) return false;
    seenTargetIdeas.add(idea);
    perPartner.set(m.partner_roster_id, n + 1);
    return true;
  });

  // What the ranking changes, made explicit — the single clearest way to show
  // why this module exists at all.
  const byRawGain = moves.slice().sort((a, b) => b.my_ppg_gain - a.my_ppg_gain)[0];
  const byExpected = moves[0];

  // Waivers, on the same scale.
  //
  // Adding this changed the plan's top recommendation on the first run, which is
  // the argument for it: a free agent worth +1.93 points a week outranked every
  // trade on the board, because nobody has to agree to a waiver claim. The trade
  // planner could not see that, since it only ever looked at trades — a search
  // that is blind to the cheapest move in fantasy football.
  let waiver = { upgrades: [], drop_candidates: [] };
  let selling = { candidates: [] };
  try { waiver = waiverUpgrades(leagueId, { myTeamId, limit: 6 }); } catch { /* optional */ }
  try { selling = sellHigh(leagueId, { myTeamId, limit: 4 }); } catch { /* optional */ }

  const tradeMoves = spread.slice(0, limit).map(m => ({ ...m, kind: 'trade' }));
  const waiverMoves = (waiver.upgrades ?? []).map(u => ({
    kind: 'waiver',
    partner: 'Waiver wire',
    you_get: [{ name: u.player.name, position: u.player.position, value: u.player.value }],
    you_send: u.drop_candidate ? [{ name: u.drop_candidate.name, position: u.drop_candidate.position }] : [],
    my_ppg_gain: u.ppg_gain,
    accept_probability: u.accept_probability,
    expected_value: u.expected_value,
    replaces: u.replaces,
    pitch: { to: 'Nobody', text: u.why, reasoning: u.horizon }
  }));

  // One ranking over both, which is the only way the comparison is honest.
  const allMoves = [...tradeMoves, ...waiverMoves]
    .sort((a, b) => b.expected_value - a.expected_value);
  const topIsWaiver = allMoves[0]?.kind === 'waiver';

  return {
    ...state,
    partners: partners.filter(p => !p.skip),
    unreachable: partners.filter(p => p.skip).map(p => p.owner),
    moves: spread.slice(0, limit),
    moves_considered: moves.length,
    all_moves: allMoves,
    // What was considered and refused, with the gate that stopped it. Ranked by
    // how close it came, so the top of this list is the deal to go and negotiate
    // by hand if you disagree with the machine.
    near_misses: rejected
      .sort((a, b) => (b.my_ppg_gain ?? 0) - (a.my_ppg_gain ?? 0))
      .slice(0, 6),
    considered: rejected.length + moves.length,
    waivers: waiver.upgrades ?? [],
    drop_candidates: waiver.drop_candidates ?? [],
    sell_high: selling.candidates ?? [],
    playoff_weight: waiver.playoff_weight ?? null,
    best_move_note: topIsWaiver
      ? `The best move on the board is not a trade. ${allMoves[0].you_get[0].name} is sitting on ` +
        `waivers and is worth ${allMoves[0].my_ppg_gain} points a week to your lineup — nobody has ` +
        'to agree to that, which is why it outranks every deal below it.'
      : allMoves.length
        ? 'The best available move is a trade, so it depends on someone else saying yes.'
        : 'Nothing on the board improves the lineup right now.',
    ranking_note: byRawGain && byExpected && byRawGain !== byExpected
      ? `Ranked by expected value, not raw gain. The biggest deal on the board is ` +
        `${byRawGain.you_get.map(x => x.name).join(' + ')} from ${byRawGain.partner} at ` +
        `+${byRawGain.my_ppg_gain} ppg, but ${byRawGain.partner} signs it about ` +
        `${Math.round(byRawGain.accept_probability * 100)}% of the time, which makes it worth less ` +
        `than the smaller deal at the top.`
      : 'Ranked by acceptance probability times gain.',
    assumptions: [
      'Acceptance probabilities come from the tier you set for each manager, not from ' +
        'trade history — there is not enough of it in any fantasy league to fit a curve on.',
      'Only deals that improve both optimal lineups are shown. A contender tax discounts ' +
        'the benefit when the other manager is already one of the teams you have to catch.',
      '"Never trades" managers are excluded entirely rather than ranked last.'
    ]
  };
}

/**
 * Candidate packages between two rosters, restricted to what each side needs.
 *
 * Not a full combinatorial search: only players at positions the other side is
 * actually weak at, which is both far smaller and far more realistic than every
 * 2-for-2 permutation.
 */
function enumerateDeals(me, them, slots, scoutOf, max = 2) {
  const myScout = scoutOf.get(me.roster_id) ?? {};
  const theirScout = scoutOf.get(them.roster_id) ?? {};
  // Graded, not binary — see needProfile. A team with no tagged weakness still
  // has a worst position, and that is the one to go shopping for.
  const iNeed = SKILL.filter(p =>
    (myScout[p]?.need ?? 0) - (theirScout[p]?.need ?? 0) >= GAP);
  const theyNeed = SKILL.filter(p =>
    (theirScout[p]?.need ?? 0) - (myScout[p]?.need ?? 0) >= GAP);
  if (!iNeed.length || !theyNeed.length) return [];

  const startersOf = team => new Set(bestLineup(team.players, slots).slots
    .map(s => s.player?.id).filter(Boolean));
  const myStarters = startersOf(me);

  // What I can afford to send: players at positions I am strong at. Seven per
  // side is still a tiny search, but catches the second starter + bench-piece
  // constructions the old five-player, one-target loop could never invent.
  const mine = me.players
    .filter(p => theyNeed.includes(p.position) && p.value > 0)
    .sort((a, b) => b.value - a.value).slice(0, 7);
  const theirs = them.players
    .filter(p => iNeed.includes(p.position) && p.value > 0)
    .sort((a, b) => b.value - a.value).slice(0, 7);
  if (!mine.length || !theirs.length) return [];

  // Keyed by the SET of players on each side, because [Warren, Henry] and
  // [Henry, Warren] are one offer, and shipping both meant the top of the plan
  // was the same trade listed twice.
  const out = new Map();
  const key = d => `${d.mine.map(p => p.id).sort().join(',')}|${d.theirs.map(p => p.id).sort().join(',')}`;
  const add = d => { const k = key(d); if (!out.has(k)) out.set(k, d); };

  const bundles = (players, starters = new Set()) => {
    const result = players.map(player => [player]);
    if (max < 2) return result;
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        // Do not casually package two starters from the same side; those are
        // usually roster-destroying spam and evaluate() will rarely rescue them.
        if (starters.has(players[i].id) && starters.has(players[j].id)) continue;
        result.push([players[i], players[j]]);
      }
    }
    return result;
  };
  const theirStarters = startersOf(them);
  for (const myBundle of bundles(mine, myStarters)) {
    const myValue = myBundle.reduce((sum, player) => sum + player.value, 0);
    for (const theirBundle of bundles(theirs, theirStarters)) {
      const theirValue = theirBundle.reduce((sum, player) => sum + player.value, 0);
      const ratio = theirValue > 0 ? myValue / theirValue : 0;
      if (ratio < 0.6 || ratio > 1.65) continue;
      add({ mine: myBundle, theirs: theirBundle });
    }
  }
  return [...out.values()].slice(0, 160);
}

/** The message you would actually send, in the register a manager reads. */
function pitchFor(partner, deal, myGain, theirGain, theirEdgePct) {
  const get = deal.theirs.map(p => p.name).join(' + ');
  const send = deal.mine.map(p => p.name).join(' + ');
  const framing = theirEdgePct > 8
    ? 'They come out ahead on value, which is what makes it sendable.'
    : theirEdgePct < -8
      ? 'You come out ahead on value — expect a counter rather than an acceptance.'
      : 'Close to even on value, which is the range that gets signed.';
  return {
    to: partner.owner,
    text: `${send} for ${get}. ${theirGain > 0
      ? `It helps you at ${deal.mine[0]?.position} where you are thin, and I need the ${deal.theirs[0]?.position}.`
      : `I need the ${deal.theirs[0]?.position} and can spare ${deal.mine[0]?.position} depth.`}`,
    reasoning: `+${r2(myGain)} ppg for you, ${theirGain >= 0 ? '+' : ''}${r2(theirGain)} for them. ${framing}`
  };
}
