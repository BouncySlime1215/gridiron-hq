/**
 * WR-1: the War Room's one switch (docs: WAR-ROOM-UI.md section 6).
 *
 * GRIDIRON_WARROOM_ENABLED=1 turns the War Room tab on inside Trade Brain. It is
 * default off; fly.toml does not set it. Preview mode (server/services/preview-mode.js,
 * the one local-testing switch) also turns it on, and then the view says so: it
 * carries `preview: true`, `preview_reason`, and every sentence it prints starts with
 * PREVIEW_PREFIX.
 *
 * This file is the only reader of GRIDIRON_WARROOM_ENABLED and of the plans path
 * variable, GRIDIRON_WARROOM_PLANS. Both are read per call so a test can flip them.
 */
import os from 'node:os';
import path from 'node:path';
import { previewUnconfirmed } from './preview-mode.js';

export const WARROOM_ENV = 'GRIDIRON_WARROOM_ENABLED';
export const WARROOM_PLANS_ENV = 'GRIDIRON_WARROOM_PLANS';
export const WARROOM_PREVIEW_REASON =
  'War Room plans come from a study run (scripts/study/acq-flip-proto.mjs), not the live engine';

/**
 * { enabled, preview }. `preview` is true only when the War Room is on because of
 * preview mode and not because its own switch is set.
 */
export function warRoomFlag() {
  if (process.env[WARROOM_ENV] === '1') return { enabled: true, preview: false };
  if (previewUnconfirmed()) return { enabled: true, preview: true };
  return { enabled: false, preview: false };
}

/** Where the plans JSON lives: GRIDIRON_WARROOM_PLANS, else ~/gridiron-local/warroom/plans.json. */
export function warRoomPlansPath() {
  const set = process.env[WARROOM_PLANS_ENV];
  if (set && set.trim()) return set.trim();
  return path.join(os.homedir(), 'gridiron-local', 'warroom', 'plans.json');
}

/**
 * NEGOTIATE-UI: negotiation mode's switch. GRIDIRON_WARROOM_NEGOTIATE=1 turns it on
 * inside a War Room that is itself on; preview mode turns both on. Default off,
 * fly.toml does not set it. When on only because of preview, the thread carries
 * `preview: true` and NEGOTIATE_PREVIEW_REASON.
 */
export const NEGOTIATE_ENV = 'GRIDIRON_WARROOM_NEGOTIATE';
export const NEGOTIATE_PREVIEW_REASON =
  'Negotiation mode reads an unvalidated acceptance model and hand-set follow-up rules';

export function negotiateFlag() {
  const room = warRoomFlag();
  if (!room.enabled) return { enabled: false, preview: false };
  if (process.env[NEGOTIATE_ENV] === '1') return { enabled: true, preview: room.preview };
  if (previewUnconfirmed()) return { enabled: true, preview: true };
  return { enabled: false, preview: false };
}
