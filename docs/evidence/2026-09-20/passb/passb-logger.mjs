// Pass B instrument: record every (regex, subject) pair that reaches
// assert.match / assert.doesNotMatch, so each alternation branch can be
// re-tested against the real fixture without re-running the suite per branch.
import fs from 'node:fs';
import strict from 'node:assert/strict';
import loose from 'node:assert';

const OUT = process.env.PASSB_OUT;
const lines = [];
process.on('exit', () => {
  if (lines.length) fs.appendFileSync(OUT, lines.join('\n') + '\n');
});

const seen = new Set();
function record(kind, re, subject) {
  if (!(re instanceof RegExp)) return;
  if (typeof subject !== 'string') return;
  const dedupe = kind + '\u0000' + re.source + '\u0000' + subject.slice(0, 200);
  if (seen.has(dedupe)) return;
  seen.add(dedupe);
  const site = (new Error().stack || '').split('\n')
    .find((l) => l.includes('/test/') && l.includes('.test.js')) || '';
  lines.push(JSON.stringify({
    kind,
    src: re.source,
    flags: re.flags,
    subject: subject.length > 4000 ? subject.slice(0, 4000) : subject,
    site: site.trim().slice(0, 200)
  }));
}

for (const mod of [strict, loose]) {
  for (const name of ['match', 'doesNotMatch']) {
    const orig = mod[name];
    if (typeof orig !== 'function') continue;
    mod[name] = function wrapped(subject, re, ...rest) {
      record(name, re, subject);
      return orig.call(this, subject, re, ...rest);
    };
  }
}

// Second instrument: RegExp.prototype.test, which catches the alternation sites
// that sit inside `.some(...)` or a bare `if` and never reach assert.match.
// Guarded hard: this runs on every regex test in the process, production code
// included, so it must cost nothing on the overwhelming majority of calls.
const origTest = RegExp.prototype.test;
let budget = 200000;
RegExp.prototype.test = function (subject) {
  if (budget > 0 && typeof subject === 'string' && this.source.includes('|')) {
    budget -= 1;
    try { record('regexp.test', this, subject); } catch { /* recording never changes a result */ }
  }
  return origTest.call(this, subject);
};
