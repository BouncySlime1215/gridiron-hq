export const name = '083_eval_seams';
/**
 * FIX-09: the seams between the EVAL graders (#235/#246) and the tables their
 * writers actually write. ADDITIVE ONLY: two columns on `trade_outcomes`, one
 * new table (plus 079's, if absent), one view, two indexes. Nothing is rewritten or deleted.
 *
 * `trade_outcomes.price_band` — where the offer was priced against the clone's
 *   predicted "yes" point, decided by the producer that priced it: 'below',
 *   'at_point' or 'above'. NULL = not priced against a yes point. E2 grades
 *   sent app_proposed rows that carry one.
 * `trade_outcomes.move_id` — the campaign move this offer is a step of, the
 *   key `campaign_steps` shares. NULL = not part of a campaign.
 *
 * `campaign_steps` — one row per executed campaign step, E5's evidence. The
 *   campaign producer writes the row with `predicted_title_odds_gain` (and its
 *   `predicted_se`) when it consumes the offer.sent event, and fills
 *   `realized_title_odds_gain` / `realized_at` after the step settles accepted
 *   (paired-seed rescoring). Gains are in the unit the producer serves them in.
 *
 * `title_odds_snapshots` — a VIEW, not a table: the weekly title-odds numbers
 *   are already stored once, in `served_numbers` (surface 'title_odds', trigger
 *   'weekly', entity `team:<roster id>`), so a second copy would be a second
 *   producer of the same number. One row per team per weekly snapshot:
 *   title_odds -> p_title, playoff_odds -> p_playoffs. Outcomes come from the
 *   league history tables (064) and are NULL until the season has ended, which
 *   here means BOTH: every team has a final_rank > 0 (ESPN reports
 *   rankCalculatedFinal 0 in season) AND a playoff week has been scored (so a
 *   final_rank that is really the playoff-seed fallback in league-history.js
 *   #saveTeams cannot end a season early).
 *     won_title     = final_rank = 1
 *     made_playoffs = playoff_seed <= the league's playoffTeamCount, read from
 *                     leagues.payload; NULL when the payload does not say.
 *
 * `served_numbers` is created here too, IF NOT EXISTS, with 079's DDL (#243)
 *   column for column. SQLite checks every view on each ALTER TABLE ... RENAME,
 *   so a view over a table that does not exist yet breaks every later rename in
 *   the database ("error in view title_odds_snapshots: no such table"). If this
 *   file lands before #243, 079 then finds the table and only adds its indexes;
 *   if after, this CREATE is the no-op.
 *
 * Numbered 083 by the coordinator: 082 is the follow ledger, 084 offer
 * snapshots (#247).
 */
const COLUMNS = [
  ['price_band', "TEXT CHECK (price_band IN ('below', 'at_point', 'above'))"],
  ['move_id', 'TEXT'],
];
const cols = db => db.prepare('PRAGMA table_info(trade_outcomes)').all().map(c => c.name);

export function up(db) {
  const have = cols(db);
  if (!have.length) throw new Error('083_eval_seams: trade_outcomes (067) does not exist');
  for (const [c, t] of COLUMNS) if (!have.includes(c)) db.exec(`ALTER TABLE trade_outcomes ADD COLUMN ${c} ${t}`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS served_numbers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id INTEGER NOT NULL,
      surface TEXT NOT NULL,
      entity TEXT NOT NULL,
      field TEXT NOT NULL,
      value REAL,
      model TEXT NOT NULL,
      model_version TEXT,
      as_of TEXT,
      served_at TEXT NOT NULL,
      request_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      season INTEGER,
      week INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_trade_outcomes_move
      ON trade_outcomes (league_id, move_id) WHERE move_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS campaign_steps (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id                 INTEGER NOT NULL,
      move_id                   TEXT NOT NULL,
      step_index                INTEGER NOT NULL CHECK (step_index >= 0),
      trade_outcome_id          INTEGER REFERENCES trade_outcomes (id),
      predicted_title_odds_gain REAL NOT NULL,
      predicted_se              REAL CHECK (predicted_se IS NULL OR predicted_se >= 0),
      realized_title_odds_gain  REAL,
      realized_at               TEXT,
      created_at                TEXT NOT NULL,
      CHECK ((realized_title_odds_gain IS NULL) = (realized_at IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_steps_identity
      ON campaign_steps (league_id, move_id, step_index);

    CREATE VIEW IF NOT EXISTS title_odds_snapshots AS
    WITH snaps AS (
      SELECT league_id, season, week, SUBSTR(entity, 6) AS team_id, request_id,
             MIN(served_at) AS served_at, MAX(as_of) AS as_of,
             MAX(CASE WHEN field = 'title_odds' THEN value END) AS p_title,
             MAX(CASE WHEN field = 'playoff_odds' THEN value END) AS p_playoffs
        FROM served_numbers
       WHERE surface = 'title_odds' AND trigger = 'weekly' AND entity LIKE 'team:%'
         AND field IN ('title_odds', 'playoff_odds')
         AND season IS NOT NULL AND week IS NOT NULL
       GROUP BY league_id, season, week, entity, request_id
    ),
    ended AS (
      SELECT t.league_id, t.season
        FROM league_season_teams t
       GROUP BY t.league_id, t.season
      HAVING MIN(COALESCE(t.final_rank, 0)) > 0
    ),
    finished AS (
      SELECT e.league_id, e.season FROM ended e
       WHERE EXISTS (SELECT 1 FROM league_week_scores w
                      WHERE w.league_id = e.league_id AND w.season = e.season AND w.is_playoff = 1)
    ),
    playoff_spots AS (
      SELECT id AS league_id,
             CAST(json_extract(payload, '$.settings.scheduleSettings.playoffTeamCount') AS INTEGER) AS n
        FROM leagues WHERE json_valid(payload)
    )
    SELECT s.league_id, s.season, s.team_id, s.week, s.p_title, s.p_playoffs,
           s.served_at, s.as_of, s.request_id,
           CASE WHEN f.league_id IS NULL OR t.playoff_seed IS NULL OR ps.n IS NULL THEN NULL
                WHEN t.playoff_seed <= ps.n THEN 1 ELSE 0 END AS made_playoffs,
           CASE WHEN f.league_id IS NULL OR t.final_rank IS NULL THEN NULL
                WHEN t.final_rank = 1 THEN 1 ELSE 0 END AS won_title
      FROM snaps s
      LEFT JOIN league_season_teams t
        ON t.league_id = s.league_id AND t.season = s.season AND t.roster_id = s.team_id
      LEFT JOIN finished f ON f.league_id = s.league_id AND f.season = s.season
      LEFT JOIN playoff_spots ps ON ps.league_id = s.league_id;
  `);
}

/**
 * Rolls 083 back only while nothing it added holds evidence: a campaign step
 * or a price band is a record of what was predicted at the moment an offer
 * went out, and cannot be recomputed later (the same refusal 071 and 081 make).
 */
export function down(db) {
  const steps = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'campaign_steps'`).get()
    ? db.prepare('SELECT COUNT(*) AS n FROM campaign_steps').get().n : 0;
  if (steps) {
    throw new Error(`rollback refused: ${steps} campaign_steps row(s) record predicted and realized step value. `
      + 'Restore the pre-migration snapshot instead.');
  }
  const have = cols(db);
  const banded = have.includes('price_band')
    ? db.prepare(`SELECT COUNT(*) AS n FROM trade_outcomes WHERE price_band IS NOT NULL OR move_id IS NOT NULL`).get().n : 0;
  if (banded) {
    throw new Error(`rollback refused: ${banded} trade_outcomes row(s) carry a price_band or move_id. `
      + 'Restore the pre-migration snapshot instead.');
  }
  // served_numbers is left in place: it is 079's table (#243) whichever file
  // created it, and rolling 083 back must not delete served numbers.
  db.exec(`
    DROP VIEW IF EXISTS title_odds_snapshots;
    DROP INDEX IF EXISTS idx_campaign_steps_identity;
    DROP TABLE IF EXISTS campaign_steps;
    DROP INDEX IF EXISTS idx_trade_outcomes_move;
  `);
  for (const [c] of [...COLUMNS].reverse()) if (have.includes(c)) db.exec(`ALTER TABLE trade_outcomes DROP COLUMN ${c}`);
}
