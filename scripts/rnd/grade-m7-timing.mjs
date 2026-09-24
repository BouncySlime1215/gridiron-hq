#!/usr/bin/env node
/**
 * M7-TIMING grade: P(trade within 7 days | urgency spike) vs the same rate on non-spike
 * manager-days, per league, as of each event (server/services/campaign/urgency.js#gradeM7).
 *
 *   node scripts/rnd/grade-m7-timing.mjs [--league <id>] [--json]
 *
 * Reads GRIDIRON_DB_PATH (leagues.payload schedule, league_transactions_raw, schedule_games,
 * league_member_identity) and GRIDIRON_CHAT_DB_PATH (messages). Prints aggregates only: roster
 * ids and counts, never a name or a message.
 *
 * Arms graded:
 *   need_move    a roster-day with >= 1 'need a move' message (at = first such message);
 *                baseline = every other roster-day in the chat's span (at = 00:00Z)
 *   loss_streak  a roster-week ending a streak of >= 2 decided losses (at = the day after the
 *                last game of that NFL week); baseline = every other decided roster-week.
 *                Assumes matchupPeriodId = NFL week (true for 1-week matchups).
 * Not graded, with the reason printed: starter_injured and bye_crunch (no as-of injury or
 * weekly-roster history is stored, so a past spike cannot be rebuilt without leaking today).
 */
import { pathToFileURL } from 'node:url';
import * as U from '../../server/services/campaign/urgency.js';

const DAY = 864e5;

function args(argv) {
  const o = { league: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--league') o.league = Number(argv[++i]);
    else if (argv[i] === '--json') o.json = true;
  }
  return o;
}

const tableExists = (db, name) => db.rows(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, name).length > 0;

function tradesFor(db, leagueId) {
  if (!tableExists(db, 'league_transactions_raw')) return { status: 'absent', rows: [] };
  const out = [];
  for (const t of db.rows(`SELECT tx_id, items_json, processed_at, proposed_at FROM league_transactions_raw
                           WHERE league_id = ? AND type = 'TRADE_ACCEPT' AND execution_type = 'PROCESS' AND status = 'EXECUTED'`, leagueId)) {
    const at = Date.parse(t.processed_at ?? t.proposed_at ?? '');
    if (!Number.isFinite(at)) continue;
    let items;
    try { items = JSON.parse(t.items_json || '[]'); } catch (e) { throw new Error(`tx ${t.tx_id}: items_json unreadable (${e.message})`); }
    const parties = new Set(items.flatMap(i => [i.fromTeamId, i.toTeamId]).filter(x => Number(x) > 0).map(String));
    if (parties.size) out.push({ at, parties });
  }
  return { status: 'ok', rows: out };
}

export function lossStreakEvents(schedule, weekEnd) {
  const teams = new Set((schedule ?? []).flatMap(m => [m?.home?.teamId, m?.away?.teamId]).filter(x => x != null).map(String));
  const periods = [...new Set((schedule ?? []).filter(m => m?.winner && m.winner !== 'UNDECIDED').map(m => m.matchupPeriodId))]
    .filter(Number.isInteger).sort((a, b) => a - b);
  const spikes = [], baseline = [];
  for (const w of periods) {
    const at = weekEnd(w);
    if (!Number.isFinite(at)) continue;
    const upTo = schedule.filter(m => (m.matchupPeriodId ?? 0) <= w);
    for (const t of teams) {
      const s = U.lossStreak(upTo, t);
      if (!s || s.through_period !== w) continue;
      (s.n >= U.THRESHOLDS.loss_streak ? spikes : baseline).push({ team: t, at });
    }
  }
  return { spikes, baseline };
}

async function main() {
  const opts = args(process.argv);
  const db = await import('../../server/db/index.js');
  const { identityMap } = await import('../../server/services/manager-identity.js');
  const { openChatDb } = await import('../../server/services/manager-signals.js');
  const leagues = db.rows('SELECT id, season, payload FROM leagues ORDER BY id').filter(l => opts.league == null || l.id === opts.league);
  const chat = openChatDb();
  const report = [];
  try {
    for (const lg of leagues) {
      const trades = tradesFor(db, lg.id);
      const entry = { league: lg.id, trades: trades.rows.length, trades_status: trades.status, arms: {},
        not_graded: { starter_injured: 'no as-of injury history stored', bye_crunch: 'no as-of weekly roster history stored' } };
      // loss_streak
      let payload = {};
      try { payload = JSON.parse(lg.payload ?? '{}'); } catch (e) { entry.arms.loss_streak = { error: `payload unreadable: ${e.message}` }; }
      if (!entry.arms.loss_streak) {
        const weekEnd = w => {
          const r = db.row('SELECT MAX(date) AS d FROM schedule_games WHERE season = ? AND week = ?', lg.season, w);
          const t = Date.parse(r?.d ?? '');
          return Number.isFinite(t) ? t + DAY : NaN;
        };
        const ev = lossStreakEvents(payload.schedule ?? [], weekEnd);
        entry.arms.loss_streak = U.gradeM7({ ...ev, trades: trades.rows });
      }
      // need_move
      const ids = identityMap(lg.id);
      if (!chat) entry.arms.need_move = { skipped: 'chat DB not found (GRIDIRON_CHAT_DB_PATH)' };
      else if (!ids.size) entry.arms.need_move = { skipped: 'no trusted chat identities for this league' };
      else {
        const spikes = [], baseline = [];
        const span = chat.prepare('SELECT MIN(ts_utc) AS lo, MAX(ts_utc) AS hi FROM messages').get();
        const lo = Date.parse(span?.lo ?? ''), hi = Date.parse(span?.hi ?? '');
        let messages = 0, matched = 0;
        for (const [rosterId, ident] of ids) {
          const days = new Map();
          for (const m of chat.prepare('SELECT ts_utc, text FROM messages WHERE name = ? ORDER BY ts_utc').all(ident.chat_name)) {
            messages++;
            if (!U.isNeedMove(m.text)) continue;
            matched++;
            const at = Date.parse(m.ts_utc);
            const day = Math.floor(at / DAY);
            if (Number.isFinite(at) && !days.has(day)) days.set(day, at);
          }
          for (const at of days.values()) spikes.push({ team: String(rosterId), at });
          if (Number.isFinite(lo) && Number.isFinite(hi)) {
            for (let d = Math.floor(lo / DAY); d <= Math.floor(hi / DAY); d++) if (!days.has(d)) baseline.push({ team: String(rosterId), at: d * DAY });
          }
        }
        entry.arms.need_move = { ...U.gradeM7({ spikes, baseline, trades: trades.rows }), messages_read: messages, matched };
      }
      report.push(entry);
    }
  } finally { chat?.close(); }
  if (opts.json) { console.log(JSON.stringify(report, null, 2)); return; }
  const pct = x => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
  for (const e of report) {
    console.log(`league ${e.league}: ${e.trades} executed trades (${e.trades_status})`);
    for (const [arm, g] of Object.entries(e.arms)) {
      if (g.skipped || g.error) { console.log(`  ${arm}: ${g.skipped ?? g.error}`); continue; }
      console.log(`  ${arm}: spike ${g.spike.k}/${g.spike.n} = ${pct(g.spike.p)} [90% ${pct(g.spike.ci[0])}, ${pct(g.spike.ci[1])}]`
        + ` vs baseline ${g.baseline.k}/${g.baseline.n} = ${pct(g.baseline.p)}; lift ${g.lift == null ? 'n/a' : g.lift.toFixed(2)}x; ${g.verdict}`
        + (g.messages_read != null ? `; ${g.matched} matching of ${g.messages_read} messages` : ''));
    }
    for (const [arm, why] of Object.entries(e.not_graded)) console.log(`  ${arm}: not graded (${why})`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
