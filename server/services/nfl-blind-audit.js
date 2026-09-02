/**
 * Content-addressed, week-at-a-time NFL audit controller.
 *
 * Historical outcomes physically exist in the local database, so this is an
 * algorithmically blind chronological replay—not a claim that a human has
 * never inspected 2021-25. The untouched test is the forward 2026 shadow
 * ledger. This controller still makes historical leakage difficult: it freezes
 * the exact code, input tables, candidate registry and policy, then refuses to
 * open week N+1 if any of them change after preregistration.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db, rows, run } from '../db/index.js';
import { replaySeasonWeekly } from './weekly-backtest.js';
import { replaySeason } from './nfl-replay.js';
import { PLAYER_HEAD_REGISTRY_VERSION, PLAYER_HEADS } from './player-head-registry.js';
import { PLAYER_WEEK_ENGINE_VERSION } from './player-week-engine.js';
import { NFL_HISTORICAL_REPLAY_POLICY } from './nfl-policy.js';
import { explainPick } from './pick-reasoning.js';
import { ensembleLine, withEphemeralEnsembleArtifacts } from './nfl-ensemble.js';
import { weeklyExpertAudit, persistWeeklyExpertAudit, EXPERT_COUNCIL_VERSION,
  NFL_EXPERTS } from './nfl-expert-council.js';
import { buildPostgameTruth, persistPostgameTruth, postgameAuditSummary,
  POSTGAME_TRUTH_VERSION } from './nfl-postgame-truth.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_blind_audit_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    label TEXT NOT NULL,
    spec_hash TEXT NOT NULL UNIQUE,
    spec_json TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    data_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'registered',
    next_ordinal INTEGER NOT NULL DEFAULT 0,
    final_json TEXT
  );
  CREATE TABLE IF NOT EXISTS nfl_blind_audit_weeks (
    run_id INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    opened_at TEXT NOT NULL,
    prior_chain_hash TEXT NOT NULL,
    result_hash TEXT NOT NULL,
    chain_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    fault_json TEXT NOT NULL,
    PRIMARY KEY (run_id, ordinal),
    UNIQUE (run_id, season, week)
  );
  CREATE TABLE IF NOT EXISTS nfl_blind_input_mutations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    operation TEXT NOT NULL,
    changed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS nfl_blind_audit_week_performance (
    run_id INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    freeze_check_ms INTEGER NOT NULL,
    compute_ms INTEGER NOT NULL,
    persist_ms INTEGER NOT NULL,
    total_ms INTEGER NOT NULL,
    PRIMARY KEY (run_id, ordinal)
  );
`);

const INPUT_TABLES = [
  'players', 'player_week_usage', 'game_lines', 'nflverse_player_positions',
  'nfl_team_week_features', 'nfl_player_week_features', 'nfl_depth',
  'nfl_injuries', 'nfl_ngs', 'nfl_pfr_adv', 'nfl_snaps', 'nfl_teams',
  'weekly_ensemble_fits', 'nfl_ensemble_fit_artifacts', 'nfl_line_snapshots',
  'nfl_news_signals', 'news_items', 'nfl_external_player_grades',
  'nfl_rookie_evidence', 'nfl_team_coaches', 'player_team_changes',
  'nfl_player_roster_events', 'nfl_roster_snapshots', 'nfl_play_by_play',
  'nfl_play_formations', 'nfl_play_charting', 'nfl_verified_events',
  'nfl_team_feature_vectors', 'nfl_player_feature_vectors', 'nfl_team_cards',
  'nfl_quote_tape'
];
const sha = value => createHash('sha256').update(value).digest('hex');
const mutationCursor = new Map();

function installInputMutationJournal() {
  const tables = new Set(rows("SELECT name FROM sqlite_master WHERE type='table'").map(item => item.name));
  for (const table of INPUT_TABLES) {
    if (!tables.has(table)) continue;
    const prefix = `nfl_blind_input_${table}`;
    if (table === 'players') {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${prefix}_insert AFTER INSERT ON ${table}
        WHEN NEW.gsis_id IS NOT NULL BEGIN
          INSERT INTO nfl_blind_input_mutations(table_name,operation,changed_at)
          VALUES ('${table}','insert',datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS ${prefix}_update AFTER UPDATE OF id,name,position,gsis_id ON ${table}
        WHEN OLD.gsis_id IS NOT NULL OR NEW.gsis_id IS NOT NULL BEGIN
          INSERT INTO nfl_blind_input_mutations(table_name,operation,changed_at)
          VALUES ('${table}','update',datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS ${prefix}_delete AFTER DELETE ON ${table}
        WHEN OLD.gsis_id IS NOT NULL BEGIN
          INSERT INTO nfl_blind_input_mutations(table_name,operation,changed_at)
          VALUES ('${table}','delete',datetime('now'));
        END;
      `);
      continue;
    }
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${prefix}_${operation.toLowerCase()} AFTER ${operation} ON ${table}
      BEGIN
        INSERT INTO nfl_blind_input_mutations(table_name,operation,changed_at)
        VALUES ('${table}','${operation.toLowerCase()}',datetime('now'));
      END;
    `);
  }
}

installInputMutationJournal();

function inputMutationState(afterId = 0) {
  const latest = rows('SELECT COALESCE(MAX(id),0) id FROM nfl_blind_input_mutations')[0]?.id ?? 0;
  const changed = latest > afterId
    ? rows(`SELECT table_name,COUNT(*) mutations,MIN(id) first_id,MAX(id) last_id
        FROM nfl_blind_input_mutations WHERE id>? GROUP BY table_name ORDER BY table_name`, afterId)
    : [];
  return { latest: Number(latest), changed };
}

function repositoryState() {
  const cwd = process.cwd();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const diff = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'],
    { cwd, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
  const content = createHash('sha256').update(commit).update('\0').update(diff);
  for (const path of untracked) content.update('\0').update(path).update('\0').update(readFileSync(resolve(cwd, path)));
  return { commit, dirty: diff.length > 0 || untracked.length > 0, hash: content.digest('hex') };
}

function inputDataState(spec = null) {
  const hash = createHash('sha256');
  const tables = new Set(rows("SELECT name FROM sqlite_master WHERE type='table'").map(x => x.name));
  const coverage = {};
  const maxSeason = spec?.seasons?.length ? Math.max(...spec.seasons) : null;
  const afterSeason = maxSeason == null ? null : `${maxSeason + 1}-03-01T00:00:00.000Z`;
  const seasonTables = new Set(['game_lines', 'nfl_team_week_features', 'nfl_player_week_features',
    'nfl_depth', 'nfl_injuries', 'nfl_ngs', 'nfl_pfr_adv', 'nfl_snaps', 'nfl_external_player_grades',
    'nfl_rookie_evidence', 'nfl_team_coaches', 'nfl_play_by_play',
    'nfl_play_formations', 'nfl_play_charting', 'nfl_verified_events',
    'nfl_team_feature_vectors', 'nfl_player_feature_vectors', 'nfl_team_cards']);
  for (const table of INPUT_TABLES) {
    if (!tables.has(table)) { coverage[table] = { rows: 0, missing: true }; continue; }
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(x => x.name);
    let where = '', params = [], selectedColumns = columns;
    // `players` is shared with the fantasy draft room and live ESPN roster
    // reconciliation. Those workflows legitimately change slot, phase and team
    // metadata while an NFL audit is running, but the historical model consumes
    // only canonical NFL identities joined from player_week_usage. Freeze that
    // actual dependency instead of allowing unrelated fantasy churn to void a run.
    if (table === 'players') {
      selectedColumns = ['id', 'name', 'position', 'gsis_id'];
      where = ' WHERE gsis_id IS NOT NULL';
    } else if (maxSeason != null && seasonTables.has(table) && columns.includes('season')) {
      where = ' WHERE season<=?'; params = [maxSeason];
    } else if (afterSeason && table === 'news_items') {
      where = ` WHERE COALESCE(published_at,date,created_at)<?`; params = [afterSeason];
    } else if (afterSeason && table === 'nfl_news_signals') {
      where = ' WHERE published_at<?'; params = [afterSeason];
    } else if (afterSeason && table === 'nfl_line_snapshots') {
      where = ' WHERE commence_time IS NULL OR commence_time<?'; params = [afterSeason];
    } else if (afterSeason && table === 'nfl_quote_tape') {
      where = ' WHERE commence_time<?'; params = [afterSeason];
    } else if (afterSeason && table === 'nfl_player_roster_events') {
      where = ' WHERE effective_at<?'; params = [afterSeason];
    } else if (afterSeason && table === 'nfl_roster_snapshots') {
      where = ' WHERE captured_at<?'; params = [afterSeason];
    } else if (afterSeason && table === 'player_team_changes') {
      where = ' WHERE detected_at<?'; params = [afterSeason];
    } else if (maxSeason != null && table === 'weekly_ensemble_fits') {
      where = ' WHERE through_season<=?'; params = [maxSeason];
    }
    const data = rows(`SELECT ${selectedColumns.join(',')} FROM ${table}${where} ORDER BY rowid`, ...params);
    const tableHash = createHash('sha256').update(table).update('\0').update(JSON.stringify(selectedColumns)).update('\0');
    for (const record of data) tableHash.update(JSON.stringify(record)).update('\n');
    const digest = tableHash.digest('hex');
    coverage[table] = { rows: data.length, columns: selectedColumns, hash: digest,
      scope: where ? { where, params } : 'all_rows' };
    hash.update(table).update('\0').update(digest).update('\n');
  }
  return { hash: hash.digest('hex'), coverage };
}

function scheduleFor(seasons, startWeek, endWeek) {
  return seasons.flatMap(season => Array.from({ length: endWeek - startWeek + 1 }, (_, i) => ({
    season, week: startWeek + i
  })));
}

function normalizeSpec(input = {}) {
  const seasons = [...new Set((input.seasons ?? [2021, 2022, 2023, 2024, 2025]).map(Number))]
    .sort((a, b) => a - b);
  if (!seasons.length || seasons.some(x => !Number.isInteger(x) || x < 1999 || x > 2100)) {
    throw new Error('blind audit requires valid seasons');
  }
  const startWeek = Math.max(5, Number(input.startWeek) || 5);
  const endWeek = Math.min(18, Number(input.endWeek) || 18);
  if (endWeek < startWeek) throw new Error('blind audit endWeek must be at or after startWeek');
  return {
    protocol: 'nfl-blind-week-chain-v1',
    classification: 'historical_algorithmically_blind_replay',
    seasons, startWeek, endWeek,
    schedule: scheduleFor(seasons, startWeek, endWeek),
    domains: ['player_week', 'spread', 'total'],
    player_engine: PLAYER_WEEK_ENGINE_VERSION,
    player_head_registry: PLAYER_HEAD_REGISTRY_VERSION,
    player_head_ids: PLAYER_HEADS.map(x => x.id),
    betting_policy: NFL_HISTORICAL_REPLAY_POLICY,
    expert_council: EXPERT_COUNCIL_VERSION,
    expert_ids: NFL_EXPERTS.map(expert => expert.id),
    postgame_truth: POSTGAME_TRUTH_VERSION,
    rules: [
      'One week opens once and cannot be overwritten.',
      'Every prediction is generated from information strictly before its target week.',
      'Code and model-input data must match preregistration before every opened week.',
      'Persistent ensemble-fit artifacts are neither read nor written while an audited week is computed.',
      'Fault attribution is descriptive and cannot alter the frozen model during this run.',
      'Historical ROI is reported but cannot establish production profitability without real archived quotes and forward CLV.',
      'The genuinely untouched gate is the 2026 forward shadow ledger.'
    ]
  };
}

export function preregisterBlindAudit({ label = 'NFL five-year blind replay', allowDirty = false, ...input } = {}) {
  const code = repositoryState();
  if (code.dirty && !allowDirty) {
    throw new Error('blind audit preregistration requires a clean committed repository state');
  }
  const normalized = normalizeSpec(input);
  db.exec('BEGIN IMMEDIATE');
  try {
    const data = inputDataState(normalized);
    const guard = inputMutationState();
    const spec = { ...normalized, provenance: { code, data_coverage: data.coverage,
      input_guard: { version: 'nfl-input-mutation-journal-v1', mutation_id: guard.latest } } };
    const specHash = sha(JSON.stringify(spec));
    run(`INSERT INTO nfl_blind_audit_runs
         (created_at,label,spec_hash,spec_json,code_hash,data_hash,status,next_ordinal)
         VALUES (datetime('now'),?,?,?,?,?,'registered',0)`,
      label, specHash, JSON.stringify(spec), code.hash, data.hash);
    const id = Number(rows('SELECT last_insert_rowid() id')[0].id);
    db.exec('COMMIT');
    mutationCursor.set(id, guard.latest);
    return blindAuditStatus(id);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function parseRun(record) {
  if (!record) return null;
  return { ...record, spec: JSON.parse(record.spec_json), final: record.final_json ? JSON.parse(record.final_json) : null,
    spec_json: undefined, final_json: undefined };
}

function assertFrozen(record) {
  const code = repositoryState();
  if (code.hash !== record.code_hash) throw new Error('blind audit blocked: repository state changed after preregistration');
  const spec = JSON.parse(record.spec_json);
  const priorMutation = mutationCursor.get(record.id)
    ?? Number(spec.provenance?.input_guard?.mutation_id ?? -1);
  const mutations = inputMutationState(Math.max(-1, priorMutation));
  if (priorMutation >= 0 && mutations.latest <= priorMutation) return;
  const data = inputDataState(spec);
  if (data.hash !== record.data_hash) {
    const prior = spec.provenance?.data_coverage ?? {};
    const changed = Object.entries(data.coverage).filter(([table, state]) => prior[table]?.hash !== state.hash)
      .map(([table, state]) => ({ table, before_rows: prior[table]?.rows ?? null, now_rows: state.rows,
        before_hash: prior[table]?.hash ?? null, now_hash: state.hash }));
    throw new Error(`blind audit blocked: model input data changed after preregistration (${changed.map(item => item.table).join(', ') || 'legacy snapshot without table hashes'})`);
  }
  mutationCursor.set(record.id, mutations.latest);
}

function playerWeekResult(season, week) {
  const replay = replaySeasonWeekly(season, { startWeek: week, endWeek: week, distributions: false });
  const misses = [...replay._predictions]
    .map(x => ({ player_id: x.player_id, position: x.position, predicted: +x.prediction.toFixed(3),
      actual: +x.actual.toFixed(3), error: +Math.abs(x.prediction - x.actual).toFixed(3),
      direction: x.prediction > x.actual ? 'over_projection' : 'under_projection' }))
    .sort((a, b) => b.error - a.error).slice(0, 10);
  return {
    metrics: { player_weeks: replay.player_weeks, point: replay.point,
      decision_including_dnp: replay.decision_including_dnp },
    faults: misses
  };
}

function bettingWeekResult(season, week) {
  const replay = replaySeason(season, { startWeek: week, endWeek: week });
  if (replay.error) return { metrics: { error: replay.error }, faults: [], picks: [] };

  // Every pick, translated. A hundred recorded losses tell you the model is bad
  // without telling you why, and why is the only part that leads anywhere. The
  // trace separates what CAUSED the number — component models and their weights,
  // which is exact arithmetic on a weighted mean — from what was merely true at
  // the time, which the model never read.
  //
  // Reasoning is generated from the same cutoff-safe context the pick had. It
  // adds one ensemble call per game, which is cached, and no tokens.
  const picks = [];
  for (const b of replay.bets) {
    let models = null;
    try {
      const line = ensembleLine(season, week, b.home, b.away, { includeEvidence: false });
      if (!line.error) models = line.models;
    } catch { /* explain without attribution rather than not at all */ }
    const explained = explainPick(b, { models });
    picks.push({
      matchup: `${b.away} at ${b.home}`, market: b.market, selection: b.side, line: b.line,
      result: b.result, units: b.units,
      model_number: b.model_margin, market_number: b.market_margin, edge: b.edge,
      reasoning: explained.error ? null : {
        english: explained.english,
        drove_it: explained.what_drove_it.contributions?.slice(0, 3) ?? [],
        component_scatter: explained.what_drove_it.spread_points ?? null,
        attribution_verified: explained.what_drove_it.reconstruction_matches ?? null,
        context_net: explained.what_was_true.net,
        context_disagreed: explained.what_was_true.disagrees_with_pick
      }
    });
  }

  const misses = [...replay.bets]
    .map(x => ({ market: x.market, matchup: `${x.away} at ${x.home}`, selection: x.side,
      model: x.model_margin, market_line: x.market_margin, actual_margin: x.actual_margin,
      actual_total: x.actual_total, result: x.result,
      miss_size: x.market === 'spread'
        ? +Math.abs(x.model_margin - x.actual_margin).toFixed(3)
        : +Math.abs(x.model_margin - x.actual_total).toFixed(3) }))
    .sort((a, b) => b.miss_size - a.miss_size).slice(0, 10);

  return { metrics: replay.summary, faults: misses, picks };
}

/**
 * The floor below which a win-rate split says nothing.
 *
 * Thirty settled bets a side is still a small sample — the standard error on a
 * 50% rate at n=30 is about nine points — but it is the point below which the
 * difference between two arms is essentially guaranteed to be noise. Set high
 * enough that the template stays quiet through a partial season, which is when
 * the temptation to read something into it is strongest.
 */
const MIN_READ_SAMPLE = 30;
const MIN_READ_SAMPLE_UNMET = (a, b) =>
  a.length < MIN_READ_SAMPLE || b.length < MIN_READ_SAMPLE;

/**
 * Is the difference between two arms bigger than sampling noise?
 *
 * A sample floor alone is not enough, and the measured data proved it: across
 * five seasons the component-agreement split came in at 49.4% against 40.6% on
 * 79 and 32 settled bets. Both arms cleared the floor, the gap is nearly nine
 * points, and it is still nothing — a two-proportion test puts it at z = 0.84,
 * which is the kind of number that becomes a strategy if the template is allowed
 * to say "beat" without checking.
 *
 * Two-sided, pooled, because there is no prior direction worth assuming.
 */
function splitSignificance(a, b) {
  const wins = list => list.filter(p => p.result === 'Won').length;
  const na = a.length, nb = b.length;
  if (!na || !nb) return { z: null, significant: false };
  const pa = wins(a) / na, pb = wins(b) / nb;
  const pooled = (wins(a) + wins(b)) / (na + nb);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / na + 1 / nb));
  if (!(se > 1e-9)) return { z: null, significant: false };
  const z = (pa - pb) / se;
  return { z: +z.toFixed(2), significant: Math.abs(z) >= 1.96, diff_pp: +((pa - pb) * 100).toFixed(1) };
}

function aggregate(weeks) {
  const player = weeks.flatMap(x => x.result.player?.faults ?? []);
  const bets = weeks.flatMap(x => x.result.betting?.metrics?.bets ? [x.result.betting.metrics] : []);
  const totalBets = bets.reduce((sum, x) => sum + x.bets, 0);
  const units = bets.reduce((sum, x) => sum + x.units, 0);
  // What the reasoning traces say across the whole run, which is the part that
  // can actually change the model. Two questions matter:
  //   - When the model's components agreed with each other, did it do better?
  //     If not, the disagreement measure is not carrying information.
  //   - When the descriptive context disagreed with the pick, was the context
  //     right? A feature that beats the model repeatedly is a feature that
  //     should be an input rather than a footnote.
  const allPicks = weeks.flatMap(x => x.result.betting?.picks ?? []);
  const settled = allPicks.filter(p => p.result === 'Won' || p.result === 'Lost');
  const rate = list => (list.length
    ? +(list.filter(p => p.result === 'Won').length / list.length).toFixed(4) : null);

  const tight = settled.filter(p => (p.reasoning?.component_scatter ?? Infinity) <= Math.abs(p.edge ?? 0));
  const loose = settled.filter(p => (p.reasoning?.component_scatter ?? Infinity) > Math.abs(p.edge ?? 0));
  const ctxAgainst = settled.filter(p => (p.reasoning?.context_net ?? 0) < 0);
  const ctxFor = settled.filter(p => (p.reasoning?.context_net ?? 0) > 0);
  const agreementSplit = splitSignificance(tight, loose);
  const contextSplit = splitSignificance(ctxFor, ctxAgainst);
  const expertGames = weeks.flatMap(x => x.result.expert_council?.games ?? []);
  const expertLearning = NFL_EXPERTS.map(registry => {
    const outputs = expertGames.map(game => game.experts?.find(expert => expert.id === registry.id)).filter(Boolean);
    const observed = outputs.filter(expert => expert.observed);
    const directional = observed.filter(expert => expert.directional_correct != null);
    const errors = observed.map(expert => expert.squared_error).filter(Number.isFinite);
    return { ...registry, examples: outputs.length, observed: observed.length,
      coverage: outputs.length ? +(observed.length / outputs.length).toFixed(4) : 0,
      directional_calls: directional.length,
      directional_rate: directional.length ? +(directional.filter(expert => expert.directional_correct).length / directional.length).toFixed(4) : null,
      root_mean_squared_error: errors.length ? +Math.sqrt(errors.reduce((sum, value) => sum + value, 0) / errors.length).toFixed(3) : null };
  });
  const truth = weeks.flatMap(x => x.result.postgame_truth ?? []).filter(item => !item.error);
  const markerCounts = new Map();
  for (const game of truth) for (const marker of game.filtration?.variance_markers ?? []) {
    const kind = marker.replace(/^\d+(?:\.\d+)?\s+/, '');
    markerCounts.set(kind, (markerCounts.get(kind) ?? 0) + 1);
  }

  return {
    weeks_opened: weeks.length,
    player_faults_recorded: player.length,
    betting: { bets: totalBets, wins: bets.reduce((s, x) => s + x.wins, 0),
      losses: bets.reduce((s, x) => s + x.losses, 0), units: +units.toFixed(3),
      roi: totalBets ? +(units / totalBets).toFixed(4) : null },
    reasoning: {
      picks_explained: allPicks.length,
      attribution_verified: allPicks.filter(p => p.reasoning?.attribution_verified).length,
      when_components_agreed: { n: tight.length, win_rate: rate(tight) },
      when_components_scattered: { n: loose.length, win_rate: rate(loose) },
      when_context_agreed: { n: ctxFor.length, win_rate: rate(ctxFor) },
      when_context_disagreed: { n: ctxAgainst.length, win_rate: rate(ctxAgainst) },
      component_split_test: agreementSplit,
      context_split_test: contextSplit,
      // Nothing is claimed below a sample that could support it. On a seven-week
      // slice this split produced 33% against 67% on twelve bets versus six, in
      // the OPPOSITE direction to the hypothesis — which is what noise looks
      // like, and exactly the sort of number that becomes a confident sentence
      // if the template does not refuse to write one.
      reads: [
        MIN_READ_SAMPLE_UNMET(tight, loose)
          ? `Not enough settled bets to read the component-agreement split ` +
            `(${tight.length} against ${loose.length}; ${MIN_READ_SAMPLE} a side is the floor). ` +
            'A win-rate difference on samples this size is noise, and stating it as a finding is ' +
            'how a replay manufactures a strategy.'
          : (agreementSplit.significant
            ? (agreementSplit.diff_pp > 0
              ? `Picks where the component models agreed with each other beat picks where they ` +
                `scattered by ${agreementSplit.diff_pp} points (z = ${agreementSplit.z}). The ` +
                'disagreement measure is carrying information and is worth preregistering as a ' +
                'selection filter.'
              : `Picks where the components scattered actually did BETTER, by ` +
                `${Math.abs(agreementSplit.diff_pp)} points (z = ${agreementSplit.z}). That is the ` +
                'opposite of the hypothesis and worth understanding before any filter is built on it.')
            : `The component-agreement split is ${agreementSplit.diff_pp} points ` +
              `(z = ${agreementSplit.z}), which is inside sampling noise. The disagreement measure ` +
              'is not demonstrably carrying information, and filtering on it would be fitting noise.'),
        MIN_READ_SAMPLE_UNMET(ctxFor, ctxAgainst)
          ? `Not enough settled bets to read whether the descriptive context beats the model ` +
            `(${ctxFor.length} against ${ctxAgainst.length}).`
          : (contextSplit.significant
            ? `Picks the descriptive context disagreed with fared ${Math.abs(contextSplit.diff_pp)} ` +
              `points ${contextSplit.diff_pp > 0 ? 'better' : 'worse'} (z = ${contextSplit.z}). ` +
              'Cover records and efficiency gaps are beating the model on its own picks, which makes ' +
              'them candidates to become actual inputs — preregister that before believing it.'
            : `Context agreement moved the win rate by ${contextSplit.diff_pp} points ` +
              `(z = ${contextSplit.z}), inside noise. Those descriptive features are not ` +
              'demonstrably worth promoting to inputs on this evidence.')
      ].filter(Boolean)
    },
    expert_learning: {
      games: expertGames.length, experts: expertLearning,
      coordinator_ready_games: expertGames.filter(game => game.coordinator?.ready).length,
      rule: 'Every expert is scored on the same weeks. Coverage and abstentions remain visible; no best-looking subset is promoted here.'
    },
    postgame_learning: {
      games: truth.length,
      core_training_eligible: truth.filter(game => game.filtration?.core_training_eligible).length,
      deep_gameplay_coverage: truth.filter(game => game.filtration?.deep_postgame_eligible).length,
      usage_surprises: truth.reduce((sum, game) => sum + (game.usage_surprises?.length ?? 0), 0),
      structural_trends: truth.reduce((sum, game) => sum + (game.structural_trends?.length ?? 0), 0),
      variance_markers: [...markerCounts].map(([marker, games]) => ({ marker, games })).sort((a, b) => b.games - a.games),
      rule: 'Valid chaotic games retain weight 1. Only identity/source incompleteness quarantines a label.'
    },
    interpretation: 'Historical chronological replay only. Profitability promotion still requires forward priced decisions and positive CLV.'
  };
}

function bettingSummary(weeks) {
  const metrics = weeks.map(item => item.result?.betting?.metrics).filter(item => Number.isFinite(item?.bets));
  const bets = metrics.reduce((sum, item) => sum + item.bets, 0);
  const wins = metrics.reduce((sum, item) => sum + (item.wins ?? 0), 0);
  const losses = metrics.reduce((sum, item) => sum + (item.losses ?? 0), 0);
  const pushes = metrics.reduce((sum, item) => sum + (item.pushes ?? Math.max(0, item.bets - (item.wins ?? 0) - (item.losses ?? 0))), 0);
  const units = metrics.reduce((sum, item) => sum + (item.units ?? 0), 0);
  return { bets, wins, losses, pushes, win_rate: wins + losses ? +(wins / (wins + losses)).toFixed(4) : null,
    units: +units.toFixed(3), roi: bets ? +(units / bets).toFixed(4) : null };
}

function runManifest(record, weeks) {
  const spec = record.spec ?? JSON.parse(record.spec_json);
  const final = record.final ?? (record.final_json ? JSON.parse(record.final_json) : null);
  const opened = weeks.map(item => item.opened_at).filter(Boolean).sort();
  const last = opened.at(-1) ?? null;
  const createdMs = Date.parse(record.created_at), lastMs = Date.parse(last);
  const failures = [];
  for (const item of weeks) {
    if (item.result?.betting?.metrics?.error) failures.push({ season: item.season, week: item.week,
      phase: 'betting', error: item.result.betting.metrics.error });
    for (const game of item.result?.expert_council?.games ?? []) if (game.error) failures.push({
      season: item.season, week: item.week, game: `${game.game?.away ?? '?'} at ${game.game?.home ?? '?'}`,
      phase: 'expert_council', error: game.error });
    for (const game of item.result?.postgame_truth ?? []) if (game.error) failures.push({
      season: item.season, week: item.week, game: game.game ?? null, phase: 'postgame_truth', error: game.error });
  }
  const bySeason = (spec.seasons ?? []).map(season => ({ season,
    weeks_opened: weeks.filter(item => item.season === season).length,
    ...bettingSummary(weeks.filter(item => item.season === season)) }));
  const inputTables = Object.entries(spec.provenance?.data_coverage ?? {}).map(([table, state]) => ({
    table, rows: state.rows ?? 0, hash: state.hash ?? null, missing: Boolean(state.missing), scope: state.scope ?? null
  }));
  return {
    schema_version: 'nfl-audit-run-manifest-v1', run_id: record.id, label: record.label,
    classification: spec.classification, status: record.status,
    hashes: { spec: record.spec_hash, code: record.code_hash, data: record.data_hash,
      commit: spec.provenance?.code?.commit ?? null,
      final_chain: weeks.at(-1)?.chain_hash ?? record.spec_hash },
    versions: { player_engine: spec.player_engine, player_head_registry: spec.player_head_registry,
      expert_council: spec.expert_council, postgame_truth: spec.postgame_truth },
    schedule: { seasons: spec.seasons, start_week: spec.startWeek, end_week: spec.endWeek,
      expected_weeks: spec.schedule?.length ?? 0, opened_weeks: weeks.length },
    timing: { registered_at: record.created_at, first_week_opened_at: opened[0] ?? null,
      last_week_opened_at: last,
      elapsed_wall_seconds: Number.isFinite(createdMs) && Number.isFinite(lastMs)
        ? Math.max(0, Math.round((lastMs - createdMs) / 1000)) : null,
      limitation: 'v1 records week-open timestamps, not per-phase latency' },
    coverage: { input_tables: inputTables, expert_games: final?.expert_learning?.games ?? 0,
      coordinator_ready_games: final?.expert_learning?.coordinator_ready_games ?? 0,
      specialists: final?.expert_learning?.experts ?? [],
      deep_postgame_games: final?.postgame_learning?.deep_gameplay_coverage ?? 0 },
    failures: { count: failures.length, items: failures,
      retries: { recorded: false, count: null, reason: 'audit protocol v1 did not persist retry attempts' } },
    results: { overall: bettingSummary(weeks), by_season: bySeason },
    calibration: { available: false,
      reason: 'audit protocol v1 did not persist probability forecasts on the identical settled selection rows' },
    interpretation: final?.interpretation ?? 'Historical chronological replay only; no profitability promotion authority.'
  };
}

export function runNextBlindAuditWeek(id) {
  const startedAt = performance.now();
  const record = rows('SELECT * FROM nfl_blind_audit_runs WHERE id=?', Number(id))[0];
  if (!record) throw new Error('blind audit not found');
  if (record.status === 'complete') throw new Error('blind audit is already complete');
  if (record.status === 'failed') throw new Error('blind audit is sealed as failed');
  if (record.status === 'cancelled') throw new Error('blind audit is sealed as cancelled');
  assertFrozen(record);
  const freezeCheckMs = performance.now() - startedAt;
  const spec = JSON.parse(record.spec_json);
  const target = spec.schedule[record.next_ordinal];
  if (!target) throw new Error('blind audit has no remaining weeks');
  const computeStartedAt = performance.now();
  const { expertCouncil, postgamePackets, result } = withEphemeralEnsembleArtifacts(() => {
    const expertCouncil = weeklyExpertAudit(target.season, target.week, { auditRunId: record.id });
    const postgamePackets = expertCouncil.games.map(item => buildPostgameTruth(target.season, target.week,
      item.game.home, { expertPacket: item }));
    return { expertCouncil, postgamePackets, result: {
      cutoff: `${target.season}-W${target.week - 1}`,
      player: playerWeekResult(target.season, target.week),
      betting: bettingWeekResult(target.season, target.week),
      expert_council: expertCouncil,
      postgame_truth: postgamePackets.map(postgameAuditSummary)
    } };
  });
  const computeMs = performance.now() - computeStartedAt;
  const fault = { player: result.player.faults, betting: result.betting.faults,
    classification: 'outcome-visible fault pass; no model mutation authorized' };
  const prior = rows(`SELECT chain_hash FROM nfl_blind_audit_weeks
                      WHERE run_id=? ORDER BY ordinal DESC LIMIT 1`, record.id)[0]?.chain_hash ?? record.spec_hash;
  const resultHash = sha(JSON.stringify(result));
  const chainHash = sha(`${prior}:${record.next_ordinal}:${target.season}:${target.week}:${resultHash}`);
  const persistStartedAt = performance.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    // Recheck while holding the writer lock. This catches an external input
    // mutation that landed during inference and closes the final race before
    // the immutable week is sealed.
    assertFrozen(record);
    run(`INSERT INTO nfl_blind_audit_weeks
         (run_id,ordinal,season,week,opened_at,prior_chain_hash,result_hash,chain_hash,result_json,fault_json)
         VALUES (?,?,?,?,datetime('now'),?,?,?,?,?)`, record.id, record.next_ordinal,
      target.season, target.week, prior, resultHash, chainHash, JSON.stringify(result), JSON.stringify(fault));
    persistWeeklyExpertAudit(record.id, result.expert_council);
    for (const packet of postgamePackets) persistPostgameTruth(packet);
    const next = record.next_ordinal + 1;
    const complete = next >= spec.schedule.length;
    const weekRows = rows('SELECT result_json FROM nfl_blind_audit_weeks WHERE run_id=? ORDER BY ordinal', record.id)
      .map(x => ({ result: JSON.parse(x.result_json) }));
    const final = complete ? aggregate(weekRows) : null;
    run(`UPDATE nfl_blind_audit_runs SET next_ordinal=?,status=?,final_json=? WHERE id=?`,
      next, complete ? 'complete' : 'running', final ? JSON.stringify(final) : null, record.id);
    const persistMs = performance.now() - persistStartedAt;
    run(`INSERT INTO nfl_blind_audit_week_performance
      (run_id,ordinal,freeze_check_ms,compute_ms,persist_ms,total_ms) VALUES (?,?,?,?,?,?)`,
    record.id, record.next_ordinal, Math.round(freezeCheckMs), Math.round(computeMs),
    Math.round(persistMs), Math.round(performance.now() - startedAt));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return blindAuditStatus(record.id);
}

export function failBlindAudit(id, error) {
  const record = rows('SELECT id,status,next_ordinal FROM nfl_blind_audit_runs WHERE id=?', Number(id))[0];
  if (!record) throw new Error('blind audit not found');
  if (record.status === 'complete') throw new Error('completed blind audit cannot be failed');
  const failure = { classification: 'audit_execution_failure', error: String(error?.message ?? error),
    weeks_opened: record.next_ordinal, sealed_at: new Date().toISOString() };
  run(`UPDATE nfl_blind_audit_runs SET status='failed',final_json=? WHERE id=?`,
    JSON.stringify(failure), record.id);
  return blindAuditStatus(record.id);
}

export function blindAuditStatus(id) {
  const record = parseRun(rows('SELECT * FROM nfl_blind_audit_runs WHERE id=?', Number(id))[0]);
  if (!record) return null;
  const weeks = rows(`SELECT ordinal,season,week,opened_at,prior_chain_hash,result_hash,chain_hash,
                             result_json,fault_json FROM nfl_blind_audit_weeks
                      WHERE run_id=? ORDER BY ordinal`, record.id).map(x => ({ ...x,
    result: JSON.parse(x.result_json), faults: JSON.parse(x.fault_json), result_json: undefined, fault_json: undefined }));
  const timings = rows(`SELECT freeze_check_ms,compute_ms,persist_ms,total_ms
    FROM nfl_blind_audit_week_performance WHERE run_id=? ORDER BY ordinal`, record.id);
  const average = key => timings.length
    ? Math.round(timings.reduce((sum, item) => sum + item[key], 0) / timings.length) : null;
  const averageTotalMs = average('total_ms');
  return { ...record, progress: { opened: weeks.length, total: record.spec.schedule.length,
    next: record.spec.schedule[record.next_ordinal] ?? null },
  performance: { measured_weeks: timings.length,
    average_freeze_check_ms: average('freeze_check_ms'), average_compute_ms: average('compute_ms'),
    average_persist_ms: average('persist_ms'), average_total_ms: averageTotalMs,
    estimated_remaining_ms: averageTotalMs == null ? null
      : averageTotalMs * Math.max(0, record.spec.schedule.length - weeks.length),
    latest: timings.at(-1) ?? null },
  manifest: runManifest(record, weeks), weeks };
}

export function listBlindAudits() {
  return rows('SELECT id FROM nfl_blind_audit_runs ORDER BY id DESC').map(x => blindAuditStatus(x.id));
}

export function blindAuditProtocol() {
  return { ...normalizeSpec({}), input_tables: INPUT_TABLES,
    warning: 'Do not preregister until the model code is committed and the input data snapshot is frozen.' };
}

export const __test = { bettingSummary, runManifest, inputDataState, inputMutationState };
