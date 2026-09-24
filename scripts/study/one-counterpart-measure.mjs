/**
 * ONE-COUNTERPART measurement (study only; not imported by the app). Run on DB copies:
 *
 *   GRIDIRON_DB_PATH=<copy> GRIDIRON_CHAT_DB_PATH=<chat copy> SCHEDULER_DISABLED=1 \
 *     node scripts/study/one-counterpart-measure.mjs <league_id> [offers.json] [lifts_out.json]
 *
 * (1) max |P(accept) with chat labels - without| over every single-player step
 *     (his player x Nick's player) for every other manager, on a p grid.
 *     "Without" = the same managers with every profile read typed unknown
 *     (Nick's own read kept: it is not a chat label).
 * (2) managers with manager_notes rows vs managers whose override the model read.
 * (3) with offers.json (rnd/eval/e1l_offers.py output): the counterpart model's
 *     per-offer (lift, mult) on P(accept) for that league's decided offers, for
 *     scripts/study/one-counterpart-e1.py to grade against activity-only.
 *     Profiles are read as of now (hindsight: they were built after most offers).
 *
 * Works on PR #254's head (readProfiles) and on this branch (people.profile).
 * Prints counts and roster ids only: no names, no chat text.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [leagueArg, offersPath, liftsOut] = process.argv.slice(2);
const leagueId = Number(leagueArg ?? 4);
const reader = await import('../../server/services/people/profile-reader.js');
const cpm = await import('../../server/services/people/counterpart.js');
const { rows } = await import('../../server/db/index.js');
const { identityMap } = await import('../../server/services/manager-identity.js');

const chat = new DatabaseSync(process.env.GRIDIRON_CHAT_DB_PATH, { readOnly: true });
const ids = identityMap(leagueId);
const myTeam = String(rows('SELECT my_team_id FROM leagues WHERE id = ?', leagueId)[0]?.my_team_id);
const season = rows('SELECT season FROM leagues WHERE id = ?', leagueId)[0]?.season;
const sp = rows(`SELECT MAX(scoring_period_id) AS sp FROM league_roster_snapshots WHERE league_id = ? AND season = ?`, leagueId, season)[0].sp;
const rosterRows = rows(`SELECT team_id, espn_player_id, player_name FROM league_roster_snapshots
                         WHERE league_id = ? AND season = ? AND scoring_period_id = ?`, leagueId, season, sp);
const players = new Map();
const rosters = new Map();
for (const r of rosterRows) {
  players.set(String(r.espn_player_id), { name: r.player_name });
  if (!rosters.has(String(r.team_id))) rosters.set(String(r.team_id), []);
  rosters.get(String(r.team_id)).push(String(r.espn_player_id));
}
// Name resolution over every player the league has traded or rostered this season.
for (const t of rows(`SELECT items_json FROM league_transactions_raw WHERE league_id = ? AND season = ? AND items_json IS NOT NULL`, leagueId, season)) {
  let items = [];
  try { items = JSON.parse(t.items_json); } catch { /* skip */ }
  for (const i of items) if (i.playerId != null && !players.has(String(i.playerId))) players.set(String(i.playerId), { name: null });
}
const teams = [...rosters.keys()].filter(t => t !== myTeam);
const tx = rows(`SELECT tx_id, type, status, execution_type, items_json, proposed_at, processed_at
                 FROM league_transactions_raw WHERE league_id = ? AND season = ?`, leagueId, season);
const toMs = v => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(' ', 'T')}Z`));
const events = cpm.tradeEvents(tx, toMs);
const now = Date.now();

const NEW = typeof reader.peopleProfileFromChat === 'function' && typeof cpm.counterpartsFromPeople === 'function';
let withLabels, withoutLabels, impl;
if (NEW) {
  impl = 'one-counterpart (people.profile)';
  const pp = reader.peopleProfileFromChat(chat, { leagueId, ids, myTeam });
  const stripped = { ...pp, byRoster: new Map([...pp.byRoster].map(([k, e]) => [k, { ...e, status: 'unknown', reason: 'stripped', profile: null }])) };
  withLabels = cpm.counterpartsFromPeople(pp, { players, events, now, teams });
  withoutLabels = cpm.counterpartsFromPeople(stripped, { players, events, now, teams });
} else {
  impl = 'pr-254 (readProfiles)';
  const pr = reader.readProfiles({ chat, ids, asOf: now, myTeam });
  const stripped = new Map([...pr.byRoster].map(([k, e]) => [k, { ...e, negotiation: { status: 'unknown', reason: 'stripped' }, history: [] }]));
  withLabels = cpm.buildCounterparts({ profiles: pr.byRoster, players, events, now, teams });
  withoutLabels = cpm.buildCounterparts({ profiles: stripped, players, events, now, teams });
}

// (1)
const GRID = [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95];
const mine = rosters.get(myTeam) ?? [];
let maxDiff = 0, steps = 0, moved = 0;
const perTeam = {};
for (const t of teams) {
  let tMax = 0;
  for (const get of rosters.get(t) ?? []) for (const give of mine) {
    const a = cpm.stepAdjust(withLabels.get(t), { team: t, get: [get], give: [give] });
    const b = cpm.stepAdjust(withoutLabels.get(t), { team: t, get: [get], give: [give] });
    for (const p of GRID) {
      const d = Math.abs(cpm.adjustP(p, a) - cpm.adjustP(p, b));
      steps++;
      if (d > 1e-12) moved++;
      if (d > tMax) tMax = d;
    }
  }
  perTeam[t] = Number(tMax.toFixed(4));
  if (tMax > maxDiff) maxDiff = tMax;
}

// (2)
const noted = new Set(chat.prepare('SELECT DISTINCT name FROM manager_notes').all().map(r => r.name));
const withNotes = teams.filter(t => noted.has(ids.get(Number(t))?.chat_name ?? ids.get(t)?.chat_name));
const overrideRead = teams.filter(t => withLabels.get(t)?.override?.status === 'ok');
const notesRead = withNotes.filter(t => overrideRead.includes(t));
const known = teams.filter(t => withLabels.get(t)?.status === 'ok');

const out = {
  impl, league: leagueId, managers: teams.length, profiles_known: known.length,
  m1_max_abs_p_accept_diff: Number(maxDiff.toFixed(6)), m1_steps: steps, m1_steps_moved: moved, m1_per_team: perTeam,
  m2_managers_with_notes: withNotes.length, m2_override_read: overrideRead.length, m2_notes_read: notesRead.length,
  m2_override_status: Object.fromEntries(teams.map(t => [t, withLabels.get(t)?.override?.status ?? 'none'])),
};

// (3)
if (offersPath) {
  const offers = JSON.parse(fs.readFileSync(offersPath, 'utf8')).offers.filter(o => o.league_id === leagueId);
  const lifts = offers.map(o => {
    const t = String(o.receiver);
    const adj = cpm.stepAdjust(withLabels.get(t), { team: t, get: o.recv_gives.map(String), give: o.recv_gets.map(String) });
    return { offer_id: o.offer_id, lift: adj.lift, mult: adj.mult, features: adj.features.map(f => f.feature) };
  });
  out.m3_offers = lifts.length;
  out.m3_offers_moved = lifts.filter(l => l.lift !== 0 || l.mult !== 1).length;
  if (liftsOut) fs.writeFileSync(liftsOut, JSON.stringify({ impl, lifts }));
}
chat.close();
console.log(JSON.stringify(out, null, 1));
