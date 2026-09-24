/**
 * BLEND-01 runner: the pre-registered tournament that picks how the served weekly number
 * ("this week's points", trade-engine.js currentWeekPpg) combines our projection with ESPN's.
 * Pre-registration: docs/evidence/2026-09-22/weekly-blend-tournament-preregistration.md
 * Library (fits, grades, the selection and ship rules): scripts/weekly-blend-tournament-lib.mjs
 * Served module (the candidates themselves, ESPN reader, the served switch):
 *   server/services/weekly-blend.js
 *
 * Run it on a COPY of the app database, never the original:
 *
 *   sqlite3 ~/gridiron-local/data.sqlite ".backup '<worktree>/.local-db/data.sqlite'"
 *   GRIDIRON_DB_PATH=<worktree>/.local-db/data.sqlite SCHEDULER_DISABLED=1 NFL_SEASON=2026 \
 *     nice -n 10 node --max-old-space-size=3072 scripts/weekly-blend-tournament.mjs <mode> [options]
 *
 * Modes:
 *   --assemble   builds the graded rows and writes them to --rows-dir (never committed:
 *                player ids, fantasy points and ESPN's numbers). Prints counts only, no
 *                metric. History: 2022-2024 weeks 2-17, our number replayed as served
 *                (buildPlayerWeekEngine, configuration B, x active_probability, 0 on a
 *                bye) beside ESPN's archived weekly projection. Forward: 2026 week 2, the
 *                snapshot the app captured before kickoff beside ESPN's settled value.
 *                2025 is refused everywhere (the used-up holdout).
 *   --grade      the tournament itself. Refuses to run unless the pre-registration is
 *                committed and unchanged. Reads --rows-dir, writes aggregates only to --out.
 *   --forward-blind  FIX-164-1: grades only the BLIND forward weeks (2026 weeks whose first game
 *                is after the pre-registration commit and whose games all have scores), ESPN
 *                against ours, per week and pooled, and writes `forward_blind` into --out
 *                (default: the committed output), leaving every other key as it was. The
 *                `forward_unconfirmed` serving hold (weekly-blend.js) lifts only when its
 *                pooled CI lower bound is above 0. Assemble a newly completed week first:
 *                --assemble --forward-only --forward-weeks <N>. Add one HOLDOUT-LEDGER.md row
 *                per graded week.
 *
 * Options:
 *   --rows-dir <dir>       where --assemble writes and --grade reads (default .local-db/blend-rows)
 *   --espn-archive <dir>   ESPN's public weekly projections, one gzip per season, pulled by the
 *                          R&D loop (default ~/gridiron-local/rnd/loop/data/espn_proj_hist).
 *                          Benchmark data, local only (licence: Disney terms of use, personal
 *                          non-commercial; r2-external-espn-weekly-projection-history.md §0).
 *   --out <file.json>      aggregates (default for --grade: the committed output file)
 *   --forward-weeks <a,b>  --assemble: 2026 weeks to assemble beside week 2 (e.g. 3,4)
 *
 * Output: aggregates only (no player rows, no league or manager data), labelled
 * "local copy, not production".
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PREREG = 'docs/evidence/2026-09-22/weekly-blend-tournament-preregistration.md';
export const DEFAULT_OUT = 'docs/evidence/2026-09-22/weekly-blend-tournament-output.json';
const ORIGINAL_DB = path.join(process.env.HOME ?? '', 'gridiron-local', 'data.sqlite');
const DEFAULT_ARCHIVE = path.join(process.env.HOME ?? '', 'gridiron-local', 'rnd', 'loop', 'data', 'espn_proj_hist');
export const HISTORY_SEASONS = Object.freeze([2022, 2023, 2024]);
export const HELD_OUT = 2025;
export const FORWARD = 2026;
export const FORWARD_WEEKS = Object.freeze([2]);
export const FIRST_WEEK = 2;
export const LAST_WEEK = 17;
/** The coordinator fit S-03 promotes (weekly-construction-walk-forward-output.json forward.fit.id). */
export const SERVED_COORDINATOR_FIT_ID = 7;
/** No 2022-2024 or 2026 team has a bye before week 5 (game_lines); a bye there means a team-code mismatch. */
const NO_BYE_WEEKS = new Set([2, 3, 4]);

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

export function refuseHoldout(season) {
  if (season === HELD_OUT) throw new Error(`${HELD_OUT} is the used-up holdout (STATS-METHOD.md rule 2); BLEND-01 never opens it`);
  return season;
}

/**
 * ESPN's archived weekly projection for one season: `${espnId}|${week}` -> points
 * (statSourceId 1 = projection, statSplitTypeId 1 = one scoring period; appliedTotal is
 * leaguedefaults/3's full-PPR score). Players outside QB/RB/WR/TE are skipped.
 */
export function parseEspnArchive(json, season) {
  const SKILL = new Set([1, 2, 3, 4]);
  const out = new Map();
  let players = 0;
  for (const entry of json?.players ?? []) {
    const pl = entry?.player ?? {};
    if (!SKILL.has(pl.defaultPositionId) || !Number.isFinite(Number(pl.id))) continue;
    players++;
    for (const s of pl.stats ?? []) {
      if (s.seasonId !== season || s.statSourceId !== 1 || s.statSplitTypeId !== 1) continue;
      const week = Number(s.scoringPeriodId);
      const pts = Number(s.appliedTotal);
      if (!Number.isInteger(week) || week < 1 || week > 18 || !Number.isFinite(pts)) continue;
      out.set(`${Number(pl.id)}|${week}`, pts);
    }
  }
  return { byEspnWeek: out, players };
}

function readArchive(dir, season) {
  refuseHoldout(season);
  const file = path.join(dir, `espn_leaguedefaults3_${season}.json.gz`);
  if (!fs.existsSync(file)) throw new Error(`ESPN archive for ${season} not found at ${file}`);
  const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  return { file: path.basename(file), ...parseEspnArchive(json, season) };
}

/**
 * One value per ESPN player from several league rows (league-scored): the rows must agree
 * to the cent, otherwise the player gets null and is counted as conflicting (C-01's rule).
 */
export function oneValuePerPlayer(list, key, value) {
  const seen = new Map();
  for (const r of list) {
    const k = String(r[key]);
    const v = r[value];
    if (v == null || !Number.isFinite(Number(v))) continue;
    const cur = seen.get(k);
    if (!cur) seen.set(k, { value: Number(v), conflict: false });
    else if (Math.abs(cur.value - Number(v)) > 0.01) cur.conflict = true;
  }
  const out = new Map();
  let conflicting = 0;
  for (const [k, { value: v, conflict }] of seen) {
    if (conflict) conflicting++;
    else out.set(k, v);
  }
  return { values: out, conflicting };
}

/**
 * S-03's served construction for one projection, rebuilt from the merged served functions
 * (fantasy-coordinator.js servedWeekConstruction on S-03's branch, :710-729, with its
 * promoted fit on in every window, as S-03's walk-forward decided): the structural head plus
 * the coordinator's correction when the fit is ready and the player has coordinator inputs,
 * otherwise the ensemble. `--assemble` checks this against servedWeekConstruction itself
 * whenever that function is importable (S-03 merged into the tree the runner runs on).
 */
export function servedBaseFor(proj, fit, { season, week, scoring }, deps) {
  const A = Number.isFinite(proj?.ppg) ? proj.ppg : null;
  if (A == null) return { base: null, arm: null };
  if (!fit?.ready || !Number.isFinite(proj.structural_ppg)) return { base: A, arm: 'A' };
  const experts = deps.weeklyExpertValues(proj, season, week, scoring);
  if (!experts) return { base: A, arm: 'A' };
  const c = deps.coordinateFantasy(fit, experts, proj.structural_ppg);
  return c?.ready ? { base: c.corrected_ppg, arm: 'S1' } : { base: A, arm: 'A' };
}

async function assemble({ rowsDir, archiveDir, log, forwardOnly = false }) {
  const { rows: dbRows } = await import('../server/db/index.js');
  const { PPR } = await import('../server/services/scoring.js');
  const { actuals } = await import('../server/services/backtest.js');
  const { buildPlayerWeekEngine, clearPlayerWeekEngineCache } = await import('../server/services/player-week-engine.js');
  const { activeKVectorFor } = await import('../server/services/shrinkage-fit.js');
  const { WEEKLY_ROLE_RECENCY } = await import('../server/services/weekly-ensemble.js');
  const { activeWeeklyWeightSet } = await import('../server/services/weekly-weight-store.js');
  const { weeklyAvailability } = await import('../server/services/contingency.js');
  const coordinator = await import('../server/services/fantasy-coordinator.js');
  const { eligibleRows, assertKControl, assertFitCutoff } = await import('./weekly-construction-grade-lib.mjs');
  const deps = { weeklyExpertValues: coordinator.weeklyExpertValues, coordinateFantasy: coordinator.coordinateFantasy };
  const STRUCTURAL_TARGET = 'structural-projection residual';

  const report = { k_control: {}, weight_sets: {}, seasons: {}, forward: {}, coordinator: {} };
  // ---- Stop condition 1 (standing rule 3): every graded season runs on the fitted volume k.
  for (const season of [...HISTORY_SEASONS, FORWARD]) {
    report.k_control[season] = assertKControl(activeKVectorFor(WEEKLY_ROLE_RECENCY, { predictingSeason: season }), season);
    for (const week of [2, 6]) report.weight_sets[`${season}-W${week}`] = activeWeeklyWeightSet({ season, week }).id;
  }
  log('k control', report.k_control, 'weight sets', report.weight_sets);

  // Each player row's own ESPN id, as the producer reads p.espn_id (players.espn_id, writer
  // espn-draft.js:135 resolveEspnPlayers). 0 is the table's "unknown" placeholder, never an id.
  const playerToEspn = new Map(dbRows('SELECT id, espn_id FROM players WHERE espn_id IS NOT NULL AND espn_id != 0')
    .map(p => [p.id, String(Number(p.espn_id))]));
  report.id_map = { players_with_espn_id: playerToEspn.size, distinct_espn_ids: new Set(playerToEspn.values()).size,
    zero_placeholders_skipped: dbRows('SELECT COUNT(*) AS n FROM players WHERE espn_id = 0')[0]?.n ?? null };

  const teamsWithGame = (season, week) => new Set(dbRows('SELECT team FROM game_lines WHERE season = ? AND week = ?', season, week)
    .map(g => g.team));
  const teamsInSeason = season => new Set(dbRows('SELECT DISTINCT team FROM game_lines WHERE season = ?', season).map(g => g.team));

  fs.mkdirSync(path.resolve(ROOT, rowsDir), { recursive: true });
  const writeRows = (name, list) => fs.writeFileSync(path.resolve(ROOT, rowsDir, name),
    list.map(r => JSON.stringify(r)).join('\n') + '\n');

  // ---- History. Our number for each decision row exactly as the producer prices it once
  // S-03 is in: servedBaseFor (structural + the coordinator's correction, walk-forward fits)
  // x thisGame.mult (1) x active_probability (?? 0.92, trade-engine.js:346), 0 on a bye.
  // ours_A is the same without the coordinator (the ensemble), for the sensitivity row.
  if (!forwardOnly) {
    // Walk-forward coordinator fits (S-02/HX-01 shape): the fit that grades season S has
    // seen seasons <= S - 1 only.
    const examples = await coordinator.buildFantasyCoordinatorExamples({ fromSeason: HISTORY_SEASONS[0] - 1,
      throughSeason: HISTORY_SEASONS.at(-1) - 1 });
    const fits = {};
    for (const season of HISTORY_SEASONS) {
      const base = examples.filter(e => e.season <= season - 1);
      assertFitCutoff(base, season - 1, `coordinator fit for ${season}`);
      const fit = coordinator.fitFantasyCoordinator(base);
      if (!fit.ready) throw new Error(`coordinator fit for ${season} not ready: ${fit.reason}`);
      if (fit.safeguards?.target !== STRUCTURAL_TARGET) throw new Error(`coordinator fit for ${season}: target ${fit.safeguards?.target}`);
      fits[season] = fit;
      report.coordinator[season] = { through: season - 1, rows: base.length, intercept: fit.coefficients?.[0] ?? null };
    }
    log('coordinator fits', report.coordinator);
    for (const season of HISTORY_SEASONS) {
      refuseHoldout(season);
      const archive = readArchive(archiveDir, season);
      const truth = actuals(season, PPR);
      const known = teamsInSeason(season);
      const out = [];
      const census = [];
      for (let week = FIRST_WEEK; week <= LAST_WEEK; week++) {
        const engine = buildPlayerWeekEngine({ season, week, scoring: PPR });
        const availability = weeklyAvailability(season, week, { through: season - 1 });
        const withGame = teamsWithGame(season, week);
        let decisions = 0, byes = 0, noEspn = 0, unknownTeam = 0, ensembleFallback = 0;
        for (const row of eligibleRows(week, engine, truth)) {
          if (!row.decision) continue;
          decisions++;
          const team = row.proj.team ?? null;
          if (team != null && !known.has(team)) unknownTeam++;
          const hasGame = team != null && withGame.has(team);
          if (!hasGame) byes++;
          const a = availability.get(row.player_id) ?? null;
          const p = a?.active_probability ?? 0.92;
          const served = servedBaseFor(row.proj, fits[season], { season, week, scoring: PPR }, deps);
          if (served.base == null) throw new Error(`${season} W${week}: player ${row.player_id} has no weekly number`);
          if (served.arm !== 'S1') ensembleFallback++;
          const espnId = playerToEspn.get(row.player_id) ?? null;
          const espn = espnId != null ? archive.byEspnWeek.get(`${espnId}|${week}`) ?? null : null;
          if (espn == null) noEspn++;
          out.push({ season, week, player_id: row.player_id, position: row.position, played: row.played,
            actual: row.actual, A: row.proj.ppg, base: served.base, base_arm: served.arm, p, bye: !hasGame,
            ours: hasGame ? served.base * 1 * p : 0, ours_A: hasGame ? row.proj.ppg * 1 * p : 0,
            espn: hasGame ? espn : (espn == null ? null : 0), report_status: a?.report_status ?? null });
        }
        // ---- Stop condition 2: team codes. No team has a bye in weeks 2-4 of these seasons.
        if (unknownTeam) throw new Error(`${season} W${week}: ${unknownTeam} rows carry a team code game_lines never uses`);
        if (NO_BYE_WEEKS.has(week) && byes) throw new Error(`${season} W${week}: ${byes} bye rows in a week with no byes`);
        census.push({ week, decision_rows: decisions, byes, no_espn: noEspn, ensemble_fallback: ensembleFallback });
        log(`${season} W${week}: ${decisions} decision rows, ${byes} bye, ${noEspn} without ESPN, ${ensembleFallback} on the ensemble`);
      }
      clearPlayerWeekEngineCache();
      // ---- Stop condition 3: a known-nonzero count before anything is written.
      if (!out.length) throw new Error(`${season}: no decision rows`);
      writeRows(`rows-${season}.ndjson`, out);
      report.seasons[season] = { archive: { file: archive.file, skill_players: archive.players,
        player_weeks: archive.byEspnWeek.size }, rows: out.length, with_espn: out.filter(r => r.espn != null).length, census };
    }
  }

  // ---- Forward: 2026 week 2 (the only 2026 week with a pre-kickoff snapshot and outcomes).
  const season = FORWARD;
  // The fit S-03 promotes (its walk-forward output: fit id 7, through 2025), pinned by id.
  const fitRow = dbRows('SELECT id, through_season, fit_json FROM fantasy_coordinator_fits WHERE id = ?', SERVED_COORDINATOR_FIT_ID)[0];
  if (!fitRow) throw new Error(`coordinator fit ${SERVED_COORDINATOR_FIT_ID} is not stored in this database`);
  if (!(fitRow.through_season < season)) throw new Error(`coordinator fit ${fitRow.id} reaches ${fitRow.through_season}`);
  const servedFit = JSON.parse(fitRow.fit_json);
  if (!servedFit.ready || servedFit.safeguards?.target !== STRUCTURAL_TARGET) throw new Error(`coordinator fit ${fitRow.id} is not a ready structural fit`);
  report.coordinator[season] = { fit_id: fitRow.id, through: fitRow.through_season, intercept: servedFit.coefficients?.[0] ?? null };
  const parityFn = typeof coordinator.servedWeekConstruction === 'function' ? coordinator.servedWeekConstruction : null;
  const archive2026 = readArchive(archiveDir, season);
  const truth = actuals(season, PPR);
  const known = teamsInSeason(season);
  const out = [];
  const extra = (arg('--forward-weeks') ?? '').split(',').filter(Boolean).map(Number);
  if (extra.some(w => !Number.isInteger(w) || w < 1 || w > 18)) throw new Error(`--forward-weeks ${arg('--forward-weeks')}: weeks 1-18`);
  for (const week of [...new Set([...FORWARD_WEEKS, ...extra])].sort((a, b) => a - b)) {
    const engine = buildPlayerWeekEngine({ season, week, scoring: PPR });
    const availability = weeklyAvailability(season, week, { through: season - 1 });
    const withGame = teamsWithGame(season, week);
    const snapshot = new Map(dbRows(`SELECT player_id, prediction, weight_fit, as_of FROM weekly_prediction_snapshots
                                     WHERE season = ? AND week = ?`, season, week).map(s => [s.player_id, s]));
    // ESPN's settled weekly projection (league_roster_snapshots, writer
    // scripts/collect-roster-snapshots.mjs:109 writePeriod, value built at :92), one value
    // per player-week across leagues, conflicting leagues dropped.
    const settled = oneValuePerPlayer(dbRows(`SELECT espn_player_id, projected_points FROM league_roster_snapshots
      WHERE season = ? AND scoring_period_id = ? AND source = 'final' AND on_roster = 1`, season, week),
    'espn_player_id', 'projected_points');
    // ESPN's Thursday capture (espn_player_market_weekly: no writer in the repo; one capture).
    const thursday = oneValuePerPlayer(dbRows(`SELECT espn_id, week_proj FROM espn_player_market_weekly
      WHERE season = ? AND week = ?`, season, week), 'espn_id', 'week_proj');
    const captured = dbRows(`SELECT MIN(captured_at) AS first, MAX(captured_at) AS last FROM espn_player_market_weekly
      WHERE season = ? AND week = ?`, season, week)[0] ?? null;
    let decisions = 0, byes = 0, unknownTeam = 0, noSnapshot = 0, ensembleFallback = 0, parityChecked = 0;
    for (const row of eligibleRows(week, engine, truth)) {
      if (!row.decision) continue;
      decisions++;
      const team = row.proj.team ?? null;
      if (team != null && !known.has(team)) unknownTeam++;
      const hasGame = team != null && withGame.has(team);
      if (!hasGame) byes++;
      const a = availability.get(row.player_id) ?? null;
      const p = a?.active_probability ?? 0.92;
      const served = servedBaseFor(row.proj, servedFit, { season, week, scoring: PPR }, deps);
      if (served.base == null) throw new Error(`${season} W${week}: player ${row.player_id} has no weekly number`);
      if (served.arm !== 'S1') ensembleFallback++;
      if (parityFn) {
        const s03 = parityFn(row.proj, { fit: servedFit, season, week, scoring: PPR, windows: { '2-4': 'on', '5-17': 'on' } });
        if (s03?.ppg !== served.base) throw new Error(`parity: 2026 W${week} player ${row.player_id} servedBaseFor ${served.base} vs servedWeekConstruction ${s03?.ppg}`);
        parityChecked++;
      }
      const snap = snapshot.get(row.player_id) ?? null;
      if (!snap) noSnapshot++;
      const espnId = playerToEspn.get(row.player_id) ?? null;
      const pick = m => (espnId != null ? m.get(espnId) ?? null : null);
      out.push({ season, week, player_id: row.player_id, position: row.position, played: row.played, actual: row.actual,
        p, bye: !hasGame, report_status: a?.report_status ?? null,
        A: row.proj.ppg, base: served.base, base_arm: served.arm,
        ours: hasGame ? served.base * 1 * p : 0, ours_A: hasGame ? row.proj.ppg * 1 * p : 0,
        A_snapshot: snap ? Number(snap.prediction) : null, weight_fit: snap?.weight_fit ?? null,
        ours_snapshot: snap && hasGame ? Number(snap.prediction) * 1 * p : (hasGame ? null : 0),
        espn: pick(settled.values), espn_thursday: pick(thursday.values),
        espn_archive: espnId != null ? archive2026.byEspnWeek.get(`${espnId}|${week}`) ?? null : null });
    }
    if (unknownTeam) throw new Error(`${season} W${week}: ${unknownTeam} rows carry a team code game_lines never uses`);
    if (NO_BYE_WEEKS.has(week) && byes) throw new Error(`${season} W${week}: ${byes} bye rows in a week with no byes`);
    const inWeek = out.filter(r => r.week === week);
    report.forward[week] = { decision_rows: decisions, byes, no_snapshot: noSnapshot, ensemble_fallback: ensembleFallback,
      parity: parityFn ? { checked: parityChecked, against: 'fantasy-coordinator.js servedWeekConstruction' }
        : { checked: 0, reason: 'servedWeekConstruction is not in this tree (S-03 not merged)' },
      snapshot_rows: snapshot.size, snapshot_as_of: [...new Set([...snapshot.values()].map(s => s.as_of))],
      snapshot_weight_fit: [...new Set([...snapshot.values()].map(s => s.weight_fit))],
      espn_settled: { player_weeks: settled.values.size, conflicting: settled.conflicting },
      espn_thursday: { player_weeks: thursday.values.size, conflicting: thursday.conflicting, captured },
      espn_archive_player_weeks: [...archive2026.byEspnWeek.keys()].filter(k => k.endsWith(`|${week}`)).length,
      with: { espn: inWeek.filter(r => r.espn != null).length, espn_archive: inWeek.filter(r => r.espn_archive != null).length,
        snapshot: inWeek.filter(r => r.ours_snapshot != null).length } };
    log(`${season} W${week}:`, JSON.stringify(report.forward[week]));
  }
  clearPlayerWeekEngineCache();
  if (!out.length) throw new Error(`${season}: no forward rows`);
  writeRows(`rows-${season}.ndjson`, out);
  return report;
}

/**
 * 2026 weeks in order with their first game day and whether every game has a final score
 * (game_lines), for the blind forward check. Reads the database copy only.
 */
export async function forwardWeeks(season = FORWARD) {
  const { rows: dbRows } = await import('../server/db/index.js');
  return dbRows(`SELECT week, MIN(gameday) AS first_gameday, SUM(team_score IS NULL) AS unscored
                 FROM game_lines WHERE season = ? AND gameday IS NOT NULL GROUP BY week ORDER BY week`, season)
    .map(r => ({ week: r.week, first_gameday: r.first_gameday, complete: r.unscored === 0 }));
}

async function main() {
  const mode = ['--assemble', '--grade', '--forward-blind'].find(m => process.argv.includes(m));
  if (!mode) throw new Error('choose one mode: --assemble, --grade or --forward-blind');
  if (!process.env.GRIDIRON_DB_PATH) throw new Error('set GRIDIRON_DB_PATH to a COPY of the app database');
  if (path.resolve(process.env.GRIDIRON_DB_PATH) === path.resolve(ORIGINAL_DB)) {
    throw new Error(`refusing to run on ${ORIGINAL_DB}; make a .backup copy first`);
  }
  process.env.SCHEDULER_DISABLED = '1';
  const rowsDir = arg('--rows-dir') ?? '.local-db/blend-rows';
  const t0 = Date.now();
  const log = (...a) => console.log(`[blend-01 ${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
  if (mode === '--assemble') {
    const forwardOnly = process.argv.includes('--forward-only');
    const report = await assemble({ rowsDir, archiveDir: arg('--espn-archive') ?? DEFAULT_ARCHIVE, log, forwardOnly });
    const file = path.resolve(ROOT, rowsDir, forwardOnly ? 'assemble-forward-report.json' : 'assemble-report.json');
    fs.writeFileSync(file, `${JSON.stringify({ label: 'local copy, not production',
      tree: { head: git('rev-parse', 'HEAD') }, ...report }, null, 2)}\n`);
    log('assembled; counts in', path.relative(ROOT, file));
    return;
  }
  const lib = await import('./weekly-blend-tournament-lib.mjs');
  const blindWeeks = await forwardWeeks();
  const out = arg('--out') ?? DEFAULT_OUT;
  if (mode === '--forward-blind') {
    if (!git('ls-files', PREREG) || git('status', '--porcelain', '--', PREREG)) throw new Error(`${PREREG} must be committed and unchanged`);
    const file = path.resolve(ROOT, out);
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rowsFile = path.resolve(ROOT, rowsDir, 'rows-2026.ndjson');
    const rows = fs.existsSync(rowsFile)
      ? fs.readFileSync(rowsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    report.forward_blind = { graded_at: new Date().toISOString(), tree: { head: git('rev-parse', 'HEAD') },
      label: 'local copy, not production', ...lib.forwardBlind(rows, blindWeeks) };
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    log('forward_blind', JSON.stringify({ graded: report.forward_blind.weeks.map(w => ({ week: w.week, pa_diff: w.pa_diff, ci90: w.pa.ci90 })),
      pooled: report.forward_blind.pooled?.pa ?? null, lifts_hold: report.forward_blind.lifts_hold }));
    return;
  }
  await lib.grade({ root: ROOT, rowsDir, out, prereg: PREREG, git, log, blindWeeks });
}

const invokedDirectly = (() => {
  try { return import.meta.url === `file://${fs.realpathSync(process.argv[1] ?? '')}`; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
})();
if (invokedDirectly) {
  main().catch(error => { console.error(error); process.exit(1); });
}
