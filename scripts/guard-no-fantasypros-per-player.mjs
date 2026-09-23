/**
 * NICK-FP guard: no committed evidence file may carry per-player FantasyPros ranks or
 * projections. HX-01's method, scripts and our own aggregate accuracy numbers stay; a real
 * FantasyPros export (one row per player, an id/name column next to an ecr/rank column) does
 * not. The scripts already read that export only from `.local-db/` (git-excluded,
 * scripts/historical-consensus-head-to-head.mjs:121); this guard makes sure a future commit
 * cannot put a copy of it, or a table shaped like it, into docs/evidence or docs/tdd.
 *
 * Three shapes count as a violation:
 *   1. A FantasyPros-shaped raw export file (.csv/.tsv/.parquet) under a scanned directory.
 *   2. A delimited header (pipe, comma or tab) naming a player-identity column and a FantasyPros
 *      rank/projection column (see isPerPlayerFantasyProsHeader), followed by 3+ data rows (a
 *      real table, not one worked example or a mention in prose). Markdown separators skipped.
 *   3. In a .json file, any array of 3+ objects whose keys form that same header.
 *
 * Nick 2026-09-23 (NICK-FP, WORK-QUEUE.md §12): "NO FantasyPros-derived per-player data in the
 * public repo."
 */
import fs from 'node:fs';
import path from 'node:path';

const RAW_EXPORT_EXTENSION = /\.(csv|tsv|parquet)$/i;
const FANTASYPROS_HINT = /fantasypros|fp[-_]?ecr|\becr\b/i;
const DATA_ROW_THRESHOLD = 3;
const LOOKAHEAD_LINES = 30;

// Column-name classes, matched against one normalised column name (lower-case, spaces -> _).
// A per-player FantasyPros table needs a player-identity column AND a FantasyPros rank or
// projection column. `id` alone counts as identity because the real export HX-01 reads
// (.local-db/fp-ecr-weekly-wp.csv) has the header page_type,scrape_date,id,player,pos,team,ecr.
const FP_ID_COLUMN = /^(fantasypros_id|fp_id|fpid)$/;
const IDENTITY_COLUMN = /^(id|player|player_name|name|full_name|gsis_id|player_id|fantasypros_id|fp_id|fpid)$/;
// ecr is FantasyPros' own term, so it counts on its own. Generic rank/projection columns
// (rk, rank, fpts, proj...) only count when the header also has a FantasyPros id column, or the
// site's own best/worst columns, so our own ranked tables are not flagged.
const FP_RANK_COLUMN = /^(ecr|fp_ecr|fp_rank|fantasypros_rank|fantasypros_ecr)$/;
const GENERIC_RANK_OR_PROJECTION_COLUMN = /^(rk|rank|avg|fpts|proj|projection|projected_points|proj_pts)$/;

const normaliseColumn = c => String(c).trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/^["'`*]+|["'`*]+$/g, '');

/** True when a list of column names is shaped like a per-player FantasyPros ranks/projections table. */
export function isPerPlayerFantasyProsHeader(columns) {
  const cols = columns.map(normaliseColumn).filter(Boolean);
  if (!cols.some(c => IDENTITY_COLUMN.test(c))) return false;
  if (cols.some(c => FP_RANK_COLUMN.test(c))) return true;
  const fpContext = cols.some(c => FP_ID_COLUMN.test(c)) || (cols.includes('best') && cols.includes('worst'));
  return fpContext && cols.some(c => GENERIC_RANK_OR_PROJECTION_COLUMN.test(c));
}

const splitRow = line => {
  const delimiter = line.includes('|') ? '|' : line.includes('\t') ? '\t' : ',';
  return line.split(delimiter).map(c => c.trim()).filter(Boolean);
};
const isMarkdownSeparator = line => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

/** Every array (at any depth) of 3+ objects whose shared keys form a per-player FantasyPros header. */
function jsonViolations(value, relPath, trail = '$') {
  const out = [];
  if (Array.isArray(value)) {
    const objects = value.filter(v => v && typeof v === 'object' && !Array.isArray(v));
    if (objects.length >= DATA_ROW_THRESHOLD && isPerPlayerFantasyProsHeader(Object.keys(objects[0]))) {
      out.push({ file: relPath, line: 1, reason: `JSON array ${trail} holds ${objects.length} per-player FantasyPros rows (keys: ${Object.keys(objects[0]).join(',')})` });
      return out;
    }
    value.forEach((v, k) => out.push(...jsonViolations(v, relPath, `${trail}[${k}]`)));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) out.push(...jsonViolations(v, relPath, `${trail}.${k}`));
  }
  return out;
}

/** Scan one file's already-read text content. `relPath` is used only for reporting. */
export function scanForPerPlayerFantasyPros(content, relPath) {
  const violations = [];
  const lines = content.split('\n');

  // A raw export extension is only a violation when it is actually FantasyPros-shaped (by name
  // or by header): plenty of unrelated .csv/.tsv files live under docs/evidence (health logs,
  // etc.) and are not this guard's business.
  if (RAW_EXPORT_EXTENSION.test(relPath) && (FANTASYPROS_HINT.test(relPath) || isPerPlayerFantasyProsHeader(splitRow(lines[0] || '')) || FANTASYPROS_HINT.test(lines[0] || ''))) {
    violations.push({ file: relPath, line: 1, reason: 'raw FantasyPros-shaped export file extension under a scanned evidence directory' });
    return violations;
  }

  if (/\.json$/i.test(relPath)) {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      // Not valid JSON (e.g. JSONL): fall through to the line scan below, which still sees
      // delimited tables; report nothing extra here.
      parsed = undefined;
      if (!(err instanceof SyntaxError)) throw err;
    }
    if (parsed !== undefined) violations.push(...jsonViolations(parsed, relPath));
  }

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i];
    if (!/[|,\t]/.test(header)) continue;
    const headerColumns = splitRow(header);
    if (!isPerPlayerFantasyProsHeader(headerColumns)) continue;

    let dataRows = 0;
    for (let j = i + 1; j < Math.min(lines.length, i + 1 + LOOKAHEAD_LINES); j++) {
      const row = lines[j];
      if (!row.trim()) { if (dataRows) break; continue; }
      if (isMarkdownSeparator(row)) continue;
      const rowCols = splitRow(row);
      const looksLikeData = rowCols.length >= Math.max(2, headerColumns.length - 1) && /\d/.test(row);
      if (looksLikeData) { dataRows++; continue; }
      break;
    }

    if (dataRows >= DATA_ROW_THRESHOLD) {
      violations.push({
        file: relPath,
        line: i + 1,
        reason: `header names a player-identity column and a FantasyPros rank/projection column, followed by ${dataRows} data rows`
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
