export const name = '016_mock_draft_ownership_exemption';

/**
 * A mock draft has no league (`drafts.league_row_id IS NULL`) — it's a personal
 * practice tool, not tied to any real roster. But `lm.league_id = d.league_row_id`
 * can never be true when `d.league_row_id` is NULL (SQL's `NULL = NULL` is not
 * true), so `validate_draft_team_owner_insert`/`_update` rejected every single
 * mock draft's ownership row, unconditionally, since the day they were added —
 * only a live draft tracker, which really does mirror one league's actual
 * draft, is meant to require real membership in it.
 */
export function up(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS validate_draft_team_owner_insert;
    CREATE TRIGGER validate_draft_team_owner_insert
    BEFORE INSERT ON draft_team_ownership BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM drafts d
        WHERE d.id = NEW.draft_id AND NEW.team_slot <= d.team_count
          AND (d.league_row_id IS NULL OR EXISTS (
            SELECT 1 FROM league_memberships lm
            WHERE lm.league_id = d.league_row_id AND lm.user_id = NEW.user_id
          ))
      ) THEN RAISE(ABORT, 'draft owner must be a league member with a valid slot') END;
    END;
    DROP TRIGGER IF EXISTS validate_draft_team_owner_update;
    CREATE TRIGGER validate_draft_team_owner_update
    BEFORE UPDATE OF draft_id, team_slot, user_id ON draft_team_ownership BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM drafts d
        WHERE d.id = NEW.draft_id AND NEW.team_slot > 0 AND NEW.team_slot <= d.team_count
          AND (d.league_row_id IS NULL OR EXISTS (
            SELECT 1 FROM league_memberships lm
            WHERE lm.league_id = d.league_row_id AND lm.user_id = NEW.user_id
          ))
      ) THEN RAISE(ABORT, 'draft owner must be a league member with a valid slot') END;
    END;
  `);
}

export function down(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS validate_draft_team_owner_insert;
    CREATE TRIGGER validate_draft_team_owner_insert
    BEFORE INSERT ON draft_team_ownership BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM drafts d JOIN league_memberships lm
          ON lm.league_id = d.league_row_id AND lm.user_id = NEW.user_id
        WHERE d.id = NEW.draft_id AND NEW.team_slot <= d.team_count
      ) THEN RAISE(ABORT, 'draft owner must be a league member with a valid slot') END;
    END;
    DROP TRIGGER IF EXISTS validate_draft_team_owner_update;
    CREATE TRIGGER validate_draft_team_owner_update
    BEFORE UPDATE OF draft_id, team_slot, user_id ON draft_team_ownership BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM drafts d JOIN league_memberships lm
          ON lm.league_id = d.league_row_id AND lm.user_id = NEW.user_id
        WHERE d.id = NEW.draft_id AND NEW.team_slot > 0 AND NEW.team_slot <= d.team_count
      ) THEN RAISE(ABORT, 'draft owner must be a league member with a valid slot') END;
    END;
  `);
}
