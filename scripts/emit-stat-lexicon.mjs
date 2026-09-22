/**
 * Write the stat lexicon out as JSON for anything that cannot import the
 * module — the client build, chiefly.
 *
 * ONE GENERATOR. `server/services/coach/stat-names.js` is the list; this
 * script is a printer. The whole point of the lexicon is that a stat has one
 * name everywhere, and a second hand-maintained copy in the client would undo
 * that within a week. So the emitted file says at the top where it came from
 * and that editing it is pointless, and a test in test/coach-stat-names.test.js
 * fails when the checked-in file no longer matches the module.
 *
 *   node scripts/emit-stat-lexicon.mjs            write docs/stat-lexicon.json
 *   node scripts/emit-stat-lexicon.mjs --check    exit 1 if it would change
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { statLexicon } from '../server/services/coach/stat-names.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', 'docs', 'stat-lexicon.json');

const lexicon = statLexicon();
const body = JSON.stringify({
  _generated_by: 'scripts/emit-stat-lexicon.mjs from server/services/coach/stat-names.js',
  _do_not_edit: 'Edit stat-names.js and re-run the script. Edits here are overwritten.',
  concept_count: Object.keys(lexicon.concepts).length,
  field_count: Object.keys(lexicon.fields).length,
  ...lexicon
}, null, 2) + '\n';

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== body) {
    console.error('docs/stat-lexicon.json is stale — run: node scripts/emit-stat-lexicon.mjs');
    process.exit(1);
  }
  console.log(`docs/stat-lexicon.json is current (${Object.keys(lexicon.concepts).length} concepts, ` +
    `${Object.keys(lexicon.fields).length} fields).`);
} else {
  fs.writeFileSync(OUT, body);
  console.log(`wrote docs/stat-lexicon.json — ${Object.keys(lexicon.concepts).length} concepts, ` +
    `${Object.keys(lexicon.fields).length} fields, ${lexicon.not_stored.length} named gaps.`);
}
