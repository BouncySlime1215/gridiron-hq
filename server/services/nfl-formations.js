/**
 * Real formations and charted play detail, from two nflverse datasets this
 * project has never touched.
 *
 * The drive animation was drawing formations from a shotgun *rate* — a single
 * probability applied to a generic five-linemen picture. That is a reasonable
 * placeholder and it is not football. nflverse publishes the actual answer in
 * two releases nothing here was reading:
 *
 *   pbp_participation  offense_formation (SHOTGUN, SINGLEBACK, EMPTY, I_FORM,
 *                      PISTOL, JUMBO, WILDCAT), offense_personnel and
 *                      defense_personnel as counted groupings, defenders in the
 *                      box, and the number of pass rushers.
 *
 *   ftn_charting       hand-charted detail no automated feed produces:
 *                      play action, motion, RPO, screen, QB location, trick
 *                      plays, whether a throw was catchable or contested.
 *
 * Both are free. Together they answer "what did this offence line up in, on this
 * down, against this box" — which is the difference between a drawing and a
 * diagram, and is also a real modelling input the ensemble has never had.
 *
 * A LIMIT WORTH KNOWING, corrected 2026-09-22 by downloading every season:
 * participation is published for 2016-2025, not "through 2023" as this comment
 * previously claimed. 2024 has 45,919 rows over 285 games and 2025 has 45,184
 * over 285 games, both weeks 1-22, with offense_players 100% populated. The
 * real limit is the near edge, not the far one: pbp_participation_2026.csv
 * returns HTTP 404 while snap_counts and stats_player_week are already current
 * through 2026 week 2. So this is excellent history and still not a live feed —
 * it cannot tell you what happened last Sunday.
 *
 * The cost of the old error was two full seasons: 2024 and 2025 both exist,
 * this ingester already handled them, and nobody called it for them because the
 * code said not to bother. If you are reading this in a later year, check the
 * year rather than trusting the numbers above; a hardcoded end season is
 * exactly how the first version went stale.
 */
import { db, rows, row, run } from '../db/index.js';

const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

// nfl_play_formations, nfl_play_charting and their season indexes come from
// server/migrations/000_legacy_schema.js.

/** Split a CSV line, honouring quoted fields — personnel strings contain commas. */
function splitCsv(line) {
  const out = []; let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { quoted = !quoted; continue; }
    if (c === ',' && !quoted) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// An empty CSV cell is unknown, not zero: Number('') === 0 would read a missing box
// count as an empty box.
const num = v => { if (v == null || String(v).trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const bool = v => (v === '1' || v === 'TRUE' || v === 'true' ? 1 : v == null || String(v).trim() === '' ? null : 0);

/** Ingest one season of formation and personnel data. */
export async function ingestFormations(season, { timeoutMs = 900000 } = {}) {
  const res = await fetch(`${BASE}/pbp_participation/pbp_participation_${season}.csv`,
    { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    return { error: `participation for ${season} returned ${res.status}`,
      // No hardcoded end season here: that is what made the previous version of
      // this note wrong for two years running. A 404 means nflverse has not
      // published that season, which for the current season is normal.
      note: res.status === 404
        ? `nflverse has not published participation for ${season}; the current season is never available.`
        : undefined };
  }
  const text = await res.text();
  const lines = text.split('\n');
  const header = splitCsv(lines[0]).map(h => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  let stored = 0, withFormation = 0;
  // Upsert, not insert-or-ignore, for the same reason ingestCharting is one: rows
  // stored before the charted columns existed (migration 070) only get them on a
  // re-ingest, and DO NOTHING would leave them null forever.
  const stmt = db.prepare(`INSERT INTO nfl_play_formations
         (game_id, play_id, season, possession, offense_formation, offense_personnel,
          defense_personnel, defenders_in_box, pass_rushers,
          time_to_throw, was_pressure, defense_man_zone_type, defense_coverage_type)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(game_id, play_id) DO UPDATE SET
           season = excluded.season, possession = excluded.possession,
           offense_formation = excluded.offense_formation,
           offense_personnel = excluded.offense_personnel,
           defense_personnel = excluded.defense_personnel,
           defenders_in_box = excluded.defenders_in_box, pass_rushers = excluded.pass_rushers,
           time_to_throw = excluded.time_to_throw, was_pressure = excluded.was_pressure,
           defense_man_zone_type = excluded.defense_man_zone_type,
           defense_coverage_type = excluded.defense_coverage_type`,
  );
  db.exec('BEGIN');
  try {
    for (const raw of lines.slice(1)) {
      if (!raw.trim()) continue;
      const p = splitCsv(raw);
      const gameId = p[idx.nflverse_game_id];
      const playId = num(p[idx.play_id]);
      if (!gameId || playId == null) continue;
      const formation = (p[idx.offense_formation] ?? '').trim() || null;
      if (formation) withFormation++;
      const manZone = (p[idx.defense_man_zone_type] ?? '').trim() || null;
      const shell = (p[idx.defense_coverage_type] ?? '').trim() || null;
      // Coverage charted is what marks a dropback. `was_pressure` still reads
      // FALSE on runs, kneels, punts and kicks — 51.2% of the 2024 rows — and
      // averaging those in halves the pressure rate (0.1539 against 0.3145).
      // The gate is coverage and not time_to_throw on purpose: 2,689 rows have
      // coverage and no time_to_throw and 74% of them are pressured, because
      // they are the sacks and scrambles.
      const dropback = manZone != null || shell != null;
      stmt.run(gameId, playId, season, p[idx.possession_team] ?? null, formation,
        (p[idx.offense_personnel] ?? '').trim() || null,
        (p[idx.defense_personnel] ?? '').trim() || null,
        num(p[idx.defenders_in_box]), num(p[idx.number_of_pass_rushers]),
        num(p[idx.time_to_throw]), dropback ? bool(p[idx.was_pressure]) : null,
        manZone, shell);
      stored++;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { season, plays_stored: stored, with_formation: withFormation,
    note: 'Formation is blank on special teams and some no-play rows, which is why the counts differ.' };
}

/** Ingest one season of FTN hand-charting. */
export async function ingestCharting(season, { timeoutMs = 900000 } = {}) {
  const res = await fetch(`${BASE}/ftn_charting/ftn_charting_${season}.csv`,
    { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return { error: `ftn charting for ${season} returned ${res.status}` };
  const text = await res.text();
  const lines = text.split('\n');
  const header = splitCsv(lines[0]).map(h => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  let stored = 0;
  // Upsert, not insert-or-ignore: FTN revises charting after games, and rows stored before
  // the pressure/target-quality columns existed (migration 059) must get them on re-ingest.
  const stmt = db.prepare(`INSERT INTO nfl_play_charting
         (game_id, play_id, season, week, qb_location, backfield, defense_box,
          no_huddle, motion, play_action, screen, rpo, trick, out_of_pocket,
          throw_away, contested, n_blitzers, n_pass_rushers, catchable, created_reception,
          drop_, read_thrown, interception_worthy, qb_fault_sack)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(game_id, play_id) DO UPDATE SET
           season = excluded.season, week = excluded.week, qb_location = excluded.qb_location,
           backfield = excluded.backfield, defense_box = excluded.defense_box, no_huddle = excluded.no_huddle,
           motion = excluded.motion, play_action = excluded.play_action, screen = excluded.screen,
           rpo = excluded.rpo, trick = excluded.trick, out_of_pocket = excluded.out_of_pocket,
           throw_away = excluded.throw_away, contested = excluded.contested,
           n_blitzers = excluded.n_blitzers, n_pass_rushers = excluded.n_pass_rushers,
           catchable = excluded.catchable, created_reception = excluded.created_reception,
           drop_ = excluded.drop_, read_thrown = excluded.read_thrown,
           interception_worthy = excluded.interception_worthy, qb_fault_sack = excluded.qb_fault_sack`,
  );
  db.exec('BEGIN');
  try {
    for (const raw of lines.slice(1)) {
      if (!raw.trim()) continue;
      const p = splitCsv(raw);
      const gameId = p[idx.nflverse_game_id];
      const playId = num(p[idx.nflverse_play_id]);
      if (!gameId || playId == null) continue;
      stmt.run(gameId, playId, num(p[idx.season]) ?? season, num(p[idx.week]),
        (p[idx.qb_location] ?? '').trim() || null,
        num(p[idx.n_offense_backfield]), num(p[idx.n_defense_box]),
        bool(p[idx.is_no_huddle]), bool(p[idx.is_motion]), bool(p[idx.is_play_action]),
        bool(p[idx.is_screen_pass]), bool(p[idx.is_rpo]), bool(p[idx.is_trick_play]),
        bool(p[idx.is_qb_out_of_pocket]), bool(p[idx.is_throw_away]), bool(p[idx.is_contested_ball]),
        num(p[idx.n_blitzers]), num(p[idx.n_pass_rushers]), bool(p[idx.is_catchable_ball]),
        bool(p[idx.is_created_reception]), bool(p[idx.is_drop]), num(p[idx.read_thrown]),
        bool(p[idx.is_interception_worthy]), bool(p[idx.is_qb_fault_sack]));
      stored++;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { season, plays_stored: stored };
}

/**
 * How offences actually line up, by down and distance.
 *
 * This is what the drive animation should draw from instead of a single
 * shotgun probability: the real distribution of formations a team uses on
 * third-and-eight is not the one it uses on first-and-ten, and the difference
 * is the whole reason a diagram is worth looking at.
 */
export function formationDistribution({ season = null, team = null } = {}) {
  const where = [], args = [];
  if (season) { where.push('season = ?'); args.push(season); }
  if (team) { where.push('UPPER(possession) = UPPER(?)'); args.push(team); }
  where.push('offense_formation IS NOT NULL');
  const clause = `WHERE ${where.join(' AND ')}`;

  const total = row(`SELECT COUNT(*) AS n FROM nfl_play_formations ${clause}`, ...args)?.n ?? 0;
  if (!total) {
    return { error: 'no formation data stored', hint: 'POST /nfl-betting/formations/ingest' };
  }

  const byFormation = rows(
    `SELECT offense_formation AS formation, COUNT(*) AS n,
            -- NULLIF, because the file writes 0 rather than blank on plays that
            -- were never a dropback: 9,219 of the 2024 rows for box count, 23,754
            -- for rushers. The histogram below already filters them with
            -- defenders_in_box > 0; leaving them in the mean read a league
            -- average box of 4.87 against a real 5.84.
            AVG(CAST(NULLIF(defenders_in_box, 0) AS REAL)) AS mean_box,
            AVG(CAST(NULLIF(pass_rushers, 0) AS REAL)) AS mean_rushers
     FROM nfl_play_formations ${clause}
     GROUP BY offense_formation ORDER BY n DESC`, ...args);

  const byPersonnel = rows(
    `SELECT offense_personnel AS personnel, COUNT(*) AS n FROM nfl_play_formations ${clause}
       AND offense_personnel IS NOT NULL
     GROUP BY offense_personnel ORDER BY n DESC LIMIT 10`, ...args);

  const byBox = rows(
    `SELECT defenders_in_box AS box, COUNT(*) AS n FROM nfl_play_formations ${clause}
       AND defenders_in_box > 0
     GROUP BY defenders_in_box ORDER BY box`, ...args);

  return {
    season: season ?? 'all stored', team: team ?? 'all teams', plays: total,
    formations: byFormation.map(f => ({ formation: f.formation, plays: f.n,
      share: r4(f.n / total), mean_defenders_in_box: f.mean_box == null ? null : +f.mean_box.toFixed(2),
      mean_pass_rushers: f.mean_rushers == null ? null : +f.mean_rushers.toFixed(2) })),
    top_personnel: byPersonnel.map(p => ({ personnel: p.personnel, plays: p.n, share: r4(p.n / total) })),
    defenders_in_box: byBox.map(b => ({ box: b.box, plays: b.n, share: r4(b.n / total) })),
    note: 'Personnel strings are the league\'s own counted groupings — "1 RB, 1 TE, 3 WR" is 11 ' +
      'personnel. Formation is what they lined up in; personnel is who was on the field.'
  };
}

/** What the hand-charting says about how plays are actually run. */
export function chartingSummary({ season = null } = {}) {
  const clause = season ? `WHERE season = ${Number(season)}` : '';
  const total = row(`SELECT COUNT(*) AS n FROM nfl_play_charting ${clause}`)?.n ?? 0;
  if (!total) return { error: 'no charting data stored', hint: 'POST /nfl-betting/formations/ingest' };

  const rates = row(`
    SELECT AVG(CAST(play_action AS REAL)) AS play_action,
           AVG(CAST(motion AS REAL)) AS motion,
           AVG(CAST(screen AS REAL)) AS screen,
           AVG(CAST(rpo AS REAL)) AS rpo,
           AVG(CAST(no_huddle AS REAL)) AS no_huddle,
           AVG(CAST(trick AS REAL)) AS trick,
           AVG(CAST(out_of_pocket AS REAL)) AS out_of_pocket,
           AVG(CAST(defense_box AS REAL)) AS mean_box
    FROM nfl_play_charting ${clause}`) ?? {};

  return {
    season: season ?? 'all stored', plays: total,
    rates: {
      play_action: r4(rates.play_action), motion: r4(rates.motion),
      screen: r4(rates.screen), rpo: r4(rates.rpo), no_huddle: r4(rates.no_huddle),
      trick: r4(rates.trick), qb_out_of_pocket: r4(rates.out_of_pocket)
    },
    mean_defenders_in_box: rates.mean_box == null ? null : +rates.mean_box.toFixed(2),
    note: 'Hand-charted by FTN. Play action, motion and RPO are not derivable from a box score or ' +
      'from ESPN play text, which is what makes this dataset worth having.'
  };
}

/** What is stored. */
export function formationStatus() {
  const f = row(`SELECT COUNT(*) AS n, COUNT(DISTINCT season) AS seasons FROM nfl_play_formations`) ?? {};
  const c = row(`SELECT COUNT(*) AS n, COUNT(DISTINCT season) AS seasons FROM nfl_play_charting`) ?? {};
  const fs = rows(`SELECT season, COUNT(*) AS n FROM nfl_play_formations GROUP BY season ORDER BY season`);
  const cs = rows(`SELECT season, COUNT(*) AS n FROM nfl_play_charting GROUP BY season ORDER BY season`);
  return {
    formations: { plays: f.n ?? 0, seasons: fs.map(x => ({ season: x.season, plays: x.n })) },
    charting: { plays: c.n ?? 0, seasons: cs.map(x => ({ season: x.season, plays: x.n })) },
    limits: 'Participation is published for 2016-2025 (verified 2026-09-22 by download: 2024 = 45,919 ' +
      'plays over 285 games, 2025 = 45,184 over 285). The current season is not published — ' +
      'pbp_participation_2026.csv returns 404 — so this is history for learning formation ' +
      'distributions and not a live feed.'
  };
}
