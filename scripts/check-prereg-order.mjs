#!/usr/bin/env node
/**
 * Pre-registration order check (GR-05, plan items 12/18).
 *
 * docs/evidence/STATS-METHOD.md rule 1: the commit that adds a pre-registration
 * "must be an ancestor of the result's commit". This script is the check. For
 * every results file under an evidence prefix it finds the file's pre-registration
 * and fails if the results file's FIRST commit is not a descendant of (or equal
 * to) the prereg's first commit, i.e. if the numbers were committed before the
 * rule that judges them.
 *
 * How a results file is paired with its pre-registration:
 *   1. By name, in the same directory. A prereg file is `<stem>-prereg.md`,
 *      `<stem>-preregistration.md` (also `pre-reg`, `pre-registration`, any case),
 *      optionally followed by `-addendum-N` / `-amendment-N`. Its results are the
 *      other tracked files in that directory named `<stem>.<ext>` or
 *      `<stem>-result(s)|output|outcome|findings.<ext>`. The EARLIEST committed
 *      prereg of the group is the anchor, so an amendment committed after the
 *      results neither rescues nor breaks the base prereg.
 *   2. By an explicit marker in a Markdown file: `<!-- prereg: <repo path> -->`.
 *      An evidence file (`*.tdd.md`) is never paired by name, because the house
 *      process writes its audit section before the first test; it opts in with
 *      the marker.
 *
 * "First commit" walks `git log --follow`: renaming a file into place keeps the
 * commit that first added its text, but a copy (C) counts as a new file, so an
 * identical-content twin elsewhere cannot date it earlier (firstAddCommit).
 *
 * A squash merge puts a PR's prereg and results in one commit on main. That is
 * reported as `same commit` (order not provable from main's history) and passes,
 * unless --strict. On a PR branch the individual commits are visible.
 *
 * A shallow clone (CI's default checkout depth is 1) cannot see first commits:
 * the script exits 2 and says so rather than passing on an empty history.
 *
 * Usage:
 *   node scripts/check-prereg-order.mjs                         # docs/evidence/ and docs/tdd/
 *   node scripts/check-prereg-order.mjs --prefix docs/evidence/  # one prefix (repeatable)
 *   node scripts/check-prereg-order.mjs --repo <dir> --strict --json
 *   node scripts/check-prereg-order.mjs --rev origin/<branch>        # a branch, no checkout
 * Exit: 0 ok, 1 violation (or same-commit under --strict), 2 shallow clone, 3 other error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PREFIXES = Object.freeze(['docs/evidence/', 'docs/tdd/']);

const PREREG_RE = /^(.+?)[-_.]pre-?reg(?:istration)?(?:[-_.](?:addendum|amendment)[-_.]?\d+)?\.md$/i;
const RESULT_SUFFIX_RE = /[-_.](?:results?|output|outcome|findings)$/i;
const MARKER_RE = /<!--\s*prereg:\s*`?([^\s`>]+?)`?\s*-->/gi;

const isAmendment = file => /[-_.](?:addendum|amendment)[-_.]?\d+\.md$/i.test(file);
/** Base prereg before its addenda, so a tie (one squash commit) is reported against the base. */
const byBaseFirst = (a, b) => (isAmendment(a) - isAmendment(b)) || a.localeCompare(b);

export class ShallowRepoError extends Error {
  constructor(repo) {
    super(`${repo} is a shallow clone: first commits are not visible, so prereg order cannot be checked (fetch full history, e.g. actions/checkout fetch-depth: 0)`);
    this.name = 'ShallowRepoError';
  }
}

/** The lower-cased stem of a prereg file, or null if the path is not a prereg file. */
export function preregStem(file) {
  const m = PREREG_RE.exec(path.posix.basename(file));
  return m ? m[1].toLowerCase() : null;
}

/** The lower-cased stem a results file would pair on, or null if it never pairs by name. */
export function resultStem(file) {
  const base = path.posix.basename(file);
  if (preregStem(file) != null || /\.tdd\.md$/i.test(base)) return null;
  const ext = path.posix.extname(base);
  const name = ext ? base.slice(0, -ext.length) : base;
  return name.replace(RESULT_SUFFIX_RE, '').toLowerCase();
}

/**
 * The commit that first created a file, from `git log --follow --name-status
 * --format=%x00%H` output (newest first).
 *   - A rename (R) is followed back to the older name.
 *   - An add (A) is a candidate, and the walk goes on: the OLDEST add wins. A PR's
 *     branch adds the file in its own commit, main adds it again in the squash
 *     commit, and a branch that merged main back sees both; the branch commit is
 *     the first one.
 *   - A copy (C) is where this file was created, and the walk stops: `--follow`
 *     also reports copies, and following one would date an identical-content file
 *     (an empty stub, a template) to its twin's commit, a false violation.
 * Null if there is no history.
 */
export function firstAddCommit(logOutput) {
  const records = logOutput.split('\0').map(s => s.trim()).filter(Boolean).map(chunk => {
    const [sha, ...lines] = chunk.split('\n').map(l => l.trim()).filter(Boolean);
    return { sha, status: lines[0]?.split('\t')[0] ?? '' };
  });
  let first = null;
  for (const r of records) {
    if (/^A/.test(r.status)) first = r.sha;
    else if (/^C/.test(r.status)) return r.sha;
  }
  return first ?? (records.length ? records[records.length - 1].sha : null);
}

function gitRunner(repo) {
  const base = ['-C', repo, '-c', 'core.quotepath=false'];
  const run = (...args) => execFileSync('git', [...base, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const status = (...args) => spawnSync('git', [...base, ...args], { encoding: 'utf8' });
  return { run, status };
}

/**
 * Check every results file under `prefixes` in `repo`.
 * @returns {{ pairs: object[], violations: object[], sameCommit: object[], pending: object[] }}
 *   pairs: every (result, prereg) pair found; violations: results committed before
 *   (or without) their prereg; sameCommit: prereg and results added in one commit;
 *   pending: results not yet committed.
 * @throws {ShallowRepoError} on a shallow clone.
 */
export function checkPreregOrder({ repo = process.cwd(), prefixes = DEFAULT_PREFIXES, rev = null } = {}) {
  if (rev != null && (typeof rev !== 'string' || !rev || rev.startsWith('-'))) throw new Error(`--rev must be a commit-ish, got ${JSON.stringify(rev)}`);
  const git = gitRunner(repo);
  if (git.run('rev-parse', '--is-shallow-repository').trim() === 'true') throw new ShallowRepoError(repo);
  const root = git.run('rev-parse', '--show-toplevel').trim();

  // Files: the index (default) or the tree of `rev`, so a branch is checked without a checkout.
  const listFiles = (...paths) => (rev
    ? git.run('ls-tree', '-r', '-z', '--name-only', rev, '--', ...paths)
    : git.run('ls-files', '-z', '--', ...paths)).split('\0').filter(Boolean);
  const tracked = listFiles(...prefixes);
  const allTracked = new Set(listFiles());
  const readText = file => {
    if (rev) return git.run('show', `${rev}:${file}`);
    const abs = path.join(root, file);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null; // tracked but deleted in the working tree
  };

  const firstCache = new Map();
  const firstCommit = file => {
    if (!firstCache.has(file)) firstCache.set(file, firstAddCommit(git.run('log', ...(rev ? [rev] : []), '--follow', '--name-status', '--format=%x00%H', '--', file)));
    return firstCache.get(file);
  };
  const isAncestor = (a, b) => {
    const r = git.status('merge-base', '--is-ancestor', a, b);
    if (r.status === 0) return true;
    if (r.status === 1) return false;
    throw new Error(`git merge-base --is-ancestor ${a} ${b} failed: ${r.stderr.trim()}`);
  };
  const commitTime = sha => Number(git.run('show', '-s', '--format=%ct', sha).trim());

  // Prereg groups by (directory, stem).
  const groups = new Map();
  for (const file of tracked) {
    const stem = preregStem(file);
    if (stem == null) continue;
    const key = `${path.posix.dirname(file)}\0${stem}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }

  /** The earliest committed prereg of a group: an ancestor of every other, else the oldest by time. */
  const anchorOf = files => {
    const committed = files.map(f => ({ file: f, sha: firstCommit(f) })).filter(x => x.sha);
    if (!committed.length) return null;
    const root = committed.find(c => committed.every(o => o.sha === c.sha || isAncestor(c.sha, o.sha)));
    return root ?? committed.sort((a, b) => commitTime(a.sha) - commitTime(b.sha))[0];
  };

  const wanted = new Map(); // `${result}\0${preregs}` -> {result, preregs, via}
  const want = (result, preregs, via) => {
    const k = `${result}\0${preregs.join('\0')}`;
    if (!wanted.has(k)) wanted.set(k, { result, preregs, via });
  };
  for (const file of tracked) {
    const stem = resultStem(file);
    if (stem != null) {
      const group = groups.get(`${path.posix.dirname(file)}\0${stem}`);
      if (group) want(file, [...group].sort(byBaseFirst), 'name');
    }
    if (preregStem(file) == null && /\.md$/i.test(file)) {
      const text = readText(file);
      if (text == null) continue;
      for (const m of text.matchAll(MARKER_RE)) want(file, [m[1].replace(/^\.\//, '')], 'marker');
    }
  }

  const report = { repo: root, rev: rev ?? 'HEAD', prefixes: [...prefixes], pairs: [], violations: [], sameCommit: [], pending: [] };
  for (const { result, preregs, via } of wanted.values()) {
    const resultSha = firstCommit(result);
    const known = preregs.filter(p => allTracked.has(p));
    const anchor = anchorOf(known);
    const pair = { result, prereg: anchor?.file ?? preregs[0], via, result_commit: resultSha, prereg_commit: anchor?.sha ?? null };
    report.pairs.push(pair);
    if (!resultSha) { report.pending.push({ ...pair, reason: 'results file not committed yet' }); continue; }
    if (!anchor) { report.violations.push({ ...pair, reason: `prereg ${preregs.join(', ')} is not committed` }); continue; }
    if (anchor.sha === resultSha) { report.sameCommit.push({ ...pair, reason: 'prereg and results first added in the same commit' }); continue; }
    if (!isAncestor(anchor.sha, resultSha)) {
      report.violations.push({ ...pair, reason: `results first committed in ${resultSha.slice(0, 8)}, which does not descend from the prereg's first commit ${anchor.sha.slice(0, 8)}` });
    }
  }
  return report;
}

function parseArgs(argv) {
  const opts = { prefixes: [], repo: process.cwd(), rev: null, strict: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prefix') opts.prefixes.push(argv[++i]);
    else if (a === '--repo') opts.repo = argv[++i];
    else if (a === '--rev') opts.rev = argv[++i];
    else if (a === '--strict') opts.strict = true;
    else if (a === '--json') opts.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.prefixes.length) opts.prefixes = [...DEFAULT_PREFIXES];
  return opts;
}

function main() {
  let opts;
  let report;
  try {
    opts = parseArgs(process.argv.slice(2));
    report = checkPreregOrder(opts);
  } catch (error) {
    console.error(`check-prereg-order: ${error.message}`);
    process.exit(error instanceof ShallowRepoError ? 2 : 3);
  }
  const failed = report.violations.length > 0 || (opts.strict && report.sameCommit.length > 0);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`check-prereg-order: ${report.pairs.length} prereg/results pair(s) under ${report.prefixes.join(', ')} at ${report.rev}`);
    for (const v of report.violations) console.log(`  VIOLATION ${v.result} <- ${v.prereg}: ${v.reason}`);
    for (const s of report.sameCommit) console.log(`  same commit${opts.strict ? ' (fails under --strict)' : ''}: ${s.result} <- ${s.prereg} @ ${s.result_commit.slice(0, 8)}`);
    for (const p of report.pending) console.log(`  pending: ${p.result} (${p.reason})`);
    console.log(failed ? 'FAIL' : 'ok');
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
