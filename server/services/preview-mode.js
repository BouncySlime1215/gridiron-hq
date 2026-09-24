/**
 * PREVIEW-01: the one local-testing switch for built-but-default-off features.
 *
 * GRIDIRON_PREVIEW_UNCONFIRMED=1 turns ON every default-off, "unconfirmed forward"
 * feature at once so Nick can try them on his local server. This module is the only
 * reader of that variable (test/preview-mode.test.js greps server/ and scripts/ for
 * it). Without it set, every converted site behaves exactly as it did before.
 *
 * It never changes a production default: fly.toml does not set it, and each site
 * keeps its own flag (or code constant) as the real ship switch. When a feature is on
 * only because of preview mode, its response carries `preview: true` and
 * `preview_reason` (the site's existing default-off / unconfirmed-forward reason), and
 * any sentence a page already prints is prefixed "Preview (unconfirmed forward)".
 *
 * Converted sites (read per call, so a test or a run can flip it):
 *   - counterparty-pricing.js#counterpartyLayer  activity + checked-out receptiveness terms
 *   - espn-zero-inactive.js#espnZeroInactive      ESPN-projects-0 inactive hook (lineup + card)
 *   - streaming-board.js#streamingBoard          D/ST swap suggestion (dormant: on by default
 *                                                since NICK-WV01, so preview never switches it)
 *   - waiver-wire.js#waiverBoard                 snap-share order for same-team replacements
 *   - trade-acceptance.js#cloneMode              CLONE-01b b2 manager clones + veto (GRIDIRON_CLONE_V2)
 * Not converted, with the reason, in docs/tdd/2026-09-23-preview-01-preview-unconfirmed.tdd.md.
 */
export const PREVIEW_ENV = 'GRIDIRON_PREVIEW_UNCONFIRMED';
export const PREVIEW_PREFIX = 'Preview (unconfirmed forward)';

/** True only when the local-testing switch is set to exactly '1'. */
export const previewUnconfirmed = () => process.env[PREVIEW_ENV] === '1';

/** The fields a response carries when a feature is on only because of preview mode. */
export const previewFields = reason => ({ preview: true, preview_reason: reason });

/** A sentence a page already prints, labelled so the page shows it is a preview. */
export const previewText = text => `${PREVIEW_PREFIX}: ${text}`;
