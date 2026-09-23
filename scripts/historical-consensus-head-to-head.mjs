#!/usr/bin/env node
/**
 * HX-01 runner: our served start/sit number against public consensus, 2022-2024 walk-forward,
 * and the 2026 weeks already played as forward.
 * Pre-registration: docs/evidence/2026-09-22/historical-consensus-head-to-head-preregistration.md
 * Libraries: scripts/historical-consensus-lib.mjs (served rows), scripts/consensus-arm.mjs (grade).
 *
 * Run it on a COPY of the app database, never the original, with the FantasyPros benchmark
 * export beside it (both git-excluded under .local-db/):
 *
 *   sqlite3 ~/gridiron-local/data.sqlite ".backup '<worktree>/.local-db/data.sqlite'"
 *   python3.12 -c "<the export in the evidence file, section 5>"   # -> .local-db/fp-ecr-weekly-wp.csv
 *   cp ~/gridiron-local/rnd/loop/data/dp/db_playerids.csv .local-db/
 *   GRIDIRON_DB_PATH=<worktree>/.local-db/data.sqlite SCHEDULER_DISABLED=1 NFL_SEASON=2026 \
 *     node --max-old-space-size=3072 scripts/historical-consensus-head-to-head.mjs <mode> \
 *       [--ecr .local-db/fp-ecr-weekly-wp.csv] [--ids .local-db/db_playerids.csv] [--out file.json]
 *
 * Modes:
 *   --smoke  plumbing only: the k control, the consensus join and 2024 week 6's rows through every
 *            stop condition. Prints counts, no metric.
 *   --full   the pre-registered grade. Refuses to run unless the pre-registration is committed
 *            and unchanged. Never opens 2025.
 *
 * Output: aggregates only (no player rows, no FantasyPros values, no league or manager data),
 * labelled "local copy, not production". Besides the pre-registered grade it carries, each
 * labelled post hoc and report-only:
 *   coordinator.rows_from_k_excluded_seasons  how much of each graded season's coordinator fit
 *                                             comes from 2021, whose engines run the hand-set k
 *   sensitivity.coordinator_served_recipe     OURS with the coordinator on the served recipe's
 *                                             seasons (from 2022), same rows, 2023 and 2024
 *   forward.what_ours_is                      the forward OURS is a replay of the copy's current
 *                                             chain, not the number production served
 *   forward.same_rows                         the saved snapshot, A, D and OURS against ESPN on
 *                                             one row set
 *   forward.c01_reconciliation                headToHead on C-01's rows equals C-01's
 *                                             served-vs-ESPN grade (the run stops otherwise)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREREG = 'docs/evidence/2026-09-22/historical-consensus-head-to-head-preregistration.md';
const DEFAULT_OUT = 'docs/evidence/2026-09-22/historical-consensus-head-to-head-output.json';
const ORIGINAL_DB = path.join(process.env.HOME ?? '', 'gridiron-local', 'data.sqlite');
const THRESHOLD = 4;
const COMPARISONS = Object.freeze([
  ['ours', 'consensus'], ['ours', 'std'], ['ours', 'l3'], ['consensus', 'std'], ['D', 'consensus'], ['A', 'consensus']
]);

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
const sha256 = file => execFileSync('shasum', ['-a', '256', file], { encoding: 'utf8' }).split(' ')[0];

async function main() {
  const mode = ['--smoke', '--full'].find(m => process.argv.includes(m));
  if (!mode) throw new Error('choose one mode: --smoke or --full');
  if (!process.env.GRIDIRON_DB_PATH) throw new Error('set GRIDIRON_DB_PATH to a COPY of the app database');
  if (path.resolve(process.env.GRIDIRON_DB_PATH) === path.resolve(ORIGINAL_DB)) {
    throw new Error(`refusing to run on ${ORIGINAL_DB}; make a .backup copy first`);
  }
  process.env.SCHEDULER_DISABLED = '1';
  const lib = await import('./historical-consensus-lib.mjs');
  const prereg = mode === '--full' ? lib.preregState(git, PREREG) : null;

  const { dbPath, rows: dbRows } = await import('../server/db/index.js');
  const { PPR } = await import('../server/services/scoring.js');
  const { actuals } = await import('../server/services/backtest.js');
  const { buildPlayerWeekEngine, clearPlayerWeekEngineCache } = await import('../server/services/player-week-engine.js');
  const { activeKVectorFor, activeFitMeta } = await import('../server/services/shrinkage-fit.js');
  const { WEEKLY_ROLE_RECENCY } = await import('../server/services/weekly-ensemble.js');
  const { activeWeeklyWeightSet } = await import('../server/services/weekly-weight-store.js');
  const { activeFantasyCoordinatorFit } = await import('../server/services/fantasy-coordinator.js');
  const { matchupSignalActive } = await import('../server/services/matchups.js');
  const {
    espnProjections, servedSnapshots, servedArms, replayWindow, substitute, STARTABLE_PPR
  } = await import('../server/services/gates/start-sit-gate.js');
  const { startSitPairAccuracy } = await import('./promote-early-week-weights.mjs');
  const { normalizePlayerName } = await import('../server/services/player-identity.js');
  const s02 = await import('./weekly-construction-grade-lib.mjs');
  const arm = await import('./consensus-arm.mjs');

  const t0 = Date.now();
  const log = (...a) => console.log(`[hx-01 ${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
  const report = {
    unit: 'HX-01', mode, label: 'local copy, not production',
    tree: { head: git('rev-parse', 'HEAD'), write_tree: git('write-tree') },
    database: { path_basename: path.basename(dbPath) }, prereg,
    configuration: {
      engine: 'buildPlayerWeekEngine (player-week-engine.js:256), roleRecency WEEKLY_ROLE_RECENCY hardcoded at :273, kOverride omitted',
      ours: 'startSitWeekPoints({ team_abbr: proj.team, position, current_week_ppg: round2(B x thisGame.mult x p) }).week_points',
      this_game_mult: lib.THIS_GAME_MULT, default_active_probability: lib.DEFAULT_ACTIVE_PROBABILITY,
      lift_team: 'the engine team at the cutoff (proj.team), not players.team_abbr (today\'s team)',
      scoring: 'PPR', threshold: THRESHOLD, startable_sensitivity: STARTABLE_PPR,
      population: 'S-02 eligibleRows decision rows (played week - 1), byes removed (C-01 removeByes), leak guard, ECR-ranked; DNP scored 0',
      bootstrap: 'C-01 gradeDecisions (pigeonhole player clusters and season-week clusters) and pigeonholeBootstrap for the pair-accuracy difference; 2000 draws, seed 1, 90% CI',
      sign_convention: 'policy minus baseline; positive favours the policy (OURS in every H1/H2 comparison)'
    },
    started_at: new Date().toISOString()
  };
  const out = arg('--out') ?? (mode === '--full' ? DEFAULT_OUT : null);
  const write = () => { if (out) fs.writeFileSync(path.resolve(ROOT, out), `${JSON.stringify(report, null, 2)}\n`); };

  // ---- Stop condition: thisGame.mult is 1 only while the matchup signal is off.
  if (matchupSignalActive()) throw new Error('a matchup multiplier is on, so thisGame.mult is not 1; the replay would not be the served number');

  // ---- Stop condition 1: the k control, per requested season, and the forward season.
  const k = lib.kControlSeasons(lib.REQUESTED_SEASONS, season => activeKVectorFor(WEEKLY_ROLE_RECENCY, { predictingSeason: season }));
  const forwardK = s02.assertKControl(activeKVectorFor(WEEKLY_ROLE_RECENCY, { predictingSeason: lib.FORWARD }), lib.FORWARD);
  const graded = k.graded.map(g => g.season);
  if (!graded.length) throw new Error('k control: no requested season can be graded');
  report.k_control = { graded: k.graded, excluded: k.excluded, forward: { season: lib.FORWARD, target_share_k: forwardK } };
  report.weight_sets = Object.fromEntries([...graded, lib.FORWARD].flatMap(s => [2, 6].map(w => [`${s}-W${w}`, activeWeeklyWeightSet({ season: s, week: w }).id])));
  log('k control', JSON.stringify(report.k_control), 'weights', JSON.stringify(report.weight_sets));

  // ---- The consensus: the local FantasyPros export, mapped to weeks and app players.
  const ecrFile = path.resolve(ROOT, arg('--ecr') ?? '.local-db/fp-ecr-weekly-wp.csv');
  const idsFile = path.resolve(ROOT, arg('--ids') ?? '.local-db/db_playerids.csv');
  const ecrRows = arm.parseEcrCsv(fs.readFileSync(ecrFile, 'utf8'));
  // Schedules for every requested season and the forward one; never 2025's.
  const seasons = [...lib.REQUESTED_SEASONS, lib.FORWARD].map(lib.assertNotHoldout);
  const bounds = arm.weekBounds(dbRows(`SELECT season, week, gameday FROM game_lines
    WHERE season IN (${seasons.map(() => '?').join(',')}) AND week BETWEEN 1 AND 18`, ...seasons));
  const players = new Map(dbRows(`SELECT id, name, position, gsis_id FROM players WHERE position IN ('QB','RB','WR','TE')`)
    .map(p => [p.id, p]));
  const byGsis = new Map([...players.values()].filter(p => p.gsis_id).map(p => [String(p.gsis_id), p.id]));
  const fpToGsis = new Map();
  const idLines = fs.readFileSync(idsFile, 'utf8').split(/\r?\n/).filter(Boolean);
  const idHeader = arm.splitCsvLine(idLines.shift());
  const fpCol = idHeader.indexOf('fantasypros_id'), gsisCol = idHeader.indexOf('gsis_id');
  if (fpCol < 0 || gsisCol < 0) throw new Error('id map: db_playerids.csv needs fantasypros_id and gsis_id');
  for (const line of idLines) {
    const f = arm.splitCsvLine(line);
    const fp = f[fpCol], gsis = f[gsisCol];
    if (fp && fp !== 'NA' && gsis && gsis !== 'NA') fpToGsis.set(String(fp), String(gsis));
  }
  const idMap = { get: fpId => byGsis.get(fpToGsis.get(fpId)) };
  const ecr = arm.ecrConsensus(ecrRows, { bounds, idMap, positionOf: id => players.get(id)?.position, excludeSeasons: [lib.HELD_OUT] });
  // Name cross-check: FantasyPros' name against the app's, both through the app's normalizer.
  const named = new Map();
  for (const r of ecrRows) {
    const id = idMap.get(r.fp_id);
    if (id != null && r.player && !named.has(r.fp_id)) named.set(r.fp_id, normalizePlayerName(r.player) === normalizePlayerName(players.get(id)?.name ?? ''));
  }
  report.consensus = {
    source: arm.CONSENSUS_SOURCES.fantasypros_ecr,
    not_used: { sleeper_rotowire: arm.CONSENSUS_SOURCES.sleeper_rotowire.use, espn_2021_2024: 'not available: the app\'s ESPN client reads each league\'s current season only (scripts/collect-roster-snapshots.mjs:220,230-233)' },
    file_sha256: sha256(ecrFile), id_map_sha256: sha256(idsFile), rows_parsed: ecrRows.length,
    counts: ecr.counts,
    weeks: Object.fromEntries(seasons.map(s => [s, [...ecr.scrapeByWeek].filter(([key]) => key.startsWith(`${s}|`))
      .map(([key, date]) => ({ week: Number(key.split('|')[1]), scrape_date: date, weekday: new Date(`${date}T12:00:00Z`).toUTCString().slice(0, 3) }))
      .sort((a, b) => a.week - b.week)])),
    name_check: { fantasypros_ids_mapped: named.size, names_agree: [...named.values()].filter(Boolean).length,
      share: named.size ? +([...named.values()].filter(Boolean).length / named.size).toFixed(4) : null }
  };
  for (const s of graded) {
    if (!ecr.counts.by_season[s]?.kept) throw new Error(`consensus join: no FantasyPros row survived for ${s}`);
  }
  log('consensus', JSON.stringify(report.consensus.counts), 'names', JSON.stringify(report.consensus.name_check));
  write();

  // ---- One season's rows through every stop condition.
  // `alsoRegistry` (post hoc, report-only): a second walk-forward registry whose OURS is carried
  // beside the pre-registered one as `ours_recipe`, on the same engine and the same rows.
  const seasonRows = (season, weeks, registry, { keepPreLeak = false, alsoRegistry = null } = {}) => {
    const truth = actuals(season, PPR);
    const usage = dbRows('SELECT player_id, week, team FROM player_week_usage WHERE season = ?', season);
    const teamAt = lib.teamAtWeek(usage);
    const gameDateOf = arm.gameDateLookup(dbRows('SELECT season, week, team, gameday FROM game_lines WHERE season = ?', season));
    const kept = [], preLeak = [], census = [];
    const fitThrough = new Set();
    for (const week of weeks) {
      const engine = buildPlayerWeekEngine({ season, week, scoring: PPR });
      let rowsW = arm.withConsensus(lib.servedWeekRows({ season, week, engine, truth, registry, scoring: PPR, teamAt }),
        ecr.values);
      for (const r of rowsW) fitThrough.add(r.fit_through);
      if (alsoRegistry?.has(season)) {
        const alt = new Map(lib.servedWeekRows({ season, week, engine, truth, registry: alsoRegistry, scoring: PPR, teamAt })
          .map(r => [r.player_id, r]));
        rowsW = rowsW.map(r => ({ ...r, ours_recipe: alt.get(r.player_id)?.ours ?? null, B_recipe: alt.get(r.player_id)?.B ?? null,
          fit_through_recipe: alt.get(r.player_id)?.fit_through ?? null }));
      }
      const byes = lib.SERVED_CHAIN.removeByes(rowsW, usage);
      const leak = arm.leakGuard(byes.kept, { scrapeByWeek: ecr.scrapeByWeek, gameDateOf });
      kept.push(...leak.kept);
      if (keepPreLeak) preLeak.push(...byes.kept);
      census.push({ week, decision_rows: rowsW.length, coordinator_moved: rowsW.filter(r => r.B !== r.A).length,
        byes_removed: byes.removed.length, team_unknown: byes.team_unknown,
        leak_dropped: leak.dropped_game_on_or_before_scrape, no_game_date: leak.no_game_date, no_scrape: leak.no_scrape,
        kept: leak.kept.length, with_consensus: leak.kept.filter(r => Number.isFinite(r.consensus)).length });
      clearPlayerWeekEngineCache();
      log(`${season} W${week}: ${rowsW.length} decision rows, ${leak.kept.length} after byes and the leak guard`);
    }
    if (fitThrough.size !== 1) throw new Error(`cutoff: ${season} was graded with coordinator fits through ${[...fitThrough].join(', ') || 'none'}`);
    // Known-nonzero control for the fit handoff: a ready coordinator fit moves some players' B off A.
    if (!census.some(c => c.coordinator_moved > 0)) throw new Error(`coordinator: no ${season} row's B differs from A, so no fit reached constructArms`);
    return { rows: kept, preLeak, census, fit_through: [...fitThrough][0] };
  };

  if (mode === '--smoke') {
    const examples = await s02.SERVED.buildFantasyCoordinatorExamples({ fromSeason: 2023, throughSeason: 2023 });
    clearPlayerWeekEngineCache();
    const registry = lib.coordinatorRegistry(examples, [2024]);
    const { rows, census } = seasonRows(2024, [6], registry);
    // ---- Stop condition 4 in miniature: the instrument must find the oracle's edge on these rows.
    const universe = arm.commonSet(rows, { pointArms: lib.POINT_ARMS, threshold: THRESHOLD });
    if (!universe.length) throw new Error('smoke: 2024 W6 produced no common-set rows');
    report.smoke = { census, universe_rows: universe.length, instrument_passed: arm.instrumentControl(universe, 'consensus').passed };
    report.finished_at = new Date().toISOString();
    write();
    log('smoke OK', JSON.stringify(report.smoke));
    return;
  }

  // ---- Walk-forward coordinator fits: examples 2021 .. (last graded season - 1).
  const examples = await s02.SERVED.buildFantasyCoordinatorExamples({ fromSeason: lib.PREREGISTERED_COORDINATOR_FROM, throughSeason: Math.max(...graded) - 1 });
  clearPlayerWeekEngineCache();
  const exampleCounts = {};
  for (const e of examples) {
    exampleCounts[e.season] ??= 0;
    exampleCounts[e.season]++;
  }
  const registry = lib.coordinatorRegistry(examples, graded);
  // Standing rule 3's k control over the coordinator's own training seasons, and how much of
  // each graded season's fit comes from a season that fails it.
  const exampleSeasons = Object.keys(exampleCounts).map(Number).sort((a, b) => a - b);
  const exampleK = lib.kControlSeasons(exampleSeasons, season => activeKVectorFor(WEEKLY_ROLE_RECENCY, { predictingSeason: season }));
  const kExcluded = new Set(exampleK.excluded.map(e => e.season));
  const fromExcluded = Object.fromEntries(graded.map(season => {
    const slot = registry.get(season);
    const bad = exampleSeasons.filter(s => s <= slot.through && kExcluded.has(s)).reduce((sum, s) => sum + exampleCounts[s], 0);
    return [season, { rows: slot.rows, from_k_excluded_seasons: bad, share: +(bad / slot.rows).toFixed(4) }];
  }));
  const servedFit = activeFantasyCoordinatorFit();
  if (!servedFit?.ready) throw new Error('the served coordinator fit is not ready on this copy');
  // activeFantasyCoordinatorFit reads the newest row; this is that row's cutoff and stamp.
  const servedRow = dbRows('SELECT id, through_season, rows, created_at FROM fantasy_coordinator_fits ORDER BY id DESC LIMIT 1')[0] ?? null;
  const servedThrough = servedRow?.through_season ?? null;
  registry.set(lib.FORWARD, { fitS: servedFit, through: servedThrough, rows: servedRow?.rows ?? null });
  // Post hoc (added 2026-09-23 after the results, at a skeptic's request; report-only, not
  // pre-registered): the coordinator on the served recipe's seasons, for every graded season it
  // can fit. 2022 cannot be fit on it: no season from 2022 ends before 2022.
  const recipeExamples = examples.filter(e => e.season >= lib.SERVED_COORDINATOR_FROM);
  const recipeSeasons = graded.filter(season => season - 1 >= lib.SERVED_COORDINATOR_FROM);
  const recipeRegistry = lib.coordinatorRegistry(recipeExamples, recipeSeasons);
  report.coordinator = {
    examples_from: lib.PREREGISTERED_COORDINATOR_FROM, served_recipe_from: lib.SERVED_COORDINATOR_FROM,
    examples_by_season: exampleCounts,
    examples_k_control: { graded: exampleK.graded, excluded: exampleK.excluded },
    rows_from_k_excluded_seasons: fromExcluded,
    fits: Object.fromEntries([...registry].map(([s, v]) => [s, { through: v.through, rows: v.rows,
      intercept: v.fitS.coefficients?.[0] ?? null }])),
    served_fit: servedRow ? { id: servedRow.id, through: servedRow.through_season, rows: servedRow.rows, created_at: servedRow.created_at } : null,
    note: `pre-registration §4 starts the examples at ${lib.PREREGISTERED_COORDINATOR_FROM}. The ${[...kExcluded].join(', ')} examples are built by `
      + 'engines whose volume k is the hand-set constant (no volume fit can end before 2021), and they are in EVERY graded '
      + 'season\'s fit (rows_from_k_excluded_seasons), not only 2022\'s. The served recipe starts at '
      + `${lib.SERVED_COORDINATOR_FROM} (fantasy-coordinator.js); sensitivity.coordinator_served_recipe reports it, post hoc, `
      + `for ${recipeSeasons.join(' and ')}. Standing rule 3 on the training replay is for the Independent Auditor to rule on.`
  };
  log('coordinator', JSON.stringify(report.coordinator.fits), 'from k-excluded seasons', JSON.stringify(fromExcluded));
  write();

  // ---- The graded seasons.
  const weeksOf = season => [...ecr.scrapeByWeek.keys()].filter(key => key.startsWith(`${season}|`))
    .map(key => Number(key.split('|')[1])).filter(w => w >= lib.FIRST_WEEK && w <= lib.LAST_WEEK).sort((a, b) => a - b);
  const all = [];
  report.seasons = {};
  for (const season of graded) {
    const s = seasonRows(season, weeksOf(season), registry, { alsoRegistry: recipeRegistry });
    all.push(...s.rows);
    report.seasons[season] = { weeks: weeksOf(season), coordinator_through: s.fit_through, census: s.census };
    write();
  }
  // ---- Stop condition 6: nothing from the held-out season reached the grade.
  if (all.some(r => r.season === lib.HELD_OUT)) throw new Error('holdout: a 2025 row reached the grade');

  const primary = arm.commonSet(all, { pointArms: lib.POINT_ARMS, threshold: THRESHOLD });
  const played = arm.commonSet(all.filter(r => r.played), { pointArms: lib.POINT_ARMS, threshold: THRESHOLD });
  const startable = arm.commonSet(all, { pointArms: lib.POINT_ARMS, threshold: STARTABLE_PPR });

  // ---- Stop condition 4: the instrument must find the oracle's edge; a policy against itself has none.
  const controls = { consensus: arm.instrumentControl(primary, 'consensus'), ours: arm.instrumentControl(primary, 'ours') };
  if (!controls.consensus.passed || !controls.ours.passed) throw new Error(`instrument control failed: ${JSON.stringify(controls)}`);
  // ---- Pair-accuracy parity with the canonical producer, per season (it pairs by week, not season).
  const parity = {};
  for (const season of graded) {
    const rowsS = primary.filter(r => r.season === season);
    const canonical = startSitPairAccuracy(rowsS.map(r => ({ week: r.week, position: r.position, actual: r.actual,
      preds: Object.fromEntries(lib.POINT_ARMS.map(a => [a, r[a]])) })), [...lib.POINT_ARMS], { threshold: THRESHOLD });
    const mine = Object.fromEntries(lib.POINT_ARMS.map(a => {
      const scored = arm.pairScores(rowsS, a, a);
      return [a, scored.reduce((sum, x) => sum + x.sp, 0) / scored.length];
    }));
    for (const a of lib.POINT_ARMS) {
      if (Math.abs(canonical.accuracy[a] - mine[a]) > 1e-12) throw new Error(`pair-accuracy parity: ${season} ${a} ${mine[a]} vs startSitPairAccuracy ${canonical.accuracy[a]}`);
    }
    parity[season] = { pairs: canonical.pairs, arms_checked: [...lib.POINT_ARMS] };
  }
  report.controls = { instrument: controls, pair_accuracy_parity: parity };
  report.universe = {
    decision_rows_after_byes_and_leak: all.length,
    with_consensus: all.filter(r => Number.isFinite(r.consensus)).length,
    primary: primary.length, played: played.length, startable_8: startable.length
  };
  log('universe', JSON.stringify(report.universe));
  write();

  // ---- The grades (prereg §6-7). Every set below is already a common set (commonSet held each
  // point arm to its line), so pairs are formed with no further threshold.
  const opts = { iterations: 2000, seed: 1, threshold: -Infinity };
  const results = { primary: {}, played: {}, startable_8: {} };
  for (const [p, q] of COMPARISONS) {
    const key = `${p}_vs_${q}`;
    const pooled = arm.headToHead(primary, p, q, { ...opts, keepWeeks: p === 'ours' && q === 'consensus' });
    const b = arm.breakouts(primary, p, q, opts);
    const full = p === 'ours' && q === 'consensus';
    results.primary[key] = { pooled, by_season: b.by_season, by_band: b.by_band, by_position: b.by_position,
      ...(full ? { by_season_band: b.by_season_band, by_season_position: b.by_season_position } : {}) };
    if (p === 'ours' && ['consensus', 'std', 'l3'].includes(q)) {
      const cells = [
        ...Object.entries(b.by_season).map(([k2, c]) => ({ key: `season ${k2}`, grade: c.decisions })),
        ...Object.entries(b.by_band).map(([k2, c]) => ({ key: `weeks ${k2}`, grade: c.decisions })),
        ...Object.entries(b.by_position).map(([k2, c]) => ({ key: `position ${k2}`, grade: c.decisions }))
      ];
      results.primary[key].holm = arm.holmCells(cells, { alpha: 0.10 });
      for (const [label, set] of [['played', played], ['startable_8', startable]]) {
        const bb = arm.breakouts(set, p, q, opts);
        results[label][key] = { pooled: arm.headToHead(set, p, q, opts), by_season: bb.by_season };
      }
    }
    log(`graded ${key}: pooled verdict ${pooled.verdict}`);
    report.results = results;
    write();
  }
  report.clean_check = { what: 'arm D (no availability) vs consensus in 2024: every fit ends at or before 2023',
    cell: results.primary.D_vs_consensus.by_season[2024] ?? null };

  // ---- Post-hoc sensitivity (report-only): the served coordinator recipe, on the same rows and pairs.
  const recipeRows = primary.filter(r => recipeRegistry.has(r.season));
  const missingRecipe = recipeRows.filter(r => !Number.isFinite(r.ours_recipe)).length;
  if (missingRecipe) throw new Error(`sensitivity: ${missingRecipe} primary rows have no served-recipe value`);
  const recipeCells = rs => ({
    preregistered_vs_consensus: arm.headToHead(rs, 'ours', 'consensus', opts),
    served_recipe_vs_consensus: arm.headToHead(rs, 'ours_recipe', 'consensus', opts),
    served_recipe_vs_preregistered: arm.headToHead(rs, 'ours_recipe', 'ours', opts)
  });
  report.sensitivity = {
    coordinator_served_recipe: {
      label: 'post hoc, report-only: added 2026-09-23 after the results, at a skeptic\'s request; not pre-registered',
      what: `OURS with the coordinator fit on examples from ${lib.SERVED_COORDINATOR_FROM} (the served recipe) instead of `
        + `${lib.PREREGISTERED_COORDINATOR_FROM} (pre-registered, §4), on the same primary rows and pairs; everything else identical`,
      seasons: recipeSeasons,
      not_fittable: graded.filter(season => !recipeRegistry.has(season))
        .map(season => ({ season, reason: `no example season from ${lib.SERVED_COORDINATOR_FROM} ends before ${season}` })),
      fits: Object.fromEntries([...recipeRegistry].map(([season, v]) => [season, { through: v.through, rows: v.rows,
        intercept: v.fitS.coefficients?.[0] ?? null }])),
      rows: recipeRows.length,
      fit_through: [...new Set(recipeRows.map(r => `${r.season}<-${r.fit_through_recipe}`))].sort(),
      b_changed: recipeRows.filter(r => r.B_recipe !== r.B).length,
      ours_changed: recipeRows.filter(r => r.ours_recipe !== r.ours).length,
      pooled: recipeCells(recipeRows),
      by_season: Object.fromEntries(recipeSeasons.map(season => [season, recipeCells(recipeRows.filter(r => r.season === season))]))
    }
  };
  log('sensitivity', JSON.stringify({ rows: recipeRows.length,
    verdicts: Object.fromEntries(Object.entries(report.sensitivity.coordinator_served_recipe.pooled).map(([k2, v]) => [k2, v.verdict])) }));
  write();

  // ---- Forward: the 2026 weeks already played with a prior week.
  const fwdWeeks = dbRows('SELECT DISTINCT week FROM player_week_usage WHERE season = ? AND week BETWEEN ? AND ? ORDER BY week',
    lib.FORWARD, lib.FIRST_WEEK, lib.LAST_WEEK).map(r => r.week);
  report.forward = { season: lib.FORWARD, weeks: fwdWeeks, label: 'forward, one week per row of weeks: an anecdote, not a verdict',
    coordinator_through: servedThrough };
  if (fwdWeeks.length) {
    const fwdWindow = [fwdWeeks[0], fwdWeeks.at(-1)];
    const f = seasonRows(lib.FORWARD, fwdWeeks, registry, { keepPreLeak: true });
    const espn = espnProjections(lib.FORWARD, fwdWindow);
    // The projection the app saved before each week (C-01's reader of weekly_prediction_snapshots).
    const snaps = servedSnapshots(lib.FORWARD, fwdWindow);
    const saved = new Map(snaps.map(s2 => [`${s2.week}|${s2.player_id}`, s2.prediction]));
    const ecrSet = arm.commonSet(f.rows, { pointArms: lib.POINT_ARMS, threshold: THRESHOLD });
    const withEspn = f.preLeak.map(r => ({ ...r, espn: espn.values.get(`${r.week}|${r.player_id}`) ?? null,
      snapshot: saved.get(`${r.week}|${r.player_id}`) ?? null }));
    const espnSet = arm.commonSet(withEspn, { pointArms: [...lib.POINT_ARMS, 'espn'], threshold: THRESHOLD, consensusArm: 'espn' });
    const espnStartable = arm.commonSet(withEspn, { pointArms: [...lib.POINT_ARMS, 'espn'], threshold: STARTABLE_PPR, consensusArm: 'espn' });
    const sameRows = arm.commonSet(withEspn, { pointArms: ['ours', 'snapshot', 'espn'], threshold: STARTABLE_PPR, consensusArm: 'espn' });

    // What OURS is on this week: a replay, not the number production served.
    const ws = activeWeeklyWeightSet({ season: lib.FORWARD, week: fwdWeeks[0] });
    const kMeta = activeFitMeta();
    const kFittedAt = kMeta ? dbRows('SELECT fitted_at FROM shrinkage_fits WHERE id = ?', kMeta.id)[0]?.fitted_at ?? null : null;
    const kickoff = dbRows(`SELECT gameday, gametime FROM game_lines WHERE season = ? AND week = ? AND gameday IS NOT NULL
      ORDER BY gameday, gametime LIMIT 1`, lib.FORWARD, fwdWeeks[0])[0] ?? null;
    const capturedAt = snaps.reduce((m, s2) => (m == null || s2.as_of < m ? s2.as_of : m), null);
    // Stamps: an ISO string with a zone as is, SQLite's datetime('now') (UTC, no zone) with a Z.
    const toUtc = t => (t == null ? NaN : Date.parse(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(t) ? t : `${String(t).replace(' ', 'T')}Z`));
    // nflverse schedules give the kickoff in US Eastern time; a September game is on daylight time (UTC-4).
    const kickoffUtc = kickoff ? Date.parse(`${kickoff.gameday}T${kickoff.gametime}:00-04:00`) : NaN;
    const stamp = at => ({ at,
      after_saved_snapshot: Number.isFinite(toUtc(at)) && Number.isFinite(toUtc(capturedAt)) ? toUtc(at) > toUtc(capturedAt) : null,
      after_first_kickoff: Number.isFinite(toUtc(at)) && Number.isFinite(kickoffUtc) ? toUtc(at) > kickoffUtc : null });
    report.forward.what_ours_is = {
      name: 'OURS-replay',
      label: 'the local copy\'s current chain (the weight set, coordinator fit and volume k below) replayed on the week after '
        + 'the fact. NOT verified to be what production served: the projection the app saved before the week used another '
        + 'weight set (saved_before_the_week); each fit below says whether it was created after that save and after the '
        + 'week\'s first kickoff; and weekly-ensemble.js:4-11 records a production live read with no promoted weekly fit '
        + '(weeks 2-4: promotion date unknown). Which arm counts as served is settled once S-12 stores the served '
        + 'week_points at lock.',
      weight_set: { id: ws.id, created: stamp(ws.fit?.created_at ?? null) },
      coordinator_fit: report.coordinator.served_fit ? { ...report.coordinator.served_fit, created: stamp(report.coordinator.served_fit.created_at) } : null,
      k_fit: kMeta ? { id: kMeta.id, through: kMeta.through_season, created: stamp(kFittedAt) } : null,
      first_kickoff: kickoff ? { gameday: kickoff.gameday, gametime: kickoff.gametime,
        utc: Number.isFinite(kickoffUtc) ? new Date(kickoffUtc).toISOString() : null,
        source: 'game_lines.gameday/gametime (nflverse schedule, US Eastern; UTC-4 applied for September)' } : null,
      saved_before_the_week: { rows: snaps.length, weight_fit: [...new Set(snaps.map(s2 => s2.weight_fit))].sort(), captured_at: capturedAt }
    };
    report.forward.census = f.census;
    report.forward.espn = { player_weeks: espn.values.size, conflicting_dropped: espn.conflicting };
    report.forward.universe = { ecr: ecrSet.length, espn: espnSet.length, espn_startable_8: espnStartable.length, same_rows: sameRows.length };
    report.forward.labels = {
      espn_startable_8: 'HX-01\'s 8.0 common set: every point arm (OURS, D, A, STD, L3) and ESPN at least 8.0. Not C-01\'s rule.',
      ours_vs_espn_c01_rule: 'C-01\'s rule: OURS and ESPN each at least 8.0 (start-sit-gate.js#startSitDecisions at STARTABLE_PPR), '
        + 'through headToHead\'s default threshold'
    };
    report.forward.results = {
      ours_vs_consensus: arm.headToHead(ecrSet, 'ours', 'consensus', opts),
      ours_vs_std: arm.headToHead(ecrSet, 'ours', 'std', opts),
      ours_vs_l3: arm.headToHead(ecrSet, 'ours', 'l3', opts),
      consensus_vs_std: arm.headToHead(ecrSet, 'consensus', 'std', opts),
      ours_vs_espn: arm.headToHead(espnSet, 'ours', 'espn', opts),
      espn_vs_std: arm.headToHead(espnSet, 'espn', 'std', opts),
      ours_vs_espn_startable_8: arm.headToHead(espnStartable, 'ours', 'espn', opts),
      ours_vs_espn_c01_rule: arm.headToHead(withEspn, 'ours', 'espn', { iterations: opts.iterations, seed: opts.seed })
    };
    // One row set for every arm (post hoc, at a skeptic's request): who is ahead of ESPN depends
    // on the arm, not on which players each comparison happened to keep.
    report.forward.same_rows = {
      label: 'post hoc, report-only (added 2026-09-23 at a skeptic\'s request)',
      population: 'the week\'s decision rows after byes (no leak guard: ESPN is at lock) with a saved snapshot and an ESPN value, '
        + 'where OURS-replay, the saved snapshot and ESPN each reach 8.0; pairs are formed on these rows with no further threshold',
      rows: sameRows.length,
      results: Object.fromEntries([['snapshot', 'espn'], ['ours', 'espn'], ['A', 'espn'], ['D', 'espn'], ['ours', 'snapshot'], ['A', 'snapshot']]
        .map(([pp, qq]) => [`${pp}_vs_${qq}`, arm.headToHead(sameRows, pp, qq, opts)]))
    };
    // C-01's plan-rule input from C-01's own producer, and the consensus arm on C-01's rows: one number.
    const c01Replay = replayWindow(lib.FORWARD, fwdWindow);
    const c01Served = servedArms(lib.FORWARD, fwdWindow, c01Replay.rows, { champions: c01Replay.champions,
      iterations: opts.iterations, seed: opts.seed });
    if (c01Served.vs_espn.status) throw new Error(`C-01's served-vs-ESPN arm is not available: ${c01Served.vs_espn.reason}`);
    const c01Rows = substitute(substitute(c01Replay.rows, saved, 'policy').rows, espn.values, 'baseline').rows;
    const viaArm = arm.headToHead(c01Rows, 'policy', 'baseline', { iterations: opts.iterations, seed: opts.seed });
    const pick = g => ({ pairs: g.pairs, agreement_share: g.agreement_share,
      pair_accuracy: { policy: g.pair_accuracy.policy, baseline: g.pair_accuracy.baseline },
      n: g.n, players: g.players, win_rate: g.win_rate, points_per_decision: g.points_per_decision,
      ci90: g.ci90, se: g.se, mde80: g.mde80 });
    const c01Grade = pick(c01Served.vs_espn);
    const armGrade = pick({ ...viaArm.decisions, pairs: viaArm.pairs, agreement_share: viaArm.agreement_share,
      pair_accuracy: viaArm.pair_accuracy });
    const equal = JSON.stringify(c01Grade) === JSON.stringify(armGrade);
    report.forward.c01_reconciliation = {
      what: 'C-01\'s served-vs-ESPN grade (servedArms: the saved snapshot vs ESPN at lock, the plan rule\'s input) and '
        + 'headToHead with its default threshold, on the same rows',
      rows: c01Rows.length, weeks: c01Served.weeks, replay_champions: c01Replay.champions,
      c01: c01Grade, consensus_arm: armGrade, equal
    };
    if (!equal) throw new Error('one producer: headToHead on C-01\'s rows does not give C-01\'s served-vs-ESPN grade');
    log('forward', JSON.stringify(Object.fromEntries(Object.entries(report.forward.results).map(([k2, v]) => [k2, v.verdict]))),
      'same rows', JSON.stringify(Object.fromEntries(Object.entries(report.forward.same_rows.results).map(([k2, v]) => [k2, v.verdict]))),
      'C-01 reconciliation', equal);
  }
  // ---- Rule 5 (STATS-METHOD.md): any job fit on a 2026 week is a forward look to log.
  report.ledger_query = { sql: 'SELECT id, through_season, through_week, promoted FROM weekly_ensemble_fits WHERE through_season >= 2026',
    rows: dbRows('SELECT id, through_season, through_week, promoted FROM weekly_ensemble_fits WHERE through_season >= 2026'),
    control_rows_total: dbRows('SELECT COUNT(*) AS n FROM weekly_ensemble_fits')[0]?.n ?? null };
  report.finished_at = new Date().toISOString();
  write();
  log('done', JSON.stringify({ primary: results.primary.ours_vs_consensus.pooled.verdict,
    holm: results.primary.ours_vs_consensus.holm.map(c => `${c.key}:${c.verdict}`) }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
}
