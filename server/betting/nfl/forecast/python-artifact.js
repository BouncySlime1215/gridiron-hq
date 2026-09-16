/** Node → the original Python pipeline, using frozen features and pinned files.
 * No DB reads, artifact selection, fitting, probability invention or promotion.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { RESEARCH_ROOT } from '../../../platform/paths.js';

const worker = path.join(RESEARCH_ROOT, 'betting/nfl/score_artifact.py');
const defaultRoot = path.join(RESEARCH_ROOT, 'betting/nfl/artifacts');
const unavailable = reason => ({ available: false, qualified: false, authority: 'research_only', reason });

export function resolveResearchPython(explicit) {
  if (explicit || process.env.GRIDIRON_RESEARCH_PYTHON) return explicit || process.env.GRIDIRON_RESEARCH_PYTHON;
  const venv = path.join(RESEARCH_ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return existsSync(venv) ? venv : null;
}

export async function scorePythonArtifact(request, { artifactRoot = defaultRoot, python,
  timeoutMs = 30_000 } = {}) {
  const executable = resolveResearchPython(python);
  if (!executable) return unavailable('research_python_unconfigured: set GRIDIRON_RESEARCH_PYTHON or use research/.venv');
  try {
    if (!request || request.schema !== 'nfl-margin-score-request-v1') return unavailable('unsupported scoring request schema');
    const id = request.artifact?.run_id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id)) return unavailable('invalid artifact run_id');
    // The worker deserializes joblib: only named artifacts inside the configured
    // local root may be loaded. No caller-controlled arbitrary file paths.
    const root = realpathSync(artifactRoot);
    const dir = realpathSync(path.join(root, id));
    if (path.dirname(dir) !== root) return unavailable('artifact escaped configured root');
    for (const file of ['metadata.json', 'model.joblib']) {
      if (path.dirname(realpathSync(path.join(dir, file))) !== dir) return unavailable('artifact file escaped configured directory');
    }
    if (!request.features || Object.values(request.features).some(v => v !== null && (typeof v !== 'number' || !Number.isFinite(v)))) {
      return unavailable('feature values must be finite numbers or explicit null');
    }
    // Snapshot before awaiting the child so callers cannot mutate the request
    // used to validate its response. Reject NaN rather than JSON's silent null.
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > 1_000_000) return unavailable('scoring request too large');
    const frozen = JSON.parse(input);
    const requestHash = createHash('sha256').update(input).digest('hex');
    const response = await new Promise(resolve => {
      const child = execFile(executable, [worker, '--artifact-dir', dir], {
        timeout: timeoutMs, maxBuffer: 1_000_000,
        env: { ...process.env, PYTHONNOUSERSITE: '1', OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1' }
      }, (error, stdout) => {
        if (error) { resolve(unavailable(`python_worker_failed: ${error.code ?? error.signal ?? error.message}`)); return; }
        try { resolve(JSON.parse(stdout)); }
        catch { resolve(unavailable('invalid JSON from Python scoring worker')); }
      });
      child.stdin.on('error', () => {}); // execFile callback owns early-exit failures.
      child.stdin.end(input);
    });
    if (response?.available !== true) return { ...unavailable(response?.reason ?? 'invalid worker result'), request_hash: requestHash };
    if (response.schema !== 'nfl-margin-score-result-v1' || !Number.isFinite(response.predicted_margin)
        || response.qualified !== false || response.authority !== 'research_only'
        || JSON.stringify(response.artifact) !== JSON.stringify(frozen.artifact)
        || JSON.stringify(response.game) !== JSON.stringify(frozen.game)
        || response.cutoff_at !== frozen.cutoff_at) return unavailable('worker output does not match frozen request');
    return { ...response, request_hash: requestHash };
  } catch (error) {
    return unavailable(`artifact_scoring_unavailable: ${error.message}`);
  }
}
