/**
 * Copy shared across the app.
 *
 * `NOT_PROVEN_MESSAGE` used to live in the betting pages, which were removed
 * with the rest of the betting UI (the models behind them are untouched and
 * still run). The page-explain assistant is mounted app-wide and still needs
 * it, so it lives here rather than in a deleted folder.
 */
export const NOT_PROVEN_MESSAGE =
  "This model hasn't beaten the real betting lines yet, so no real money is at risk — everything below is practice, tracked so we'll know the moment that changes.";
