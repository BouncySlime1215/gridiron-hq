#!/usr/bin/env node
/**
 * NEGOTIATE-UI benchmark and data check, for a copy of the real database.
 *
 * Times the counter builder's rescore (server/services/warroom-rescorer.js) on one
 * league: the one-off world build, then N package edits against it (target: about
 * 80 ms each). Also prints, per other team, where negotiation mode's follow-up clock
 * would get his reply-time distribution (ESPN answers, chat, or hand-set) and the
 * ESPN proposal rows it reads. Counts and timings only: no names, no message text.
 *
 * Usage:
 *   SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<db copy> node scripts/campaign/negotiate-bench.mjs --league 4 [--edits 20]
 */
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const leagueId = Number(arg('league', 4));
const edits = Math.max(1, Number(arg('edits', 20)));

const { row } = await import('../../server/db/index.js');
const { makeRescorer, defaultDeps } = await import('../../server/services/warroom-rescorer.js');
const { replyTimes } = await import('../../server/services/warroom-negotiate.js');

const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
if (!lg) { console.error(`league ${leagueId} not found`); process.exit(1); }

const R = makeRescorer(lg, await defaultDeps());
const out = { league: leagueId, fast_rescore: (await import('../../server/services/season-sim.js')).fastRescoreEnabled() };
if (R.fail) { Object.assign(out, { fail: R.fail, build_ms: R.build_ms }); console.log(JSON.stringify(out, null, 2)); process.exit(0); }

// Package edits: Nick's top players against each other team's top player, one to three for one.
const mine = R.roster(R.me).map(p => p.id);
const partners = R.teams.filter(t => t !== R.me);
const ms = [], scored = [];
for (let i = 0; i < edits && partners.length; i++) {
  const partner = partners[i % partners.length];
  const his = R.roster(partner).map(p => p.id);
  if (!his.length || !mine.length) continue;
  const give = mine.slice(i % 3, (i % 3) + 1 + (i % 3));
  const s = R.score({ partner, give, get: [his[0]] });
  if (s.problems?.length) { scored.push({ partner, problem: s.problems[0] }); continue; }
  ms.push(s.ms);
  scored.push({ partner, n_give: give.length, delta_status: s.nick.title_odds_delta.status, p_yes_status: s.his.p_yes.status,
    yes_point_basis: s.his.yes_point.basis?.startsWith('where') ? 'his read' : 'market-fair' });
}
const sorted = ms.slice().sort((a, b) => a - b);
const q = p => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
const tally = (list, f) => list.reduce((m, x) => ({ ...m, [f(x)]: (m[f(x)] ?? 0) + 1 }), {});

// ESPN offers Nick sent and how many carry his answer (the join replyTimes uses).
try {
  out.espn_offers = row(`SELECT COUNT(DISTINCT o.tx_id) AS offers, COUNT(DISTINCT a.related_tx_id) AS answered
                         FROM league_transactions_raw o
                         LEFT JOIN league_transactions_raw a ON a.league_id = o.league_id AND a.season = o.season
                          AND a.related_tx_id = o.tx_id AND a.type IN ('TRADE_ACCEPT', 'TRADE_DECLINE') AND a.execution_type = 'EXECUTE'
                         WHERE o.league_id = ? AND o.type = 'TRADE_PROPOSAL' AND o.execution_type = 'EXECUTE' AND o.team_id = ?`,
  leagueId, Number(R.me));
} catch (e) { out.espn_offers = `unreadable: ${e.message}`; }

// Where each team's reply-time distribution comes from (one line per team).
out.reply_times = [];
for (const t of partners) {
  const d = await replyTimes(leagueId, R.me, t);
  out.reply_times.push(`team ${t}: ${d.source} n=${d.n} p50=${d.p50_min == null ? '-' : Math.round(d.p50_min)} p90=${d.p90_min == null ? '-' : Math.round(d.p90_min)} min`);
}

// Timings last: the runner shows the tail.
Object.assign(out, {
  outcomes: { problems: scored.filter(x => x.problem).length, delta: tally(scored.filter(x => !x.problem), x => x.delta_status),
    p_yes: tally(scored.filter(x => !x.problem), x => x.p_yes_status), yes_point: tally(scored.filter(x => !x.problem), x => x.yes_point_basis) },
  edits: ms.length,
  build_ms: R.build_ms,
  rescore_ms: { p50: q(0.5), p90: q(0.9), max: sorted.at(-1) ?? null }
});
console.log(JSON.stringify(out, null, 2));
