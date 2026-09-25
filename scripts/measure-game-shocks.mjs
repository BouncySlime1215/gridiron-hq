#!/usr/bin/env node
/**
 * GAME-SHOCKS measurement (pre-registration docs/tdd/2026-09-25-game-shocks.tdd.md).
 *
 *   SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<copy of the live db> node scripts/measure-game-shocks.mjs [--leagues 4] [--runs 2000] [--no-sim]
 *
 * M1 (decides): same-game joint upper-decile exceedance in 2021+ weekly residuals
 * (player_week_usage), for same-team QB-WR pairs and for every same-game pair, against
 * the sampler's rate at the group's mean correlation with shocks off and on. Prints a
 * PASS / FAIL line per group and overall, judged by the pre-registered bar.
 *
 * M2 (report only): each league's title / playoff odds and expected points per week,
 * flag off vs on, on one fixed world (paired). Roster ids only, no names. Checks the
 * invariants: title odds sum to 1, playoff odds to the playoff spots, and every team's
 * expected points per week moves by less than 0.5.
 *
 * Read-only: nothing is written to the database.
 */
import { rows } from '../server/db/index.js';
import {
  sameGameResiduals, tailCoexceedance, simulatedJointExceedance, gameShockVerdict, GAME_SHOCK_NU
} from '../server/services/correlation.js';
import { simulateSeason, GAME_SHOCKS_ENV } from '../server/services/season-sim.js';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const leagueIds = arg('--leagues', null)?.split(',').map(s => s.trim()).filter(Boolean) ?? null;
const runs = Number(arg('--runs', 2000));
const WORLD = 20260925;
const r4 = n => (n == null ? null : +n.toFixed(4));

/* ---- M1 ---- */
const games = sameGameResiduals();
const emp = tailCoexceedance(games, { q: 0.9, since: 2021 });
const m1 = {};
let m1Pass = true;
for (const [group, e] of Object.entries(emp)) {
  if (!e.pairs) { m1[group] = { pairs: 0, verdict: { pass: false, reason: 'no pairs in player_week_usage 2021+' } }; m1Pass = false; continue; }
  const off = simulatedJointExceedance(e.rho, { q: 0.9, nu: null, draws: 200000, key: 11 });
  const on = simulatedJointExceedance(e.rho, { q: 0.9, nu: GAME_SHOCK_NU, draws: 200000, key: 11 });
  const verdict = gameShockVerdict({ empirical: e.rate, off, on });
  m1Pass &&= verdict.pass;
  m1[group] = { pairs: e.pairs, rho: r4(e.rho), empirical: r4(e.rate), off: r4(off), on: r4(on), verdict };
}
console.log(JSON.stringify({ m1, nu: GAME_SHOCK_NU }, null, 2));
console.log(`M1 ${m1Pass ? 'PASS' : 'FAIL'}: ${Object.entries(m1).map(([g, v]) => `${g} ${v.verdict.pass ? 'pass' : 'fail'} (${v.verdict.reason})`).join('; ')}`);

/* ---- M2 ---- */
if (!argv.includes('--no-sim')) {
  const leagues = rows('SELECT * FROM leagues').filter(lg => !leagueIds || leagueIds.includes(String(lg.id)));
  for (const lg of leagues) {
    const arm = flag => {
      process.env[GAME_SHOCKS_ENV] = flag;
      return simulateSeason(lg, { runs, worldId: WORLD });
    };
    const off = arm('0');
    const on = arm('1');
    if (off.error || on.error) { console.log(`league ${lg.id}: sim failed: ${off.error ?? on.error}`); continue; }
    const byId = new Map(on.teams.map(t => [t.roster_id, t]));
    const sum = (res, k) => res.teams.reduce((s, t) => s + t[k], 0);
    let worstPpw = 0;
    const teams = off.teams.map(a => {
      const b = byId.get(a.roster_id);
      const ppw = (b.expected_points - a.expected_points) / (off.weeks || 1);
      worstPpw = Math.max(worstPpw, Math.abs(ppw));
      return { roster_id: a.roster_id, title: [a.title_odds, b.title_odds], playoffs: [a.playoff_odds, b.playoff_odds], ppw_shift: +ppw.toFixed(2) };
    });
    const inv = {
      title_sum_on: r4(sum(on, 'title_odds')),
      playoff_sum_on: r4(sum(on, 'playoff_odds')), playoff_spots: on.playoff_teams,
      worst_ppw_shift: +worstPpw.toFixed(2)
    };
    const ok = Math.abs(inv.title_sum_on - 1) < 2e-3 && Math.abs(inv.playoff_sum_on - on.playoff_teams) < 2e-3 && inv.worst_ppw_shift < 0.5;
    console.log(JSON.stringify({ league: lg.id, runs, world: WORLD, game_shocks: on.game_shocks ?? null, invariants: inv, teams }, null, 2));
    console.log(`M2 league ${lg.id} invariants ${ok ? 'PASS' : 'FAIL'}`);
  }
  delete process.env[GAME_SHOCKS_ENV];
}
