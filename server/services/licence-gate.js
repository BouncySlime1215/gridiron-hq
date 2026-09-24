/**
 * Licence gate for bulk external-data loads (standing rule 10: read the licence
 * before measuring any new external data).
 *
 * The decision is written by a person into a committed evidence file, one line
 * per source:
 *
 *   - decision: <source> usable (<why>)
 *   - decision: <source> blocked (<why>)
 *
 * A loader asks `licenceDecision(source)` before it opens a database or reads a
 * byte of data. A missing file, a source the file does not name, or any word
 * other than `usable` is a refusal. There is no default-allow.
 *
 * GRIDIRON_LICENCE_FILE overrides the path so tests can point at a file that
 * does not exist.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_LICENCE_FILE = path.join(ROOT, 'docs', 'evidence', '2026-09-23', 'proj-00-licences.md');

export function licenceFile() {
  return process.env.GRIDIRON_LICENCE_FILE || DEFAULT_LICENCE_FILE;
}

/** { usable, source, line, reason } for one source name. */
export function licenceDecision(source, { file = licenceFile() } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { usable: false, source, line: null,
        reason: `licence file missing: ${file}. Read and commit the source's licence before any pull.` };
    }
    throw error;
  }
  const line = text.split('\n').map(l => l.trim())
    .find(l => l.startsWith(`- decision: ${source} `));
  if (!line) return { usable: false, source, line: null, reason: `licence file ${file} has no decision for ${source}` };
  const verdict = line.slice(`- decision: ${source} `.length).split(/\s+/)[0];
  return verdict === 'usable'
    ? { usable: true, source, line, reason: line }
    : { usable: false, source, line, reason: `licence decision for ${source} is ${verdict}: ${line}` };
}
