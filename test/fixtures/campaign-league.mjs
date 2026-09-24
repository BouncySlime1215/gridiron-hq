/**
 * A made-up four-team league for the campaign producer tests. No real data:
 * team ids 1-4, players "P1".."P20" with invented values. Nick is team 1.
 *
 * The fake world scores a roster by the sum of its best five players' power;
 * title odds are each team's strength^6 share, plus a small seed-dependent
 * wobble so different seeds give (slightly) different dice. Every world a
 * test builds is recorded in `worldsBuilt` (the seeds), so a test can check
 * the confirm pass used a different seed.
 */
const P = (id, position, value, power, extra = {}) => ({ id, name: `P${id}`, position, value, power, ros_ppg: power, injury: 0, bye: null, trend_kind: null, ...extra });

export function makePlayers() {
  return new Map([
    // Nick (team 1): solid depth, weak WR.
    P(1, 'QB', 3000, 20), P(2, 'RB', 2600, 15), P(3, 'RB', 2200, 13), P(4, 'WR', 1400, 8), P(5, 'TE', 1500, 9),
    P(6, 'RB', 1500, 9, { bye: 6 }), P(7, 'WR', 1300, 7),
    // Team 2: the star WR (hard to get: low receptiveness).
    P(11, 'WR', 4200, 24), P(12, 'QB', 2400, 17), P(13, 'RB', 1800, 11), P(14, 'TE', 1200, 7), P(15, 'WR', 1100, 6),
    // Team 3: a good WR, eager trader.
    P(21, 'WR', 2600, 14), P(22, 'QB', 2300, 16), P(23, 'RB', 1700, 10), P(24, 'TE', 1000, 6), P(25, 'RB', 900, 5),
    // Team 4: middling, one injured WR.
    P(31, 'WR', 2500, 13, { injury: 1 }), P(32, 'QB', 2200, 15), P(33, 'RB', 1600, 10), P(34, 'TE', 1300, 8), P(35, 'WR', 800, 5),
  ].map(p => [p.id, p]));
}

const ROSTERS = () => new Map([
  ['1', [1, 2, 3, 4, 5, 6, 7]], ['2', [11, 12, 13, 14, 15]], ['3', [21, 22, 23, 24, 25]], ['4', [31, 32, 33, 34, 35]],
]);

function hash(...parts) {
  let h = 0x811c9dc5;
  for (const s of parts.map(String)) for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export function makeAdapter({ seed = 12345, receptiveness = { 2: 0.3, 3: 1.3, 4: 1.0 }, sent = {}, managerExtra = {}, players = makePlayers() } = {}) {
  const rosters = ROSTERS();
  const worldsBuilt = [];
  const strength = ids => ids.map(id => players.get(id)?.power ?? 0).sort((a, b) => b - a).slice(0, 5).reduce((s, x) => s + x, 0);
  const build = s => {
    const odds = (state, kind) => {
      const str = new Map([...rosters.keys()].map(t => [t, strength(state.get(t) ?? rosters.get(t))]));
      const k = kind === 'title' ? 6 : 3;
      const tot = [...str.values()].reduce((a, v) => a + v ** k, 0);
      const key = JSON.stringify([...state.entries()].sort());
      return new Map([...str].map(([t, v]) => [t, v ** k / tot + ((hash(s, key, t, kind) % 1000) / 1000 - 0.5) * 0.004]));
    };
    const base = { title: odds(new Map(), 'title'), playoff: odds(new Map(), 'playoff') };
    const block = (t, st) => {
      const tb = base.title.get(t), ta = st.title.get(t), pb = base.playoff.get(t), pa = st.playoff.get(t);
      return { roster_id: t, title_before: tb, title_after: ta, title_delta: ta - tb, title_delta_se: 0.003,
        title_delta_clears_noise: Math.abs(ta - tb) > 0.006, playoff_before: pb, playoff_after: pa,
        playoff_delta: pa - pb, playoff_delta_se: 0.004, playoff_delta_clears_noise: Math.abs(pa - pb) > 0.008 };
    };
    const weekly = ids => {
      const out = [];
      for (let w = 4; w <= 8; w++) {
        const samples = [];
        for (let r = 0; r < 200; r++) {
          const onBye = ids.filter(id => players.get(id)?.bye === w).map(id => players.get(id).power).reduce((a, b) => a + b, 0);
          samples.push(strength(ids) * 1.5 - onBye + ((hash(s, w, r) % 2000) / 100 - 10));
        }
        out.push({ week: w, samples });
      }
      return out;
    };
    const pointsOf = ids => strength(ids) * 1.5;
    return {
      seed: s,
      rescore(state, a = '1', b = null) {
        const st = { title: odds(state, 'title'), playoff: odds(state, 'playoff') };
        const other = b ?? [...state.keys()].find(id => id !== a) ?? '2';
        const me = block(a, st);
        const before = pointsOf(rosters.get(a)), after = pointsOf(state.get(a) ?? rosters.get(a));
        Object.assign(me, { points_before: before, points_delta: after - before, points_delta_se: 0.5, points_delta_clears: Math.abs(after - before) > 1 });
        return { me, them: block(other, st) };
      },
      weekly,
    };
  };
  // The planner's worlds are recorded; the finder and probe hooks below build theirs unrecorded.
  const world = s => { worldsBuilt.push(s); return build(s); };
  const managers = new Map(['2', '3', '4'].map(t => [t, {
    receptiveness: receptiveness[t] ?? 1, needs: t === '3' ? ['RB'] : ['WR'], blocked: false, checked_out: false,
    title_now: null, sent_this_week: sent[t] ?? 0, send_when: { when: 'now', why: 'nothing argues for waiting' },
    chat: { engagement: 'unknown', tone: 'unknown', open_to_trade: 'unknown', no_holds: 'unknown', loves: [], hates: [], messages: 0, source: 'chat', status: 'unknown' },
    ...(managerExtra[t] ?? {}),
  }]));
  const priceStep = (team, theyGive, theyGet) => {
    const v = ids => ids.reduce((s, id) => s + (players.get(id)?.value ?? 0), 0);
    const ratio = v(theyGet) / Math.max(1, v(theyGive));
    const r = managers.get(String(team))?.receptiveness ?? 1;
    const p = Math.max(0.02, Math.min(0.97, (0.3 + 0.9 * (ratio - 1)) * r));
    return { p, band: { low: Math.max(0, p - 0.08), high: Math.min(1, p + 0.08) }, basis: 'heuristic_unanchored' };
  };
  // The fake "Trade Lab finder": the best p x title delta over every one-for-one swap, on the planning seed.
  const finderBest = () => {
    const w = build(seed);
    let best = null, n = 0;
    for (const [team, ids] of rosters) {
      if (team === '1') continue;
      for (const give of rosters.get('1')) {
        for (const get of ids) {
          const state = new Map([['1', [...rosters.get('1').filter(x => x !== give), get]], [team, [...ids.filter(x => x !== get), give]]]);
          const r = w.rescore(state, '1', team).me;
          const p = priceStep(team, [get], [give]).p;
          n++;
          if (!best || p * r.title_delta > best.expected) best = { expected: p * r.title_delta, se: p * r.title_delta_se, n: 0 };
        }
      }
    }
    return best && { ...best, n };
  };
  // The composed-rescore probe: a one-for-one applied as a roster state scores the same as the same deal rescored again.
  const sanity = () => {
    const state = new Map([['1', [11, 2, 3, 4, 5, 6, 7]], ['2', [1, 12, 13, 14, 15]]]);
    return build(seed).rescore(state, '1', '2').me.title_after === build(seed).rescore(new Map(state), '1', '2').me.title_after;
  };
  return {
    // NO-OVERPAY: this fixture's worlds predate Nick's cap on market value given; they plan uncapped
    // (the cap itself is covered by test/campaign-no-overpay.test.js).
    maxOverpay: Infinity,
    league: { id: 99, me: '1', fetched_at: 'fixture', week: 4, deadline_week: 8, days_left_in_week: 3, team_count: 4 },
    seed, world, worldsBuilt, rosters, players, managers,
    starters: new Set([1, 2, 3, 4, 5]),
    freeAgents: [{ id: 41, name: 'P41', position: 'WR', ros_ppg: 9.5 }, { id: 42, name: 'P42', position: 'TE', ros_ppg: 4 }],
    priceStep, finderBest, sanity, priceOf: (team, id) => ({ mult: 1, price: players.get(id)?.value ?? 0 }),
    names: () => Object.fromEntries([...players.values()].map(p => [String(p.id), `${p.name} (${p.position})`])),
    // TEAM-NAMES: synthetic only (public repo); a label of 'Team N' renders exactly as before.
    teams: () => Object.fromEntries([...rosters.keys()].map(t => [t, { name: `Team ${t}` }])),
  };
}
