export const name = '011_espn_credential_health';

export function up(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(leagues)').all().map(column => column.name));
  const additions = [
    ['espn_connection_state', "TEXT NOT NULL DEFAULT 'disconnected'"],
    ['espn_validated_at', 'TEXT'],
    ['espn_last_sync_at', 'TEXT'],
    ['espn_account_fingerprint', 'TEXT']
  ];
  for (const [column, type] of additions) {
    if (!columns.has(column)) db.exec(`ALTER TABLE leagues ADD COLUMN ${column} ${type}`);
  }
  db.exec(`UPDATE leagues SET espn_connection_state='connected'
    WHERE platform='espn' AND espn_s2 IS NOT NULL AND swid IS NOT NULL`);
}

export function down(db) {
  db.exec(`ALTER TABLE leagues DROP COLUMN espn_account_fingerprint;
    ALTER TABLE leagues DROP COLUMN espn_last_sync_at;
    ALTER TABLE leagues DROP COLUMN espn_validated_at;
    ALTER TABLE leagues DROP COLUMN espn_connection_state;`);
}
