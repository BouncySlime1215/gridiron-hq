#!/usr/bin/env node
/**
 * NEGOTIATE-UI route benchmark on a copy of the real database (local copy only).
 *
 * Mounts the negotiation router in-process, opens one thread on the first served
 * move, then times through HTTP:
 *   - the FIRST rescore call (latency) and the event loop's max lag while it runs;
 *   - if the first call says the engine is still being built, polls every second
 *     until it is ready (time to ready, max lag meanwhile);
 *   - N counter edits after that (p50/p95/max latency, max lag).
 * Counts and timings only: no names.
 *
 * Usage (point the War Room plans-path variable, warroom-flag.js, at a plans copy too,
 * and set the preview switch, preview-mode.js#PREVIEW_ENV, to 1):
 *   SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<db copy> \
 *     node scripts/campaign/negotiate-bench.mjs --league 4 [--edits 10]
 * Runs this tree's migrations on the copy. With no served move for the league it
 * seeds one thread from the latest roster snapshot (see seedThread).
 */
import { performance } from 'node:perf_hooks';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const leagueId = Number(arg('league', 4));
const edits = Math.max(1, Number(arg('edits', 10)));

const { default: express } = await import('express');
const { row, rows, run } = await import('../../server/db/index.js');
await (await import('../../server/db/migrate.js')).runMigrations();
const { negotiateRouter } = await import('../../server/routes/warroom-negotiate.js');
const { warRoomView } = await import('../../server/services/war-room-view.js');

const lg = row('SELECT id, my_team_id FROM leagues WHERE id = ?', leagueId);
if (!lg) { console.error(`league ${leagueId} not found`); process.exit(1); }
const member = row('SELECT user_id FROM league_memberships WHERE league_id = ? LIMIT 1', leagueId);

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.auth = { userId: member?.user_id ?? 1 }; next(); });
app.use('/api/warroom', negotiateRouter());
app.use((err, _req, res, _next) => { res.status(err.status ?? 500).json({ error: String(err.message ?? err) }); });
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/warroom/${leagueId}/negotiations`;

// Event-loop lag: a 5 ms ticker; lag = how late each tick fires.
let maxLag = 0, last = performance.now();
const tick = setInterval(() => { const t = performance.now(); maxLag = Math.max(maxLag, t - last - 5); last = t; }, 5);
const window = async fn => { maxLag = 0; last = performance.now(); const t0 = performance.now(); const out = await fn();
  return { out, ms: Math.round(performance.now() - t0), lag: Math.round(maxLag) }; };
const post = async (path, body) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { code: r.status, body: await r.json() };
};

const out = { league: leagueId, local_copy: true };
const view = await warRoomView(leagueId);
const moves = [...(view?.alternatives?.status === 'ok' ? view.alternatives.value : []), ...(view?.next_move?.status === 'ok' ? [view.next_move.value] : [])];
const move = moves.find(m => m?.steps?.[0]);
let thread;
if (move) {
  const opened = await post('', { move_id: move.move_id, step_index: 0 });
  thread = opened.body.thread;
  if (!thread) { out.fail = `open failed: ${opened.code} ${JSON.stringify(opened.body)}`; console.log(JSON.stringify(out, null, 2)); process.exit(0); }
  out.thread_from = 'served move';
} else {
  thread = seedThread();
  out.thread_from = 'seeded (no move served for this league on the copy): my top rostered player for one of team 2\'s';
}
const give0 = thread.give, get0 = thread.get;

/**
 * No served move: seed one thread straight into the copy, from the latest roster
 * snapshot (one of my players for one of the first other team's), on whichever
 * schema this tree has (093 warroom_negotiations with its own sent_at, or 102
 * negotiation_threads tied to a trade_outcomes sent row).
 */
function seedThread() {
  const snap = row('SELECT season, MAX(scoring_period_id) AS sp FROM league_roster_snapshots WHERE league_id = ? AND season = (SELECT MAX(season) FROM league_roster_snapshots WHERE league_id = ?)', leagueId, leagueId);
  const pick = team => rows('SELECT player_id FROM league_roster_snapshots WHERE league_id = ? AND season = ? AND scoring_period_id = ? AND team_id = ? AND player_id IS NOT NULL ORDER BY player_id', leagueId, snap.season, snap.sp, team).map(r => String(r.player_id));
  const me = String(lg.my_team_id);
  const partner = String(row('SELECT MIN(team_id) AS t FROM league_roster_snapshots WHERE league_id = ? AND season = ? AND scoring_period_id = ? AND team_id <> ?', leagueId, snap.season, snap.sp, Number(me)).t);
  const give = pick(me).slice(0, 1), get = pick(partner).slice(0, 1);
  const step = { partner, give, get, walk_away: { status: 'unknown', reason: 'bench' }, reply_table: { status: 'unknown', reason: 'bench' } };
  const now = new Date().toISOString();
  const cols = t => rows(`PRAGMA table_info(${t})`).map(c => c.name);
  let id;
  const table = cols('negotiation_threads').length ? 'negotiation_threads' : 'warroom_negotiations';
  run(`UPDATE ${table} SET status = 'closed', closed_reason = 'walked_away', closed_at = ? WHERE move_id = 'bench' AND status = 'open'`, now);
  if (cols('warroom_negotiations').includes('sent_at')) {
    run(`INSERT INTO warroom_negotiations (league_id, user_id, move_id, step_index, partner, give_json, get_json, step_json, names_json, sent_at)
         VALUES (?, ?, 'bench', 0, ?, ?, ?, ?, '{}', ?)`, leagueId, member?.user_id ?? null, partner, JSON.stringify(give), JSON.stringify(get), JSON.stringify(step), now);
  } else {
    run(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id, give_json, get_json, proposed_at,
           model_p_accept, model_p_accept_low, model_p_accept_high, model_basis, model_version, status, idea_id, created_at, sent_at, move_id)
         VALUES (?, ?, 'app_proposed', ?, ?, ?, ?, ?, 0.5, 0.3, 0.7, 'no_information', 'bench', 'proposed', ?, ?, ?, 'bench')`,
    leagueId, snap.season, me, partner, JSON.stringify(give), JSON.stringify(get), now, `bench-${Date.now()}`, now, now);
    const to = row('SELECT last_insert_rowid() AS id').id;
    run(`INSERT INTO negotiation_threads (league_id, user_id, trade_outcome_id, move_id, step_index, partner, give_json, get_json, step_json, names_json)
         VALUES (?, ?, ?, 'bench', 0, ?, ?, ?, ?, '{}')`, leagueId, member?.user_id ?? null, to, partner, JSON.stringify(give), JSON.stringify(get), JSON.stringify(step));
  }
  id = row('SELECT last_insert_rowid() AS id').id;
  return { id, give, get };
}

// 1. The first rescore call.
const first = await window(() => post(`/${thread.id}/rescore`, { give: give0, get: get0, rosters: true }));
out.first_call = { ms: first.ms, max_lag_ms: first.lag, http: first.code ?? first.out.code, status: first.out.body.status };

// 2. Until ready (only when the first call did not score).
let rosters = first.out.body.rosters ?? null;
if (first.out.body.status !== 'ok') {
  const t0 = performance.now(); let lag = 0, polls = 0, got = first.out;
  maxLag = 0; last = performance.now();
  while (got.body.status !== 'ok' && got.body.status !== 'failed' && performance.now() - t0 < 180_000) {
    await new Promise(r => setTimeout(r, 1000));
    got = await post(`/${thread.id}/rescore`, { give: give0, get: get0, rosters: true }); polls++;
  }
  lag = Math.round(maxLag);
  rosters = got.body.rosters ?? null;
  out.warm_up = { ms_to_ready: Math.round(performance.now() - t0), polls, max_lag_ms: lag, status: got.body.status, reason: got.body.reason };
}

// 3. Counter edits: swap in his next players and my next players, one at a time.
const mine = (rosters?.mine ?? []).map(p => p.id).filter(id => !give0.includes(id));
const his = (rosters?.his ?? []).map(p => p.id).filter(id => !get0.includes(id));
const ms = []; let lag = 0; const codes = {};
for (let i = 0; i < edits; i++) {
  const give = i % 2 === 0 && mine.length ? [...give0.slice(0, 3), mine[i % mine.length]] : give0;
  const get = i % 2 === 1 && his.length ? [...get0.slice(0, 3), his[i % his.length]] : get0;
  const e = await window(() => post(`/${thread.id}/rescore`, { give: [...new Set(give)], get: [...new Set(get)] }));
  ms.push(e.ms); lag = Math.max(lag, e.lag);
  const k = `${e.out.code}:${e.out.body.status ?? e.out.body.error?.slice(0, 40)}`; codes[k] = (codes[k] ?? 0) + 1;
}
const s = ms.slice().sort((a, b) => a - b);
const q = p => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
out.edits = { n: ms.length, p50_ms: q(0.5), p95_ms: q(0.95), max_ms: s.at(-1), max_lag_ms: lag, outcomes: codes };

clearInterval(tick);
server.close();
console.log(JSON.stringify(out, null, 2));
process.exit(0);
