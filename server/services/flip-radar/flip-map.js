/**
 * FLIP-01: the flip map on an injected world. No DB, no sim; flip-world.js
 * supplies the world from the real league, the tests supply a fixture.
 *
 * For every tradable player p on league-mate A (his top `topPerTeam` by market
 * value) and every other league-mate B:
 *   - what p is worth to B's title odds and to A's (move p from A to B,
 *     rescore): the spread dB + dA, with its paired SE;
 *   - what A and B each price p at (clone price: market value x that
 *     manager's playerValuation multiplier);
 *   - a flip exists when the spread clears 2 SE and B prices p at least as
 *     high as A does (ENGINE-SPECS FLIP-01: "A prices a player low, B prices
 *     him high").
 * The biggest spreads are then realised through Nick with two one-player legs
 * that each look fair on that manager's own screen (FantasyCalc window), each
 * leg priced by the acceptance model and the pair rescored exactly. The map is
 * ranked by spread x P(A) x P(B) x days before the deadline.
 *
 * ctx = {
 *   me, teams: Map<roster_id, player_id[]>, tradable(id), val(id),
 *   move(pid, a, b) -> { dB, seB, dA, seA },          // p from A to B
 *   priceOf(team, pid) -> { price, mult },            // clone price
 *   pAccept(team, theyGive[], theyGet[]) -> number,   // P(he says yes)
 *   nickAdd: Map<pid, delta>, nickLoss: Map<pid, delta>,
 *   legs(a, b, pid, giveA, getB) -> { d1, d2, se2, clears2 },
 *   blocked: Set<roster_id>, days: number | null
 * }
 */
import { flipSpread, screenFair, twoLegExpectation, rankScore } from './flip-score.js';

export const DEFAULTS = Object.freeze({ topPerTeam: 8, realiseMax: 24 });

export function computeFlipMap(ctx, opts = {}) {
  const { topPerTeam, realiseMax } = { ...DEFAULTS, ...opts };
  const { me, teams, tradable, val, blocked = new Set(), days = null } = ctx;
  const pairs = [];
  for (const [aId, ids] of teams) {
    if (aId === me) continue;
    const keyPlayers = ids.filter(tradable).sort((x, y) => val(y) - val(x)).slice(0, topPerTeam);
    for (const pid of keyPlayers) {
      const pa = ctx.priceOf(aId, pid);
      for (const bId of teams.keys()) {
        if (bId === me || bId === aId) continue;
        const m = ctx.move(pid, aId, bId);
        const s = flipSpread(m.dB, m.seB, m.dA, m.seA);
        const pb = ctx.priceOf(bId, pid);
        pairs.push({ player: pid, a: aId, b: bId, dB: m.dB, dA: m.dA, ...s,
          price_a: pa.price, price_b: pb.price, mult_a: pa.mult, mult_b: pb.mult });
      }
    }
  }
  pairs.sort((x, y) => y.spread - x.spread);

  const myIds = (teams.get(me) ?? []).filter(tradable);
  const candidates = pairs.filter(f => f.clears && f.price_b >= f.price_a && !blocked.has(f.a) && !blocked.has(f.b))
    .slice(0, realiseMax);
  const flips = candidates.map(f => {
    const pv = val(f.player);
    // Leg 1: A gives p, gets one of Nick's players, fair on A's screen; the one Nick misses least.
    const giveA = myIds.filter(x => screenFair(val(x), pv))
      .sort((x, y) => (ctx.nickLoss.get(y) ?? 0) - (ctx.nickLoss.get(x) ?? 0))[0];
    // Leg 2: B gives one of his players for p, fair on B's screen; the one Nick gains most from.
    const getB = (teams.get(f.b) ?? []).filter(tradable).filter(y => screenFair(pv, val(y)))
      .sort((x, y) => (ctx.nickAdd.get(y) ?? 0) - (ctx.nickAdd.get(x) ?? 0))[0];
    if (giveA == null || getB == null) {
      return { ...f, legs: null, legs_why_not: 'no one-player leg fair on both screens', rank_score: 0 };
    }
    const p1 = ctx.pAccept(f.a, [f.player], [giveA]);
    const p2 = ctx.pAccept(f.b, [getB], [f.player]);
    const r = ctx.legs(f.a, f.b, f.player, giveA, getB);
    const e = twoLegExpectation(p1, r.d1, p2, r.d2);
    return { ...f, legs: { give_a: giveA, get_b: getB, p1, p2, ...e, d1: r.d1, d2: r.d2, se2: r.se2, clears2: r.clears2 },
      rank_score: rankScore({ spread: f.spread, p1, p2, days }) };
  });
  // Realised flips first, by the spec's rank; the unrealised after them, by spread.
  flips.sort((x, y) => (y.legs ? 1 : 0) - (x.legs ? 1 : 0) || y.rank_score - x.rank_score || y.spread - x.spread);
  return { pairs, flips, days, managers: managerPrices(pairs) };
}

/**
 * Per league-mate: his price for each of his own key players vs what that
 * player is worth to his title odds (minus the mean dA over every buyer).
 */
export function managerPrices(pairs) {
  const acc = new Map();
  for (const f of pairs) {
    const byPlayer = acc.get(f.a) ?? acc.set(f.a, new Map()).get(f.a);
    const cur = byPlayer.get(f.player) ?? { player: f.player, price: f.price_a, mult: f.mult_a, sum: 0, n: 0 };
    cur.sum += -f.dA; cur.n++;
    byPlayer.set(f.player, cur);
  }
  return Object.fromEntries([...acc].map(([team, m]) => [team,
    [...m.values()].map(({ sum, n, ...r }) => ({ ...r, title_value: sum / n }))]));
}
