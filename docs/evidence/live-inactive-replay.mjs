/**
 * RL-3-2 replay: runs the live-inactive parser (server/services/live-inactive-monitor.js)
 * over the research lane's stored Bluesky posts. Pre-registered in
 * docs/tdd/2026-09-23-live-inactive-monitor.tdd.md section 3.
 *
 * Two windows, both in the stored file:
 *   A. 2026 W1-W2 against the research lane's 47 events (38 did not play, 9 played).
 *   B. 2024 W11-18 against nflverse: roster_weekly status 'INA' = did not play; a
 *      player_stats row = played. Population is the section 1a rule: QB/RB/WR/TE
 *      with season-to-date PPR >= 8 per game over >= 2 games before that week.
 * A claim counts when posted in (kickoff - 5 days, kickoff]. The player's latest such
 * claim wins, which is the same rule the reader uses.
 *
 * Usage (read-only inputs, nothing is written anywhere):
 *   GRIDIRON_DB_PATH=<local copy> SCHEDULER_DISABLED=1 node docs/evidence/live-inactive-replay.mjs \
 *     <bsky_posts_v2.jsonl> <r3x_bsky_leadtime_events.json> <nflverse.sqlite>
 * The inputs live outside the repo (the research lane, and data/line-history). No
 * post text is printed. Output is counts plus player names from public injury reports.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { claimsFromPost, loadPlayerIndex, WATCHED_ACCOUNTS } from '../../server/services/live-inactive-monitor.js';
import { normalizePlayerName } from '../../server/services/player-identity.js';

const [postsPath, eventsPath, nflversePath] = process.argv.slice(2);
if (!postsPath || !eventsPath || !nflversePath) { console.error('usage: see header'); process.exit(2); }

// Production reads only the watched DIDs (Jetstream filters on the server), so the replay does too.
// ONLY_WATCHED=0 replays every stored account (the first run, before the filter, did that).
const watched = new Set(WATCHED_ACCOUNTS.keys());
const posts = fs.readFileSync(postsPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  .filter(p => process.env.ONLY_WATCHED === '0' || watched.has(p.did));
console.log(`posts replayed: ${posts.length} (${process.env.ONLY_WATCHED === '0' ? 'all stored accounts' : 'watched accounts only'})`);
const DAY = 86_400_000;

/** Latest pre-kickoff claim per normalized name, over posts in the 5-day window. */
function latestClaims(windowPosts, index, kickMs) {
  const out = new Map();
  for (const p of windowPosts) {
    const t = Date.parse(p.createdAt);
    if (!(t <= kickMs && t > kickMs - 5 * DAY)) continue;
    for (const c of claimsFromPost({ text: p.text, embedTitle: p.card_title, embedDescription: p.card_desc }, index)) {
      const key = normalizePlayerName(c.player_name);
      const prev = out.get(key);
      if (!prev || prev.t <= t) out.set(key, { status: c.status, t, src: p.bsky });
    }
  }
  return out;
}

function tally(rowsIn, label) {
  const dnp = rowsIn.filter(r => !r.played), played = rowsIn.filter(r => r.played);
  const by = s => dnp.filter(r => r.friday === s);
  const caught = rs => rs.filter(r => r.claim?.status === 'inactive').length;
  const wrongActive = dnp.filter(r => r.claim?.status === 'active').length;
  const falseFlags = played.filter(r => r.claim?.status === 'inactive');
  console.log(`\n== ${label}`);
  console.log(`did not play: n=${dnp.length}, latest pre-kickoff claim inactive: ${caught(dnp)}; wrong-direction active: ${wrongActive}`);
  for (const s of ['Out', 'Doubtful', 'Questionable', 'none']) console.log(`  Friday ${s}: ${caught(by(s))} of ${by(s).length}`);
  console.log(`played: n=${played.length}, false flags (latest pre-kickoff claim inactive): ${falseFlags.length}` +
    (falseFlags.length ? ` -> ${falseFlags.map(r => `${r.name} W${r.week} (${r.claim.src})`).join('; ')}` : ''));
  const srcs = {};
  for (const r of dnp) if (r.claim?.status === 'inactive') srcs[r.claim.src] = (srcs[r.claim.src] ?? 0) + 1;
  console.log('  catches by source:', JSON.stringify(srcs));
}

// ---- A. 2026 W1-W2 (index = current player table in the local copy)
{
  const index = loadPlayerIndex();
  const events = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
  const a = posts.filter(p => p.window === 'A_2026');
  const rowsA = events.map(e => {
    const kick = Date.parse(e.kickoff);
    const claim = latestClaims(a, index, kick).get(normalizePlayerName(e.name)) ?? null;
    const inIndex = index.byName.has(normalizePlayerName(e.name));
    return { name: e.name, week: e.week, played: e.played, friday: e.status ?? 'none', claim, inIndex };
  });
  tally(rowsA, `A. 2026 W1-W2, ${a.length} posts, ${events.length} events (in-sample)`);
  console.log(`  events whose name is not in the player index (cannot be matched): ${rowsA.filter(r => !r.inIndex).map(r => r.name).join(', ') || 'none'}`);
}

// ---- B. 2024 W11-18 (index = nflverse 2024 rosters; truth = roster_weekly INA / player_stats)
{
  const nv = new DatabaseSync(nflversePath, { readOnly: true });
  const b = posts.filter(p => p.window === 'B_2024w11_18');
  const byName = new Map();
  const seen = new Set();
  for (const r of nv.prepare(`SELECT DISTINCT gsis_id, full_name, position, team FROM roster_weekly
                               WHERE season = 2024 AND game_type = 'REG' AND week BETWEEN 11 AND 18
                                 AND position IN ('QB','RB','WR','TE','K') AND gsis_id IS NOT NULL`).all()) {
    if (seen.has(r.gsis_id)) continue;
    seen.add(r.gsis_id);
    const key = normalizePlayerName(r.full_name);
    if (!key.includes(' ')) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push({ id: r.gsis_id, name: r.full_name, position: r.position, team_id: r.team });
  }
  const teamAbbr = new Map(nv.prepare(`SELECT DISTINCT team FROM roster_weekly WHERE season = 2024`).all().map(r => [r.team, r.team]));
  const nick2abbr = new Map();
  // nflverse abbreviations for the nickname map; only used to break shared-name ties.
  const NICK = { cardinals: 'ARI', falcons: 'ATL', ravens: 'BAL', bills: 'BUF', panthers: 'CAR', bears: 'CHI', bengals: 'CIN',
    browns: 'CLE', cowboys: 'DAL', broncos: 'DEN', lions: 'DET', packers: 'GB', texans: 'HOU', colts: 'IND', jaguars: 'JAX',
    chiefs: 'KC', raiders: 'LV', chargers: 'LAC', rams: 'LA', dolphins: 'MIA', vikings: 'MIN', patriots: 'NE', saints: 'NO',
    giants: 'NYG', jets: 'NYJ', eagles: 'PHI', steelers: 'PIT', '49ers': 'SF', seahawks: 'SEA', buccaneers: 'TB', titans: 'TEN',
    commanders: 'WAS' };
  for (const [k, v] of Object.entries(NICK)) if (teamAbbr.has(v)) nick2abbr.set(k, v);
  let maxTokens = 2;
  for (const k of byName.keys()) maxTokens = Math.max(maxTokens, k.split(' ').length);
  const index = { byName, nicknames: nick2abbr, maxTokens };

  const kick = new Map(); // team|week -> ms (Nov-Jan kickoffs are EST, UTC-5)
  for (const g of nv.prepare(`SELECT week, gameday, gametime, home_team, away_team FROM games
                               WHERE season = 2024 AND game_type = 'REG' AND week BETWEEN 11 AND 18`).all()) {
    const ms = Date.parse(`${g.gameday}T${g.gametime}:00-05:00`);
    kick.set(`${g.home_team}|${g.week}`, ms); kick.set(`${g.away_team}|${g.week}`, ms);
  }
  const ppr = nv.prepare(`SELECT player_id, week, fantasy_points_ppr AS p FROM player_stats
                           WHERE season = 2024 AND season_type = 'REG' AND position IN ('QB','RB','WR','TE')`).all();
  const hist = new Map();
  for (const r of ppr) { if (!hist.has(r.player_id)) hist.set(r.player_id, new Map()); hist.get(r.player_id).set(r.week, r.p ?? 0); }
  const friday = new Map(nv.prepare(`SELECT gsis_id, week, report_status FROM injuries WHERE season = 2024 AND game_type = 'REG'`).all()
    .map(r => [`${r.gsis_id}|${r.week}`, r.report_status]));
  const rw = nv.prepare(`SELECT gsis_id, full_name, team, week, status FROM roster_weekly
                          WHERE season = 2024 AND game_type = 'REG' AND week BETWEEN 11 AND 17
                            AND position IN ('QB','RB','WR','TE')`).all();
  const claimCache = new Map();
  const rowsB = [];
  let unknown = 0;
  for (const r of rw) {
    const h = hist.get(r.gsis_id);
    if (!h) continue;
    const prior = [...h.entries()].filter(([w]) => w < r.week).map(([, p]) => p);
    if (prior.length < 2 || prior.reduce((s, p) => s + p, 0) / prior.length < 8) continue;
    const played = h.has(r.week);
    if (r.status !== 'INA' && !played) { unknown++; continue; }
    if (r.status === 'INA' && played) { unknown++; continue; }
    const k = kick.get(`${r.team}|${r.week}`);
    if (!k) { unknown++; continue; }
    if (!claimCache.has(k)) claimCache.set(k, latestClaims(b, index, k));
    rowsB.push({ name: r.full_name, week: r.week, played, friday: friday.get(`${r.gsis_id}|${r.week}`) ?? 'none',
      claim: claimCache.get(k).get(normalizePlayerName(r.full_name)) ?? null });
  }
  tally(rowsB, `B. 2024 W11-17, ${b.length} posts, fantasy-relevant player-weeks (not used to tune the parser; about 25 of its inactive posts were read while writing it)`);
  console.log(`  excluded as unknown (no stats row but not INA, or no kickoff): ${unknown}`);
}
