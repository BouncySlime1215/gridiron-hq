#!/usr/bin/env node
/**
 * CLEANUP tracking report (plan item 20).
 *
 * For each open PR: has main already made it obsolete? Read-only. It reads git and
 * a PR list you give it; it never closes, comments on or pushes to anything. The
 * output is the table that goes in the tracking PR body, and a human closes PRs.
 *
 * Content check, per head (classifyContent), strongest first:
 *   1. ancestor  - the head is an ancestor of main: merged as-is.
 *   2. patch     - `git cherry`: every commit has a patch-equivalent on main.
 *   3. content   - the head's net change (merge-base..head) reverse-applies on
 *                  main's tree: main already holds it (squash merges land here).
 * Anything else is `unique`, listing the touched files whose content on the head
 * differs from main. A branch squash-merged and then rewritten on main comes out
 * unique; the check errs toward keeping.
 *
 * Action, per PR (buildReport):
 *   keep  - on the keep list (locally owned, the handoff branch, ...), whatever else.
 *   wait  - younger than --min-age-days (default 7).
 *   close - content on main, or superseded by a replacement PR that is merged.
 *   flag  - unique work, a replacement not merged yet, or a head git could not read.
 *
 * Usage:
 *   node scripts/ops/pr-cleanup-report.mjs --prs prs.json [--config cfg.json]
 *        [--base origin/main] [--ref-prefix refs/remotes/pr/] [--now ISO] [--json]
 *   prs.json:  [{number, title, head (ref or sha), created_at, base_sha?}]
 *   cfg.json:  {keep: {"148": "reason"}, superseded: {"377": {by: 440, merged: true}}}
 *   Fetch heads first: git fetch origin '+refs/pull/*\/head:refs/remotes/pr/*'
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DAY_MS = 24 * 60 * 60 * 1000;

function gitRun(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...opts,
  });
}

function gitOk(repo, args, opts = {}) {
  try { gitRun(repo, args, opts); return true; } catch (error) {
    if (typeof error.status === 'number') return false;
    throw error;
  }
}

/** Touched files (merge-base..head) whose blob on head differs from base. */
function differingFiles(repo, base, head, mergeBase) {
  const touched = gitRun(repo, ['diff', '--name-only', '--no-renames', mergeBase, head]).split('\n').filter(Boolean);
  const differ = gitRun(repo, ['diff', '--name-only', '--no-renames', base, head, '--', ...touched]);
  return touched.length ? differ.split('\n').filter(Boolean).sort() : [];
}

/** Does main's tree already hold the head's net change? Uses a throwaway index, no worktree. */
function contentOnBase(repo, base, head, mergeBase) {
  const patch = gitRun(repo, ['diff', '--binary', '--no-renames', mergeBase, head]);
  if (!patch.trim()) return true;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-cleanup-idx-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(tmp, 'index') };
    gitRun(repo, ['read-tree', base], { env });
    return gitOk(repo, ['apply', '--cached', '--check', '-R', '-'], { env, input: patch });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function tryMergeBase(repo, a, b) {
  try { return gitRun(repo, ['merge-base', a, b]).trim() || null; } catch (error) {
    if (typeof error.status === 'number') return null;
    throw error;
  }
}

/**
 * `baseSha` is the PR's own base (GitHub's base.sha). It is used only when the head
 * shares no history with main (main was re-rooted on 2026-09-24): the PR's change is
 * then merge-base(baseSha, head)..head.
 */
/**
 * A hint, never a close reason: the share of the PR's added lines (trimmed, 4+ chars)
 * found verbatim in main's copy of the same file. High means "probably landed in a
 * different shape"; the row stays flag either way.
 */
function addedLinesOnMain(repo, base, head, mergeBase) {
  const patch = gitRun(repo, ['diff', '--no-renames', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '-U0', mergeBase, head]);
  let file = null;
  const added = new Map();
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) { file = line === '+++ /dev/null' ? null : line.slice(6); continue; }
    if (!file || !line.startsWith('+')) continue;
    const text = line.slice(1).trim();
    if (text.length < 4) continue;
    if (!added.has(file)) added.set(file, []);
    added.get(file).push(text);
  }
  let total = 0;
  let found = 0;
  for (const [path_, lines] of added) {
    let onMain = new Set();
    try {
      onMain = new Set(gitRun(repo, ['show', `${base}:${path_}`]).split('\n').map(l => l.trim()));
    } catch (error) {
      if (typeof error.status !== 'number') throw error;
    }
    total += lines.length;
    found += lines.filter(l => onMain.has(l)).length;
  }
  return total ? found / total : null;
}

export function classifyContent({ repo, base, head, baseSha }) {
  if (!gitOk(repo, ['rev-parse', '--verify', '--quiet', `${head}^{commit}`])) {
    return { status: 'unreadable', how: `could not read ${head}`, files: [] };
  }
  let mergeBase = tryMergeBase(repo, base, head);
  let from = 'main';
  if (!mergeBase) {
    if (!baseSha || !gitOk(repo, ['rev-parse', '--verify', '--quiet', `${baseSha}^{commit}`])) {
      return { status: 'unreadable', how: 'could not read a base: no history shared with main and the PR base is not fetched', files: [] };
    }
    mergeBase = tryMergeBase(repo, baseSha, head);
    if (!mergeBase) return { status: 'unreadable', how: 'could not read a base: head shares no history with its PR base', files: [] };
    from = 'its PR base (no history shared with main)';
  } else if (gitOk(repo, ['merge-base', '--is-ancestor', head, base])) {
    return { status: 'on-main', how: 'ancestor of main', files: [] };
  }
  const cherry = gitRun(repo, ['cherry', base, head, mergeBase]).split('\n').filter(Boolean);
  const ahead = cherry.length;
  const plus = cherry.filter(line => line.startsWith('+')).length;
  if (plus === 0) {
    return { status: 'on-main', how: `every commit (${ahead}) has a patch on main`, files: [], ahead, from };
  }
  if (contentOnBase(repo, base, head, mergeBase)) {
    return { status: 'on-main', how: 'its content is already on main', files: [], ahead, from };
  }
  const files = differingFiles(repo, base, head, mergeBase);
  const landed = addedLinesOnMain(repo, base, head, mergeBase);
  return { status: 'unique', how: `${plus} of ${ahead} commits not on main`, files, ahead, from, landed };
}

function listFiles(files, max = 3) {
  const shown = files.slice(0, max).join(', ');
  return files.length > max ? `${shown} +${files.length - max} more` : shown;
}

export function buildReport({ repo, base, prs, now = Date.now(), minAgeDays = 7, keep = {}, superseded = {}, refFor = pr => pr.head }) {
  return prs.map(pr => {
    const ageDays = (now - Date.parse(pr.created_at)) / DAY_MS;
    const row = { number: pr.number, title: pr.title, created_at: pr.created_at, age_days: Math.floor(ageDays) };
    if (keep[pr.number]) return { ...row, action: 'keep', reason: `keep list: ${keep[pr.number]}` };

    const content = classifyContent({ repo, base, head: refFor(pr), baseSha: pr.base_sha });
    const sup = superseded[pr.number];
    let action;
    let reason;
    if (content.status === 'unreadable') {
      action = 'flag';
      reason = `${content.how}; check by hand`;
    } else if (content.status === 'on-main') {
      action = 'close';
      reason = `on main (${content.how})`;
    } else if (sup?.merged) {
      action = 'close';
      reason = `superseded by merged #${sup.by}; ${content.how} (${listFiles(content.files)}), carried by the replacement`;
    } else {
      action = 'flag';
      reason = `unique work: ${content.how}; differs in ${listFiles(content.files)}`
        + (content.landed == null ? '' : `; ${Math.round(content.landed * 100)}% of its added lines are on main`)
        + (sup ? `; replacement #${sup.by} not merged yet` : '');
    }
    if (content.from && content.from !== 'main') reason += '; pre-rewrite history, cannot merge as-is (needs a rebuild on main)';
    if (ageDays < minAgeDays) {
      return { ...row, action: 'wait', reason: `under ${minAgeDays} days old; would be ${action}: ${reason}`, would: action };
    }
    return { ...row, action, reason };
  });
}

const cell = text => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function toMarkdown(rows) {
  const lines = ['| PR | Opened | Action | Reason | Title |', '|---|---|---|---|---|'];
  for (const r of rows) {
    lines.push(`| #${r.number} | ${String(r.created_at).slice(0, 10)} | ${r.action} | ${cell(r.reason)} | ${cell(r.title)} |`);
  }
  return lines.join('\n');
}

export function summarize(rows) {
  const count = {};
  for (const r of rows) {
    const key = r.action === 'wait' ? `wait (would ${r.would})` : r.action;
    count[key] = (count[key] ?? 0) + 1;
  }
  return count;
}

function parseArgs(argv) {
  const args = { base: 'origin/main', refPrefix: 'refs/remotes/pr/', minAgeDays: 7, repo: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--prs') args.prs = next();
    else if (a === '--config') args.config = next();
    else if (a === '--base') args.base = next();
    else if (a === '--ref-prefix') args.refPrefix = next();
    else if (a === '--repo') args.repo = next();
    else if (a === '--now') args.now = Date.parse(next());
    else if (a === '--min-age-days') args.minAgeDays = Number(next());
    else if (a === '--json') args.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!args.prs) throw new Error('--prs <file> is required');
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const prs = JSON.parse(fs.readFileSync(args.prs, 'utf8'));
  const cfg = args.config ? JSON.parse(fs.readFileSync(args.config, 'utf8')) : {};
  const rows = buildReport({
    repo: args.repo, base: args.base, prs, now: args.now ?? Date.now(), minAgeDays: args.minAgeDays,
    keep: cfg.keep ?? {}, superseded: cfg.superseded ?? {},
    refFor: pr => `${args.refPrefix}${pr.number}`,
  });
  if (args.json) process.stdout.write(`${JSON.stringify({ summary: summarize(rows), rows }, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(summarize(rows))}\n\n${toMarkdown(rows)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`pr-cleanup-report: ${error.message}\n`);
    process.exit(2);
  }
}
