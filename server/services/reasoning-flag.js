/**
 * FIX-08: the reasoning panels' one switch.
 *
 * GRIDIRON_REASONING_ENABLED=1 lets the campaign producer write a reasoning
 * panel into each War Room move (move.reasoning). It is default off; fly.toml
 * does not set it. Preview mode (server/services/preview-mode.js, the one
 * local-testing switch) also turns it on, and then `preview` says so.
 *
 * The switch never spends by itself: the producer also needs the paid-run
 * opt-in (scripts/paid-run-optin.mjs, GRIDIRON_ALLOW_PAID_RUN), a separate and
 * required gate that preview mode does not touch.
 *
 * This file is the only reader of GRIDIRON_REASONING_ENABLED. It is read per
 * call so a test or a run can flip it.
 */
import { previewUnconfirmed } from './preview-mode.js';

export const REASONING_ENV = 'GRIDIRON_REASONING_ENABLED';
export const REASONING_PREVIEW_REASON =
  'Reasoning panels are written by a model from the plan\'s own numbers and have not been graded against outcomes';

/** { enabled, preview }. `preview` is true only when preview mode, not the switch, turned it on. */
export function reasoningFlag() {
  if (process.env[REASONING_ENV] === '1') return { enabled: true, preview: false };
  if (previewUnconfirmed()) return { enabled: true, preview: true };
  return { enabled: false, preview: false };
}
