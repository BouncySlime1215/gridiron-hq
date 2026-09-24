// PROJ-02-a sharp chain: the pre-registered per-link grade
// (docs/evidence/2026-09-23/proj-02-a-sharp-chain-preregistration.md section 3).
//
// Run on a LOCAL COPY of the app database, never production:
//   SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<wt>/.local-db/data.sqlite \
//     node docs/evidence/2026-09-23/proj-02-a-sharp-chain-study.mjs > <out>.json
// Configuration B: roleRecency WEEKLY_ROLE_RECENCY, no kOverride, k control below.
// 2025 is never read (the used holdout). Output is aggregates only: no names.
import { buildProjections } from '../../../server/services/projections.js';
import { activeKVectorFor } from '../../../server/services/shrinkage-fit.js';
import { WEEKLY_ROLE_RECENCY } from '../../../server/services/weekly-ensemble.js';
import { scoreSim, PPR } from '../../../server/services/scoring.js';
import { rows } from '../../../server/db/index.js';

const SEASONS = [2023, 2024];
const FORWARD = { season: 2026, weeks: [2] };
const B = 2000, SEED = 20260923;

function assertNotHoldout(season) {
  if (season === 2025) throw new Error('2025 is the used holdout; this study never reads it');
}

function kControl(season) {
  const v = activeKVectorFor(WEEKLY_ROLE_RECENCY, { predictingSeason: season });
  const k = v?.target_share?.ALL;
  if (k == null) throw new Error(`k control failed for ${season}: fitted target_share withheld, K.share = 6 would run`);
  return { target_share_ALL: +k.toFixed(4), team_pass_att: v?.team_pass_att?.ALL ?? null };
}

// Actuals from the same rows history() reads (players.position QB/RB/WR/TE).
function actuals(season) {
  assertNotHoldout(season);
  const r = rows(`SELECT u.player_id, u.week, u.team, COALESCE(u.attempts,0) att, COALESCE(u.carries,0) car,
                         COALESCE(u.targets,0) tgt, COALESCE(u.receptions,0) rec,
                         COALESCE(u.receiving_yards,0) recYd, COALESCE(u.receiving_tds,0) recTd,
                         COALESCE(u.rushing_yards,0) rushYd, COALESCE(u.rushing_tds,0) rushTd,
                         COALESCE(u.passing_yards,0) passYd, COALESCE(u.passing_tds,0) passTd,
                         COALESCE(u.interceptions,0) ints
                  FROM player_week_usage u JOIN players p ON p.id = u.player_id
                  WHERE u.season = ? AND p.position IN ('QB','RB','WR','TE')`, season);
  const team = new Map(), player = new Map();
  for (const x of r) {
    if (!x.team) continue;
    const tk = `${x.team}|${x.week}`;
    const t = team.get(tk) ?? { att: 0, car: 0 };
    t.att += x.att; t.car += x.car; team.set(tk, t);
    player.set(`${x.player_id}|${x.week}`, {
      team: x.team, tgt: x.tgt, car: x.car,
      pts: scoreSim({ passYd: x.passYd, passTd: x.passTd, int: x.ints, rushYd: x.rushYd, rushTd: x.rushTd,
        rec: x.rec, recYd: x.recYd, recTd: x.recTd }, PPR)
    });
  }
  return { team, player };
}

function collect(season, weeks) {
  const { team: teamAct, player: playerAct } = actuals(season);
  const out = { plays: [], pass_rate: [], plays_neutral: [], pass_rate_neutral: [], targets: [], carries: [], targets_dnp: [], carries_dnp: [], pairs: [],
    red: { team_weeks: 0, max_target_dev: 0, max_carry_dev: 0 } };
  for (const week of weeks) {
    const proj = buildProjections({ through: season, throughWeek: week - 1, roleRecency: WEEKLY_ROLE_RECENCY });
    const byTeam = new Map();
    for (const p of proj.values()) {
      if (!p.links.share.roster) continue;
      (byTeam.get(p.team) ?? byTeam.set(p.team, []).get(p.team)).push(p);
    }
    for (const [team, roster] of byTeam) {
      const L = roster[0].links;
      const t = L.plays.team;
      // RED invariant on the replay.
      const sT = roster.reduce((s, p) => s + p.links.volume.targets.chain, 0);
      const sC = roster.reduce((s, p) => s + p.links.volume.carries.chain, 0);
      out.red.team_weeks++;
      out.red.max_target_dev = Math.max(out.red.max_target_dev, Math.abs(sT / (t.pass_att * t.target_rate) - 1));
      out.red.max_carry_dev = Math.max(out.red.max_carry_dev, Math.abs(sC / t.rush_att - 1));

      const act = teamAct.get(`${team}|${week}`);
      if (!act) continue;                                   // bye or no rows
      // `plays` / `pass_rate`: the pre-registered comparison, vs the raw season-to-date average.
      if (L.plays.season_average != null) {
        out.plays.push({ c: team, chain: L.plays.chain, inc: L.plays.season_average, act: act.att + act.car });
      }
      // Skeptic re-grade (2026-09-23): the true incumbent is main's neutral shrunk pace
      // (teamVolume pass_att + rush_att, served as links.*.incumbent), which the chain
      // starts from. Rows only where a line exists, so this isolates the script term.
      if (L.pass_rate.chain_scripted) {
        out.plays_neutral.push({ c: team, chain: L.plays.chain, inc: L.plays.incumbent, act: act.att + act.car });
        if (act.att + act.car > 0) {
          out.pass_rate_neutral.push({ c: team, chain: L.pass_rate.chain, inc: L.pass_rate.incumbent,
            act: act.att / (act.att + act.car) });
        }
      }
      if (L.pass_rate.season_average != null && L.pass_rate.chain != null && act.att + act.car > 0) {
        out.pass_rate.push({ c: team, chain: L.pass_rate.chain, inc: L.pass_rate.season_average,
          act: act.att / (act.att + act.car) });
      }
      const played = [];
      for (const p of roster) {
        const a = playerAct.get(`${p.player_id}|${week}`);
        const v = p.links.volume;
        const on = a && a.team === team;
        const tg = { c: p.player_id, chain: v.targets.chain, inc: v.targets.incumbent, act: on ? a.tgt : 0 };
        const ca = { c: p.player_id, chain: v.carries.chain, inc: v.carries.incumbent, act: on ? a.car : 0 };
        out.targets_dnp.push(tg); out.carries_dnp.push(ca);
        if (!on) continue;
        out.targets.push(tg); out.carries.push(ca);
        // Structural ppg with the chain volume swapped in (PPR), for the decision grade.
        const e = p.links.eff, d = p.links.td;
        const dT = v.targets.chain - v.targets.incumbent, dC = v.carries.chain - v.carries.incumbent;
        const chainPpg = p.ppg + dT * (e.catch_rate * PPR.rec + e.yards_per_target * PPR.rec_yd + d.rec_td_rate * PPR.rec_td)
          + dC * (e.yards_per_carry * PPR.rush_yd + d.rush_td_rate * PPR.rush_td);
        played.push({ pos: p.position, inc: p.ppg, chain: chainPpg, act: a.pts });
      }
      out.pairs.push(...played.map(x => ({ ...x, week })));
    }
  }
  return out;
}

// ---- stats
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const mae = (xs, key) => xs.reduce((s, x) => s + Math.abs(x[key] - x.act), 0) / xs.length;
function grade(rowsIn) {
  const n = rowsIn.length;
  if (!n) return { n: 0 };
  const chain = mae(rowsIn, 'chain'), inc = mae(rowsIn, 'inc');
  return { n, mae_chain: +chain.toFixed(4), mae_incumbent: +inc.toFixed(4), diff: +(chain - inc).toFixed(4) };
}
function clusterBoot(rowsIn) {
  const by = new Map();
  for (const x of rowsIn) {
    const d = Math.abs(x.chain - x.act) - Math.abs(x.inc - x.act);
    const g = by.get(x.c) ?? { s: 0, n: 0 }; g.s += d; g.n += 1; by.set(x.c, g);
  }
  const groups = [...by.values()];
  const R = rng(SEED), stats = [];
  for (let b = 0; b < B; b++) {
    let s = 0, n = 0;
    for (let i = 0; i < groups.length; i++) { const g = groups[Math.floor(R() * groups.length)]; s += g.s; n += g.n; }
    stats.push(s / n);
  }
  stats.sort((a, b) => a - b);
  const m = stats.reduce((s, x) => s + x, 0) / B;
  const se = Math.sqrt(stats.reduce((s, x) => s + (x - m) ** 2, 0) / (B - 1));
  return { clusters: groups.length, lo90: +stats[Math.floor(0.05 * B)].toFixed(4),
    hi90: +stats[Math.floor(0.95 * B) - 1].toFixed(4), se: +se.toFixed(4), mde80: +(2.49 * se).toFixed(4) };
}
function pairAccuracy(pairs) {
  // Same position, same week, both played: did the higher projection score more?
  const byKey = new Map();
  for (const p of pairs) (byKey.get(`${p.week}|${p.pos}`) ?? byKey.set(`${p.week}|${p.pos}`, []).get(`${p.week}|${p.pos}`)).push(p);
  let n = 0, inc = 0, chain = 0;
  for (const g of byKey.values()) {
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      const a = g[i], b = g[j];
      if (a.act === b.act) continue;
      const truth = a.act > b.act;
      n++;
      if ((a.inc > b.inc) === truth && a.inc !== b.inc) inc++;
      if ((a.chain > b.chain) === truth && a.chain !== b.chain) chain++;
    }
  }
  return { pairs: n, incumbent: n ? +(inc / n).toFixed(4) : null, chain: n ? +(chain / n).toFixed(4) : null };
}

const LINKS = ['plays', 'pass_rate', 'plays_neutral', 'pass_rate_neutral', 'targets', 'carries'];
const result = { rig: { roleRecency: WEEKLY_ROLE_RECENCY, kOverride: 'omitted (activeKVectorFor)', weeks: '2-18',
  sign: 'chain - incumbent MAE; negative favours the chain', bootstrap: { B, seed: SEED, level: 90 } },
k_control: {}, seasons: {}, pooled: {}, forward: {}, red: {}, decision: {}, verdict: {} };

const perSeason = {};
for (const s of SEASONS) {
  result.k_control[s] = kControl(s);
  perSeason[s] = collect(s, Array.from({ length: 17 }, (_, i) => i + 2));
  result.red[s] = perSeason[s].red;
  result.seasons[s] = Object.fromEntries([...LINKS, 'targets_dnp', 'carries_dnp'].map(l => [l, grade(perSeason[s][l])]));
  result.decision[s] = pairAccuracy(perSeason[s].pairs);
}
for (const l of [...LINKS, 'targets_dnp', 'carries_dnp']) {
  const pooled = SEASONS.flatMap(s => perSeason[s][l]);
  result.pooled[l] = { ...grade(pooled), ...clusterBoot(pooled) };
}
result.k_control[FORWARD.season] = kControl(FORWARD.season);
const fwd = collect(FORWARD.season, FORWARD.weeks);
result.red[FORWARD.season] = fwd.red;
result.forward = Object.fromEntries([...LINKS, 'targets_dnp', 'carries_dnp'].map(l => [l, grade(fwd[l])]));

for (const l of LINKS) {
  const bothSeasons = SEASONS.every(s => result.seasons[s][l].diff < 0);
  const ci = result.pooled[l].hi90 < 0;
  const dnpKey = `${l}_dnp`;
  const dnpOk = !(dnpKey in result.pooled) || SEASONS.every(s => result.seasons[s][dnpKey].diff <= 0);
  const pass = bothSeasons && ci && dnpOk;
  const forwardSame = result.forward[l].n ? result.forward[l].diff < 0 : null;
  result.verdict[l] = { lower_in_both_seasons: bothSeasons, pooled_ci_below_zero: ci, dnp_no_worse: dnpOk,
    pass, forward_same_sign: forwardSame,
    ship: !pass ? 'incumbent kept' : forwardSame ? 'ON' : 'default-off (unconfirmed forward)' };
}
// The ship decision reads each link against its REAL incumbent: plays and pass rate
// against main's neutral shrunk pace (the *_neutral rows), not the season average the
// pre-registration named (a straw man the chain's own pace already beats).
result.ship_decision = {
  note: 'plays/pass_rate graded vs neutral shrunk pace (teamVolume), the producer main already serves',
  plays: result.verdict.plays_neutral.ship, pass_rate: result.verdict.pass_rate_neutral.ship,
  targets: result.verdict.targets.ship, carries: result.verdict.carries.ship
};
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
