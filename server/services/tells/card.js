/**
 * TELLS-01b: the one response the Trade Brain tells card reads.
 *
 * Default OFF. On with GRIDIRON_TELLS_CARD=1 (the ship switch, flipped only
 * once E1 passes for the clone on league offers), or locally with preview mode
 * (previewUnconfirmed()), in which case the response is labelled a preview.
 *
 * The card and its grade are computed from the same loaded context, so the
 * weights and the E1 row the page shows are the ones that were graded.
 */
import { loadCloneContext, gradeClone, tellsCard } from './clone-features.js';
import { previewUnconfirmed, previewFields } from '../preview-mode.js';

export const TELLS_CARD_FLAG = 'GRIDIRON_TELLS_CARD';
export const OFF_REASON = 'TELLS-01b tells card is default-off: the clone features have not passed E1 (log loss vs activity-only) on league offers';

export function tellsCardResponse(database, leagueId, { now = new Date() } = {}) {
  const flagOn = process.env[TELLS_CARD_FLAG] === '1';
  const preview = !flagOn && previewUnconfirmed();
  if (!flagOn && !preview) return { enabled: false, reason: OFF_REASON, flag: TELLS_CARD_FLAG };
  const ctx = loadCloneContext(database);
  const grade = gradeClone(ctx.offers, ctx, { leagueId, excluded: ctx.excluded, sources: ctx.sources, reason: ctx.reason });
  const card = tellsCard(ctx, { leagueId, asOf: now.toISOString(), grade });
  return { enabled: true, ...(preview ? previewFields(OFF_REASON) : {}), card, grade };
}
