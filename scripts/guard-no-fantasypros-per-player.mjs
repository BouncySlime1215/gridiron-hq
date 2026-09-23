/**
 * NICK-FP guard: no committed evidence file may carry per-player FantasyPros ranks or
 * projections. HX-01's method, scripts and our own aggregate accuracy numbers stay; a real
 * FantasyPros export (one row per player, an id/name column next to an ecr/rank column) does
 * not. The scripts already read that export only from `.local-db/` (git-excluded,
 * scripts/historical-consensus-head-to-head.mjs:121); this guard makes sure a future commit
 * cannot put a copy of it, or a table shaped like it, into docs/evidence or docs/tdd.
 *
 * Two shapes count as a violation:
 *   1. A raw export file extension (.csv/.tsv/.parquet) committed under a scanned directory.
 *   2. A header-shaped line naming both a FantasyPros id/name column and an ecr/rank column,
 *      immediately followed by 3+ rows that parse as data under that header (a real table, not
 *      one worked example or a mention in prose).
 *
 * Nick 2026-09-23 (NICK-FP, WORK-QUEUE.md §12): "NO FantasyPros-derived per-player data in the
 * public repo."
 */
import fs from 'node:fs';
import path from 'node:path';

const RAW_EXPORT_EXTENSION = /\.(csv|tsv|parquet)$/i;
const FANTASYPROS_HINT = /fantasypros|fp[-_]?ecr|\becr\b/i;
const ID_COLUMN = /\b(fantasypros_id|fp_id|fpid)\b/i;
const RANK_COLUMN = /\becr\b|\bfp_?rank\b/i;
const DATA_ROW_THRESHOLD = 3;
const LOOKAHEAD_LINES = 30;

/** Scan one file's already-read text content. `relPath` is used only for reporting. */
export function scanForPerPlayerFantasyPros(content, relPath) {
  const violations = [];

  // A raw export extension is only a violation when it is actually FantasyPros-shaped (by name
  // or by content): plenty of unrelated .csv/.tsv files live under docs/evidence (health logs,
  // etc.) and are not this guard's business.
  if (RAW_EXPORT_EXTENSION.test(relPath) && (FANTASYPROS_HINT.test(relPath) || ID_COLUMN.test(content) || RANK_COLUMN.test(content))) {
    violations.push({ file: relPath, line: 1, reason: 'raw FantasyPros-shaped export file extension under a scanned evidence directory' });
    return violations;
  }

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i];
    if (!ID_COLUMN.test(header) || !RANK_COLUMN.test(header) || !/[|,]/.test(header)) continue;

    const headerCols = header.split(/[|,]/).map(c => c.trim()).filter(Boolean).length;
    let dataRows = 0;
    for (let j = i + 1; j < Math.min(lines.length, i + 1 + LOOKAHEAD_LINES); j++) {
      const row = lines[j];
      if (!row.trim()) continue;
      const rowCols = row.split(/[|,]/).map(c => c.trim()).filter(Boolean);
      const looksLikeData = rowCols.length >= Math.max(2, headerCols - 1) && /\d/.test(row);
      if (looksLikeData) { dataRows++; continue; }
      break;
    }

    if (dataRows >= DATA_ROW_THRESHOLD) {
      violations.push({
        file: relPath,
        line: i + 1,
        reason: `header names both a FantasyPros id column and a rank/ecr column, followed by ${dataRows} data rows`
      });
    }
  }
  return violations;
}

function* walk(dir, root) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(abs, root);
    else yield path.relative(root, abs);
  }
}

/** Scan every file under each of `dirs` (relative to `root`) that exists. */
export function scanTree(root, dirs) {
  const violations = [];
  for (const dir of dirs) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const rel of walk(abs, root)) {
      const content = fs.readFileSync(path.join(root, rel), 'utf8');
      violations.push(...scanForPerPlayerFantasyPros(content, rel));
    }
  }
  return violations;
}

export const GUARDED_DIRECTORIES = Object.freeze(['docs/evidence', 'docs/tdd']);
