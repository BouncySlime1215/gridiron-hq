/**
 * The migration-name rules, as a function rather than a script step, so they
 * can be exercised against a directory built to break each one. A rule that
 * only ever runs against the real `server/migrations` is a rule nobody can
 * show failing, which is the shape this repository keeps finding.
 *
 * `scripts/lint.mjs` calls this and decides what to do with the result; the
 * decision to exit belongs to the script, not to the check.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Migrations are identified by their `name` export, not by their number, and
 * nothing else in this repository checks that those names behave. Two of the
 * three failures below are silent — they produce a clean boot and a database
 * that is missing a change, or a schema change with no backup behind it — so
 * they cannot be caught by a test that exercises the runner. They can only be
 * caught here, at the moment the file is written. See server/migrations/README.md.
 *
 * Returns { problems, checked }; it never exits.
 */
export function migrationNameProblems(dir = path.join('server', 'migrations')) {
  const entries = fs.readdirSync(dir).filter(f => /^\d+_.+\.js$/.test(f)).sort();
  const byName = new Map();
  const byPrefix = new Map();
  const problems = [];

  for (const file of entries) {
    const basename = file.replace(/\.js$/, '');
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    const declared = /^export const name = (['"`])(.*?)\1;?$/m.exec(source);

    // `server/db/migrate.js` uses `mod.name ?? basename`, so a file with no
    // name export is fine and takes its filename. A name export this regex
    // cannot read is NOT fine: the guard would be inspecting something other
    // than the string the runner uses.
    if (!declared && /^export\s+(?:const|let|var)\s+name\b/m.test(source)) {
      problems.push(`${file}: exports \`name\` in a form this check cannot read. `
        + 'Write it as a single line: export const name = \'<basename>\';');
      continue;
    }
    const effective = declared ? declared[2] : basename;

    // A mismatch is the dangerous one, and it is dangerous in one direction.
    // migrate.js counts pending migrations by FILENAME and that count is what
    // decides whether backupBeforeMigration takes a VACUUM INTO snapshot,
    // while the apply-once guard keys on the NAME. A file whose basename is
    // already recorded but whose name is not therefore runs up() against the
    // live database with no snapshot taken and nothing in the output saying so.
    if (effective !== basename) {
      problems.push(`${file}: exports name '${effective}' but its filename says '${basename}'. `
        + 'They must match — see "The half-rename is the quiet one" in '
        + 'server/migrations/README.md.');
    }

    // Two files sharing a name means the second is recorded as applied and
    // skipped, with no error anywhere and nothing in schema_migrations to show
    // it was passed over. Easiest to hit by copying a migration as a template.
    if (byName.has(effective)) {
      problems.push(`${file}: name '${effective}' is already used by ${byName.get(effective)}. `
        + 'The second one would be silently skipped.');
    } else byName.set(effective, file);

    const prefix = file.slice(0, file.indexOf('_'));
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), file]);
  }

  // Duplicate numbers are cosmetic — the runner never reads them — but they
  // cost a reader the ability to tell what ran before what, so new ones are
  // rejected. The exception is a number the September 2026 release train
  // already landed twice: those files have run against the live database, and
  // renaming an applied migration re-runs it (README, rule 1). They are
  // permanent, and 062 has a third claimant still in flight.
  const LANDED_DUPLICATE_PREFIXES = new Set(['062']);
  for (const [prefix, group] of byPrefix) {
    if (group.length > 1 && !LANDED_DUPLICATE_PREFIXES.has(prefix)) {
      problems.push(`migration number ${prefix} is used by ${group.join(', ')}. `
        + 'Pick an unused number — do not renumber an existing file.');
    }
  }

  return { problems, checked: entries.length };
}
