/**
 * A made-up four-team league for the ACQ-01 planner tests. No real data: team
 * ids '1'-'4', players P<id> with invented market values and weekly power.
 * Nick is team '1'.
 *
 * Title odds: each team's strength (sum of its best five players' power) to the
 * sixth power, as a share of the league's. Deterministic, so a delta is exact;
 * the paired SE is a flat 0.003.
 *
 * Built so the IDEA-038 case exists: team 2's star WR (id 11, value 4000) is
 * worth more than any single spare piece Nick has (his best tradable non-QB is
 * 2300), so no 1-for-1 is screen-fair for him, while two mid pieces (2100 +
 * 2000 = 4100) are.
 *
 * Quick value: Nick's strength (the lineup-points stand-in).
 *
 * P(yes): a base rate per team, up 0.1 when he gets more market value than he
 * gives, and up 0.15 when he gets a TE and wants one (team 2). Band = mid +/- 0.1.
 */
export const P = (id, position, value, power) => ({ id, name: `P${id}`, position, value, power });

export function players() {
  return new Map([
    // Nick: a QB he keeps, two mid RBs, mid WRs, a thin bench.
    P(1, 'QB', 3000, 20), P(2, 'RB', 2100, 12), P(3, 'RB', 2000, 11.5), P(4, 'WR', 1200, 6), P(5, 'WR', 2300, 12),
    P(6, 'TE', 900, 5), P(7, 'RB', 700, 4),
    // Team 2: the star WR and a filler.
    P(11, 'WR', 4000, 26), P(12, 'QB', 2500, 17), P(13, 'RB', 1500, 10), P(14, 'WR', 600, 4), P(15, 'RB', 800, 5),
    // Team 3: a good TE and a WR.
    P(21, 'TE', 2200, 11), P(22, 'QB', 2400, 16), P(23, 'WR', 1900, 11), P(24, 'RB', 1000, 6), P(25, 'WR', 700, 4),
    // Team 4: middling.
    P(31, 'WR', 2600, 14), P(32, 'QB', 2200, 15), P(33, 'RB', 1600, 10), P(34, 'TE', 1100, 7), P(35, 'RB', 500, 3),
    // Free agents.
    P(91, 'WR', 1300, 7), P(92, 'RB', 400, 2)
  ].map(p => [p.id, p]));
}

export const ROSTERS = () => new Map([
  ['1', [1, 2, 3, 4, 5, 6, 7]], ['2', [11, 12, 13, 14, 15]], ['3', [21, 22, 23, 24, 25]], ['4', [31, 32, 33, 34, 35]]
]);

export function makeAdapter({ ps = players(), rosters = ROSTERS(), base = { 2: 0.35, 3: 0.55, 4: 0.45 }, wantsTE = new Set(['2']),
  blocked = new Set(), freeAgents = [91, 92], clock = null } = {}) {
  let t = 0;
  const now = clock ?? (() => (t += 1));
  const strength = ids => ids.map(id => ps.get(id)?.power ?? 0).sort((a, b) => b - a).slice(0, 5).reduce((s, x) => s + x, 0);
  const odds = state => {
    const s = new Map([...rosters.keys()].map(k => [k, strength(state.get(k) ?? rosters.get(k))]));
    const tot = [...s.values()].reduce((a, v) => a + v ** 6, 0);
    return new Map([...s].map(([k, v]) => [k, v ** 6 / tot]));
  };
  const before = odds(new Map()).get('1');
  let rescores = 0;
  const value = id => ps.get(id)?.value ?? 0;
  const sum = ids => ids.reduce((a, id) => a + value(id), 0);
  return {
    me: '1',
    teams: [...rosters.keys()],
    blocked,
    freeAgents,
    roster: k => [...rosters.get(k)],
    value,
    tradable: id => ['QB', 'RB', 'WR', 'TE'].includes(ps.get(id)?.position) && value(id) > 0,
    quick: state => strength(state.get('1') ?? rosters.get('1')),
    rescore: state => {
      rescores++;
      const after = odds(state).get('1');
      const d = after - before;
      return { title_before: before, title_after: after, title_delta: d, title_delta_se: 0.003, clears: Math.abs(d) > 0.006 };
    },
    pAccept: (team, theyGive, theyGet) => {
      let p = base[team] ?? 0.3;
      if (sum(theyGet) > sum(theyGive)) p += 0.1;
      if (wantsTE.has(String(team)) && theyGet.some(id => ps.get(id)?.position === 'TE')) p += 0.15;
      p = Math.min(0.95, p);
      return { p, low: Math.max(0.02, p - 0.1), high: Math.min(0.97, p + 0.1), basis: 'fixture' };
    },
    claimP: () => ({ p: 1, basis: 'assumed', reason: 'fixture: claims assumed to land' }),
    now,
    get rescores() { return rescores; }
  };
}

export const nameOf = ps => id => { const p = ps.get(Number(id)); return p ? `${p.name} (${p.position})` : `#${id}`; };
