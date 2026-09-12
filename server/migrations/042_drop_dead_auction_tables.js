export const name = '042_drop_dead_auction_tables';

/**
 * Drops two dead tables.
 *
 * `auction_sales` and `auction_settings` have zero readers and zero writers
 * anywhere in server/, client/ or scripts/ (confirmed by grep across all three
 * ahead of this migration). Nothing in this codebase creates them, joins them,
 * or reads from them — they are leftover schema with no code path attached.
 *
 * down() is intentionally empty: the tables carry no data worth restoring (a
 * dropped empty table has nothing to reconstruct), and recreating dead schema
 * on rollback would just reintroduce the same zero-reader tables this
 * migration exists to remove.
 */

export function up(db) {
  db.exec(`
    DROP TABLE IF EXISTS auction_sales;
    DROP TABLE IF EXISTS auction_settings;
  `);
}

export function down(db) {}
