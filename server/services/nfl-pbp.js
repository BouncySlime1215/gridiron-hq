/**
 * Play-by-play ingestion — the raw material for every advanced variable.
 *
 * nflverse publishes one CSV per season with 372 columns and ~50k plays. That is
 * ~95MB uncompressed, so this streams it: HTTPS -> gunzip -> incremental CSV
 * parse -> fold each play into an in-memory accumulator -> write one row per
 * team-week and player-week. Raw plays are never held in memory, so the whole
 * season costs a few MB rather than a gigabyte.
 *
 * Features land in a JSON blob rather than 200 SQL columns. The feature set is
 * meant to grow, and a 200-column DDL would turn every addition into a
 * migration. Identity columns (season, week, team, player) stay real columns so
 * they can be indexed and joined; see nfl-features.js for the catalog that
 * documents what each key in that blob actually means.
 */
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { db, rows, run } from '../db/index.js';

const PBP_URL = s => `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${s}.csv.gz`;

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_team_week_features (
    season INTEGER NOT NULL, week INTEGER NOT NULL, team TEXT NOT NULL,
    opponent TEXT, home INTEGER, features TEXT NOT NULL,
    PRIMARY KEY (season, week, team)
  );
  CREATE INDEX IF NOT EXISTS idx_twf_team ON nfl_team_week_features(team, season, week);

  CREATE TABLE IF NOT EXISTS nfl_player_week_features (
    season INTEGER NOT NULL, week INTEGER NOT NULL, player_id TEXT NOT NULL,
    player_name TEXT, team TEXT, opponent TEXT, position TEXT, features TEXT NOT NULL,
    PRIMARY KEY (season, week, player_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pwf_player ON nfl_player_week_features(player_id, season, week);
  CREATE INDEX IF NOT EXISTS idx_pwf_team ON nfl_player_week_features(team, season, week);
`);

/* ------------------------------------------------------------ CSV streaming */

/**
 * Incremental RFC4180 parser. Play descriptions contain commas and quotes, and
 * a naive split would corrupt every row that has one, so this tracks quote
 * state across chunk boundaries and emits complete records only.
 */
function createCsvStreamer(onRecord) {
  let field = '', record = [], inQuotes = false, prevQuote = false;
  return {
    push(chunk) {
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i];
        if (inQuotes) {
          if (prevQuote) {
            prevQuote = false;
            if (c === '"') { field += '"'; continue; }
            inQuotes = false;           // closing quote already consumed
          } else if (c === '"') { prevQuote = true; continue; }
          else { field += c; continue; }
        }
        if (c === '"') { inQuotes = true; continue; }
        if (c === ',') { record.push(field); field = ''; continue; }
        if (c === '\n') { record.push(field); field = ''; onRecord(record); record = []; continue; }
        if (c === '\r') continue;
        field += c;
      }
    },
    end() { if (field.length || record.length) { record.push(field); onRecord(record); } }
  };
}

/* ------------------------------------------------------------- accumulators */

const teamAcc = () => ({
  plays: 0, pass: 0, rush: 0, epa: 0, pass_epa: 0, rush_epa: 0,
  succ: 0, pass_succ: 0, rush_succ: 0, expl_pass: 0, expl_rush: 0,
  air_yards: 0, yac: 0, cpoe: 0, cpoe_n: 0, xpass: 0, xpass_n: 0, pass_oe: 0, pass_oe_n: 0,
  comp: 0, att: 0, pass_yds: 0, rush_yds: 0, carries: 0,
  sacks: 0, qb_hits: 0, scrambles: 0, ints: 0, fumbles: 0,
  penalties: 0, first_downs: 0,
  third_att: 0, third_conv: 0, third_dist: 0,
  fourth_att: 0, fourth_conv: 0,
  rz_plays: 0, rz_td: 0, gtg_plays: 0, gtg_td: 0,
  early_plays: 0, early_pass: 0, early_epa: 0,
  neutral_plays: 0, neutral_pass: 0,
  lead_plays: 0, lead_pass: 0, trail_plays: 0, trail_pass: 0,
  h1_epa: 0, h1_plays: 0, h2_epa: 0, h2_plays: 0,
  shotgun: 0, no_huddle: 0,
  deep_att: 0, short_att: 0,
  drives: new Set(), series_succ: 0, series_n: 0,
  td: 0, pass_td: 0, rush_td: 0
});

const playerAcc = () => ({
  // passing
  dropbacks: 0, att: 0, comp: 0, pass_yds: 0, pass_td: 0, ints: 0, sacks: 0,
  air_yards_thrown: 0, cpoe: 0, cpoe_n: 0, pass_epa: 0, deep_att: 0, scrambles: 0,
  pass_rz_att: 0,
  // rushing
  carries: 0, rush_yds: 0, rush_td: 0, rush_epa: 0, rush_succ: 0, expl_rush: 0,
  rush_rz: 0, rush_gtg: 0,
  // receiving
  targets: 0, rec: 0, rec_yds: 0, rec_td: 0, rec_air: 0, rec_yac: 0, rec_epa: 0,
  rec_succ: 0, expl_rec: 0, deep_tgt: 0, rec_rz_tgt: 0,
  position: null, team: null, opponent: null, name: null
});

const div = (a, b) => (b > 0 ? a / b : null);
const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/* ------------------------------------------------------------------ ingest */

/**
 * Streams one season and writes its team-week and player-week feature rows.
 * `onProgress` reports parsed play counts so a long run isn't silent.
 */
export async function syncPbpSeason(season, { onProgress } = {}) {
  const res = await fetch(PBP_URL(season), { signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error(`pbp ${season} -> HTTP ${res.status}`);

  let header = null, idx = null;
  const teams = new Map();    // `${week}|${team}` -> { off, def, opponent, home }
  const players = new Map();  // `${week}|${playerId}` -> playerAcc
  let plays = 0;

  const num = (rec, name) => {
    const i = idx?.[name];
    if (i == null) return null;
    const v = rec[i];
    if (v === '' || v == null || v === 'NA') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const str = (rec, name) => {
    const i = idx?.[name];
    if (i == null) return null;
    const v = rec[i];
    return v === '' || v === 'NA' ? null : v;
  };

  const teamSlot = (week, team, opponent, home) => {
    const k = `${week}|${team}`;
    let t = teams.get(k);
    if (!t) { t = { off: teamAcc(), def: teamAcc(), opponent, home }; teams.set(k, t); }
    return t;
  };
  const playerSlot = (week, id) => {
    const k = `${week}|${id}`;
    let p = players.get(k);
    if (!p) { p = playerAcc(); players.set(k, p); }
    return p;
  };

  const onRecord = rec => {
    if (!header) {
      header = rec;
      idx = Object.fromEntries(header.map((h, i) => [h, i]));
      return;
    }
    if (rec.length < 10) return;
    if (str(rec, 'season_type') !== 'REG') return;

    const week = num(rec, 'week');
    const posteam = str(rec, 'posteam'), defteam = str(rec, 'defteam');
    if (!week || !posteam || !defteam) return;
    const homeTeam = str(rec, 'home_team');
    const playType = str(rec, 'play_type');
    if (!playType || playType === 'no_play') {
      // Penalties still matter, but they carry no play_type — count and move on.
      if (num(rec, 'penalty') === 1) {
        teamSlot(week, posteam, defteam, posteam === homeTeam ? 1 : 0).off.penalties++;
      }
      return;
    }
    if (!['pass', 'run'].includes(playType)) return;

    plays++;
    const o = teamSlot(week, posteam, defteam, posteam === homeTeam ? 1 : 0).off;
    const d = teamSlot(week, defteam, posteam, defteam === homeTeam ? 1 : 0).def;

    const epa = num(rec, 'epa') ?? 0;
    const success = num(rec, 'success') === 1;
    const isPass = playType === 'pass';
    const down = num(rec, 'down');
    const ydstogo = num(rec, 'ydstogo');
    const yl100 = num(rec, 'yardline_100');
    const diff = num(rec, 'score_differential') ?? 0;
    const qtr = num(rec, 'qtr') ?? 1;
    const airY = num(rec, 'air_yards');
    const yacY = num(rec, 'yards_after_catch');
    const passYds = num(rec, 'passing_yards') ?? 0;
    const rushYds = num(rec, 'rushing_yards') ?? 0;
    const recYds = num(rec, 'receiving_yards') ?? 0;

    for (const side of [o, d]) {
      side.plays++; side.epa += epa; if (success) side.succ++;
      if (isPass) { side.pass++; side.pass_epa += epa; if (success) side.pass_succ++; }
      else { side.rush++; side.rush_epa += epa; if (success) side.rush_succ++; }
      if (qtr <= 2) { side.h1_epa += epa; side.h1_plays++; } else { side.h2_epa += epa; side.h2_plays++; }
      if (down === 1 || down === 2) {
        side.early_plays++; side.early_epa += epa; if (isPass) side.early_pass++;
      }
      if (down === 3) {
        side.third_att++; side.third_dist += ydstogo ?? 0;
        if (num(rec, 'third_down_converted') === 1) side.third_conv++;
      }
      if (down === 4) { side.fourth_att++; if (num(rec, 'first_down') === 1) side.fourth_conv++; }
      if (yl100 != null && yl100 <= 20) { side.rz_plays++; if (num(rec, 'touchdown') === 1) side.rz_td++; }
      if (num(rec, 'goal_to_go') === 1) { side.gtg_plays++; if (num(rec, 'touchdown') === 1) side.gtg_td++; }
      if (num(rec, 'first_down') === 1) side.first_downs++;
      if (num(rec, 'sack') === 1) side.sacks++;
      if (num(rec, 'qb_hit') === 1) side.qb_hits++;
      if (num(rec, 'qb_scramble') === 1) side.scrambles++;
      if (num(rec, 'interception') === 1) side.ints++;
      if (num(rec, 'fumble') === 1) side.fumbles++;
      if (num(rec, 'shotgun') === 1) side.shotgun++;
      if (num(rec, 'no_huddle') === 1) side.no_huddle++;
      if (num(rec, 'touchdown') === 1) {
        side.td++;
        if (num(rec, 'pass_touchdown') === 1) side.pass_td++;
        if (num(rec, 'rush_touchdown') === 1) side.rush_td++;
      }
      // Game script: who is ahead is stated from the possessing team, so the
      // defensive slot has to read it inverted or every defense looks like it
      // is always playing from behind.
      const sideDiff = side === o ? diff : -diff;
      if (Math.abs(sideDiff) <= 7) { side.neutral_plays++; if (isPass) side.neutral_pass++; }
      if (sideDiff > 0) { side.lead_plays++; if (isPass) side.lead_pass++; }
      if (sideDiff < 0) { side.trail_plays++; if (isPass) side.trail_pass++; }
      if (isPass) {
        if (airY != null) { side.air_yards += airY; if (airY >= 15) side.deep_att++; else side.short_att++; }
        if (yacY != null) side.yac += yacY;
        if (num(rec, 'complete_pass') === 1) { side.comp++; side.pass_yds += passYds; }
        side.att++;
        const c = num(rec, 'cpoe'); if (c != null) { side.cpoe += c; side.cpoe_n++; }
        if (passYds >= 20) side.expl_pass++;
      } else {
        side.carries++; side.rush_yds += rushYds;
        if (rushYds >= 10) side.expl_rush++;
      }
      const xp = num(rec, 'xpass'); if (xp != null) { side.xpass += xp; side.xpass_n++; }
      const poe = num(rec, 'pass_oe'); if (poe != null) { side.pass_oe += poe; side.pass_oe_n++; }
      const drv = num(rec, 'fixed_drive'); if (drv != null) side.drives.add(`${week}|${drv}`);
      const ss = num(rec, 'series_success'); if (ss != null) { side.series_succ += ss; side.series_n++; }
      if (num(rec, 'penalty') === 1) side.penalties++;
    }

    /* ---- players ---- */
    const passerId = str(rec, 'passer_player_id');
    if (passerId) {
      const p = playerSlot(week, passerId);
      p.name ??= str(rec, 'passer_player_name'); p.team ??= posteam; p.opponent ??= defteam; p.position ??= 'QB';
      p.dropbacks++;
      if (num(rec, 'sack') === 1) p.sacks++;
      else {
        p.att++; p.pass_epa += epa;
        if (num(rec, 'complete_pass') === 1) { p.comp++; p.pass_yds += passYds; }
        if (num(rec, 'pass_touchdown') === 1) p.pass_td++;
        if (num(rec, 'interception') === 1) p.ints++;
        if (airY != null) { p.air_yards_thrown += airY; if (airY >= 15) p.deep_att++; }
        const c = num(rec, 'cpoe'); if (c != null) { p.cpoe += c; p.cpoe_n++; }
        if (yl100 != null && yl100 <= 20) p.pass_rz_att++;
      }
      if (num(rec, 'qb_scramble') === 1) p.scrambles++;
    }
    const rusherId = str(rec, 'rusher_player_id');
    if (rusherId) {
      const p = playerSlot(week, rusherId);
      p.name ??= str(rec, 'rusher_player_name'); p.team ??= posteam; p.opponent ??= defteam;
      p.carries++; p.rush_yds += rushYds; p.rush_epa += epa;
      if (success) p.rush_succ++;
      if (rushYds >= 10) p.expl_rush++;
      if (num(rec, 'rush_touchdown') === 1) p.rush_td++;
      if (yl100 != null && yl100 <= 20) p.rush_rz++;
      if (num(rec, 'goal_to_go') === 1) p.rush_gtg++;
    }
    const recId = str(rec, 'receiver_player_id');
    if (recId) {
      const p = playerSlot(week, recId);
      p.name ??= str(rec, 'receiver_player_name'); p.team ??= posteam; p.opponent ??= defteam;
      p.targets++; p.rec_epa += epa;
      if (airY != null) { p.rec_air += airY; if (airY >= 15) p.deep_tgt++; }
      if (num(rec, 'complete_pass') === 1) {
        p.rec++; p.rec_yds += recYds; if (yacY != null) p.rec_yac += yacY;
        if (success) p.rec_succ++;
        if (recYds >= 20) p.expl_rec++;
      }
      if (num(rec, 'pass_touchdown') === 1 && num(rec, 'complete_pass') === 1) p.rec_td++;
      if (yl100 != null && yl100 <= 20) p.rec_rz_tgt++;
    }

    if (onProgress && plays % 20000 === 0) onProgress(plays);
  };

  const streamer = createCsvStreamer(onRecord);
  const gunzip = createGunzip();
  const source = Readable.fromWeb(res.body).pipe(gunzip);
  source.setEncoding('utf8');
  for await (const chunk of source) streamer.push(chunk);
  streamer.end();

  writeTeamWeeks(season, teams);
  const teamTotals = writePlayerWeeks(season, players, teams);
  return { season, plays, team_rows: teams.size, player_rows: players.size, teams_seen: teamTotals };
}

/* ------------------------------------------------------------------ derive */

/** Offense-side or defense-side rate features from one accumulator. */
function sideFeatures(a, p) {
  const drives = a.drives.size;
  return {
    [`${p}_plays`]: a.plays,
    [`${p}_epa_per_play`]: r3(div(a.epa, a.plays)),
    [`${p}_pass_epa_per_play`]: r3(div(a.pass_epa, a.pass)),
    [`${p}_rush_epa_per_play`]: r3(div(a.rush_epa, a.rush)),
    [`${p}_success_rate`]: r3(div(a.succ, a.plays)),
    [`${p}_pass_success_rate`]: r3(div(a.pass_succ, a.pass)),
    [`${p}_rush_success_rate`]: r3(div(a.rush_succ, a.rush)),
    [`${p}_pass_rate`]: r3(div(a.pass, a.plays)),
    [`${p}_explosive_pass_rate`]: r3(div(a.expl_pass, a.att)),
    [`${p}_explosive_rush_rate`]: r3(div(a.expl_rush, a.carries)),
    [`${p}_explosive_play_rate`]: r3(div(a.expl_pass + a.expl_rush, a.plays)),
    [`${p}_yards_per_attempt`]: r3(div(a.pass_yds, a.att)),
    [`${p}_yards_per_carry`]: r3(div(a.rush_yds, a.carries)),
    [`${p}_completion_pct`]: r3(div(a.comp, a.att)),
    [`${p}_cpoe`]: r3(div(a.cpoe, a.cpoe_n)),
    [`${p}_adot`]: r3(div(a.air_yards, a.att)),
    [`${p}_yac_per_completion`]: r3(div(a.yac, a.comp)),
    [`${p}_deep_attempt_rate`]: r3(div(a.deep_att, a.att)),
    [`${p}_proe`]: r3(div(a.pass_oe, a.pass_oe_n)),
    [`${p}_xpass`]: r3(div(a.xpass, a.xpass_n)),
    [`${p}_sack_rate`]: r3(div(a.sacks, a.pass)),
    [`${p}_qb_hit_rate`]: r3(div(a.qb_hits, a.pass)),
    [`${p}_scramble_rate`]: r3(div(a.scrambles, a.pass)),
    [`${p}_int_rate`]: r3(div(a.ints, a.att)),
    [`${p}_fumble_rate`]: r3(div(a.fumbles, a.plays)),
    [`${p}_turnover_rate`]: r3(div(a.ints + a.fumbles, a.plays)),
    [`${p}_penalty_count`]: a.penalties,
    [`${p}_first_down_rate`]: r3(div(a.first_downs, a.plays)),
    [`${p}_third_down_rate`]: r3(div(a.third_conv, a.third_att)),
    [`${p}_third_down_distance`]: r3(div(a.third_dist, a.third_att)),
    [`${p}_third_down_attempts`]: a.third_att,
    [`${p}_fourth_down_rate`]: r3(div(a.fourth_conv, a.fourth_att)),
    [`${p}_red_zone_plays`]: a.rz_plays,
    [`${p}_red_zone_td_rate`]: r3(div(a.rz_td, a.rz_plays)),
    [`${p}_goal_to_go_td_rate`]: r3(div(a.gtg_td, a.gtg_plays)),
    [`${p}_early_down_epa`]: r3(div(a.early_epa, a.early_plays)),
    [`${p}_early_down_pass_rate`]: r3(div(a.early_pass, a.early_plays)),
    [`${p}_neutral_pass_rate`]: r3(div(a.neutral_pass, a.neutral_plays)),
    [`${p}_leading_pass_rate`]: r3(div(a.lead_pass, a.lead_plays)),
    [`${p}_trailing_pass_rate`]: r3(div(a.trail_pass, a.trail_plays)),
    [`${p}_first_half_epa`]: r3(div(a.h1_epa, a.h1_plays)),
    [`${p}_second_half_epa`]: r3(div(a.h2_epa, a.h2_plays)),
    [`${p}_half_epa_delta`]: r3((div(a.h2_epa, a.h2_plays) ?? 0) - (div(a.h1_epa, a.h1_plays) ?? 0)),
    [`${p}_shotgun_rate`]: r3(div(a.shotgun, a.plays)),
    [`${p}_no_huddle_rate`]: r3(div(a.no_huddle, a.plays)),
    [`${p}_drives`]: drives,
    [`${p}_plays_per_drive`]: r3(div(a.plays, drives)),
    [`${p}_series_success_rate`]: r3(div(a.series_succ, a.series_n)),
    [`${p}_td_per_drive`]: r3(div(a.td, drives)),
    [`${p}_pass_td`]: a.pass_td,
    [`${p}_rush_td`]: a.rush_td
  };
}

function writeTeamWeeks(season, teams) {
  const stmt = db.prepare(`INSERT INTO nfl_team_week_features
      (season, week, team, opponent, home, features)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(season, week, team) DO UPDATE SET
      opponent=excluded.opponent, home=excluded.home, features=excluded.features`);
  db.exec('BEGIN');
  try {
    for (const [key, t] of teams) {
      const [week, team] = key.split('|');
      const f = { ...sideFeatures(t.off, 'off'), ...sideFeatures(t.def, 'def') };
      // Net views: the same metric from both directions is far more useful as a
      // difference than as two numbers a model has to learn to subtract.
      f.net_epa_per_play = r3((f.off_epa_per_play ?? 0) - (f.def_epa_per_play ?? 0));
      f.net_success_rate = r3((f.off_success_rate ?? 0) - (f.def_success_rate ?? 0));
      f.net_explosive_rate = r3((f.off_explosive_play_rate ?? 0) - (f.def_explosive_play_rate ?? 0));
      f.net_turnover_rate = r3((f.def_turnover_rate ?? 0) - (f.off_turnover_rate ?? 0));
      f.net_third_down = r3((f.off_third_down_rate ?? 0) - (f.def_third_down_rate ?? 0));
      f.net_sack_rate = r3((f.def_sack_rate ?? 0) - (f.off_sack_rate ?? 0));
      f.net_red_zone_td_rate = r3((f.off_red_zone_td_rate ?? 0) - (f.def_red_zone_td_rate ?? 0));
      stmt.run(season, Number(week), team, t.opponent, t.home, JSON.stringify(f));
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function writePlayerWeeks(season, players, teams) {
  // Team target/air-yard totals, so share metrics (target share, WOPR) are real
  // shares of that team's actual week rather than league-wide approximations.
  const teamTot = new Map();
  for (const [key, p] of players) {
    const [week] = key.split('|');
    if (!p.team) continue;
    const k = `${week}|${p.team}`;
    const t = teamTot.get(k) ?? { targets: 0, air: 0, carries: 0 };
    t.targets += p.targets; t.air += p.rec_air; t.carries += p.carries;
    teamTot.set(k, t);
  }

  const stmt = db.prepare(`INSERT INTO nfl_player_week_features
      (season, week, player_id, player_name, team, opponent, position, features)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(season, week, player_id) DO UPDATE SET
      player_name=excluded.player_name, team=excluded.team, opponent=excluded.opponent,
      position=excluded.position, features=excluded.features`);

  db.exec('BEGIN');
  try {
    for (const [key, p] of players) {
      const [week, pid] = key.split('|');
      const tt = teamTot.get(`${week}|${p.team}`) ?? { targets: 0, air: 0, carries: 0 };
      const tgtShare = div(p.targets, tt.targets), airShare = div(p.rec_air, tt.air);
      const f = {
        // passing
        dropbacks: p.dropbacks, pass_attempts: p.att, completions: p.comp,
        completion_pct: r3(div(p.comp, p.att)), passing_yards: p.pass_yds,
        yards_per_attempt: r3(div(p.pass_yds, p.att)), passing_tds: p.pass_td,
        interceptions: p.ints, pass_td_rate: r3(div(p.pass_td, p.att)),
        int_rate: r3(div(p.ints, p.att)), sacks_taken: p.sacks,
        sack_rate: r3(div(p.sacks, p.dropbacks)), pass_epa_per_att: r3(div(p.pass_epa, p.att)),
        adot: r3(div(p.air_yards_thrown, p.att)), cpoe: r3(div(p.cpoe, p.cpoe_n)),
        deep_attempt_rate: r3(div(p.deep_att, p.att)), scrambles: p.scrambles,
        pass_rz_attempts: p.pass_rz_att,
        // rushing
        carries: p.carries, rushing_yards: p.rush_yds,
        yards_per_carry: r3(div(p.rush_yds, p.carries)), rushing_tds: p.rush_td,
        rush_epa_per_carry: r3(div(p.rush_epa, p.carries)),
        rush_success_rate: r3(div(p.rush_succ, p.carries)),
        explosive_rush_rate: r3(div(p.expl_rush, p.carries)),
        rush_td_rate: r3(div(p.rush_td, p.carries)),
        red_zone_carries: p.rush_rz, goal_line_carries: p.rush_gtg,
        carry_share: r3(div(p.carries, tt.carries)),
        // receiving
        targets: p.targets, receptions: p.rec, catch_rate: r3(div(p.rec, p.targets)),
        receiving_yards: p.rec_yds, yards_per_reception: r3(div(p.rec_yds, p.rec)),
        yards_per_target: r3(div(p.rec_yds, p.targets)), receiving_tds: p.rec_td,
        rec_td_rate: r3(div(p.rec_td, p.targets)),
        air_yards: p.rec_air, rec_adot: r3(div(p.rec_air, p.targets)),
        yac: p.rec_yac, yac_per_reception: r3(div(p.rec_yac, p.rec)),
        rec_epa_per_target: r3(div(p.rec_epa, p.targets)),
        rec_success_rate: r3(div(p.rec_succ, p.targets)),
        explosive_rec_rate: r3(div(p.expl_rec, p.rec)),
        deep_target_rate: r3(div(p.deep_tgt, p.targets)),
        red_zone_targets: p.rec_rz_tgt,
        target_share: r3(tgtShare), air_yards_share: r3(airShare),
        // WOPR is the standard combined-opportunity measure: targets and air
        // yards weighted the way they actually predict receiving production.
        wopr: r3(1.5 * (tgtShare ?? 0) + 0.7 * (airShare ?? 0)),
        total_touches: p.carries + p.rec,
        total_yards: p.rush_yds + p.rec_yds + p.pass_yds,
        total_tds: p.rush_td + p.rec_td + p.pass_td
      };
      stmt.run(season, Number(week), pid, p.name, p.team, p.opponent, p.position, JSON.stringify(f));
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return teamTot.size;
}

/* ---------------------------------------------------------------- accessors */

export function teamWeeks(season = null, team = null) {
  const where = [], args = [];
  if (season) { where.push('season = ?'); args.push(season); }
  if (team) { where.push('team = ?'); args.push(team); }
  const sql = `SELECT * FROM nfl_team_week_features
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY season, week`;
  return rows(sql, ...args).map(r => ({ ...r, features: JSON.parse(r.features) }));
}

export function playerWeeks(season = null, playerId = null) {
  const where = [], args = [];
  if (season) { where.push('season = ?'); args.push(season); }
  if (playerId) { where.push('player_id = ?'); args.push(playerId); }
  const sql = `SELECT * FROM nfl_player_week_features
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY season, week`;
  return rows(sql, ...args).map(r => ({ ...r, features: JSON.parse(r.features) }));
}

export function pbpCoverage() {
  return {
    team: rows(`SELECT season, COUNT(*) AS rows, COUNT(DISTINCT team) AS teams,
                       MAX(week) AS through_week
                FROM nfl_team_week_features GROUP BY season ORDER BY season`),
    player: rows(`SELECT season, COUNT(*) AS rows, COUNT(DISTINCT player_id) AS players
                  FROM nfl_player_week_features GROUP BY season ORDER BY season`)
  };
}
