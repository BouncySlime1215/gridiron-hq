/**
 * REASON-02 in one pass, offline: store the panels' claims, settle what can be
 * settled, grade C8. Behind previewUnconfirmed(); off, it writes nothing.
 */
import { recordClaims } from './claims.js';
import { resolveOpenClaims } from './resolve.js';
import { run as gradeC8, reasoningGradingEnabled, PREVIEW_REASON } from './grade.js';
import { previewFields } from '../preview-mode.js';

export function runReasoningGrading(database, { plans, panels, now = new Date(), leagueId = null }) {
  if (!reasoningGradingEnabled()) return { enabled: false, reason: PREVIEW_REASON };
  const recorded = recordClaims(database, { plans, panels, now, leagueId });
  const resolved = resolveOpenClaims(database, { now, leagueId });
  return { enabled: true, ...previewFields(PREVIEW_REASON), recorded, resolved, report: gradeC8(database, { leagueId }) };
}
