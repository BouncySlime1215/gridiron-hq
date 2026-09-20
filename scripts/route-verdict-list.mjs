/**
 * The route verdict list the owning threads cut from.
 *
 * Not a list of dead routes, which is what its first version was titled, and that
 * title alone would have cost eight live /api/auth routes: a reader acting on the
 * heading would have deleted the one that invites a league. Every row now carries a
 * status from docs/wiring/route-verdicts.json, and a row nobody has ruled on says
 * `unverified` rather than passing for a decision.
 *
 * `dials` and `mentions` are separate because they are not the same evidence, and this
 * checker has been wrong in both directions in one night: it missed a script that
 * dials nine live routes, and it would have counted a docs line recommending someone
 * BUILD a route as proof one existed. A dial is a path inside a call that fetches it.
 * A mention is the same characters in prose, a comment, or an assertion message. The
 * verdict rests on dials. `unclear` is neither; it is a request to read the line.
 */
import fs from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { routePattern } from './wiring-map.mjs';

const d = JSON.parse(fs.readFileSync('docs/wiring/wiring-map.json', 'utf8'));
const rows = (d.findings || []).filter(x => x.rule === 'route-no-caller' && x.scope !== 'betting');
const ctx  = (d.findings || []).filter(x => x.rule === 'route-called-from-outside-the-app');
const head = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();

/*
 * The fragment each row is searched by comes from the checker itself, imported rather
 * than reimplemented. It was reimplemented here, and the copy drifted in the worst
 * possible way: it took the longest run of literal segments, so the row for
 * `GET /api/trades/:leagueId/trends` was searched by `/trades` — every route on that
 * router — and reported 26 dials and 81 mentions for a route with no caller at all. A
 * row reading 26 dials says "obviously keep" to anyone scanning, and would have stopped
 * a verdict cold.
 *
 * The same copy sat in scripts/wiring-map.mjs as a GATE, where it silently suppressed
 * three routes. One implementation is the fix for both; two implementations is the
 * condition that let the report and the gate disagree.
 */
const frag = routePattern;

/*
 * A DIAL is the path inside a call that fetches it. A MENTION is the same characters in
 * prose, a comment, or an assertion message. The verdict rests on dials only — this is
 * the distinction that kept /api/dev/llm-budget (a docs line recommending someone build
 * a route) from inventing a caller, and it is why every row carries both numbers.
 */
const DIAL = /(?:fetch|api|request|run|get|post|put|patch|del|delete|curl|useApi)\s*[(`'"]/;
const classify = (file, line, text) => {
  const t = text.trim();
  if (/\.(md|txt|csv|json)$/.test(file)) return 'mention';
  if (/^\s*(\/\/|\*|\/\*)/.test(t)) return 'mention';
  const before = t.slice(0, t.search(/['"`]/) + 1);
  if (DIAL.test(before)) return 'dial';
  if (/assert|toBe|equal\(|message:|error:/.test(t)) return 'mention';
  return 'unclear';
};

const evidence = (file, f) => {
  // execFileSync, not a shell string: the fragment is a regex now and holds characters
  // a shell would eat. git grep exits 1 on no matches, which is not an error here.
  let out = [];
  try {
    out = execFileSync('git', ['grep', '-n', '-E', '--', `/${f}`,
      '--', `:!${file}`, ':!docs/wiring', ':!*wiring-map*'],
      { encoding: 'utf8', maxBuffer: 1 << 24 }).trim().split('\n').filter(Boolean);
  } catch (e) {
    if (e.status === 1) out = [];
    else if (typeof e.stdout === 'string') out = e.stdout.trim().split('\n').filter(Boolean);
    else throw e;
  }
  const dials = [], mentions = [], unclear = [];
  for (const l of out) {
    const i = l.indexOf(':'), j = l.indexOf(':', i + 1);
    const file2 = l.slice(0, i), line = l.slice(i + 1, j), text = l.slice(j + 1);
    const k = classify(file2, line, text);
    (k === 'dial' ? dials : k === 'mention' ? mentions : unclear).push(`${file2}:${line}`);
  }
  return { dials, mentions, unclear };
};

// Owner-supplied verdicts. Each one came from the thread that owns the file, with its
// reason; nothing here is this checker's inference.
// Owner verdicts live in docs/wiring/route-verdicts.json, read by this generator AND
// by scripts/route-deletion-impact.mjs. One file, so a route ruled kept in one place
// cannot still be dying in the other — which it was, for one run, and the impact report
// announced that live code was about to fall.
const verdictFile = JSON.parse(fs.readFileSync('docs/wiring/route-verdicts.json', 'utf8'));
const OVERRIDE = Object.fromEntries(Object.entries(verdictFile.verdicts)
  .map(([route, v]) => [route, [v.status, v.why]]));

const byFile = new Map();
for (const r of rows) {
  const file = (r.evidence?.[0] ?? '?').split(':')[0];
  if (!byFile.has(file)) byFile.set(file, []);
  byFile.get(file).push(r);
}

const o = [];
o.push('# Route verdicts — cut from this list, not from memory');
o.push('');
o.push(`Branch \`${branch}\`, head \`${head}\`. **Every line number in this file is taken from THIS tree.** Another branch's head will have different offsets: if a row's offset does not match your tree, use the method and the fragment, which do not move.`);
o.push('');
o.push(`**${rows.length} in-scope rows**, ${(d.findings||[]).filter(x=>x.rule==='route-no-caller').length} total including betting, plus ${ctx.length} routes that are NOT dead.`);
o.push('');
o.push('## How to read a row');
o.push('');
o.push('`status` is the verdict, and it is not "dead" for every row — the earlier version of this file was titled as though it were, which would have cost eight live `/api/auth` routes:');
o.push('');
o.push('| status | meaning |');
o.push('|---|---|');
o.push('| `delete` | no caller and no reason to keep it |');
o.push('| `delete-route-only` | the route is dead, the service behind it is live — delete the handler, keep the module |');
o.push('| `kept-no-screen` | no UI calls it and it stays anyway, on its owner\'s word |');
o.push('| `kept-tombstone` | a deliberate 410 that names its replacement |');
o.push('| `external-caller` | something outside the client dials it — a script, a test, an operator |');
o.push('| `orphaned-backend-of-deleted-page` | its page was removed and the computation behind it is still the only one of its kind |');
o.push('| `already-removed` | gone on its owner\'s branch already; do not report it twice |');
o.push('| `unverified` | this checker found no caller and no owner has ruled — **verify before cutting** |');
o.push('');
o.push('`dials` and `mentions` are counted separately because they are not the same evidence. A dial is the path inside a call that fetches it. A mention is the same characters in prose, a comment, or an assertion message. **The verdict rests on dials only.** `/api/dev/sources` shows four references and not one of them is a dial: two are documentation, one is a comment in `model-sync-current-season.test.js:6`, one is a message string in `nfl-prospective-collection.test.js:87`. Counting those as callers would have been the inverse of the bug this file was rebuilt to fix.');
o.push('');
o.push('`unclear` is a reference this classifier would not call either way. It is not a verdict, it is a request to read the line.');
o.push('');

for (const file of [...byFile.keys()].sort()) {
  const list = byFile.get(file).sort((a, b) => a.subject.localeCompare(b.subject));
  o.push(`## ${file} — ${list.length}`);
  o.push('');
  for (const r of list) {
    const f = frag(r.subject.split(' ')[1]);
    const { dials, mentions, unclear } = evidence(file, f);
    const [status, why] = OVERRIDE[r.subject] ?? ['unverified', ''];
    o.push(`### \`${r.subject}\``);
    o.push('');
    o.push(`- **status: \`${status}\`**${why ? ' — ' + why : ''}`);
    o.push(`- declared at \`${r.evidence?.[0] ?? ''}\` *(offset is on ${branch} @ ${head})*`);
    o.push(`- fragment searched: \`/${f}\``);
    o.push(`- **dials: ${dials.length}**${dials.length ? ' — ' + dials.join(', ') : ''}`);
    o.push(`- mentions: ${mentions.length}${mentions.length ? ' — ' + mentions.join(', ') : ''}`);
    if (unclear.length) o.push(`- unclear, read these: ${unclear.join(', ')}`);
    o.push('');
  }
}
o.push('## NOT dead — a script in this repository dials these over HTTP');
o.push('');
o.push('These sat in `route-no-caller` until 2026-09-20, when the checker learned to see a path that starts a string. **Do not delete any of them.**');
o.push('');
for (const c of ctx.sort((a, b) => a.subject.localeCompare(b.subject)))
  o.push(`- \`${c.subject}\` — ${c.detail}`);
o.push('');
o.push('## Module reaching no surface, routed rather than deleted');
o.push('');
o.push('- `valuationMap` (valuation-map, `server/routes/trades.js:415` comment only) — **routed-not-deleted.** Trade Brain is routing it to Trade Lab through `routes/trades.js`. Do not cut it as an orphan.');
fs.writeFileSync(process.env.OUT || '/mnt/project-files/dead-routes-corrected.md', o.join('\n') + '\n');
console.log('rows', rows.length, 'files', byFile.size, 'ruled', Object.keys(OVERRIDE).length);
