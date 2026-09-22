/**
 * Why was_pressure cannot be stored as it is read.
 *
 * Downloads one season of nflverse participation and measures how many rows
 * carry a was_pressure value on a play that was never a dropback. Free data,
 * no key. Usage: node docs/evidence/participation-dropback-contamination.mjs 2024
 */
const season = process.argv[2] ?? '2024';
const url = `https://github.com/nflverse/nflverse-data/releases/download/pbp_participation/pbp_participation_${season}.csv`;
const res = await fetch(url);
if (!res.ok) throw new Error(`participation ${season} -> HTTP ${res.status}`);
const text = await res.text();

const split = line => {
  const out = []; let cur = '', q = false;
  for (const c of line) {
    if (c === '"') { q = !q; continue; }
    if (c === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur); return out;
};
const lines = text.split('\n').filter(l => l.trim());
const idx = Object.fromEntries(split(lines[0]).map((h, i) => [h.trim(), i]));
const rows = lines.slice(1).map(split);
const get = (r, k) => (idx[k] == null ? '' : (r[idx[k]] ?? '')).trim();
const blank = v => v === '';
const dropback = r => !blank(get(r, 'defense_coverage_type')) || !blank(get(r, 'defense_man_zone_type'));

const pres = rows.filter(r => !blank(get(r, 'was_pressure')));
const presNo = pres.filter(r => !dropback(r));
const rate = s => s.filter(r => get(r, 'was_pressure') === 'TRUE').length / s.length;

console.log(`participation ${season}: ${rows.length} rows\n`);
console.log(`was_pressure non-blank            ${pres.length}`);
console.log(`  on a charted dropback           ${pres.length - presNo.length}`);
console.log(`  NOT a dropback                  ${presNo.length}  (${(presNo.length / pres.length * 100).toFixed(1)}%)`);
console.log(`  of those, reading TRUE          ${presNo.filter(r => get(r, 'was_pressure') === 'TRUE').length}`);
console.log(`\npressure rate over every non-blank row  ${rate(pres).toFixed(4)}`);
console.log(`pressure rate over dropbacks only      ${rate(pres.filter(dropback)).toFixed(4)}`);

// Why the discriminator is coverage and not time_to_throw.
const sacky = rows.filter(r => dropback(r) && blank(get(r, 'time_to_throw')));
console.log(`\ncharted dropbacks with no time_to_throw (sacks, scrambles)  ${sacky.length}`);
console.log(`  of those, pressured   ${sacky.filter(r => get(r, 'was_pressure') === 'TRUE').length}` +
  `  (${(sacky.filter(r => get(r, 'was_pressure') === 'TRUE').length / sacky.length * 100).toFixed(0)}%)`);
console.log('  -> gating on time_to_throw would delete the pressure signal where it is strongest.');

// The same shape, already live in two stored columns.
const nb = k => rows.filter(r => !blank(get(r, k)));
const mean = (s, k) => s.reduce((a, r) => a + Number(get(r, k)), 0) / s.length;
for (const k of ['number_of_pass_rushers', 'defenders_in_box']) {
  const all = nb(k), drop = all.filter(dropback);
  console.log(`\n${k}: zeros ${all.filter(r => get(r, k) === '0').length} of ${all.length}`);
  console.log(`  mean over every non-blank row  ${mean(all, k).toFixed(4)}`);
  console.log(`  mean over dropbacks only       ${mean(drop, k).toFixed(4)}`);
}
