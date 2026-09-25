/**
 * U7 GAME-SHOCKS-CHECK: the held-out tail check that decides GRIDIRON_GAME_SHOCKS.
 * Pre-registration: docs/tdd/2026-09-25-u7-game-shocks-heldout.tdd.md.
 *
 * Archetype correlations come from a train window only. On the held-out season, the
 * empirical same-game conditional co-exceedance P(U_j > q | U_i > q) is compared with
 * what the Gaussian copula (shocks off) and the grouped-t copula with one shared
 * chi2(nu)/nu shock per game (on) predict. Each prediction simulates the held-out season
 * itself: the same games, the same players, the same per-player-season cut, so the
 * small-sample bias of a 17-game cut is in both sides. The interval on "on is closer
 * than off" is a bootstrap over held-out games.
 *
 * Measurement only: nothing here is served, and nothing here turns the flag on.
 */
import {
  archetypeCorrelations, clampCorrelation, pairArchetype, gameShockScale, CORRELATION_DEFAULTS, GAME_SHOCK_NU
} from './correlation.js';
import { cholesky, correlatedNormals, keyedNormal, keyedSeed } from './stats-util.js';

const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);

/**
 * One row of nflverse `stats_player_week_<season>.csv` in the shape residualsFromLog
 * reads (the columns player_week_usage carries). Regular season QB/RB/WR/TE only; any
 * other row is null. Ids are nflverse gsis ids; names are never read.
 */
export function nflverseWeekRow(header, record) {
  const at = name => { const i = header.indexOf(name); return i < 0 ? '' : record[i]; };
  const num = name => Number(at(name)) || 0;
  if (at('season_type') !== 'REG' || !SKILL.has(at('position')) || !at('team') || !at('opponent_team')) return null;
  return {
    player_id: at('player_id'), season: num('season'), week: num('week'),
    team: at('team'), opponent: at('opponent_team'), position: at('position'),
    passing_yards: num('passing_yards'), passing_tds: num('passing_tds'), interceptions: num('passing_interceptions'),
    rushing_yards: num('rushing_yards'), rushing_tds: num('rushing_tds'),
    receptions: num('receptions'), receiving_yards: num('receiving_yards'), receiving_tds: num('receiving_tds'),
    fumbles_lost: num('sack_fumbles_lost') + num('rushing_fumbles_lost') + num('receiving_fumbles_lost')
  };
}

/** The tailCoexceedance cut rule: strictly above `sorted[ceil(q n) - 1]` is the top share. */
const cutOf = (values, q) => {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
};

/** Each (player, season)'s q cut on z in the held-out games. */
function seasonCuts(games, q) {
  const zs = new Map();
  for (const list of games.values()) for (const u of list) {
    const k = `${u.player_id}|${u.season}`;
    (zs.get(k) ?? zs.set(k, []).get(k)).push(u.z);
  }
  return new Map([...zs].map(([k, a]) => [k, cutOf(a, q)]));
}

/** Same-game pairs of one game, with whether each is a same-team QB-WR pair. */
function pairsOf(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (a.player_id === b.player_id) continue;
    out.push([i, j, pairArchetype(a, b) === 'QB|WR|team']);
  }
  return out;
}

/** Per-group sums over one game's pairs, given each player's exceedance flag: [2 * both, either count, pairs]. */
function tally(pairs, ex) {
  const g = { qb_wr_team: [0, 0, 0], same_game: [0, 0, 0] };
  for (const [i, j, qbwr] of pairs) {
    const both = 2 * ex[i] * ex[j], one = ex[i] + ex[j];
    g.same_game[0] += both; g.same_game[1] += one; g.same_game[2]++;
    if (qbwr) { g.qb_wr_team[0] += both; g.qb_wr_team[1] += one; g.qb_wr_team[2]++; }
  }
  return g;
}

/**
 * The model side: `reps` simulated copies of the held-out season, Gaussian (off) and
 * grouped-t (on) on common random numbers, each put through the empirical side's cut.
 * Returns per game and group the average [2 * both, either count] per season copy.
 */
function simulateSeasonCopies(games, pairs, rhoOf, { q, nu, reps, key }) {
  const Ls = games.map(list => cholesky(list.map(a => list.map(b => (a === b ? 1 : rhoOf(a, b))))));
  const fallbacks = Ls.filter(L => L.fallbackIdentity).length;
  const slots = new Map();   // player|season -> [[game, index]]
  games.forEach((list, g) => list.forEach((u, i) => {
    const k = `${u.player_id}|${u.season}`;
    (slots.get(k) ?? slots.set(k, []).get(k)).push([g, i]);
  }));
  const out = { off: games.map(() => ({ qb_wr_team: [0, 0], same_game: [0, 0] })), on: games.map(() => ({ qb_wr_team: [0, 0], same_game: [0, 0] })) };
  for (let r = 0; r < reps; r++) {
    const k = keyedSeed(key, 'u7-season', r);
    const zOff = games.map((list, g) => correlatedNormals(Ls[g], list.map((_, i) => keyedNormal(keyedSeed(k, g), i))));
    // One shock per game: every player in it is divided by the same sqrt(W).
    const zOn = zOff.map((z, g) => { const s = gameShockScale(k, String(g), 0, nu); return z.map(x => x * s); });
    for (const [arm, vals] of [['off', zOff], ['on', zOn]]) {
      const ex = games.map(list => new Array(list.length).fill(0));
      for (const places of slots.values()) {
        const cut = cutOf(places.map(([g, i]) => vals[g][i]), q);
        for (const [g, i] of places) if (vals[g][i] > cut) ex[g][i] = 1;
      }
      games.forEach((_, g) => {
        const t = tally(pairs[g], ex[g]);
        for (const grp of GROUPS) { out[arm][g][grp][0] += t[grp][0] / reps; out[arm][g][grp][1] += t[grp][1] / reps; }
      });
    }
  }
  return { ...out, fallbacks };
}

/** A small keyed PRNG for the bootstrap (uniform in [0, 1)). */
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const GROUPS = ['qb_wr_team', 'same_game'];

/**
 * The U7 check. `train` and `test` are residualsFromLog outputs over disjoint season
 * windows. Returns, per group, the pair and tail-event counts, the empirical and model
 * conditional co-exceedance, the improvement `diff = |emp - off| - |emp - on|` with its
 * 95% game-bootstrap interval, and the pre-registered verdict.
 */
export function heldOutTailCheck(train, test, { q = 0.9, nu = GAME_SHOCK_NU, reps = 400, B = 2000, key = 7 } = {}) {
  const fitted = archetypeCorrelations(train);
  const rhoOf = (a, b) => {
    const f = fitted.get(pairArchetype(a, b));
    return f ? clampCorrelation(f.r) : CORRELATION_DEFAULTS[a.team === b.team ? 'team' : 'opp'];
  };
  const games = [...test.values()];
  const pairs = games.map(pairsOf);

  // Empirical side: each player's own cut in the held-out season.
  const cuts = seasonCuts(test, q);
  const emp = games.map((list, g) => tally(pairs[g], list.map(u => (u.z > cuts.get(`${u.player_id}|${u.season}`) ? 1 : 0))));
  const model = simulateSeasonCopies(games, pairs, rhoOf, { q, nu, reps, key });

  // Per game and group: [emp 2*both, emp either, off 2*both, off either, on 2*both, on either, pairs].
  const perGame = games.map((_, g) => Object.fromEntries(GROUPS.map(grp => [grp, [
    emp[g][grp][0], emp[g][grp][1], model.off[g][grp][0], model.off[g][grp][1], model.on[g][grp][0], model.on[g][grp][1], emp[g][grp][2]
  ]])));
  const ratio = (n, d) => (d ? n / d : 0);
  const stat = v => {
    const e = ratio(v[0], v[1]), off = ratio(v[2], v[3]), on = ratio(v[4], v[5]);
    return { emp: e, off, on, diff: Math.abs(e - off) - Math.abs(e - on) };
  };
  const W = 7;

  const groups = {};
  for (const grp of GROUPS) {
    const total = new Array(W).fill(0);
    for (const acc of perGame) for (let i = 0; i < W; i++) total[i] += acc[grp][i];
    const point = stat(total);
    const rand = mulberry32(keyedSeed(key, 'u7-boot', grp));
    const diffs = [];
    for (let r = 0; r < B; r++) {
      const v = new Array(W).fill(0);
      for (let n = 0; n < perGame.length; n++) {
        const acc = perGame[Math.floor(rand() * perGame.length)][grp];
        for (let i = 0; i < W; i++) v[i] += acc[i];
      }
      diffs.push(stat(v).diff);
    }
    diffs.sort((x, y) => x - y);
    const pct = p => diffs[Math.min(B - 1, Math.max(0, Math.floor(p * B)))];
    groups[grp] = {
      pairs: total[6], events: total[1],
      ce_emp: point.emp, ce_off: point.off, ce_on: point.on,
      diff: point.diff, ci: [pct(0.025), pct(0.975)]
    };
  }
  return { q, nu, reps, games: games.length, cholesky_fallbacks: model.fallbacks, groups, verdict: heldOutVerdict(groups) };
}

/**
 * The pre-registered bar: per group, the interval's lower bound is above 0 and the
 * shocks-on rate is at most 25% above the empirical one; overall only if both pass.
 */
export function heldOutVerdict(groups) {
  const out = {};
  let pass = true;
  for (const g of GROUPS) {
    const v = groups[g];
    let r;
    if (!v || !v.events) r = { pass: false, reason: 'no tail events in the held-out season' };
    else if (!(v.ci[0] > 0)) r = { pass: false, reason: `shocks-on not clearly closer (95% interval ${v.ci[0].toFixed(4)} to ${v.ci[1].toFixed(4)})` };
    else if (v.ce_on > 1.25 * v.ce_emp) r = { pass: false, reason: `shocks-on overshoots the held-out rate by ${((v.ce_on / v.ce_emp - 1) * 100).toFixed(0)}%` };
    else r = { pass: true, reason: 'closer out of sample, interval above 0, within +25%' };
    out[g] = r;
    pass &&= r.pass;
  }
  return { pass, groups: out };
}
