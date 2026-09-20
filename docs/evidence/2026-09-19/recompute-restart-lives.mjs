/**
 * Rebuilds every figure quoted about the 2026-09-19 restart cycle from the raw
 * probe beside this file, so none of them has to be taken on trust.
 *
 *   node docs/evidence/2026-09-19/recompute-restart-lives.mjs
 *
 * The input is `health-uptime-poll.txt`: cache-busted GETs of /api/health from
 * outside the app, one line per poll, `[000]` meaning no response inside a
 * 20-second budget. It is the ONLY surviving copy of that measurement, which is
 * why it is in the repository rather than in a container's /tmp.
 *
 * THE COUNTING RULE, and the reason this script exists at all. A restart is
 * where `uptime_s` DROPS -- not where the probe goes dark. A blocked event loop
 * stops answering and then answers again inside the same life, so counting dark
 * windows as restarts overcounts them. Figures published before this rule was
 * written down could not be reproduced and were withdrawn (see the Correction
 * blocks on PRs #56 and #59).
 *
 * Boot is estimated as a read's timestamp minus that read's own `uptime_s`.
 * That is deliberately boot-relative: the gap from one life's last answer to
 * the next life's FIRST ANSWER includes the platform's routing grace period
 * (`fly.toml`, 60s at the time of this measurement and 300s after PR #49), so
 * it is partly a measurement of the host rather than of the app. Boot-to-boot
 * and last-answer-to-next-boot carry no grace at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const lines = fs.readFileSync(path.join(HERE, 'health-uptime-poll.txt'), 'utf8').trim().split('\n');

const parse = (l) => {
  const m = l.match(/^(\d\d):(\d\d):(\d\d)Z/);
  if (!m) throw new Error(`unparseable probe line: ${l}`);
  const u = /uptime_s":(\d+)/.exec(l);
  return {
    t: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]),
    hh: `${m[1]}:${m[2]}:${m[3]}`,
    u: u ? Number(u[1]) : null,   // null = the poll went dark
  };
};
const fmt = (s) => new Date(s * 1000).toISOString().slice(11, 19);

const rows = lines.map(parse);
const answered = rows.filter((r) => r.u !== null);

// Split into lives at every drop in uptime_s.
const lives = [];
let current = [];
for (const r of answered) {
  if (current.length && r.u < current[current.length - 1].u) { lives.push(current); current = []; }
  current.push(r);
}
lives.push(current);

const boots = lives.map((L) => L[0].t - L[0].u);

console.log(`window ${rows[0].hh}-${rows[rows.length - 1].hh}  polls ${rows.length}  answered ${answered.length}`);
console.log(`lives ${lives.length}`);
for (const [i, L] of lives.entries()) {
  const first = L[0], last = L[L.length - 1];
  console.log(`  life ${i + 1}: boot~${fmt(boots[i])}  first ${first.hh} u=${first.u}`
    + `  last ${last.hh} u=${last.u}  answered=${L.length}`);
}
console.log(`last uptime_s per life: ${lives.map((L) => L[L.length - 1].u).join(', ')}`);
console.log(`boot-to-boot (s): ${boots.slice(1).map((b, i) => b - boots[i]).join(', ')}`);
console.log(`last answer -> next boot (s): `
  + lives.slice(1).map((L, i) => boots[i + 1] - lives[i][lives[i].length - 1].t).join(', '));
console.log(`last answer -> next answer (s, INCLUDES routing grace): `
  + lives.slice(1).map((L, i) => L[0].t - lives[i][lives[i].length - 1].t).join(', '));
console.log('\nThe first interval spans a dark stretch long enough to hide a whole life,');
console.log('so it is excluded from anything published. Every other figure above is quoted as measured.');
