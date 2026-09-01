/**
 * Rookie projections — the model's largest structural blind spot.
 *
 * `buildProjections` builds entirely from `player_week_usage`, so a player
 * with no NFL history produces no projection at all. Verified directly: at
 * Week 1 of 2025, 880 players received a projection and **zero** of them were
 * players without prior usage. The model is not merely inaccurate about
 * rookies; it cannot see them. That is worst precisely when it matters most —
 * draft season and the opening weeks.
 *
 * The fix is not new modelling technique, it is a prior. Everywhere else in
 * this codebase an unknown quantity starts at a positional prior and shrinks
 * toward observed evidence as it accumulates. Rookies had no prior to start
 * from. Draft capital is that prior:
 *
 *   round 1    16.60 opportunities per game
 *   round 2     9.77
 *   round 3     5.56
 *   rounds 4-5  4.05
 *
 * A 4x spread, monotonic across the range that matters. And it is available
 * before a single snap is played.
 *
 * College production, opponent strength, athletic testing and verified
 * preseason roles are accepted below as dated evidence. They do not receive a
 * hand-written production bonus. A ridge-shrunk challenger must learn their
 * incremental value over draft capital on strictly earlier draft classes.
 *
 * COVERAGE LIMIT, stated plainly: `player_accolades` is keyed to the current
 * roster snapshot, so draft capital exists only for players still rostered in
 * 2026. The n=75 historical rookie seasons behind the table above are
 * survivors. Late-round bands are the least trustworthy for exactly this
 * reason — a sixth-rounder in this sample is a sixth-rounder who lasted.
 * Bands are therefore shrunk hard and the late-round bands are collapsed.
 */
import { db, rows } from '../db/index.js';
import { normalizePlayerName } from './player-identity.js';
import { ridgeFit } from './nfl-specialists.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_rookie_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season INTEGER NOT NULL,
    player_id INTEGER,
    player_name TEXT NOT NULL,
    position TEXT NOT NULL,
    college TEXT,
    evidence_type TEXT NOT NULL,
    values_json TEXT NOT NULL,
    available_at TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    source TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    verification_state TEXT NOT NULL,
    UNIQUE(season,player_name,evidence_type,source_ref)
  );
  CREATE INDEX IF NOT EXISTS idx_rookie_evidence_cutoff
    ON nfl_rookie_evidence(season,available_at,player_id);
`);

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));

/** Draft-capital bands. Collapsed at the tail where survivorship dominates. */
export function draftBand(pick) {
  if (pick == null) return 'undrafted';
  if (pick <= 32) return 'R1';
  if (pick <= 64) return 'R2';
  if (pick <= 105) return 'R3';
  return 'R4+';
}

/**
 * Measured rookie opportunity per game by draft band and position.
 * Survivorship-limited; see the file header.
 */
export function measureRookiePriors() {
  const acc = rows(`SELECT player_id,player_name name,position,season draft_year,
      json_extract(values_json,'$.draft_round') draft_round,
      json_extract(values_json,'$.draft_pick') draft_pick
    FROM nfl_rookie_evidence WHERE evidence_type='draft' AND verification_state='verified'
      AND player_id IS NOT NULL AND json_extract(values_json,'$.draft_pick') IS NOT NULL
      AND position IN ('QB','RB','WR','TE')`);
  const usage = new Map();
  for (const u of rows(`SELECT player_id, season,
                               SUM(COALESCE(targets,0)+COALESCE(carries,0)+COALESCE(attempts,0)) opp,
                               SUM(COALESCE(targets,0)) targets, SUM(COALESCE(carries,0)) carries,
                               SUM(COALESCE(attempts,0)) attempts, COUNT(*) g
                        FROM player_week_usage GROUP BY player_id, season`)) {
    usage.set(`${u.player_id}|${u.season}`, u);
  }
  const points = [];
  for (const a of acc) {
    const u = usage.get(`${a.player_id}|${a.draft_year}`);
    if (!u || u.g < 4) continue;
    points.push({ position: a.position, band: draftBand(a.draft_pick), pick: a.draft_pick,
      opp_per_game: u.opp / u.g, targets_per_game: u.targets / u.g,
      carries_per_game: u.carries / u.g, attempts_per_game: u.attempts / u.g });
  }
  const byBand = {}, byBandPos = {};
  for (const p of points) {
    (byBand[p.band] ??= []).push(p);
    (byBandPos[`${p.band}|${p.position}`] ??= []).push(p);
  }
  const summarize = list => ({
    n: list.length,
    opp_per_game: r3(mean(list.map(x => x.opp_per_game))),
    targets_per_game: r3(mean(list.map(x => x.targets_per_game))),
    carries_per_game: r3(mean(list.map(x => x.carries_per_game))),
    attempts_per_game: r3(mean(list.map(x => x.attempts_per_game)))
  });
  return {
    n: points.length,
    by_band: Object.fromEntries(Object.entries(byBand).map(([k, v]) => [k, summarize(v)])),
    by_band_position: Object.fromEntries(Object.entries(byBandPos)
      .filter(([, v]) => v.length >= 4)
      .map(([k, v]) => [k, summarize(v)])),
    caveat: 'Draft capital is joined through nflverse GSIS/PFR identities rather than a current-roster snapshot. ' +
      'Thin late-round bands are still collapsed into R4+ and shrunk hard downstream.'
  };
}

/** Cached measured priors, with conservative hardcoded fallbacks. */
let priorCache = null;
function priors() {
  if (priorCache) return priorCache;
  let measured;
  try { measured = measureRookiePriors(); } catch { measured = { by_band: {}, by_band_position: {} }; }
  priorCache = measured;
  return measured;
}

/**
 * Fallbacks used when a band has too little data to speak. Deliberately
 * conservative — an unknown rookie should look like a marginal contributor,
 * not a starter, because the cost of over-projecting an unknown in a draft
 * tool is a wasted pick.
 */
const FALLBACK_OPP = { R1: 12, R2: 8, R3: 5, 'R4+': 3, undrafted: 1.5 };

/**
 * Opportunity prior for a rookie, before he has played.
 *
 * `depthRank` (from `nfl_depth.pos_rank`) refines it when available: a
 * third-round receiver listed WR1 is a different proposition from the same
 * player listed WR4. Applied as a modest multiplier rather than an override,
 * because preseason depth charts are notoriously soft.
 */
export function rookieOpportunityPrior({ position, draftPick, depthRank = null } = {}) {
  const band = draftBand(draftPick);
  const p = priors();
  const posKey = `${band}|${position}`;
  const source = p.by_band_position?.[posKey] ?? p.by_band?.[band] ?? null;
  const base = source?.opp_per_game ?? FALLBACK_OPP[band] ?? 2;
  // Shrink the measured value toward the conservative fallback in proportion
  // to how thin the sample is. n=4 barely moves it; n=30 mostly trusts it.
  const n = source?.n ?? 0;
  const shrunk = (base * n + (FALLBACK_OPP[band] ?? 2) * 12) / (n + 12);
  const depthMult = depthRank == null ? 1
    : depthRank === 1 ? 1.25 : depthRank === 2 ? 1.0 : depthRank === 3 ? 0.75 : 0.5;
  return {
    band, position,
    opportunity_per_game: r3(shrunk * depthMult),
    measured_n: n,
    depth_rank: depthRank,
    depth_multiplier: depthMult,
    basis: source ? (p.by_band_position?.[posKey] ? 'band+position' : 'band') : 'fallback',
    confidence: n >= 20 ? 'moderate' : n >= 8 ? 'low' : 'very_low',
    caveat: 'Prior only. Replace with observed usage as soon as real games exist.'
  };
}

/** Current depth-chart rank for a player, latest capture at or before the season/week. */
export function depthRankFor(gsisId, season, week) {
  if (!gsisId) return null;
  const r = rows(`SELECT pos_rank FROM nfl_depth
                  WHERE gsis_id = ? AND (season < ? OR (season = ? AND week <= ?))
                  ORDER BY season DESC, week DESC LIMIT 1`, gsisId, season, season, week)[0];
  return r?.pos_rank ?? null;
}

/**
 * Blend the draft-capital prior with observed NFL usage as it accumulates.
 *
 * Identical logic to every other shrinkage in this codebase: the prior holds
 * while evidence is thin and yields as games arrive. `k = 4` means the prior
 * still carries half the weight after four games — rookie roles genuinely do
 * change fast, and four games is roughly where usage starts being real rather
 * than situational.
 */
export function blendedRookieOpportunity({ prior, observedPerGame, gamesPlayed = 0, k = 4 }) {
  if (!Number.isFinite(observedPerGame) || gamesPlayed <= 0) return prior;
  return (observedPerGame * gamesPlayed + prior * k) / (gamesPlayed + k);
}

const EVIDENCE_TYPES = new Set(['draft', 'college_production', 'opponent_strength', 'combine', 'pro_day', 'preseason_role']);
const evidenceFitCache = new Map();
const skillPositions = new Set(['QB', 'RB', 'WR', 'TE']);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const parse = value => { try { return JSON.parse(value ?? '{}'); } catch { return {}; } };

function finiteValues(value) {
  const out = {};
  for (const [key, raw] of Object.entries(value ?? {})) {
    if (typeof raw === 'boolean') out[key] = raw;
    else if (raw != null && raw !== '' && Number.isFinite(Number(raw))) out[key] = Number(raw);
  }
  return out;
}

function resolvePlayer(item) {
  if (item.player_id != null) {
    const found = rows(`SELECT id,name,position FROM players WHERE id=? LIMIT 1`, item.player_id)[0];
    if (found) return found;
  }
  const key = normalizePlayerName(item.player_name ?? item.name);
  const matches = rows(`SELECT id,name,position FROM players`).filter(player => normalizePlayerName(player.name) === key);
  return matches.length === 1 ? matches[0] : null;
}

/** Strict import boundary for licensed or public structured rookie datasets. */
export function importRookieEvidence(items, { source = null, sourceRef = null,
  capturedAt = new Date().toISOString(), verificationState = 'verified' } = {}) {
  const insert = db.prepare(`INSERT INTO nfl_rookie_evidence
    (season,player_id,player_name,position,college,evidence_type,values_json,available_at,
     captured_at,source,source_ref,verification_state)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(season,player_name,evidence_type,source_ref) DO UPDATE SET
      player_id=excluded.player_id,position=excluded.position,college=excluded.college,
      values_json=excluded.values_json,available_at=excluded.available_at,
      captured_at=excluded.captured_at,verification_state=excluded.verification_state`);
  let stored = 0, quarantined = 0;
  const reasons = {};
  for (const item of items ?? []) {
    const season = Number(item.season ?? item.draft_year), type = String(item.evidence_type ?? item.type ?? '');
    const player = resolvePlayer(item), position = String(item.position ?? player?.position ?? '').toUpperCase();
    const ref = String(item.source_ref ?? sourceRef ?? ''), provider = String(item.source ?? source ?? '');
    const availableAt = item.available_at ?? item.measured_at ?? item.published_at;
    let reason = null;
    if (!season || !EVIDENCE_TYPES.has(type)) reason = 'invalid season or evidence type';
    else if (!player) reason = 'player identity is missing or ambiguous';
    else if (!skillPositions.has(position)) reason = 'unsupported position';
    else if (!availableAt || Number.isNaN(Date.parse(availableAt))) reason = 'missing valid availability timestamp';
    else if (!provider || !ref || /ai analysis/i.test(provider)) reason = 'source and stable source reference are required';
    const values = finiteValues(item.values ?? item.metrics ?? item);
    if (!reason && !Object.keys(values).length) reason = 'no finite measurements';
    if (reason) { quarantined++; reasons[reason] = (reasons[reason] ?? 0) + 1; continue; }
    stored += insert.run(season, player.id, player.name, position, item.college ?? null, type,
      JSON.stringify(values), new Date(availableAt).toISOString(), capturedAt, provider, ref,
      verificationState === 'verified' ? 'verified' : 'quarantined').changes;
  }
  priorCache = null;
  evidenceFitCache.clear();
  return { reviewed: items?.length ?? 0, stored, quarantined, reasons };
}

/** Convert existing ESPN draft records into the same evidence contract. */
export function syncDraftRookieEvidence() {
  const items = rows(`SELECT p.id player_id,a.name player_name,r.position,a.draft_year season,
      a.draft_round,a.draft_pick,a.source,a.fetched_at
    FROM player_accolades a JOIN roster_players r ON r.id=a.roster_player_id
    LEFT JOIN players p ON p.espn_id=r.espn_id
    WHERE a.draft_year IS NOT NULL AND r.position IN ('QB','RB','WR','TE') AND p.id IS NOT NULL`)
    .map(item => ({ ...item, evidence_type: 'draft', values: { draft_round: item.draft_round,
      draft_pick: item.draft_pick }, available_at: `${item.season}-05-01T00:00:00Z`,
      source: item.source || 'ESPN draft profile', source_ref: `espn-draft:${item.player_id}:${item.season}` }));
  return importRookieEvidence(items);
}

function latestByType(playerId, season, cutoff) {
  const map = new Map();
  for (const row of rows(`SELECT * FROM nfl_rookie_evidence
    WHERE player_id=? AND season=? AND available_at<=? AND verification_state='verified'
    ORDER BY available_at DESC,id DESC`, playerId, season, cutoff)) {
    if (!map.has(row.evidence_type)) map.set(row.evidence_type, { ...row, values: parse(row.values_json) });
  }
  return map;
}

function percentile(value) {
  return Number.isFinite(Number(value)) ? clamp(Number(value), 0, 1) : null;
}

/** One inspectable feature packet; absent inputs stay absent. */
export function rookieEvidenceProfile(playerId, season, cutoff = `${season}-09-01T00:00:00Z`) {
  const player = rows(`SELECT id,name,position FROM players WHERE id=? LIMIT 1`, playerId)[0];
  if (!player) return { available: false, reason: 'unknown player identity' };
  const evidence = latestByType(playerId, season, cutoff);
  const draft = evidence.get('draft')?.values ?? {};
  const college = evidence.get('college_production')?.values ?? {};
  const opponent = evidence.get('opponent_strength')?.values ?? {};
  const combine = evidence.get('combine')?.values ?? evidence.get('pro_day')?.values ?? {};
  const role = evidence.get('preseason_role')?.values ?? {};
  const pick = Number.isFinite(Number(draft.draft_pick)) ? Number(draft.draft_pick) : null;
  const draftScore = pick == null ? null : clamp(1 - Math.log(Math.max(1, pick)) / Math.log(260), 0, 1);
  const production = percentile(college.production_percentile ?? college.position_production_percentile);
  const schedule = percentile(opponent.opponent_strength_percentile ?? college.opponent_strength_percentile);
  // Interaction says dominant production against stronger opposition is more
  // informative; it does not grant points until a historical fit learns a coefficient.
  const adjustedProduction = production == null ? null
    : production * (0.8 + 0.2 * (schedule ?? 0.5));
  const athletic = percentile(combine.athletic_percentile ?? combine.ras_percentile);
  const roleScore = percentile(role.role_percentile);
  const features = { draft_score: draftScore, adjusted_college_production: adjustedProduction,
    opponent_strength: schedule, athletic_score: athletic, preseason_role: roleScore };
  return { available: Object.values(features).some(Number.isFinite), player_id: player.id,
    player: player.name, position: player.position, season, cutoff, features,
    missing: Object.entries(features).filter(([, value]) => !Number.isFinite(value)).map(([key]) => key),
    evidence: Object.fromEntries([...evidence].map(([type, row]) => [type, {
      available_at: row.available_at, source: row.source, source_ref: row.source_ref, values: row.values
    }])) };
}

function opportunityOutcome(playerId, season) {
  const result = rows(`SELECT COUNT(*) games,
      SUM(COALESCE(targets,0)+COALESCE(carries,0)+COALESCE(attempts,0)) opportunity
    FROM player_week_usage WHERE player_id=? AND season=?`, playerId, season)[0];
  return Number(result?.games) >= 4 ? Number(result.opportunity) / Number(result.games) : null;
}

/** Learn incremental rookie weights on earlier draft classes only. */
export function fitRookieEvidenceModel(targetSeason, { cutoff = `${targetSeason}-09-01T00:00:00Z` } = {}) {
  const cacheKey = `${targetSeason}|${cutoff}`;
  if (evidenceFitCache.has(cacheKey)) return evidenceFitCache.get(cacheKey);
  const candidates = rows(`SELECT DISTINCT player_id,season FROM nfl_rookie_evidence
    WHERE season<? AND player_id IS NOT NULL AND verification_state='verified' ORDER BY season,player_id`, targetSeason);
  const samples = [];
  for (const item of candidates) {
    const profile = rookieEvidenceProfile(item.player_id, item.season, `${item.season}-09-01T00:00:00Z`);
    const y = opportunityOutcome(item.player_id, item.season);
    if (!profile.available || !Number.isFinite(y)) continue;
    const f = profile.features;
    const draftPick = profile.evidence?.draft?.values?.draft_pick;
    const baseline = rookieOpportunityPrior({ position: profile.position, draftPick }).opportunity_per_game;
    samples.push({ season: item.season, y, baseline, x: [1, f.draft_score ?? 0, f.adjusted_college_production ?? 0,
      f.athletic_score ?? 0, f.preseason_role ?? 0,
      f.adjusted_college_production == null ? 1 : 0, f.athletic_score == null ? 1 : 0,
      f.preseason_role == null ? 1 : 0], profile });
  }
  const seasons = new Set(samples.map(sample => sample.season)).size;
  const collegeCoverage = samples.filter(sample => Number.isFinite(sample.profile.features.adjusted_college_production)).length;
  const combineCoverage = samples.filter(sample => Number.isFinite(sample.profile.features.athletic_score)).length;
  const coverageReady = samples.length >= 60 && seasons >= 3 && collegeCoverage / samples.length >= 0.25
    && combineCoverage / samples.length >= 0.25;
  if (!coverageReady) {
    const result = { ready: false, target_season: targetSeason, samples: samples.length, seasons,
    coverage: { college: samples.length ? collegeCoverage / samples.length : 0,
      combine: samples.length ? combineCoverage / samples.length : 0 },
    reason: 'requires 60 settled rookies across 3 classes with at least 25% college and combine coverage' };
    evidenceFitCache.set(cacheKey, result); return result;
  }
  const holdoutSeason = Math.max(...samples.map(sample => sample.season));
  const train = samples.filter(sample => sample.season < holdoutSeason), holdout = samples.filter(sample => sample.season === holdoutSeason);
  const validationWeights = train.length >= 60
    ? ridgeFit(train.map(sample => sample.x), train.map(sample => sample.y), 24) : null;
  const predict = (weights, sample) => sample.x.reduce((sum, value, index) => sum + value * weights[index], 0);
  const mae = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const candidateMae = validationWeights ? mae(holdout.map(sample => Math.abs(predict(validationWeights, sample) - sample.y))) : null;
  const baselineMae = mae(holdout.map(sample => Math.abs(sample.baseline - sample.y)));
  const validation = { holdout_season: holdoutSeason, training_samples: train.length,
    holdout_samples: holdout.length, candidate_mae: r3(candidateMae), draft_depth_baseline_mae: r3(baselineMae),
    incremental_mae: r3(baselineMae == null || candidateMae == null ? null : baselineMae - candidateMae) };
  const validated = holdout.length >= 30 && Number.isFinite(candidateMae) && candidateMae < baselineMae;
  const weights = ridgeFit(samples.map(sample => sample.x), samples.map(sample => sample.y), 24);
  const result = { ready: validated, target_season: targetSeason, cutoff, samples: samples.length, seasons,
    weights, features: ['intercept','draft_score','adjusted_college_production','athletic_score',
      'preseason_role','college_missing','athletic_missing','role_missing'],
    validation, authority: validated ? 'chronologically_validated_research_candidate' : 'measured_but_zero_authority',
    reason: validated ? null : 'candidate did not beat draft/depth prior on the latest held-out draft class' };
  evidenceFitCache.set(cacheKey, result); return result;
}

export function evidenceAdjustedRookiePrior({ playerId, season, position, draftPick, depthRank, cutoff } = {}) {
  const baseline = rookieOpportunityPrior({ position, draftPick, depthRank });
  const profile = rookieEvidenceProfile(playerId, season, cutoff ?? `${season}-09-01T00:00:00Z`);
  const fit = fitRookieEvidenceModel(season, { cutoff });
  if (!fit.ready || !profile.available) return { ...baseline, evidence_profile: profile,
    evidence_fit: fit, evidence_adjusted: false };
  const f = profile.features;
  const x = [1, f.draft_score ?? 0, f.adjusted_college_production ?? 0, f.athletic_score ?? 0,
    f.preseason_role ?? 0, f.adjusted_college_production == null ? 1 : 0,
    f.athletic_score == null ? 1 : 0, f.preseason_role == null ? 1 : 0];
  const raw = x.reduce((sum, value, index) => sum + value * fit.weights[index], 0);
  const learned = clamp(raw, baseline.opportunity_per_game * 0.5, baseline.opportunity_per_game * 1.5);
  const shrink = fit.samples / (fit.samples + 80);
  return { ...baseline, opportunity_per_game: r3(baseline.opportunity_per_game * (1 - shrink) + learned * shrink),
    baseline_opportunity_per_game: baseline.opportunity_per_game, evidence_adjusted: true,
    evidence_profile: profile, evidence_fit: { ...fit, weights: fit.weights.map(r3) }, shrinkage: r3(shrink) };
}
