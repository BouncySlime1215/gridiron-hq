/**
 * RULE-FUZZ: a seeded generator of made-up leagues for the property tests in test/rule-fuzz.test.js.
 * No real data: team ids are small integers, every player but Nick's pinned four is "P<id>", values,
 * powers and board scores are drawn from the seed. The pinned four carry their real NFL names and the
 * ids Nick's rules name (ONE-PLAN 10b): Nico Collins 160, Chase Brown 80 and A.J. Brown 277 on
 * Nick's roster; Chris Olave (290, the id #394 pins) on someone else's.
 *
 * One seed -> one league, byte for byte: the RNG is mulberry32, the world's dice are a hash of the
 * seed and the state (the same shape as test/fixtures/campaign-league.mjs). A failing seed printed by
 * the test rebuilds the exact league with makeFuzzLeague(seed).
 *
 * The adapter carries every input the rule PRs read, so the same league exercises them once merged:
 *   untouchable   Nick's 'untouchable:' notes (FIX-02c reader). `notes` false leaves them out: the
 *                 pinned-id rule (#381 never-give.js) must hold without them.
 *   scoreOf       id -> { score, label, consistent } (GETS-FLOOR #381 reads score/label; `consistent`
 *                 is the A.J. Brown rule's weekly-scorer read, assumed: no PR defines it yet).
 *   blueChips     ids scoring 83+ (CAP-1C #382's board).
 *   tradeLedger   this season's executed trades, { now, trades: [{ tx_id, at, moves }], valueAt }
 *                 (TRADE-MEMORY #379's shape).
 *   claims        (option, FLIP-CLAIMS) a free-agent pool for SEARCH-WIDE: CLAIM_FAS free agents
 *                 "P3000".. drawn from their own RNG (so every other draw of the seed is unchanged),
 *                 simulated as the world's claim universe, and a waiver record for the claim P(yes).
 *                 One of them is sometimes a player Nick sold this season (never claimable).
 */
export const NICO_COLLINS = 160;
export const CHASE_BROWN = 80;
export const AJ_BROWN = 277;
/** The planner id #394 pins for Olave; the oracle also matches the name. */
export const OLAVE_ID = 290;
export const BLUE_CHIP = 83;
/** FLIP-CLAIMS: free agents in a claims league (ids 3000..). */
export const CLAIM_FAS = 10;
const DAY = 864e5;
const NOW = Date.parse('2026-09-24T12:00:00Z');

/** mulberry32: a 32-bit seeded RNG, [0, 1). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(...parts) {
  let h = 0x811c9dc5;
  for (const s of parts.map(String)) for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

const POS = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE'];
const labelOf = s => (s >= BLUE_CHIP ? 'Blue chip' : s >= 74 ? 'Level below' : 'Depth');

/**
 * One league from one seed. Options override the draw (tests use them to force a case):
 *   teams, notes (Nick's untouchable notes present), ajOnRoster, olaveTarget (Olave is the best WR
 *   out there), ledger (season trades present).
 */
export function makeFuzzLeague(seed, opts = {}) {
  const r = rng(seed);
  const pick = a => a[Math.floor(r() * a.length)];
  const between = (lo, hi) => lo + (hi - lo) * r();
  const teams = opts.teams ?? 4 + Math.floor(r() * 5);
  const me = String(1 + Math.floor(r() * teams));
  const notes = opts.notes ?? r() < 0.5;
  const ajOn = opts.ajOnRoster ?? r() < 0.8;
  const olaveTarget = opts.olaveTarget ?? r() < 0.5;
  const withLedger = opts.ledger ?? r() < 0.8;

  const players = new Map();
  const add = (id, position, extra = {}) => {
    const score = extra.score ?? Math.round(between(35, 99));
    const value = extra.value ?? Math.round(Math.max(20, (score - 30) ** 2 * between(1.2, 1.6)));
    const power = extra.power ?? Math.max(1, value / 400 + between(-2, 2));
    const consistent = extra.consistent ?? (score >= BLUE_CHIP ? r() < 0.6 : r() < 0.3);
    players.set(id, { id, name: extra.name ?? `P${id}`, position, value, power, ros_ppg: power, score, consistent,
      injury: extra.injury ?? 0, bye: null, trend_kind: null });
    return id;
  };
  const rosters = new Map();
  let next = 1000;
  for (let t = 1; t <= teams; t++) {
    const n = 7 + Math.floor(r() * 5);
    const ids = [];
    for (let i = 0; i < n; i++) ids.push(add(next++, pick(POS)));
    rosters.set(String(t), ids);
  }
  // Nick's pinned players: always Nico Collins and Chase Brown; A.J. Brown most of the time.
  const mine = rosters.get(me);
  mine.push(add(NICO_COLLINS, 'WR', { name: 'Nico Collins', score: Math.round(between(84, 95)), value: Math.round(between(4200, 6500)), consistent: true }));
  mine.push(add(CHASE_BROWN, 'RB', { name: 'Chase Brown', score: Math.round(between(84, 95)), value: Math.round(between(4800, 6800)), consistent: true }));
  if (ajOn) mine.push(add(AJ_BROWN, 'WR', { name: 'A.J. Brown', score: Math.round(between(78, 92)), value: Math.round(between(1800, 6000)),
    injury: r() < 0.5 ? 1 : 0, consistent: r() < 0.5 }));
  // Olave on another roster; half the time he is priced as the best WR Nick could reach.
  const others = [...rosters.keys()].filter(t => t !== me);
  const olaveTeam = pick(others);
  rosters.get(olaveTeam).push(add(OLAVE_ID, 'WR', { name: 'Chris Olave', score: Math.round(between(80, 92)),
    value: Math.round(olaveTarget ? between(5200, 6400) : between(1500, 4000)), power: olaveTarget ? between(18, 26) : undefined }));

  // This season's executed trades: Nick sold Olave to his holder (9/17), plus 0-3 more Nick trades.
  const trades = [];
  const priceThen = new Map();
  if (withLedger) {
    const sold = { tx_id: 'tx-olave', at: NOW - 7 * DAY, moves: [{ player: OLAVE_ID, from: me, to: olaveTeam }] };
    // A player moves in at most one trade, so the ledger reads as one season.
    const used = new Set([NICO_COLLINS, CHASE_BROWN, AJ_BROWN, OLAVE_ID]);
    const back = mine.find(id => !used.has(id));
    if (back != null) { sold.moves.push({ player: back, from: olaveTeam, to: me }); used.add(back); }
    trades.push(sold);
    priceThen.set(OLAVE_ID, players.get(OLAVE_ID).value * between(0.95, 1.2));
    const k = Math.floor(r() * 4);
    for (let i = 0; i < k; i++) {
      const t = pick(others);
      const theirs = rosters.get(t).filter(id => !used.has(id));
      const ours = mine.filter(id => !used.has(id));
      if (!theirs.length || !ours.length) continue;
      const sent = pick(theirs), got = pick(ours);
      used.add(sent); used.add(got);
      trades.push({ tx_id: `tx-${seed}-${i}`, at: NOW - Math.floor(between(1, 20)) * DAY,
        moves: [{ player: sent, from: me, to: t }, { player: got, from: t, to: me }] });
      priceThen.set(sent, players.get(sent).value * between(0.8, 1.2));
      priceThen.set(got, players.get(got).value * between(0.8, 1.2));
    }
    trades.sort((a, b) => a.at - b.at);
  }

  const starters = new Set([...mine].sort((a, b) => players.get(b).power - players.get(a).power).slice(0, 6));
  const strength = ids => ids.map(id => players.get(id)?.power ?? 0).sort((a, b) => b - a).slice(0, 6).reduce((s, x) => s + x, 0);
  const worldsBuilt = [];
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
    const pointsOf = ids => strength(ids) * 1.5;
    return {
      seed: s,
      rescore(state, a = me, b = null) {
        const st = { title: odds(state, 'title'), playoff: odds(state, 'playoff') };
        const other = b ?? [...state.keys()].find(id => id !== a) ?? others[0];
        const out = block(a, st);
        const before = pointsOf(rosters.get(a)), after = pointsOf(state.get(a) ?? rosters.get(a));
        Object.assign(out, { points_before: before, points_delta: after - before, points_delta_se: 0.5, points_delta_clears: Math.abs(after - before) > 1 });
        return { me: out, them: block(other, st) };
      },
    };
  };
  const world = s => { worldsBuilt.push(s); return build(s); };
  const managers = new Map(others.map(t => [t, {
    receptiveness: between(0.5, 1.5), needs: [pick(['QB', 'RB', 'WR', 'TE'])], blocked: false, checked_out: false,
    title_now: null, sent_this_week: 0, send_when: { when: 'now', why: 'nothing argues for waiting' },
    chat: { engagement: 'unknown', tone: 'unknown', open_to_trade: 'unknown', no_holds: 'unknown', loves: [], hates: [], messages: 0, source: 'chat', status: 'unknown' },
  }]));
  const priceStep = (team, theyGive, theyGet) => {
    const v = ids => ids.reduce((s, id) => s + (players.get(id)?.value ?? 0), 0);
    const ratio = v(theyGet) / Math.max(1, v(theyGive));
    const rr = managers.get(String(team))?.receptiveness ?? 1;
    const p = Math.max(0.02, Math.min(0.97, (0.3 + 0.9 * (ratio - 1)) * rr));
    return { p, band: { low: Math.max(0, p - 0.08), high: Math.min(1, p + 0.08) }, basis: 'heuristic_unanchored' };
  };
  // FLIP-CLAIMS: the free-agent pool, from its own RNG (the league's other draws are the seed's as before).
  const freeAgents = [];
  if (opts.claims) {
    const r2 = rng((seed * 7919 + 17) >>> 0);
    const b2 = (lo, hi) => lo + (hi - lo) * r2();
    for (let i = 0; i < CLAIM_FAS; i++) {
      const id = 3000 + i;
      const score = Math.round(b2(35, 92));
      const value = Math.round(Math.max(20, (score - 30) ** 2 * b2(1.2, 1.6)));
      const power = Math.max(1, value / 400 + b2(-2, 2));
      players.set(id, { id, name: `P${id}`, position: POS[Math.floor(r2() * POS.length)], value, power, ros_ppg: power, score,
        consistent: r2() < 0.3, injury: 0, bye: null, trend_kind: null });
      freeAgents.push(id);
    }
    // Sometimes Nick sold one of them earlier this season (since released): never claimable.
    if (withLedger && r2() < 0.5) trades.push({ tx_id: `tx-${seed}-fa`, at: NOW - 12 * DAY, moves: [{ player: 3000, from: me, to: others[0] }] });
  }
  const scoreOf = id => {
    const p = players.get(Number(id));
    return p ? { score: p.score, label: labelOf(p.score), consistent: p.consistent } : null;
  };
  return {
    seed,
    draw: { teams, me, notes, aj_on_roster: ajOn, olave_target: olaveTarget, olave_team: olaveTeam, ledger: withLedger, trades: trades.length },
    league: { id: 4000 + (seed % 1000), me, fetched_at: `fuzz-${seed}`, week: 4, deadline_week: 11, days_left_in_week: 3, team_count: teams },
    world, worldsBuilt, rosters, players, managers, starters,
    untouchable: notes ? new Set([String(NICO_COLLINS), String(CHASE_BROWN)]) : new Set(),
    scoreOf,
    blueChips: new Set([...players.values()].filter(p => p.score >= BLUE_CHIP).map(p => String(p.id))),
    tradeLedger: withLedger ? { now: NOW, trades, valueAt: id => priceThen.get(Number(id)) ?? null } : null,
    freeAgents: freeAgents.map(id => ({ id, name: players.get(id).name, position: players.get(id).position, ros_ppg: players.get(id).ros_ppg })),
    ...(opts.claims ? { claimUniverse: new Set(freeAgents.map(String)), waiverRecord: { won: 14, lost: 6 } } : {}),
    priceStep, priceOf: (team, id) => ({ mult: 1, price: players.get(id)?.value ?? 0 }),
    names: () => Object.fromEntries([...players.values()].map(p => [String(p.id), `${p.name} (${p.position})`])),
    teams: () => Object.fromEntries([...rosters.keys()].map(t => [t, { name: `Team ${t}` }])),
  };
}
