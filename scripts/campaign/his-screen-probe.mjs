#!/usr/bin/env node
/**
 * HIS-SCREEN probe: runs hisScreenFor on real data for one league (default 4)
 * against up to N partners, each with a one-for-one offer (Nick's highest-value
 * player for the partner's highest-value player), and prints ids, statuses,
 * numbers and timings only. No player or manager names, no chat text: the
 * output is posted to a public PR.
 *
 *   node scripts/campaign/his-screen-probe.mjs [--league 4] [--partners 3]
 */
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const leagueId = Number(arg('league', 4));
const maxPartners = Number(arg('partners', 3));

const { row } = await import('../../server/db/index.js');
const engine = await import('../../server/services/trade-engine.js');
const { deriveFormat } = await import('../../server/services/format.js');
const { hisScreenFor } = await import('../../server/services/campaign/his-screen.js');

const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
if (!lg?.payload) { console.log(JSON.stringify({ league: leagueId, error: 'league missing or not synced' })); process.exit(1); }
const me = String(lg.my_team_id ?? '');
const teams = engine.loadRosters(lg, engine.assetUniverse(lg, deriveFormat(lg).formatKey));
const top = t => [...t.players].filter(p => (p.value ?? 0) > 0).sort((a, b) => b.value - a.value)[0] ?? null;
const mine = teams.find(t => t.roster_id === me);
if (!mine) { console.log(JSON.stringify({ league: leagueId, error: 'my team not found' })); process.exit(1); }
const give = top(mine);

const out = [];
for (const t of teams.filter(x => x.roster_id !== me).slice(0, maxPartners)) {
  const get = top(t);
  if (!give || !get) { out.push({ partner: t.roster_id, skipped: 'no valued player' }); continue; }
  const t0 = Date.now();
  const s = await hisScreenFor(lg, { partner: t.roster_id, give: [give.id], get: [get.id], enabled: true });
  const ms = Date.now() - t0;
  if (s.error) { out.push({ partner: t.roster_id, error: s.error, ms }); continue; }
  const f = s.fair, v = s.value_view, o = s.title_odds;
  out.push({
    partner: t.roster_id, give: [String(give.id)], get: [String(get.id)], ms,
    roster_before: s.roster.before.length, roster_after: s.roster.after.length,
    market_pct: s.market.pct == null ? null : +s.market.pct.toFixed(1),
    clone: v.status, clone_informed: v.value?.informed ?? null,
    clone_pct: v.value?.pct == null ? null : +v.value.pct.toFixed(1),
    fair: f.status === 'ok' ? f.value.verdict : `unknown: ${f.reason}`,
    his_title: o.status === 'ok' ? { before: +o.value.before.toFixed(4), after: +o.value.after.toFixed(4),
      delta: +o.value.delta.toFixed(4), se: o.se ?? null, clears_2se: o.clears_2se ?? null } : `unknown: ${o.reason}`,
    his_values_known: s.roster.before.filter(r => r.value_his.status === 'ok').length,
  });
}
console.log(JSON.stringify({ league: leagueId, teams: teams.length, probes: out }, null, 1));
