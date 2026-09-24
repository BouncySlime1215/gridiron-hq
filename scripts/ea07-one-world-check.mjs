#!/usr/bin/env node
/**
 * EA-07 local check: one league, the one world off and then on, on a DB copy.
 *
 *   node scripts/ea07-one-world-check.mjs [leagueId=4] [--shortlist=3]
 *
 * Prints JSON (ids only: no league, manager or player names):
 *   row_b   my title odds as the My team twin (/simulate, runs 1500, fresh seed),
 *           the Title tab ("before" of each shortlisted deal) and the TradeCard
 *           (/trade-impact default) show them, off vs on. On, all must be one value.
 *   row_a   Spearman of the sim's per-player means vs the finder's ros_ppg
 *           (rostered players), off (last-season basis) vs on (the world).
 *   row_c   per rostered player this NFL week: the card's floor/ceiling (asset
 *           universe), the world pool's p10/p90, the ceiling lineup's mean, the
 *           posture's SD; off vs on, and how many disagree on.
 *   bench   world build ms, per-deal rescore ms, heap growth for the world.
 *
 * Reads only. Caches are process memory; nothing is written to the database.
 */
import { row } from '../server/db/index.js';
import { scoringFor } from '../server/services/scoring.js';
import { withRandomSeed } from '../server/services/stats-util.js';
import { simulateSeason, tradeImpact, simPlayerMeans, tradeImpactWorld } from '../server/services/season-sim.js';
import { assetUniverse, loadRosters, myPlayoffOdds, tradeWeekContext } from '../server/services/trade-engine.js';
import { titleOddsTrades, clearTitleOddsTradeCache } from '../server/services/title-odds-trades.js';
import { ceilingLineup } from '../server/services/ceiling-lineup.js';
import { lineupPosture } from '../server/services/lineup-posture.js';
import { deriveFormat } from '../server/services/format.js';
import { leagueWorld, oneWorldTitleOdds, worldRange, clearLeagueWorlds } from '../server/services/league-world.js';
import { ONE_WORLD_ENV } from '../server/services/one-world.js';

const leagueId = Number(process.argv.slice(2).find(a => !a.startsWith('--')) ?? 4);
const shortlist = Number(process.argv.find(a => a.startsWith('--shortlist='))?.split('=')[1] ?? 3);
const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
if (!lg?.payload) { console.error(`league ${leagueId} not synced`); process.exit(1); }
const me = String(lg.my_team_id);
const ms = t0 => Math.round(performance.now() - t0);
const r4 = v => (Number.isFinite(v) ? +v.toFixed(4) : null);

function ranks(xs) {
  const order = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let q = i; q <= j; q++) r[order[q][1]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
}
function spearman(xs, ys) {
  const a = ranks(xs), b = ranks(ys), n = xs.length, m = (n - 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - m) * (b[i] - m); da += (a[i] - m) ** 2; db += (b[i] - m) ** 2; }
  return n > 2 ? num / Math.sqrt(da * db) : null;
}

function phase(on) {
  process.env[ONE_WORLD_ENV] = on ? '1' : '0';
  clearLeagueWorlds(); clearTitleOddsTradeCache();
  const out = { one_world: on };
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const week = tradeWeekContext().week;

  // Row B: the three surfaces.
  let t0 = performance.now();
  let heap0 = process.memoryUsage().heapUsed;
  let world = null;
  if (on) { world = leagueWorld(lg); out.world_build_ms = ms(t0); out.world_heap_mb = Math.round((process.memoryUsage().heapUsed - heap0) / 1e6); }
  const twin = on ? oneWorldTitleOdds(lg) : simulateSeason(lg, { runs: 1500, scoring: scoringFor(lg) });
  if (twin.error) { out.error = twin.error; return out; }
  const tab = titleOddsTrades(leagueId, { shortlist });
  const deal = tab.deals?.[0] ?? null;
  t0 = performance.now();
  const card = deal ? tradeImpact(lg, {
    myTeamId: me, theirTeamId: deal.partner_id, iGive: deal.i_give.map(p => p.id), iGet: deal.i_get.map(p => p.id),
    ...(on ? { world } : {})
  }) : null;
  out.card_ms = deal ? ms(t0) : null;
  out.row_b = {
    twin_title: r4(twin.teams.find(t => t.roster_id === me)?.title_odds),
    tab_title_before: (tab.deals ?? []).map(d => d.title_before),
    card_title_before: card?.me?.title_before ?? null,
    horizon_playoff: myPlayoffOdds(lg, me).value,
    twin_playoff: r4(twin.teams.find(t => t.roster_id === me)?.playoff_odds),
    snapshot_id: twin.one_world?.snapshot_id ?? null, world_reused: card?.world_reused ?? null
  };
  const all = [out.row_b.twin_title, ...out.row_b.tab_title_before, out.row_b.card_title_before].filter(v => v != null);
  out.row_b.distinct_title_values = new Set(all).size;

  // Row A: sim means vs the finder's ros_ppg.
  const w = world ?? withRandomSeed(1, () => tradeImpactWorld(lg, { runs: 200 }));
  if (!w.fail) {
    const means = simPlayerMeans(w);
    const ids = [...w.prep.rosterIds].filter(id => means.has(id) && Number.isFinite(assets.get(id)?.ros_ppg));
    out.row_a = { spearman: r4(spearman(ids.map(id => means.get(id)), ids.map(id => assets.get(id).ros_ppg))), n: ids.length };
  }

  // Row C: one player-week, four readers.
  const mine = loadRosters(lg, assets).find(t => t.roster_id === me)?.players ?? [];
  const ceil = ceilingLineup(leagueId, { teamId: me, week, trials: 1000 });
  const ceilMean = new Map((ceil.lineup ?? []).map(s => [s.player, s.mean_points]));
  const posture = lineupPosture(lg, { myTeamId: me, week });
  out.posture = { my_sd: posture.my_sd ?? null, win_probability: posture.win_probability ?? null, sd_model: posture.sd_model ?? null };
  let disagree = 0;
  out.row_c = mine.filter(p => ['QB', 'RB', 'WR', 'TE'].includes(p.position)).map(p => {
    const a = assets.get(p.id);
    const wr = on ? worldRange(lg, p, week) : null;
    const rowC = {
      player_id: p.id, position: p.position, card_floor: a?.floor ?? null, card_ceiling: a?.ceiling ?? null,
      range_source: a?.range_source ?? null, ceiling_lineup_mean: ceilMean.get(p.name) ?? null,
      ...(wr ? { world_p10: wr.p10, world_p90: wr.p90, world_mean: wr.mean, world_sd: wr.sd } : {})
    };
    if (wr && (wr.p10 !== a?.floor || wr.p90 !== a?.ceiling)) disagree++;
    return rowC;
  });
  if (on) out.row_c_card_vs_world_disagreements = disagree;
  return out;
}

const off = phase(false);
const on = phase(true);
console.log(JSON.stringify({ league: leagueId, nfl_week: tradeWeekContext().week, off, on }, null, 1));
