// Pass B analyser. For each (regex, subject) pair captured from a passing
// assert.match, find every alternation in the pattern and test each branch
// ALONE against the real subject. A branch that matches no subject the
// assertion ever sees is dead: it can be deleted without the test noticing.
import fs from 'node:fs';

const rows = fs.readFileSync(process.argv[2], 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Scan a pattern and return the alternation regions: for each, the span of the
// whole alternation and the spans of its branches. Handles escapes, character
// classes and nesting.
function alternations(src) {
  const out = [];
  // stack frames: { start, bars: [] } ; frame 0 is the whole pattern
  const stack = [{ start: 0, bars: [], end: src.length, isGroup: false }];
  let i = 0, inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (inClass) { if (c === ']') inClass = false; i += 1; continue; }
    if (c === '[') { inClass = true; i += 1; continue; }
    if (c === '(') { stack.push({ start: i + 1, bars: [], isGroup: true }); i += 1; continue; }
    if (c === ')') {
      const f = stack.pop();
      if (f) { f.end = i; if (f.bars.length) out.push(f); }
      i += 1; continue;
    }
    if (c === '|') { stack[stack.length - 1].bars.push(i); i += 1; continue; }
    i += 1;
  }
  while (stack.length) { const f = stack.pop(); if (f.bars.length) { f.end = f.end ?? src.length; out.push(f); } }
  return out.map((f) => {
    const cuts = [f.start, ...f.bars, f.end];
    const branches = [];
    for (let k = 0; k < cuts.length - 1; k += 1) {
      const from = k === 0 ? cuts[0] : cuts[k] + 1;
      branches.push({ from, to: cuts[k + 1], text: src.slice(from, cuts[k + 1]) });
    }
    // a group opening with (?: (?= (?! (?<= (?<! keeps its prefix on branch 0
    return { start: f.start, end: f.end, branches };
  });
}

function reduceTo(src, alt, branch) {
  let head = '';
  const first = alt.branches[0].text;
  const m = /^\?(:|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(first);
  if (m && branch.from !== alt.branches[0].from) head = m[0];
  return src.slice(0, alt.start) + head + branch.text + src.slice(alt.end);
}

// group subjects by (kind, src, flags, site)
const byKey = new Map();
for (const r of rows) {
  const k = JSON.stringify([r.kind, r.src, r.flags, r.site]);
  if (!byKey.has(k)) byKey.set(k, { ...r, subjects: [] });
  byKey.get(k).subjects.push(r.subject);
}

const dead = [];
const skipped = [];
let checked = 0, live = 0;
for (const g of byKey.values()) {
  const alts = alternations(g.src);
  if (!alts.length) continue;
  if (g.kind === 'doesNotMatch') { skipped.push(g); continue; }
  for (const alt of alts) {
    for (const b of alt.branches) {
      const reduced = reduceTo(g.src, alt, b);
      let re;
      try { re = new RegExp(reduced, g.flags.replace(/[gy]/g, '')); }
      catch { continue; }
      checked += 1;
      const hit = g.subjects.some((s) => re.test(s));
      if (hit) live += 1;
      else dead.push({ src: g.src, flags: g.flags, branch: b.text, reduced, site: g.site, nSubjects: g.subjects.length, sample: g.subjects[0].slice(0, 120) });
    }
  }
}

console.log(`# assertion sites with an alternation: ${byKey.size ? [...byKey.values()].filter((g) => alternations(g.src).length).length : 0}`);
console.log(`# branches tested: ${checked}   live: ${live}   DEAD: ${dead.length}`);
console.log(`# doesNotMatch sites skipped (every branch matches nothing by design): ${skipped.length}`);
console.log('');
const byFile = new Map();
for (const d of dead) {
  const f = (/\(?([^() ]*\/test\/[^:)]+):(\d+)/.exec(d.site) || [])[1] || '?';
  const ln = (/\(?([^() ]*\/test\/[^:)]+):(\d+)/.exec(d.site) || [])[2] || '?';
  const key = `${f.replace(/^.*\/test\//, 'test/')}:${ln}`;
  if (!byFile.has(key)) byFile.set(key, []);
  byFile.get(key).push(d);
}
for (const [k, ds] of [...byFile.entries()].sort()) {
  console.log(`--- ${k}`);
  console.log(`    /${ds[0].src}/${ds[0].flags}`);
  for (const d of ds) console.log(`    DEAD branch: ${JSON.stringify(d.branch)}   (${d.nSubjects} subject(s) seen)`);
  console.log(`    subject seen: ${JSON.stringify(ds[0].sample)}`);
}
