/** Weekly training + frozen pregame candidate observations on the existing tape.
 * Own policy/experiment IDs keep research candidates outside production picks.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT, RESEARCH_ROOT, PROJECT_ROOT } from '../../../platform/paths.js';
import { dbPath } from '../../../db/index.js';
import { recordDecisionRun } from '../../../services/nfl-decision-tape.js';
import { scheduledGames } from './t60-runner.js';
import { scorePythonArtifact, resolveResearchPython } from '../forecast/python-artifact.js';

export const LEARNED_SHADOW_VERSION = 'nfl-unified-margin-shadow-v1';
const policy = { id: 'nfl-trained-margin-shadow', version: LEARNED_SHADOW_VERSION };
const worker = path.join(RESEARCH_ROOT, 'betting/nfl/weekly_training.py');
const defaultRoot = path.join(DATA_ROOT, 'learned-shadow');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const active = new Map();

function immutableJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value));
  try { fs.linkSync(temp, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { fs.unlinkSync(temp); }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function codeIdentity() {
  const files = ['research/betting/nfl/weekly_training.py', 'research/betting/nfl/model_artifact.py',
    'research/betting/nfl/dataset.py', 'research/betting/nfl/stage3_team_strength.py',
    'research/betting/nfl/score_artifact.py', 'server/betting/nfl/forecast/python-artifact.js',
    'research/betting/nfl/unified_model.py', 'research/expert_selector_lab.py',
    'server/betting/nfl/strategy/learned-shadow-runner.js'];
  const manifest = Object.fromEntries(files.map(f => [f, hash(fs.readFileSync(path.join(PROJECT_ROOT, f)))]));
  return { id: hash(JSON.stringify(manifest)), manifest };
}

function runPython(action, { python, databasePath, outputRoot, input = {} }) {
  return new Promise(resolve => {
    const child = execFile(python, [worker, action, '--db', databasePath, '--output', outputRoot], {
      timeout: 90_000, maxBuffer: 8_000_000,
      env: { ...process.env, PYTHONNOUSERSITE: '1', OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1' }
    }, (error, stdout) => {
      try { resolve(JSON.parse(stdout)); }
      catch { resolve({ ok: false, reason: `weekly_worker_failed: ${error?.message ?? 'invalid JSON'}` }); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

/** Caller can replay a retained observation after a tape-write interruption. */
export async function recordLearnedObservation(observation, { outputRoot = defaultRoot, python } = {}) {
  const file = path.join(outputRoot, 'observations', `${observation.id}.result.json`);
  let saved;
  if (fs.existsSync(file)) {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    const result = observation.request
      ? await scorePythonArtifact(observation.request, { artifactRoot: path.join(outputRoot, 'artifacts'), python })
      : { available: false, qualified: false, reason: observation.reason ?? 'no frozen feature request' };
    const late = observation.request && Date.now() >= Date.parse(observation.game.kickoff_at);
    saved = immutableJson(file, { result, scored_at: new Date().toISOString(),
      recorded_after_kickoff: !!late, observation_hash: hash(JSON.stringify(observation)) });
  }
  if (saved.observation_hash !== hash(JSON.stringify(observation))) throw new Error('frozen observation differs from saved score');
  const result = saved.result;
  const game = observation.game;
  const board = {
    policy, engine_mode: LEARNED_SHADOW_VERSION,
    decisions: [{ matchup: `${game.away} @ ${game.home}`, home_team: game.home, away_team: game.away,
      market: 'spreads', selection: game.home, side: 'home',
      eligible: false, calibration_eligible: false, calibration_status: 'not_calibrated',
      abstention_reason: result.available ? 'research_only_margin_model_without_probability_calibration' : result.reason,
      feature_snapshot: {
        raw_forecast: { projected_margin: result.available ? result.predicted_margin : null },
        forecast_identity: { id: hash(JSON.stringify(observation.request?.artifact ?? {})) },
        frozen_request: observation.request, evidence_mode: 'observed_shadow',
        unified_forecast: result.unified_forecast ?? null,
        horizon: 'scheduled_pregame_snapshot', scored_at: saved.scored_at,
        recorded_after_kickoff: saved.recorded_after_kickoff,
        source_failure: observation.reason, data_provenance: { inputs: 'retained_feature_request',
          historical_training: 'reconstructed with conservative publication proxies' }
      }
    }]
  };
  const tape = recordDecisionRun(game.season, game.week, board, {
    observation: { experimentId: LEARNED_SHADOW_VERSION, horizon: 'scheduled_pregame_snapshot',
      cutoffAt: observation.captured_at, jobId: 'scheduler:nfl_learned_shadow', observationId: observation.id },
    policyId: policy.id, policyVersion: policy.version, computationStatus: 'complete',
    dataIdentityStatus: 'frozen_packet', dataHash: hash(JSON.stringify(observation)),
    codeIdentity: observation.code_identity, decidedAt: saved.scored_at,
    note: 'Unqualified trained margin candidate; zero stake; not an exact T-60 or priced forecast.'
  });
  return { id: observation.id, available: result.available, ...tape };
}

async function pass({ season, week, outputRoot = defaultRoot, databasePath = dbPath, python: explicit }) {
  const python = resolveResearchPython(explicit);
  if (!python) return { ok: false, reason: 'research_python_unconfigured' };
  fs.mkdirSync(outputRoot, { recursive: true });
  const attempts = [];
  // Retry retained observations FIRST. No changing source/model read can alter
  // their saved requests or completed score, even if the previous tape link failed.
  const observationsRoot = path.join(outputRoot, 'observations');
  if (fs.existsSync(observationsRoot)) {
    for (const entry of fs.readdirSync(observationsRoot).filter(n => n.endsWith('.request.json'))) {
      const obs = JSON.parse(fs.readFileSync(path.join(observationsRoot, entry), 'utf8'));
      const marker = path.join(observationsRoot, `${obs.id}.linked.json`);
      if (fs.existsSync(marker)) continue;
      try { const link = await recordLearnedObservation(obs, { outputRoot, python }); immutableJson(marker, link); attempts.push(link); }
      catch (error) { attempts.push({ id: obs.id, error: error.message }); }
    }
  }
  const fit = await runPython('fit', { python, databasePath, outputRoot });
  // Failure is retained and the capture resolver may use the last completed,
  // still eligible artifact. A failed fit never replaces a working artifact.
  if (!fit.ok) immutableJson(path.join(outputRoot, 'failures', `${Date.now()}-${crypto.randomUUID()}.json`), fit);
  const now = Date.now();
  const games = scheduledGames(season, week).filter(g => Date.parse(g.kickoff) > now)
    .map(g => ({ season, week, home: g.home, away: g.away, kickoff_at: g.kickoff, event_key: g.event_key }));
  if (!games.length) return { ok: true, fit, attempts, captured: 0, reason: 'no upcoming games in selected week' };
  const batch = await runPython('capture', { python, databasePath, outputRoot, input: { games } });
  const capturedAt = batch.captured_at ?? new Date().toISOString();
  const items = batch.ok ? batch.observations : games.map(game => ({ game, captured_at: capturedAt, request: null, reason: batch.reason }));
  for (const item of items) {
    const bucket = Math.floor(Date.parse(item.captured_at) / 3_600_000);
    const id = hash(`${LEARNED_SHADOW_VERSION}|${item.game.event_key}|${bucket}`);
    const obs = immutableJson(path.join(observationsRoot, `${id}.request.json`), { ...item, id, code_identity: codeIdentity() });
    try {
      const link = await recordLearnedObservation(obs, { outputRoot, python });
      immutableJson(path.join(observationsRoot, `${id}.linked.json`), link); attempts.push(link);
    } catch (error) { attempts.push({ id, error: error.message }); }
  }
  return { ok: !attempts.some(a => a.error), fit, attempts, captured: items.length };
}

export function runLearnedShadowPass(options = {}) {
  const key = path.resolve(options.outputRoot ?? defaultRoot);
  if (active.has(key)) return active.get(key);
  const promise = pass(options).finally(() => active.delete(key));
  active.set(key, promise);
  return promise;
}
