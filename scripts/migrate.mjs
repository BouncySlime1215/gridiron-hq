import { runMigrations } from '../server/db/migrate.js';
import { db } from '../server/db/index.js';

try {
  const applied = await runMigrations();
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length) throw new Error(`foreign-key violations: ${JSON.stringify(violations)}`);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database already current.');
} finally {
  db.close();
}
