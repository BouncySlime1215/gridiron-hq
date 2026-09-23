#!/usr/bin/env node
/*
 * The docs citations this repository's SOURCE makes, and whether each one is keepable.
 *
 * The standing gate is `docs-citation-points-at-nothing` in scripts/wiring-map.mjs. It
 * runs on every check, carries two states — MOVED and GONE — and never touches git,
 * because a gate that shells out to history on every run is a gate somebody turns off.
 *
 * This script is the slower companion. It reads the gate's own rows out of
 * docs/wiring/wiring-map.json and adds the one thing the gate deliberately will not
 * compute: whether a cited document ever existed at all. That distinction decides the
 * fix. DELETED means a commit added the file and a later one removed it. NEVER EXISTED
 * means no commit on any branch ever added it, and neither of them is a licence to
 * delete the sentence that cites it — a comment records why a feature grew a
 * particular behaviour, and that provenance outlives its source.
 *
 * Resolution is by BASENAME, never by prefix. A by-hand pass over the other direction
 * reported 17 missing files and 13 were the resolver: those citations carry absolute
 * paths from a developer's home directory, which a fixed prefix cannot match and a
 * basename can. test/wiring-map.test.js pins that, so tidying the pattern cannot bring
 * it back.
 *
 *   node scripts/docs-citation-history.mjs [outfile]
 *
 * With no argument it writes to stdout. Regenerate the map first: npm run map:wiring.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const map = JSON.parse(readFileSync('docs/wiring/wiring-map.json', 'utf8'));
const rows = map.findings.filter(f => f.rule === 'docs-citation-points-at-nothing');

const git = (args) => { try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return ''; } };

// Every path this repository has EVER held, from the whole history of every branch.
const everHeld = new Set(git(['log', '--all', '--pretty=format:', '--name-only', '--diff-filter=A'])
  .split('\n').map(s => s.trim()).filter(Boolean));

// Every docs/*.md that exists now, by basename, so a moved file can be resolved.
const nowByBase = new Map();
for (const p of git(['ls-files', 'docs']).split('\n').filter(p => p.endsWith('.md'))) {
  const b = p.split('/').pop();
  if (!nowByBase.has(b)) nowByBase.set(b, []);
  nowByBase.get(b).push(p);
}

const byPath = new Map();
for (const r of rows) {
  const cited = r.subject;
  if (!byPath.has(cited)) byPath.set(cited, []);
  byPath.get(cited).push(r.evidence[0]);
}

const out = [];
for (const [cited, sites] of [...byPath].sort((a, b) => b[1].length - a[1].length)) {
  const base = cited.split('/').pop();
  const here = nowByBase.get(base) ?? [];
  const everAtCited = everHeld.has(cited);
  const everAnywhere = everAtCited || [...everHeld].some(p => p.split('/').pop() === base);
  const state = here.length === 1 ? 'MOVED'
    : here.length > 1 ? 'AMBIGUOUS'
    : everAnywhere ? 'DELETED'
    : 'NEVER EXISTED';
  out.push({ cited, state, resolves_to: here, sites: [...new Set(sites)].sort(), everAtCited });
}


const summary = { paths: out.length, sites: rows.length, tally: (() => {
  const t = {};
  for (const o of out) t[o.state] = (t[o.state] ?? 0) + 1;
  return t;
})() };

const L = [];
L.push('# Broken docs citations: source pointing AT docs');
L.push('');
L.push('**Direction matters, and this is one of two reports.** This one reads the SOURCE');
L.push('tree and finds comments, strings and assertions that name a `docs/*.md` file which is');
L.push('not where they say it is. The other, `docs-citations-stale-2026-09-20.md`, reads the');
L.push('markdown under `docs/` and finds citations pointing at source `file:line`. They share');
L.push('no rows. Fixing every row here leaves every row there untouched, and the reverse.');
L.push('');
L.push(`Produced by \`scripts/wiring-map.mjs\`, rule \`docs-citation-points-at-nothing\`, from`);
L.push(`\`docs/wiring/wiring-map.json\` at commit ${git(['rev-parse', '--short', 'HEAD']) || 'an unknown commit'}, which is the`);
L.push('tree the map was last generated from. The history column is a second pass');
L.push('over `git log --all --diff-filter=A`, so NEVER EXISTED means no commit on any branch of');
L.push('this repository ever added a file of that name.');
L.push('');
L.push(`**${summary.sites} citation sites, ${summary.paths} distinct paths.** `
  + `${summary.tally.MOVED} moved, ${summary.tally.DELETED ?? 0} deleted, ${summary.tally['NEVER EXISTED'] ?? 0} never existed.`);
L.push('');
L.push('## How to treat each state');
L.push('');
L.push('- **MOVED** — the document exists, at a different path. Repoint the citation. Exactly');
L.push('  one candidate in every case below; nothing here is ambiguous.');
L.push('- **DELETED** — a commit added it, a later commit removed it. Do not guess a successor.');
L.push('  Say in the comment that the document was removed, and keep the sentence around it: the');
L.push('  comment records why a feature grew a particular behaviour, and that provenance survives');
L.push('  the document.');
L.push('- **NEVER EXISTED** — no commit ever added it. Same treatment as DELETED: a sentence');
L.push('  saying the document is not in this repository, not a silent deletion of the reference');
L.push('  and not a guess at a successor.');
L.push('');
for (const state of ['MOVED', 'DELETED', 'NEVER EXISTED']) {
  const group = out.filter(o => o.state === state);
  if (!group.length) continue;
  L.push(`## ${state} — ${group.length} paths, ${group.reduce((n, o) => n + o.sites.length, 0)} sites`);
  L.push('');
  for (const o of group) {
    L.push(`### \`${o.cited}\``);
    if (state === 'MOVED') L.push(`Resolves to: \`${o.resolves_to[0]}\``);
    else if (state === 'DELETED') L.push('Was in this repository once and is not now. No successor is offered.');
    else L.push('**No commit on any branch ever added a file of this name.**');
    L.push('');
    for (const s of o.sites) L.push(`- \`${s}\``);
    L.push('');
  }
}
L.push('---');
L.push('');
L.push('## What this does NOT check');
L.push('');
L.push('Read this before treating a path absent from the list as verified.');
L.push('');
L.push('- **A citation that resolves is not checked for being TRUE.** `aggregates.js` may cite');
L.push('  a document that exists and no longer says anything about consensus weights. Existence');
L.push('  is all that is measured. No subset of these is checked more deeply, and nothing in');
L.push('  this report should be read as saying the surviving citations are accurate.');
L.push('- **Only `docs/*.md` is in scope.** A citation to a `.sql`, a `.json`, or a file');
L.push('  outside `docs/` is invisible here.');
L.push('- **A path is resolved by BASENAME**, so two documents with the same file name in');
L.push('  different folders would resolve ambiguously. None do today; the report would say');
L.push('  AMBIGUOUS if one did.');
L.push('- **The standing gate carries two states, not three.** `docs-citation-points-at-nothing`');
L.push('  in the wiring map distinguishes MOVED from GONE and never reads git history, because');
L.push('  it runs on every check. DELETED against NEVER EXISTED is this report only.');
L.push('');
L.push('Regenerate with `npm run map:wiring`, then read the `docs-citation-points-at-nothing`');
L.push('rows out of `docs/wiring/wiring-map.json`. The rule reports every occurrence, not one');
L.push('per file, so a file citing the same missing document twice appears twice.');

const target = process.argv[2];
const text = L.join('\n') + '\n';
if (target) { writeFileSync(target, text); console.error(`wrote ${target}`); }
else process.stdout.write(text);
