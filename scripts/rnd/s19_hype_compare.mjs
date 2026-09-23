// S-19: run the three hype-like producers on the same players and count disagreements.
// Usage: SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<local copy> node scripts/rnd/s19_hype_compare.mjs
// Prints counts only (no league, manager or player names: the repo is public).
import { rows, row } from '../../server/db/index.js';
import { trendPct } from '../../server/routes/aggregates.js';
import { sellHigh } from '../../server/services/waiver-brain.js';
import { deriveFormat } from '../../server/services/format.js';
import { assetUniverse, loadRosters } from '../../server/services/trade-engine.js';
import { loadMarketTable } from '../../server/services/trade-market.js';

// heuristicVerdict (players.js:139) as written on main, applied to (value, trend).
const heuristic = (value, trend) => {
  const pct = trendPct(value, trend);
  if (pct == null) return null;
  return pct > 5 ? 'SELL' : pct < -5 ? 'BUY' : 'HOLD';
};
const metric = (id, source) => row('SELECT value FROM player_metrics WHERE player_id = ? AND source = ?', id, source)?.value ?? null;

const table = loadMarketTable();
const tmLatest = new Map();
for (const r of table.player_weeks) {
  const k = r.sleeper_id; const cur = tmLatest.get(k);
  if (!cur || r.season > cur.season || (r.season === cur.season && r.week > cur.week)) tmLatest.set(k, r);
}

const out = { players: 0, heuristic_input_rows: { fc_value: 0, fc_trend30: 0 }, heuristic_live: { SELL: 0, BUY: 0, HOLD: 0, null: 0 },
  heuristic_on_dynasty_trend: { SELL: 0, BUY: 0, HOLD: 0, null: 0 }, sellhigh_flag: 0,
  tm09_row_any_season: 0, tm09_row_current_season: 0, tm09_latest_season_hist: {},
  pairs: { heur_dyn_SELL_and_sellhigh: 0, heur_dyn_SELL_not_sellhigh: 0, sellhigh_not_heur_dyn_SELL: 0, sellhigh_and_heur_dyn_BUY: 0 },
  tm09_sign_vs_sellhigh: { tm_pos_and_flag: 0, tm_neg_and_flag: 0, tm_pos_no_flag: 0, tm_neg_no_flag: 0 } };
out.heuristic_input_rows.fc_value = row("SELECT COUNT(*) n FROM player_metrics WHERE source='fc_value'").n;
out.heuristic_input_rows.fc_trend30 = row("SELECT COUNT(*) n FROM player_metrics WHERE source='fc_trend30'").n;
out.control_player_metrics_rows = row('SELECT COUNT(*) n FROM player_metrics').n;

const seen = new Set();
for (const { id } of rows('SELECT id FROM leagues ORDER BY id')) {
  const lg = row('SELECT id, platform, league_id, season, my_team_id, team_count, ppr, superflex, roster_positions, payload, league_type, current_week, payload_season FROM leagues WHERE id = ?', id);
  if (!lg?.payload) continue;
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  for (const t of teams) {
    const sh = sellHigh(id, { myTeamId: t.roster_id, limit: 999 });
    const flagged = new Set((sh.candidates ?? []).map(c => c.id));
    for (const p of t.players) {
      const key = `${id}:${p.id}`; if (seen.has(key)) continue; seen.add(key);
      out.players++;
      const live = heuristic(metric(p.id, 'fc_value'), metric(p.id, 'fc_trend30'));
      out.heuristic_live[live ?? 'null']++;
      const dv = row('SELECT redraft_value, trend30 FROM dynasty_values WHERE format_key = ? AND player_id = ?', formatKey, p.id);
      const hd = dv ? heuristic(dv.redraft_value, dv.trend30) : null;
      out.heuristic_on_dynasty_trend[hd ?? 'null']++;
      const f = flagged.has(p.id); if (f) out.sellhigh_flag++;
      if (hd === 'SELL' && f) out.pairs.heur_dyn_SELL_and_sellhigh++;
      if (hd === 'SELL' && !f) out.pairs.heur_dyn_SELL_not_sellhigh++;
      if (f && hd !== 'SELL') out.pairs.sellhigh_not_heur_dyn_SELL++;
      if (f && hd === 'BUY') out.pairs.sellhigh_and_heur_dyn_BUY++;
      const sid = row('SELECT sleeper_id FROM players WHERE id = ?', p.id)?.sleeper_id;
      const tm = sid ? tmLatest.get(String(sid)) : null;
      if (tm) {
        out.tm09_row_any_season++;
        out.tm09_latest_season_hist[tm.season] = (out.tm09_latest_season_hist[tm.season] ?? 0) + 1;
        if (tm.season === 2026) out.tm09_row_current_season++;
        const pos = tm.hype > 0;
        out.tm09_sign_vs_sellhigh[`tm_${pos ? 'pos' : 'neg'}_${f ? 'and_flag' : 'no_flag'}`]++;
      }
    }
  }
}
console.log(JSON.stringify(out, null, 1));
