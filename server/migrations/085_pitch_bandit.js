export const name = '085_pitch_bandit';
/**
 * M5, the pitch bandit: one new table, additive only.
 *
 * `pitch_choices` is the log of every framing the bandit picked: which arm,
 * the posterior it sampled from, the samples themselves, which arms cleared
 * the floor, and why. A choice is made when the campaign producer drafts a
 * message, before anything is sent, so most rows never become an offer. The
 * one that does is linked by "I sent this" (`recordSentOffer`), and only a
 * linked choice whose offer has settled moves the posterior.
 *
 * WHY NOT `trade_outcomes.pitch_json`. The CLONE-01b spec puts that column in
 * the b2 migration. Adding it here would make b2's ADD COLUMN fail, and one
 * offer can carry many logged choices before it is sent. The link goes the
 * other way: `outcome_id` points at the offer, and the partial unique index
 * keeps it to one choice per offer.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pitch_choices (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id             INTEGER NOT NULL,
      season                INTEGER NOT NULL,
      counterparty_team_id  TEXT NOT NULL,
      idea_id               TEXT,
      arm                   TEXT NOT NULL
        CHECK (arm IN ('need_first', 'fairness_first', 'urgency_first', 'face_safe_short')),
      prior_basis           TEXT NOT NULL,
      samples_json          TEXT NOT NULL,
      posterior_json        TEXT NOT NULL,
      eligible_json         TEXT NOT NULL,
      floor                 REAL NOT NULL,
      reason                TEXT NOT NULL,
      chosen_at             TEXT NOT NULL,
      outcome_id            INTEGER REFERENCES trade_outcomes(id),
      linked_at             TEXT
    )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pitch_choices_manager
             ON pitch_choices(league_id, season, counterparty_team_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pitch_choices_idea
             ON pitch_choices(league_id, season, idea_id)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pitch_choices_outcome
             ON pitch_choices(outcome_id) WHERE outcome_id IS NOT NULL`);
}

export function down(db) {
  db.exec('DROP TABLE IF EXISTS pitch_choices');
}
