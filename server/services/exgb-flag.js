/**
 * E-XGB's one switch (docs/tdd/EXGB-PREREG.md section 8, addendum 1).
 *
 * GRIDIRON_EXGB=1 turns on the SHADOW pipeline only: forecasting each week with the locked
 * models (exgb-shadow.js) and grading them against frozen ESPN and our weekly projection
 * (exgb-grader.js). Nothing it produces is served. It is default off, and on purpose it
 * does NOT follow preview mode (GRIDIRON_PREVIEW_UNCONFIRMED): the pre-registration says
 * only this flag may ever switch E-XGB on.
 *
 * This file is the only reader of GRIDIRON_EXGB, GRIDIRON_EXGB_PYTHON and
 * GRIDIRON_EXGB_MODEL_DIR. All are read per call so a test can flip them.
 */
import os from 'node:os';
import path from 'node:path';

export const EXGB_ENV = 'GRIDIRON_EXGB';

export function exgbEnabled() {
  return process.env[EXGB_ENV] === '1';
}

/** The Python with xgboost + lightgbm (scripts/eval/requirements-exgb.txt); never in the repo. */
export function exgbPython() {
  return process.env.GRIDIRON_EXGB_PYTHON || path.join(os.homedir(), 'gridiron-local', 'venv-ml', 'bin', 'python');
}

/** Where `exgb_shadow.py fit` wrote the locked artifacts and their manifest. */
export function exgbModelDir() {
  return process.env.GRIDIRON_EXGB_MODEL_DIR || path.join(os.homedir(), 'gridiron-local', 'exgb', 'models');
}
