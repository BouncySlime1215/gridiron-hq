/**
 * ESPN injury statuses under which ESPN is saying "he plays, or is about to".
 * Dependency-free so non-server tooling (scripts/rnd/espn-flip-timing-analysis.mjs) can
 * share the app's one availability definition without opening the database.
 * Owner: server/services/player-availability.js (the canonical availability producer).
 */
export const ESPN_AVAILABLE = new Set(['ACTIVE', 'NORMAL', 'QUESTIONABLE', 'DOUBTFUL', 'PROBABLE', 'DAY_TO_DAY']);
