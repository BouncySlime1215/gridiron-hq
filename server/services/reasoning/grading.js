/**
 * REASON-02 in one pass, offline: store the panels' claims, settle what can be
 * settled, grade C8. Behind previewUnconfirmed(); off, it writes nothing.
 *
 * Two callers:
 *   runReasoningGrading    npm run reasoning:grade (scripts/reasoning/grade-claims.mjs)
 *   refreshReasoningClaims the refresh loop's brain_report step (scripts/eval/run-graders.mjs),
 *                          just before the graders run, so C8 grades claims settled
 *                          against this tick's rows
 */
import fs from 'node:fs';
import path from 'node:path';
import { recordClaims } from './claims.js';
import { resolveOpenClaims } from './resolve.js';
import { run as gradeC8, reasoningGradingEnabled, PREVIEW_REASON } from './grade.js';
import { previewFields } from '../preview-mode.js';
import { warRoomPlansPath } from '../warroom-flag.js';

/** Same file as plan-reasoning.js#panelsCachePath, without importing the paid producer. */
const PANELS_CACHE = 'panels.json';
export const NO_NEWS_NOTE = 'no news feed in the loop; check_first quotes are stored uncheckable';

export function runReasoningGrading(database, { plans, panels, news = {}, now = new Date(), leagueId = null }) {
  if (!reasoningGradingEnabled()) return { enabled: false, reason: PREVIEW_REASON };
  const recorded = recordClaims(database, { plans, panels, news, now, leagueId });
  const resolved = resolveOpenClaims(database, { now, leagueId });
  return { enabled: true, ...previewFields(PREVIEW_REASON), recorded, resolved, report: gradeC8(database, { leagueId }) };
}

/** A JSON file, null when absent; an unreadable one throws with the path, never reads as empty. */
function readJson(file, label) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${label} file ${file} could not be read (${e.message})`);
  }
}

/**
 * The loop step: record the claims of the War Room plans file's panels (the
 * panels.json reuse cache next to it), then settle every open claim. Off, it
 * reads and writes nothing. No plans or panels file still settles what is
 * stored, with a note. A corrupt file returns `error` and records nothing.
 */
export function refreshReasoningClaims(database, { plansPath = warRoomPlansPath(), now = new Date() } = {}) {
  if (!reasoningGradingEnabled()) return { enabled: false, reason: PREVIEW_REASON };
  const panelsPath = path.join(path.dirname(path.resolve(plansPath)), PANELS_CACHE);
  let plans;
  let panels;
  try {
    plans = readJson(plansPath, 'plans');
    panels = plans ? readJson(panelsPath, 'panels') : null;
  } catch (e) {
    return { enabled: true, error: e.message, recorded: null, resolved: null, notes: [] };
  }
  const notes = [];
  if (!plans) notes.push(`no plans file at ${plansPath}; recording skipped`);
  else if (!panels) notes.push(`no panels file at ${panelsPath}; recording skipped`);
  const recorded = plans && panels ? recordClaims(database, { plans, panels, now }) : null;
  if (recorded) notes.push(NO_NEWS_NOTE);
  const resolved = resolveOpenClaims(database, { now });
  return { enabled: true, recorded, resolved, notes };
}
