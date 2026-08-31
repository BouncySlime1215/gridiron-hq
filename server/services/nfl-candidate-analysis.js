/** Candidate-vs-champion robustness and decision attribution. */
import { db, rows, run } from '../db/index.js';
import { replaySeason, uncertainty } from './nfl-replay.js';

db.exec(`CREATE TABLE IF NOT EXISTS nfl_candidate_robustness_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id TEXT NOT NULL,
  seasons_json TEXT NOT NULL, created_at TEXT NOT NULL, result_json TEXT NOT NULL
)`);

const r3 = value => value == null || !Number.isFinite(value) ? null : +value.toFixed(3);
const keyFor = item => `${item.season}|${item.week}|${item.home}|${item.market}`;
const unitsFor = item => item.result === 'Push' ? 0 : item.result === 'Lost' ? -1
  : item.american_price > 0 ? item.american_price / 100 : 100 / Math.abs(item.american_price);

function score(items) {
  const bets = items.map(item => ({ ...item, units: item.units ?? unitsFor(item) }));
  const wins = bets.filter(item => item.result === 'Won').length;
  const losses = bets.filter(item => item.result === 'Lost').length;
  const units = bets.reduce((sum, item) => sum + item.units, 0);
  return { bets: bets.length, wins, losses,
    win_rate: wins + losses ? r3(wins / (wins + losses)) : null,
    units: r3(units), roi: bets.length ? r3(units / bets.length) : null,
    uncertainty: uncertainty(bets) };
}

function runEngine(seasons, includeChallengers, extraModelOptions = {}) {
  const perSeason = [], bets = [], decisions = [];
  for (const season of seasons) {
    const result = replaySeason(season, { modelOptions: includeChallengers
      ? { includeChallengers: true, ...extraModelOptions } : extraModelOptions });
    if (result.error) { perSeason.push({ season, error: result.error }); continue; }
    perSeason.push(result.summary); bets.push(...result.bets); decisions.push(...result.decisions);
  }
  return { perSeason, bets, decisions, overall: score(bets) };
}

function edgeCalibration(decisions) {
  const definitions = [
    ['3.0–3.9', 3, 4], ['4.0–4.9', 4, 5], ['5.0–6.9', 5, 7], ['7.0+', 7, Infinity]
  ];
  const graded = decisions.filter(item => item.abstention_reason == null || item.abstention_reason === 'weekly_capacity')
    .filter(item => ['Won', 'Lost', 'Push'].includes(item.result));
  return definitions.map(([bucket, low, high]) => ({ bucket,
    ...score(graded.filter(item => item.edge_points >= low && item.edge_points < high)) }));
}

const CANDIDATE_INPUTS = ['early_down_eff', 'pass_eff_matchup', 'rush_eff_matchup',
  'explosive_pass', 'pressure_response', 'series_sustain', 'field_position',
  'second_half_eff', 'roster_strength'];

function signalAblations(seasons, allInputs) {
  return CANDIDATE_INPUTS.map(signal => {
    const without = runEngine(seasons, true, { excludeModels: [signal] });
    return { removed_signal: signal, ...without.overall,
      units_delta_vs_all_inputs: r3(without.overall.units - allInputs.overall.units),
      roi_delta_vs_all_inputs: r3(without.overall.roi - allInputs.overall.roi),
      interpretation: without.overall.units > allInputs.overall.units
        ? 'harmful in this opened replay; removal reduced losses'
        : 'helpful in this opened replay; removal worsened results' };
  }).sort((a, b) => b.units_delta_vs_all_inputs - a.units_delta_vs_all_inputs);
}

function fixedVolume(decisions, volumes) {
  const eligible = decisions.filter(item => item.abstention_reason == null || item.abstention_reason === 'weekly_capacity')
    .filter(item => ['Won', 'Lost', 'Push'].includes(item.result))
    .sort((a, b) => b.edge_points - a.edge_points || a.season - b.season || a.week - b.week);
  return volumes.map(volume => ({ requested: volume, available: eligible.length,
    ...score(eligible.slice(0, volume)),
    threshold_edge: eligible.length >= volume ? r3(eligible[volume - 1]?.edge_points) : null }));
}

function seasonDrop(engine, seasons) {
  return seasons.map(heldOut => ({ held_out: heldOut,
    ...score(engine.bets.filter(item => item.season !== heldOut)) }));
}

function topInputs(item, marketMargin) {
  return (item?.feature_snapshot?.model_trace ?? []).filter(model => model.challenger_only
      && model.margin != null && model.margin_weight > 0)
    .map(model => ({ id: model.id, weight: model.margin_weight,
      signed_market_contribution: r3(model.margin_weight * (model.margin - marketMargin)) }))
    .sort((a, b) => Math.abs(b.signed_market_contribution) - Math.abs(a.signed_market_contribution)).slice(0, 5);
}

function attribution(champion, candidate) {
  const championMap = new Map(champion.bets.map(item => [keyFor(item), item]));
  const candidateMap = new Map(candidate.bets.map(item => [keyFor(item), item]));
  const keys = new Set([...championMap.keys(), ...candidateMap.keys()]);
  const changed = [];
  for (const key of keys) {
    const before = championMap.get(key), after = candidateMap.get(key);
    const change = !before ? 'added' : !after ? 'removed' : before.side !== after.side ? 'side_flip' : 'retained';
    if (change === 'retained') continue;
    const reference = after ?? before;
    changed.push({ key, season: reference.season, week: reference.week, home: reference.home,
      away: reference.away, market: reference.market, change,
      champion_side: before?.side ?? null, candidate_side: after?.side ?? null,
      champion_edge: before?.edge ?? null, candidate_edge: after?.edge ?? null,
      champion_disagreement: before?.disagreement ?? null,
      candidate_disagreement: after?.disagreement ?? null,
      result: after?.result ?? before?.result ?? null,
      candidate_units: after?.units ?? null,
      top_candidate_inputs: after ? topInputs(after, after.market_margin) : [] });
  }
  const byChange = Object.fromEntries(['added', 'removed', 'side_flip'].map(change => {
    const items = changed.filter(item => item.change === change && item.candidate_units != null);
    return [change, { count: changed.filter(item => item.change === change).length,
      candidate_scored: items.length, candidate_units: r3(items.reduce((sum, item) => sum + item.candidate_units, 0)) }];
  }));
  const signalCounts = new Map();
  for (const item of changed) for (const signal of item.top_candidate_inputs) {
    const current = signalCounts.get(signal.id) ?? { id: signal.id, appearances: 0, abs_contribution: 0 };
    current.appearances++; current.abs_contribution += Math.abs(signal.signed_market_contribution);
    signalCounts.set(signal.id, current);
  }
  return { changed_decisions: changed.length, by_change: byChange,
    top_inputs: [...signalCounts.values()].map(item => ({ ...item, abs_contribution: r3(item.abs_contribution) }))
      .sort((a, b) => b.abs_contribution - a.abs_contribution),
    decisions: changed.sort((a, b) => b.season - a.season || b.week - a.week).slice(0, 250) };
}

function openingSeason(champion2021, candidate2021, fullCandidate) {
  const summarize = engine => ({ overall: engine.overall,
    abstentions: Object.fromEntries([...new Set(engine.decisions.filter(item => !item.eligible)
      .map(item => item.abstention_reason))].map(reason => [reason,
      engine.decisions.filter(item => item.abstention_reason === reason).length])),
    avg_models_active: r3(engine.decisions.reduce((sum, item) => sum
      + Number(item.feature_snapshot?.margin_models_active ?? 0), 0) / Math.max(engine.decisions.length, 1)) });
  return {
    season: 2021, champion: summarize(champion2021), candidate: summarize(candidate2021),
    full_candidate: fullCandidate.overall,
    diagnosis: [
      'Team-week play-by-play features exist from 2016 onward. Excluding 2021 from the headline would be cherry-picking.',
      'Opening weights are now learned only from 2018-2020 discovery games, so 2021 does not fall back to an equal vote.',
      'The decisive evidence remains a frozen 2026 forward window using evidence captured before kickoff.'
    ]
  };
}

export function buildCandidateRobustnessReport(seasons = [2021, 2022, 2023, 2024, 2025]) {
  const champion = runEngine(seasons, false), candidate = runEngine(seasons, true);
  const champion2021 = runEngine([2021], false), candidate2021 = runEngine([2021], true);
  return {
    candidate_id: 'unified-all-inputs-v3-isolated-roster',
    created_at: new Date().toISOString(), seasons,
    evidence_class: 'opened chronological development analysis; not forward proof',
    overall: { champion: champion.overall, candidate: candidate.overall },
    attribution: attribution(champion, candidate),
    fixed_volume: {
      warning: 'Post-hoc selectivity diagnostic. Thresholds are not promotion rules and cannot be tuned on the forward ledger.',
      champion: fixedVolume(champion.decisions, [25, 50, 100, 200]),
      candidate: fixedVolume(candidate.decisions, [25, 50, 100, 200])
    },
    edge_calibration: {
      warning: 'Opened historical diagnostic. A larger displayed edge should perform monotonically better; failure means edge magnitude is not decision-calibrated.',
      champion: edgeCalibration(champion.decisions), candidate: edgeCalibration(candidate.decisions)
    },
    signal_ablation: {
      warning: 'Leave-one-input-out on opened seasons. Use this to reject or redesign signals, never to claim an untouched edge.',
      results: signalAblations(seasons, candidate)
    },
    season_drop: {
      warning: 'Sensitivity after removing one opened season; this is not a new untouched holdout.',
      champion: seasonDrop(champion, seasons), candidate: seasonDrop(candidate, seasons)
    },
    opening_season_2021: openingSeason(champion2021, candidate2021, candidate)
  };
}

export function saveCandidateRobustnessReport(result) {
  run(`INSERT INTO nfl_candidate_robustness_audits
    (candidate_id,seasons_json,created_at,result_json) VALUES (?,?,?,?)`,
  result.candidate_id, JSON.stringify(result.seasons), result.created_at, JSON.stringify(result));
  return latestCandidateRobustnessReport();
}

export function latestCandidateRobustnessReport() {
  const item = rows(`SELECT * FROM nfl_candidate_robustness_audits ORDER BY id DESC LIMIT 1`)[0];
  return item ? { id: item.id, candidate_id: item.candidate_id, created_at: item.created_at,
    seasons: JSON.parse(item.seasons_json), result: JSON.parse(item.result_json) } : null;
}
