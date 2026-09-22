/**
 * What else falls when a dead route is cut, and how far down.
 *
 * The orphan rules in wiring-map.mjs answer "is this module reachable", and a module
 * is the wrong unit for this question. `server/services/position-liquidity.js` is
 * reached by `routes/trades.js`, which hosts plenty of live routes, so the module is
 * reachable and always will be — while `positionLiquidity()` inside it is called only
 * by the handler of `GET /api/trades/:leagueId/brain/liquidity`, which is dead. Cut
 * that route and the function goes dark, and so does `shoppingGuidance()`, whose only
 * consumer is `positionLiquidity`'s neighbour at position-liquidity.js:181. A sweep
 * that stops at one level keeps that chain alive forever, and it is discovered later,
 * one file at a time, by whoever is unlucky.
 *
 * So this walks FUNCTIONS, not files, and it is a report rather than a rule: it is
 * addressed to the person about to delete a route, before they delete it. Nothing here
 * says a function is dead today. Every one of them is live right now, through the route
 * that is about to go.
 *
 * WHAT IT WILL NOT SEE, stated plainly because a deletion is not reversible by reading:
 * a call made through a dynamic name, a function reached only by a string in a
 * dispatch table, and any caller outside this repository. A symbol this report says
 * falls should still be looked at before it is cut; the report narrows the search, it
 * does not end it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { isTestPath } from './wiring-map.mjs';

const ROOT = process.cwd();
const MAX_DEPTH = 4;
const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/wiring/wiring-map.json'), 'utf8'));
const head = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();

/*
 * A ROUTE ITS OWNER RULED KEPT IS NOT DYING, and the first run of this report forgot
 * that. It read every `route-no-caller` row as a deletion and so announced that
 * `requirePlatformAdmin()` falls with `POST /api/trades/managers/rebuild` — a route
 * Trade Brain had already ruled kept-external-caller — and that the whole walk-forward
 * chain falls with the model registry routes, which this thread itself decided to
 * keep. Both were confident, specific and wrong, and acting on either would have
 * deleted live code.
 *
 * docs/wiring/route-verdicts.json is the one place those verdicts live, so this report
 * and the verdict list cannot drift apart.
 */
const verdictFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/wiring/route-verdicts.json'), 'utf8'));
const KEEP = new Set(verdictFile.keep_statuses);
const statusOf = (route) => verdictFile.verdicts[route]?.status ?? 'unverified';

const dead = (map.findings || [])
  .filter(f => f.rule === 'route-no-caller' && f.scope !== 'betting')
  .filter(f => !KEEP.has(statusOf(f.subject)));

const src = new Map();
const read = (f) => {
  if (!src.has(f)) { try { src.set(f, fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch { src.set(f, ''); } }
  return src.get(f);
};

/** The source of one handler, from its `r.get(` line to the paren that closes it. */
function handlerBody(file, line) {
  const lines = read(file).split('\n');
  let bal = 0, i = line - 1;
  const out = [];
  for (; i < lines.length; i++) {
    out.push(lines[i]);
    for (const ch of lines[i].replace(/\/\/.*$/, '')) { if (ch === '(') bal++; else if (ch === ')') bal--; }
    if (bal <= 0 && out.length) break;
  }
  return { text: out.join('\n'), from: line, to: i + 1 };
}

/** The body of a named function declaration, wherever it is declared. */
function functionBody(file, name) {
  const text = read(file);
  const re = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(|(?:export\\s+)?const\\s+${name}\\s*=`);
  const m = re.exec(text);
  if (!m) return null;
  const open = text.indexOf('{', text.indexOf(')', m.index));
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return { text: text.slice(open, i + 1), line: text.slice(0, m.index).split('\n').length }; }
  }
  return null;
}

const NOISE = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
  'require', 'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Date', 'Set',
  'Map', 'Promise', 'console', 'parseInt', 'parseFloat', 'isNaN', 'res', 'req', 'next', 'await']);

/** Symbols this file imports from inside the repository, as name -> module path. */
function repoImports(file) {
  const out = new Map();
  const dir = path.dirname(file);
  for (const m of read(file).matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const target = path.normalize(path.join(dir, m[2])).replace(/\\/g, '/');
    for (const part of m[1].split(',')) {
      const local = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (local) out.set(local, target);
    }
  }
  return out;
}

const called = (text) => [...new Set([...text.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)].map(x => x[1]))]
  .filter(n => !NOISE.has(n));

/**
 * Every `name(` CALL SITE, which is not the same as every line containing `name(`.
 *
 * The first version of this counted two false survivors for `positionLiquidity()` and
 * so reported that nothing fell — on the very chain it was written for. One was a
 * comment in `scripts/wiring-map.mjs` describing the case. The other was
 * `position-liquidity.js:181`, a call from inside `shoppingGuidance()`, which has no
 * callers of its own.
 *
 * Both are the failure modes of every other rule on this branch: prose counted as a
 * dial, and a sweep that stops at one level. A comment is excluded here; the dead
 * caller is handled by the fixpoint below, not by this function.
 *
 * IT MATCHES THE BARE NAME, not `name(`, and that is deliberate. `requireAuthenticated`
 * is passed as express middleware — `r.get('/x', requireAuthenticated, handler)` — and
 * never appears with a paren after it, so a `name\\s*\\(` search found none and this
 * report called a function on the authentication path unreached. A function used as a
 * value is used. Matching the bare name over-counts a little, in the direction that
 * costs nothing: the worst case is a symbol that is not listed, and the worst case of
 * the other choice is somebody deleting live code on this report's word.
 */
/**
 * The line with its string and regex literals blanked, offsets preserved. A name that
 * survives this is in code; a name that does not was being talked about.
 */
function codeOnly(text) {
  let out = '', quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { out += '  '; i++; continue; }
      if (c === quote) { quote = null; out += c; continue; }
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; continue; }
    // A regex literal, distinguished from division by what can precede a regex.
    if (c === '/' && /[(,=:[!&|?{;]\s*$/.test(out)) {
      let j = i + 1, esc = false, cls = false;
      for (; j < text.length; j++) {
        const d = text[j];
        if (esc) { esc = false; continue; }
        if (d === '\\') { esc = true; continue; }
        if (d === '[') cls = true;
        else if (d === ']') cls = false;
        else if (d === '/' && !cls) break;
      }
      if (j < text.length) { out += ' '.repeat(j - i + 1); i = j; continue; }
    }
    out += c;
  }
  return out;
}

const sitesCache = new Map();
function callSites(name) {
  if (sitesCache.has(name)) return sitesCache.get(name);
  let out = [];
  try {
    // 'test' IS IN THIS LIST NOW, AND WAS NOT. Without it no call site could ever have
    // a test path, which made the `!isTestPath(s.file)` filter in survivors() below a
    // no-op that read as a deliberate decision. The blind spot was not partial: it was
    // total. positionRequirements() was printed as "reached only through
    // GET /brain/liquidity → positionLiquidity()" while test/pick-reasoning.test.js:9
    // imports it and :114 calls it.
    out = execSync(`git grep -n -E '\\b${name}\\b' -- 'server' 'scripts' 'client' 'test' || true`,
      { encoding: 'utf8', maxBuffer: 1 << 26 }).trim().split('\n').filter(Boolean)
      .map(l => { const i = l.indexOf(':'), j = l.indexOf(':', i + 1);
        return { file: l.slice(0, i), line: +l.slice(i + 1, j), text: l.slice(j + 1) }; })
      // a comment naming the function is somebody describing it, not calling it
      .filter(s => !/^\s*(\/\/|\*|\/\*)/.test(s.text))
      // AN IMPORT IS NOT A USE. Matching the bare name picked up
      // `import { positionLiquidity } from './position-liquidity.js'` in the very file
      // whose handler is dying, counted it as a surviving caller, and took the report
      // from 36 falling symbols to 0 — a clean, confident, entirely wrong answer.
      .filter(s => !/^\s*(import|export)\b/.test(s.text))
      // a declaration is not a call site
      .filter(s => !new RegExp(`(function|const|let|var)\\s+${name}\\s*[=(]`).test(s.text))
      .filter(s => !new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(s.text))
      // A NAME INSIDE A STRING IS NOT A CALL. This is the dial/mention distinction the
      // verdict list makes, and leaving it out here produced three wrong rows on its
      // first run with tests included: test/league-brain.test.js:57 lists 'brainState'
      // in an array of expected export names, test/route-deletion-impact.test.js:64
      // names positionLiquidity in an assertion message, and test/wiring-map.test.js
      // holds "const t = trendExploits(...)" as fixture TEXT for the scanner to read.
      // Every one of those would have told a reader that deleting the symbol deletes a
      // test that never touches it.
      .filter(s => new RegExp(`\\b${name}\\b`).test(codeOnly(s.text)));
  } catch { }
  sitesCache.set(name, out);
  return out;
}

// The line ranges that are about to be deleted. A call site inside one of these is not
// a surviving caller — it is going away in the same commit.
const doomed = [];
for (const r of dead) {
  const [file, line] = (r.evidence?.[0] ?? '').split(':');
  if (!file || !line) continue;
  const h = handlerBody(file, +line);
  doomed.push({ route: r.subject, file, from: h.from, to: h.to, text: h.text });
}
const insideDoomed = (s) => doomed.some(d => d.file === s.file && s.line >= d.from && s.line <= d.to);

const falls = new Map();   // "file#name" -> { name, file, depth, why, from, to }

/**
 * Is this call site inside a function this report has already decided is going away?
 *
 * ALREADY-UNREACHED ROWS ARE NOT GOING AWAY, and counting them here was the worst
 * thing this report did. The fixpoint records them into the same map, so a symbol whose
 * last live caller sat inside a kept-but-unreached function had that caller deleted on
 * paper and was promoted from "decide separately" to "delete it in the same commit as
 * its route". horizonValue() printed at depth 3 with live sites at roster-risk.js:190
 * and waiver-brain.js:155, :181, :401, :434, and :401 and :434 are inside sellHigh,
 * which routes/trades.js:203 keeps deliberately. Nothing in this report deletes
 * sellHigh, so nothing in this report may spend its calls.
 *
 * The cost of being right here is a symbol whose only caller is inside an
 * already-unreached function now has a surviving caller and is not reported at all.
 * That is the safe direction: under-reporting sends somebody to read a file, and
 * over-reporting sends them to delete one.
 */
const insideFalling = (site) => [...falls.values()]
  .filter(f => f.bucket === 'falls')
  .some(f => f.file === site.file && site.line >= f.from && site.line <= f.to);

/**
 * The other half of the same correction. A call site inside a function that is itself
 * unreached is a SURVIVOR — nothing here deletes it — and it is not a reason to keep
 * the symbol alive either. Excluding such rows from insideFalling and stopping there
 * made positionLiquidity(), the case this whole report was written for, vanish from it:
 * its other call site is inside shoppingGuidance(), which nothing calls, so it acquired
 * a "surviving" caller and dropped out of the list entirely. Silence is the one answer
 * a deletion report must never give. Those symbols get their own section.
 */
const insideDeadCode = (site) => [...falls.values()]
  .filter(f => f.bucket !== 'falls')
  .some(f => f.file === site.file && site.line >= f.from && site.line <= f.to);

/**
 * The call sites that would still be there after the deletion.
 *
 * Tests are excluded, and that judgement is unchanged: a test is not a reason for
 * production code to exist, so a symbol whose only remaining callers are tests still
 * falls. What changes is that the exclusion is now real — see callSites() — and that
 * the tests it drops are reported rather than discarded, by testSites() below.
 */
function survivors(name) {
  return callSites(name).filter(s => !isTestPath(s.file)
    && !insideDoomed(s) && !insideFalling(s));
}

/**
 * The tests that reach this symbol. Not survivors, and not nothing either: deleting the
 * symbol deletes these assertions, and whoever does it should decide that on purpose
 * rather than find out when the suite goes red.
 */
function testSites(name) {
  return callSites(name).filter(s => isTestPath(s.file));
}

/**
 * A TOP-LEVEL DECLARATION, not any `const name =` in the file.
 *
 * functionBody's regex matches a declaration anywhere, and walk() recurses without the
 * cross-module check the top-level loop applies, so a closure declared inside the
 * function being walked became a row of its own: countAt, a closure inside
 * waiverUpgrades used at :242 and :334 and nowhere else, printed beside real module
 * symbols in a list meant to be read line by line. A closure inside a dying function
 * goes with it; it is not a separate decision.
 */
function moduleSymbol(file, name) {
  return new RegExp(`^(?:export\\s+)?(?:async\\s+)?(?:function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\s*=)`, 'm')
    .test(read(file));
}

/**
 * `why` here is the chain that HAPPENED to reach this symbol first. It is not the whole
 * answer to "which routes reach it" and must not be read as one — see the attribution
 * pass below, which asks that question again once the fixpoint has settled.
 */
function record(name, file, depth, why, bucket = 'falls', heldBy = []) {
  const body = functionBody(file, name);
  if (!body) return false;
  falls.set(`${file}#${name}`, { name, file, depth, why, bucket, heldBy, line: body.line,
    tests: testSites(name),
    from: body.line, to: body.line + body.text.split('\n').length - 1 });
  return true;
}

function walk(name, fromFile, depth, why) {
  if (depth > MAX_DEPTH) return;
  const imports = repoImports(fromFile);
  const declaredIn = imports.get(name) ?? fromFile;
  const file = declaredIn.endsWith('.js') ? declaredIn : `${declaredIn}.js`;
  if (!fs.existsSync(path.join(ROOT, file))) return;
  if (!imports.has(name) && !moduleSymbol(file, name)) return;
  if (falls.has(`${file}#${name}`)) return;
  if (survivors(name).length) return;               // something still calls it: the chain stops
  if (!record(name, file, depth, why)) return;
  const body = functionBody(file, name);
  for (const next of called(body.text)) walk(next, file, depth + 1, `${why} → ${name}()`);
}

for (const d of doomed) {
  const imports = repoImports(d.file);
  for (const name of called(d.text)) {
    if (!imports.has(name)) continue;               // only cross-module symbols matter here
    walk(name, d.file, 1, d.route);
  }
}

/*
 * THE FIXPOINT, which is the whole point of the report.
 *
 * Marking one function as falling can strip the last surviving caller from another,
 * and that one from a third. Walking forward from the handlers once finds only the
 * first layer of that. `shoppingGuidance()` is the case: its only call site is inside
 * `positionLiquidity()`'s neighbour, and nothing calls IT either, so neither shows up
 * until the other has been decided. Repeat until nothing changes.
 *
 * A function with zero surviving callers that this pass finds, rather than the forward
 * walk, was already unreached before any of these deletions — its `depth` is 0 and it
 * is labelled as such, because telling somebody a route deletion killed something that
 * was already dead would be a false accusation against the deletion.
 */
/*
 * A FUNCTION, not every exported name. Written as `export const X =` this matched
 * `export const db = new DatabaseSync(...)` and `export const CANDIDATES = {...}`, and
 * since nothing ever writes `db(` or `CANDIDATES(`, both came back with zero call
 * sites and were reported as unreached. Neither is a function and neither is
 * unreached: `db` is the database handle the whole server uses as `db.prepare(...)`.
 * That is 126 rows of which a large share were noise, which is how a report stops
 * being read. An exported const only counts here when it is followed by a function
 * form: an arrow, or the `async`/`function` keyword.
 */
const EXPORT_DECL = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;
/*
 * The candidate set is every module a dying handler imports from, not only the files
 * something has already fallen in. `positionLiquidity()` is why: its handler at
 * trades.js:241 is dying, but its other call site sits inside `shoppingGuidance()`,
 * which is not yet known to be falling — so the forward walk stops, and a fixpoint
 * that only revisited files already in `falls` would never look at that module at all.
 */
const candidateFiles = new Set([...falls.values()].map(f => f.file));
for (const d of doomed) for (const [, target] of repoImports(d.file)) {
  const file = target.endsWith('.js') ? target : `${target}.js`;
  if (fs.existsSync(path.join(ROOT, file))) candidateFiles.add(file);
}
let changed = true;
while (changed) {
  changed = false;
  for (const file of candidateFiles) {
    for (const m of read(file).matchAll(EXPORT_DECL)) {
      const name = m[1] ?? m[2];
      if (!name || falls.has(`${file}#${name}`)) continue;
      // Three answers, not two. Alive callers that are all inside unreached code is a
      // THIRD state: the symbol is not falling with any route, and it is not reached
      // either. Collapsing it into "falls" deletes live code; collapsing it into
      // "already unreached" is a lie about why; dropping it prints nothing at all.
      const alive = survivors(name);
      if (alive.length && !alive.every(insideDeadCode)) continue;
      const heldBy = alive.length
        ? [...new Set(alive.map(a => {
            const holder = [...falls.values()].find(f => f.bucket !== 'falls'
              && f.file === a.file && a.line >= f.from && a.line <= f.to);
            return holder ? `${holder.file}:${a.line} inside ${holder.name}()` : `${a.file}:${a.line}`;
          }))]
        : [];
      const sites = callSites(name).filter(s => !isTestPath(s.file));
      // Provenance, in the order that makes it true. A symbol a dying HANDLER calls is
      // killed by that route. A symbol only a FALLING function calls inherits that
      // function's chain, one deeper. A symbol with neither was already unreached
      // before any of this, and saying a deletion killed it would be a false
      // accusation against the deletion.
      const viaRoute = doomed.find(d => sites.some(x => x.file === d.file && x.line >= d.from && x.line <= d.to));
      // Same rule as insideFalling: an already-unreached function is not being deleted,
      // so it cannot be the reason another symbol is.
      const viaFn = [...falls.values()].filter(f => f.bucket === 'falls')
        .find(f => sites.some(x => x.file === f.file && x.line >= f.from && x.line <= f.to));
      const why = viaRoute ? viaRoute.route
        : viaFn ? `${viaFn.why} → ${viaFn.name}()`
        : null;
      const depth = viaRoute ? 1 : viaFn ? viaFn.depth + 1 : 0;
      const bucket = alive.length ? 'dead-callers' : why ? 'falls' : 'already';
      if (record(name, file, depth, why ?? 'ALREADY-UNREACHED', bucket, heldBy)) changed = true;
    }
  }
}

/*
 * WHICH DYING ROUTES REACH THIS SYMBOL — all of them, computed after the fixpoint has
 * settled rather than written down as the walk goes.
 *
 * Merging a reason at record() time is not enough, because the answer depends on the
 * order the dying routes happen to be walked in. freeAgents() is called directly by the
 * handler of GET /api/trades/:leagueId/brain/free-agents AND, through byePatches(), by
 * GET /api/trades/:leagueId/brain/bye-risk. The free-agents route is walked FIRST, at
 * which point freeAgents still has surviving callers and nothing is recorded; by the
 * time the bye-risk chain makes it fall, that route has been and gone. So it printed
 * "reached only through: GET .../brain/bye-risk → byePatches()" — true, and missing the
 * route whose handler names it on one line.
 *
 * This pass asks the question from the other end and is order-independent: for every
 * row, which dying handlers contain a call site, and which other falling functions do,
 * and what reaches those. Repeat until nothing changes.
 */
for (const r of falls.values()) {
  r.viaRoutes = new Set();
  r.sites = callSites(r.name).filter(s => !isTestPath(s.file));
  if (r.bucket !== 'falls') continue;
  for (const d of doomed) {
    if (r.sites.some(x => x.file === d.file && x.line >= d.from && x.line <= d.to)) r.viaRoutes.add(d.route);
  }
}
let spread = true;
while (spread) {
  spread = false;
  for (const r of falls.values()) {
    if (r.bucket !== 'falls') continue;
    for (const f of falls.values()) {
      if (f === r || f.bucket !== 'falls') continue;
      if (!r.sites.some(x => x.file === f.file && x.line >= f.from && x.line <= f.to)) continue;
      for (const route of f.viaRoutes) if (!r.viaRoutes.has(route)) { r.viaRoutes.add(route); spread = true; }
    }
  }
}

const rows = [...falls.values()].sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));
const byFile = new Map();
for (const r of rows) { if (!byFile.has(r.file)) byFile.set(r.file, []); byFile.get(r.file).push(r); }

const o = [];
o.push('# What falls when these routes are cut');
o.push('');
o.push(`Branch \`${branch}\`, head \`${head}\`. Generated by \`scripts/route-deletion-impact.mjs\` from \`docs/wiring/wiring-map.json\`.`);
o.push('');
o.push(`Routes their owners ruled kept (${[...KEEP].join(', ')}) are excluded: they are not being deleted, so nothing falls with them.`);
o.push('');
o.push(`Read this BEFORE deleting a route, not after. Every function below is live right now — live through a route that is about to go. ${rows.length} of them, across ${byFile.size} files, from ${doomed.length} routes on the dead list.`);
o.push('');
o.push('**depth** is how far the chain runs. Depth 1 is called directly by a dying handler. Depth 2 is called only by something at depth 1, and so on. A chain longer than 1 is the case this report exists for: a one-level sweep deletes the route, leaves depth 2 alive with nothing calling it, and nobody finds out until somebody reads that file for another reason.');
o.push('');
o.push('**What this cannot see**, and a deletion is not reversible by reading: a call made through a dynamic name, a function reached only by a string in a dispatch table, and any caller outside this repository. This narrows the search; it does not end it.');
o.push('');
const fell = rows.filter(r => r.bucket === 'falls');
const held = rows.filter(r => r.bucket === 'dead-callers');
const already = rows.filter(r => r.bucket === 'already');

o.push(`## Falls with the deletion — ${fell.length} symbol(s)`);
o.push('');
o.push('Each of these is live today, reached through a route on the dead list and through nothing else. Delete it in the same commit as its route, or say why it stays.');
o.push('');
/** Five is enough to see the shape; the rest is a grep away and makes the row unreadable. */
const someTests = (tests) => {
  const shown = tests.slice(0, 5).map(t => `\`${t.file}:${t.line}\``).join(', ');
  return tests.length > 5 ? `${shown}, and ${tests.length - 5} more` : shown;
};

const group = (list) => {
  const m = new Map();
  for (const r of list) { if (!m.has(r.file)) m.set(r.file, []); m.get(r.file).push(r); }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
};
if (!fell.length) o.push('_Nothing: every symbol these handlers call has a caller that survives them._');
for (const [file, list] of group(fell)) {
  o.push(`### ${file}`);
  o.push('');
  for (const r of list.sort((a, b) => a.depth - b.depth)) {
    o.push(`- \`${r.name}()\` — **depth ${r.depth}**, declared at \`${file}:${r.line}\``);
    o.push(`  - reached through: ${r.why}`);
    if (r.viaRoutes.size > 1) {
      o.push(`  - **and by ${r.viaRoutes.size} dying routes in total**, not just that one: `
        + [...r.viaRoutes].sort().map(x => `\`${x}\``).join(', ')
        + ' — so it survives until the LAST of them goes, and no single owner deletes it alone');
    }
    if (r.tests?.length) {
      o.push(`  - **and by ${r.tests.length} test(s), which go with it**: `
        + someTests(r.tests));
    }
  }
  o.push('');
}

o.push(`## Reached only from code that is itself unreached — ${held.length} symbol(s)`);
o.push('');
o.push('A third answer, and it took two wrong ones to find it. These have a caller that this deletion does NOT remove — so they are not falling with a route, and nothing here says cut them — but that caller is itself reached by nothing. `positionLiquidity()` is the case: its handler is dying and its other call site sits inside `shoppingGuidance()`, which nothing calls. Reporting it as falling tells somebody to delete live code; reporting it as already unreached is a lie about why; leaving it out prints nothing at all, which is the one answer a deletion report must never give.');
o.push('');
o.push('Each row names the caller that holds it up. Read that caller first: if it goes, this comes with it, and if it stays, this stays.');
o.push('');
if (!held.length) o.push('_None._');
for (const [file, list] of group(held)) {
  o.push(`### ${file}`);
  o.push('');
  for (const r of list.sort((a, b) => a.depth - b.depth)) {
    o.push(`- \`${r.name}()\` — declared at \`${file}:${r.line}\``);
    o.push(`  - a dying route reaches it: ${r.why}`);
    o.push(`  - and it is held up by: ${r.heldBy.map(h => `\`${h}\``).join(', ')}`);
    if (r.tests?.length) o.push(`  - tests calling it: ${someTests(r.tests)}`);
  }
  o.push('');
}

const seams = already.filter(r => r.tests?.length);
const nothing = already.filter(r => !r.tests?.length);

o.push(`## Already unreached, BEFORE any of this — ${already.length} symbol(s)`);
o.push('');
o.push('These are exported from the same modules and have no production caller in the repository today, with or without the deletions. **The route deletions did not cause these and must not be blamed for them.** They are here because whoever opens these files to delete the section above should see them in the same pass rather than meeting them later as a surprise.');
o.push('');
o.push('They are split, because they are not the same thing and this report used to print them as one list. An export a test calls is a TEST SEAM: it is reached, the suite depends on it, and deleting it deletes those assertions. An export nothing calls at all is reached by nothing. Both still need their owner\'s verdict; only the second one is free.');
o.push('');

o.push(`### Reached by tests only — ${seams.length} symbol(s)`);
o.push('');
o.push('Live under test and dead in production. Deleting one of these is a decision about the test as much as about the code, so it is made deliberately or not at all.');
o.push('');
if (!seams.length) o.push('_None._');
for (const [file, list] of group(seams)) {
  o.push(`**${file}**`);
  o.push('');
  for (const r of list) {
    o.push(`- \`${r.name}()\` — declared at \`${file}:${r.line}\``);
    o.push(`  - called by: ${someTests(r.tests)}`);
  }
  o.push('');
}

o.push(`### No caller at all — ${nothing.length} symbol(s)`);
o.push('');
o.push('Not production code, not a test seam. Nothing in this repository names these.');
o.push('');
if (!nothing.length) o.push('_None._');
for (const [file, list] of group(nothing)) {
  o.push(`**${file}**`);
  o.push('');
  for (const r of list) o.push(`- \`${r.name}()\` — declared at \`${file}:${r.line}\``);
  o.push('');
}
// OUT so a test can point this at a fixture tree and read what it wrote. The four
// guards this file used to carry were assertions about its own SOURCE TEXT — they
// pinned the shape of a regex, not the answer the report gives — and three real
// defects went through them untouched.
fs.writeFileSync(process.env.OUT || '/mnt/project-files/route-deletion-impact.md', o.join('\n') + '\n');
console.log(`${rows.length} symbols across ${byFile.size} files, from ${doomed.length} dying routes`);
