/**
 * Does nflverse participation already give us what nflsavant gives us?
 * Compares route-type mix per receiver for 2022, from both sources.
 */
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';

const SEASON = 2022;
const PBP = `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${SEASON}.csv.gz`;
const PART = `https://github.com/nflverse/nflverse-data/releases/download/pbp_participation/pbp_participation_${SEASON}.csv`;

const splitCsv = line => {
  const out = []; let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur); return out;
};

async function* lines(url, gz) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const body = Readable.fromWeb(res.body);
  const stream = gz ? body.pipe(createGunzip()) : body;
  for await (const l of createInterface({ input: stream, crlfDelay: Infinity })) yield l;
}

// 1. pbp: (game_id, play_id) -> receiver id
const receiverOf = new Map(); let hdr = null, iGame, iPlay, iRec, iName;
for await (const l of lines(PBP, true)) {
  const f = splitCsv(l);
  if (!hdr) { hdr = f; iGame = f.indexOf('game_id'); iPlay = f.indexOf('play_id');
    iRec = f.indexOf('receiver_player_id'); iName = f.indexOf('receiver_player_name'); continue; }
  const rid = f[iRec];
  if (rid && rid !== 'NA') receiverOf.set(`${f[iGame]}|${f[iPlay]}`, [rid, f[iName]]);
}
console.log(`pbp ${SEASON}: ${receiverOf.size} plays with a named receiver`);

// 2. participation: (game_id, play_id) -> route
let phdr = null, pGame, pPlay, pRoute;
const byReceiver = new Map(); const routeVocab = new Map();
let joined = 0, withRoute = 0;
for await (const l of lines(PART, false)) {
  const f = splitCsv(l);
  if (!phdr) { phdr = f; pGame = f.indexOf('nflverse_game_id'); pPlay = f.indexOf('play_id');
    pRoute = f.indexOf('route'); continue; }
  const hit = receiverOf.get(`${f[pGame]}|${f[pPlay]}`);
  if (!hit) continue;
  joined++;
  const route = (f[pRoute] ?? '').trim();
  if (!route || route === 'NA') continue;
  withRoute++;
  routeVocab.set(route, (routeVocab.get(route) ?? 0) + 1);
  const [rid, name] = hit;
  if (!byReceiver.has(rid)) byReceiver.set(rid, { name, routes: new Map(), n: 0 });
  const r = byReceiver.get(rid);
  r.routes.set(route, (r.routes.get(route) ?? 0) + 1); r.n++;
}
console.log(`participation joined to pbp: ${joined} plays, ${withRoute} carry a route (${(withRoute / joined * 100).toFixed(1)}%)`);
console.log(`receivers with >=1 labelled route: ${byReceiver.size}`);
console.log(`\nnflverse route vocabulary (${routeVocab.size} values):`);
for (const [k, v] of [...routeVocab.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);

// 3. nflsavant side
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync('/tmp/claude-0/-home-user-gridiron-hq/88465833-631d-5966-a586-9b2d13123842/scratchpad/gridiron.sqlite', { readOnly: true });
const sav = db.prepare(`SELECT player_id, player_name, stats FROM nfl_route_splits WHERE season=? AND week=0`).all(SEASON);
console.log(`\nnflsavant ${SEASON} season rows: ${sav.length}`);
const savIds = new Set(sav.map(r => r.player_id));
const both = [...savIds].filter(id => byReceiver.has(id));
console.log(`receivers nflsavant covers: ${savIds.size}`);
console.log(`of those, present in nflverse participation: ${both.length} (${(both.length / savIds.size * 100).toFixed(1)}%)`);
console.log(`receivers nflverse has that nflsavant does NOT: ${[...byReceiver.keys()].filter(id => !savIds.has(id)).length}`);

const totalTargetsSav = sav.reduce((s, r) => s + (JSON.parse(r.stats).route_targets ?? 0), 0);
const totalRoutesNflverse = [...byReceiver.values()].reduce((s, r) => s + r.n, 0);
console.log(`\nlabelled target-routes: nflsavant ${totalTargetsSav}, nflverse ${totalRoutesNflverse}`);
db.close();
