/**
 * Provenance guard for the evidence generators under scripts/.
 *
 * These scripts read real tables, compute statistics over what they find, and
 * write a JSON report that later work cites as measurement. The failure they
 * share is that neither step notices when the read came back empty: constants
 * in the source, or fallbacks a few lines down, carry the pipeline to a
 * finished-looking artifact. `run-purged-evaluation.mjs` did exactly that with
 * two hardcoded bet-ledger rows; `run-historical-leaderboard.mjs` avoided it
 * only by throwing an unnamed TypeError out of a reduce, and not in every case.
 *
 * So a generator declares the sources it read, with counts, and which of them
 * must be non-empty for the report to mean anything. The counts are stamped
 * into the artifact; the required ones are checked before anything is created
 * on disk.
 *
 * WHAT IS REQUIRED, AND WHAT IS ONLY RECORDED. Require a source whose
 * emptiness would otherwise be INVISIBLE in the finished report -- the registry
 * read behind a Sharpe cross-section, the audit_registry read a leaderboard
 * exists to widen. Only record a source whose zero already shows on the face of
 * the report, and only record a count that is a constant in the first place: a
 * constant is disclosed, never required, because a guard that fires on a
 * correct run is a guard somebody deletes.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Thrown instead of writing. Carries `emptySources` so a caller can react to
 * which source failed rather than parsing the message.
 */
export class EmptyEvidenceSourceError extends Error {
  constructor(emptySources, sources, what) {
    super(
      `${what ?? 'This evidence report'} was not written: `
      + `${emptySources.length} required source(s) came back empty `
      + `-- ${emptySources.join(', ')}. `
      + `All declared sources: ${JSON.stringify(sources)}. `
      + 'The statistics in this run would have come from constants and '
      + 'fallbacks rather than from the data.',
    );
    this.name = 'EmptyEvidenceSourceError';
    this.emptySources = emptySources;
    this.sources = sources;
  }
}

const isRealCount = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Throw unless every key in `required` names a source with a finite count > 0.
 *
 * Absent counts as empty on purpose. A key that was renamed, or never wired
 * up, reads as `undefined`; treating that as "not checked, therefore fine" is
 * how the silent version of this defect comes back.
 *
 * Every empty source is named, not the first: reporting them one per run turns
 * one broken run into as many runs as there are empty sources.
 */
export function assertEvidenceSources(sources, required = [], what) {
  const empty = required.filter(k => !isRealCount(sources?.[k]));
  if (empty.length) throw new EmptyEvidenceSourceError(empty, sources ?? {}, what);
}

/**
 * `--out <dir>`, so a generator can be exercised without overwriting the
 * committed evidence it is meant to be checked against. A hardcoded output
 * path is the reason these two had never been run under test.
 *
 * A relative value resolves against `base` (the repo root), not the cwd, so
 * the same argument means the same directory from anywhere. `--out` with no
 * value, or followed by another flag, is a missing value and falls back --
 * never a directory literally named `--verbose`.
 */
export function resolveOutDir(argv, fallbackDir, base = process.cwd()) {
  const i = argv.indexOf('--out');
  const next = i === -1 ? null : argv[i + 1];
  return next && !next.startsWith('--') ? path.resolve(base, next) : fallbackDir;
}

/**
 * The only way a report should leave a generator.
 *
 * The assertion runs before the mkdir and before the write. A guard that
 * throws afterwards has already published the artifact it was guarding, and
 * leaves a directory behind saying a run happened.
 *
 * `sources` is stamped at `registry_summary.sources` -- inside the section both
 * of these reports already use for "what this run was built from" -- and merged
 * so nothing already there is displaced. Nothing else in the report is touched.
 */
export function writeEvidenceReport({ outDir, filename, report, sources, required = [] }) {
  assertEvidenceSources(sources, required, path.join(outDir, filename));

  const stamped = {
    ...report,
    registry_summary: { ...(report?.registry_summary ?? {}), sources },
  };
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, filename);
  fs.writeFileSync(file, JSON.stringify(stamped, null, 2));
  return { file, report: stamped };
}
