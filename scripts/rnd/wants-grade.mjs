#!/usr/bin/env node
// U8 WANTS-MENU grade (batch D item 3). Read-only. Pre-registered bar in server/services/campaign/wants.js.
// Usage: SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<local copy> node scripts/rnd/wants-grade.mjs --league 4 [--season 2026]
// Prints one JSON object: per family x side (stated/revealed x wants/gives) n, hits, hit rate with its Wilson
// 95% interval, the trailing base rate, lift and pass. Ids only: no manager or player names are printed.
// The ESPN trade block is not graded: the app keeps only the latest league payload, so it has no history.
import { rows, row } from '../../server/db/index.js';
import { executedTrades } from '../../server/services/campaign/trade-memory.js';
import { readChatTradeInterest } from '../../server/services/people/chat-trade-interest.js';
import { valuesTalk, nameResolver } from '../../server/services/people/counterpart.js';
import { gradeWants, revealedSignals, statedSignals } from '../../server/services/campaign/wants.js';
import { toTime } from '../../server/services/trade-tactics.js';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : dflt; };
const leagueId = Number(arg('league', '4'));
const lg = row('SELECT season, payload FROM leagues WHERE id = ?', leagueId);
if (!lg) throw new Error(`league ${leagueId} is not in this database`);
const season = Number(arg('season', lg.season));
const toMs = v => toTime(v);

let payload;
try { payload = JSON.parse(lg.payload || '{}'); } catch (e) { throw new Error(`league ${leagueId} payload is not JSON: ${e.message}`); }
const teams = payload.teams ?? [];
const sizes = teams.map(t => t.roster?.entries?.length ?? 0).filter(n => n > 0).sort((a, b) => a - b);
if (!teams.length || !sizes.length) throw new Error(`league ${leagueId} payload has no teams or rosters; cannot size the base rate`);
const rosterSize = sizes[Math.floor(sizes.length / 2)];

const tx = rows(`SELECT tx_id, type, status, execution_type, items_json, proposed_at, processed_at
                 FROM league_transactions_raw WHERE league_id = ? AND season = ?`, leagueId, season);
const { trades } = executedTrades(tx, { idOfEspn: e => String(e), toMs });

const revealed = revealedSignals(readChatTradeInterest({ rows }, leagueId, season), toMs);
const byEspn = new Map(rows('SELECT espn_id, name FROM players WHERE espn_id > 0').map(p => [String(p.espn_id), { name: p.name }]));
const { peopleProfile } = await import('../../server/services/people/profile-reader.js');
const stated = statedSignals(await peopleProfile(leagueId), { valuesTalk, resolve: nameResolver(byEspn), toMs });

const g = gradeWants([...stated.signals, ...revealed.signals], trades, { now: Date.now(), rosterSize, teamCount: teams.length });
console.log(JSON.stringify({ league: leagueId, season, roster_size: rosterSize, teams: teams.length, executed_trades: trades.length,
  sources: { stated: { status: stated.status, n: stated.signals.length, unresolved: stated.unresolved, undated: stated.undated, ...(stated.reason ? { reason: stated.reason } : {}) },
    revealed: { status: revealed.status, n: revealed.signals.length, unmapped: revealed.unmapped }, espn_block: 'not graded (no history)' },
  ...g }, null, 2));
