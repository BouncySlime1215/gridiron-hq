import { rollbackMigration } from '../server/db/migrate.js';
import { db } from '../server/db/index.js';

try {
  const expected = process.argv[2] ?? null;
  const rolledBack = await rollbackMigration(expected);
  console.log(rolledBack ? `Rolled back: ${rolledBack}` : 'No applied migrations.');
} finally {
  db.close();
}
