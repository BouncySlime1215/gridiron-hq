#!/usr/bin/env node
/**
 * COACH-LINK report: how well the entity map joins one league's sources, and
 * how fast connect runs, on the real databases.
 *
 *   node scripts/coach-link-report.mjs [--league 4] [--sample 20]
 *
 * Reads GRIDIRON_DB_PATH and GRIDIRON_CHAT_DB_PATH. Prints COUNTS, LABELS AND
 * TIMINGS ONLY: no player, team, manager or chat name, no handle, no message.
 * Entities appear by key (team:<roster id>, player:<internal id>). The output
 * is meant to be pasted where others can read it.
 *
 * Writes nothing of its own. Importing the app's db module runs its
 * CREATE TABLE IF NOT EXISTS statements, so point it at a copy.
 */
import { performance } from 'node:perf_hooks';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const leagueId = Number(arg('league', 4));
const sample = Number(arg('sample', 20));
if (!Number.isInteger(leagueId) || leagueId < 1) throw new Error(`--league must be a whole number, got ${arg('league')}`);
if (!Number.isInteger(sample) || sample < 1) throw new Error(`--sample must be a whole number, got ${arg('sample')}`);

const { db } = await import('../server/db/index.js');
const { buildEntityMap } = await import('../server/services/coach/entity-map.js');
const { connect } = await import('../server/services/coach/connect.js');

const ms = fn => { const t = performance.now(); const out = fn(); return [out, performance.now() - t]; };
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const round = x => (x == null ? null : Math.round(x * 10) / 10);

const [map, buildMs] = ms(() => buildEntityMap(leagueId));
console.log(`COACH_LINK_REPORT league=${leagueId} status=${map.status}${map.reason ? ` reason="${map.reason}"` : ''}`);
if (map.status !== 'ok') process.exit(0);

console.log(`map_build_ms=${round(buildMs)} entities=${map.entities.length} players=${map.entities.filter(e => e.kind === 'player').length} teams=${map.entities.filter(e => e.kind === 'team').length}`);
console.log('SOURCES');
for (const [name, s] of Object.entries(map.sources)) {
  const counts = Object.entries(s).filter(([k, v]) => k !== 'status' && k !== 'reason' && typeof v === 'number').map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`  ${name}: ${s.status}${counts ? ` ${counts}` : ''}${s.reason ? ` reason="${s.reason}"` : ''}`);
}

console.log('LINKS by source/id_space x confidence');
const table = new Map();
for (const l of map.entities.flatMap(e => e.links)) {
  const k = `${l.source}/${l.id_space}`;
  if (!table.has(k)) table.set(k, {});
  table.get(k)[l.confidence] = (table.get(k)[l.confidence] ?? 0) + 1;
}
for (const [k, c] of [...table.entries()].sort()) console.log(`  ${k}: ${Object.entries(c).map(([x, n]) => `${x}=${n}`).join(' ')}`);

const teams = map.entities.filter(e => e.kind === 'team');
const speaker = t => t.links.find(l => l.id_space === 'chat_speaker');
console.log(`TEAMS chat_speaker trusted=${teams.filter(t => speaker(t)?.trusted).length}/${teams.length} ` +
  `below_trusted=${teams.filter(t => speaker(t) && !speaker(t).trusted).length} unlinked=${teams.filter(t => !speaker(t)).length}`);
const players = map.entities.filter(e => e.kind === 'player');
const bridged = players.filter(p => p.player_id != null).length;
console.log(`PLAYERS on a players row=${bridged}/${players.length} with_sleeper=${players.filter(p => p.links.some(l => l.id_space === 'sleeper_player')).length} ` +
  `with_gsis=${players.filter(p => p.links.some(l => l.id_space === 'gsis')).length} with_news=${players.filter(p => p.links.some(l => l.source === 'news')).length} ` +
  `with_chat_label=${players.filter(p => p.links.some(l => l.id_space === 'chat_label')).length}`);

// connect: every team, plus the players with the most links, timed.
const byLinks = [...players].sort((a, b) => b.links.length - a.links.length).slice(0, sample);
const times = [];
console.log('CONNECT (key: events_n after_as_of undated sources_unknown ms)');
for (const e of [...teams, ...byLinks]) {
  const [rows, t] = ms(() => connect({ league_id: leagueId, entity: e.key }));
  times.push(t);
  const h = rows[0];
  console.log(`  ${e.key}: ${h.status === 'ok' ? `${h.events_n} ${h.events_after_as_of_n} ${h.undated_n} "${h.sources_unknown ?? ''}"` : `unknown "${h.reason}"`} ${round(t)}`);
}
console.log(`connect_ms median=${round(median(times))} max=${round(Math.max(...times))} n=${times.length}`);

const memory = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'coach_answer_memory'").get();
console.log(`MEMORY table=${memory ? 'present' : 'absent (migration 098 not applied)'}${memory
  ? ` rows=${db.prepare('SELECT COUNT(*) AS n FROM coach_answer_memory WHERE league_id = ?').get(leagueId).n}` : ''}`);
