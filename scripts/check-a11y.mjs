#!/usr/bin/env node
/**
 * Accessibility check (plan item 58, ACCESSIBILITY PASS). One command, three parts:
 *   1. contrast   design tokens, light and dark, WCAG AA (scripts/a11y/contrast.mjs);
 *   2. scan       every client TSX file: icon-only controls without a name, click-only elements,
 *                 <img> without alt, positive tabIndex, unlabeled form controls (scan-jsx.mjs);
 *   3. structure  keyboard path through the seven areas: skip link, nav, rail names, inert drawer,
 *                 Tabs arrow keys, Sheet focus (structure.mjs).
 *
 * Flag GRIDIRON_A11Y_CHECK: off | report (default) | enforce. CI sets enforce, which exits 1 on
 * any contrast failure, any structure gap, or any scan finding in a file this repo's threads may
 * edit. Files local builders own (Trades client, War Room, Coach drawer, Numbers & People, AI
 * spend) are scanned and listed but never fail the gate (scan-jsx.mjs PROTECTED).
 *
 * Usage: node scripts/check-a11y.mjs [--json] [--root <dir>]
 * Exit: 0 pass or report mode, 1 enforce and failing, 3 bad flag value.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkContrast } from './a11y/contrast.mjs';
import { scanSource, isProtected } from './a11y/scan-jsx.mjs';
import { checkStructure } from './a11y/structure.mjs';

export const MODES = Object.freeze(['off', 'report', 'enforce']);

export function readMode(env = process.env) {
  const v = (env.GRIDIRON_A11Y_CHECK ?? 'report').trim().toLowerCase();
  if (!MODES.includes(v)) throw new Error(`GRIDIRON_A11Y_CHECK must be one of ${MODES.join(', ')} (got "${v}")`);
  return v;
}

function listTsx(root, dir) {
  const out = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.tsx')) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(path.join(root, dir));
  return out.sort();
}

export function runA11y(root) {
  const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
  const contrast = checkContrast(read('client/src/styles/tokens.css'));
  const files = listTsx(root, 'client/src');
  const findings = files.flatMap(f => scanSource(read(f), f)).map(x => ({ ...x, protected: isProtected(x.file) }));
  const structure = checkStructure(read);
  const enforced = findings.filter(x => !x.protected);
  return {
    files: files.length,
    contrast, structure, findings,
    enforced,
    reportOnly: findings.filter(x => x.protected),
    pass: contrast.failures.length === 0 && structure.length === 0 && enforced.length === 0,
  };
}

function print(r, mode) {
  const lines = [`Accessibility check (${mode}): ${r.pass ? 'PASS' : 'FAIL'}`];
  lines.push(`  contrast: ${r.contrast.rows.length} pairs, ${r.contrast.failures.length} below AA`);
  for (const f of r.contrast.failures) lines.push(`    ${f.theme} ${f.fg} on ${f.bg}: ${f.ratio}:1 (needs ${f.min}:1)`);
  lines.push(`  structure: ${r.structure.length} gap(s)`);
  for (const s of r.structure) lines.push(`    ${s.rule}: ${s.detail}`);
  lines.push(`  scan: ${r.files} files, ${r.enforced.length} finding(s) enforced, ${r.reportOnly.length} report-only (locally owned files)`);
  for (const f of [...r.enforced, ...r.reportOnly]) lines.push(`    ${f.protected ? '[report] ' : ''}${f.rule} ${f.file}:${f.line} ${f.detail}`);
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let mode;
  try { mode = readMode(); } catch (e) { console.error(e.message); process.exit(3); }
  if (mode === 'off') { console.log('Accessibility check: off (GRIDIRON_A11Y_CHECK=off)'); process.exit(0); }
  const args = process.argv.slice(2);
  const rootAt = args.indexOf('--root');
  const root = rootAt >= 0 ? path.resolve(args[rootAt + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const r = runA11y(root);
  console.log(args.includes('--json') ? JSON.stringify({ mode, ...r }, null, 2) : print(r, mode));
  process.exit(mode === 'enforce' && !r.pass ? 1 : 0);
}
