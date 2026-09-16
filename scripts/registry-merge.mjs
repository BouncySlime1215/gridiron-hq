/**
 * Merge docs/betting-model/registry/rows-*.csv into MODEL-REGISTRY.csv and a
 * self-contained, filterable MODEL-REGISTRY.html. Validates every file's
 * header against SCHEMA.md's column list, normalises entry_point to a clean
 * `file:line` (agents sometimes append "(fn); also ..." notes -- kept in a
 * separate `entry_note` column, never lost), dedupes on id (first file wins,
 * duplicates reported), and refuses to run if any header is wrong.
 *
 * Usage: node scripts/registry-merge.mjs   (no database, no env)
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'docs/betting-model/registry';
const COLS = ['id','name','kind','domain','file','entry_point','predicts','inputs_tables','inputs_features',
  'upstream_models','technique','evaluation_harness','tests','measured_results','known_failures',
  'improvement_options','status','point_in_time_safe','reads_closing_market','last_verified'];

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
}
const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

const files = fs.readdirSync(DIR).filter(f => /^rows-.*\.csv$/.test(f)).sort();
if (!files.length) { console.error('no rows-*.csv found'); process.exit(1); }
const merged = new Map(); const dupes = []; const perFile = {};
for (const f of files) {
  const rows = parseCsv(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const header = rows[0].map(h => h.trim());
  const missing = COLS.filter(c => !header.includes(c));
  if (missing.length) { console.error(`${f}: header missing ${missing.join(',')}`); process.exit(1); }
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  perFile[f] = 0;
  for (const r of rows.slice(1)) {
    const obj = Object.fromEntries(COLS.map(c => [c, (r[idx[c]] ?? '').trim()]));
    // normalise entry_point -> file:line + note
    const m = /^([^\s:]+):(\d+)(.*)$/.exec(obj.entry_point);
    obj.entry_note = m ? m[3].trim().replace(/^[\s(;,-]+/, '') : (obj.entry_point && !/:\d+$/.test(obj.entry_point) ? obj.entry_point : '');
    obj.entry_point = m ? `${m[1]}:${m[2]}` : obj.entry_point;
    obj.source_file = f;
    if (!obj.id) continue;
    if (merged.has(obj.id)) { dupes.push(`${obj.id} (${f} vs ${merged.get(obj.id).source_file})`); continue; }
    merged.set(obj.id, obj); perFile[f]++;
  }
}
const OUT_COLS = [...COLS, 'entry_note', 'source_file'];
const all = [...merged.values()].sort((a, b) => (a.kind + a.domain + a.id).localeCompare(b.kind + b.domain + b.id));
fs.writeFileSync(path.join(DIR, 'MODEL-REGISTRY.csv'), [OUT_COLS.join(','), ...all.map(o => OUT_COLS.map(c => esc(o[c])).join(','))].join('\n') + '\n');

// HTML: one self-contained page, text filter + per-column dropdowns + click-to-sort
const counts = {}; for (const o of all) counts[o.kind] = (counts[o.kind] ?? 0) + 1;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Model Registry</title>
<style>:root{--bg:#fff;--fg:#111;--mut:#666;--line:#ddd;--hi:#fff7d6}@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#111;--fg:#eee;--mut:#999;--line:#333;--hi:#3a3200}}
body{background:var(--bg);color:var(--fg);font:13px/1.4 system-ui,sans-serif;margin:16px}h1{font-size:18px;margin:0 0 6px}.mut{color:var(--mut)}
.bar{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}input,select{font:inherit;padding:4px 6px;background:var(--bg);color:var(--fg);border:1px solid var(--line)}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--line);padding:4px 6px;vertical-align:top;text-align:left}th{cursor:pointer;position:sticky;top:0;background:var(--bg)}
td{max-width:340px;overflow-wrap:anywhere}tr:hover td{background:var(--hi)}.k{white-space:nowrap}.small{font-size:11px}</style></head><body>
<h1>Gridiron HQ — Model Registry</h1><div class="mut">${all.length} rows · ${Object.entries(counts).map(([k,v])=>`${k}: ${v}`).join(' · ')} · generated ${new Date().toISOString().slice(0,10)} · source: docs/betting-model/registry/rows-*.csv</div>
<div class="bar"><input id="q" placeholder="filter any text…" size="40">
<select id="kind"><option value="">kind: all</option>${[...new Set(all.map(o=>o.kind))].sort().map(k=>`<option>${k}</option>`).join('')}</select>
<select id="domain"><option value="">domain: all</option>${[...new Set(all.map(o=>o.domain))].sort().map(k=>`<option>${k}</option>`).join('')}</select>
<select id="status"><option value="">status: all</option>${[...new Set(all.map(o=>o.status))].sort().map(k=>`<option>${k}</option>`).join('')}</select>
<select id="pit"><option value="">point-in-time: all</option>${[...new Set(all.map(o=>o.point_in_time_safe.split(/[ —-]/)[0]))].sort().map(k=>`<option>${k}</option>`).join('')}</select>
<span class="mut" id="n"></span></div>
<table id="t"><thead><tr>${OUT_COLS.map(c=>`<th data-c="${c}">${c}</th>`).join('')}</tr></thead><tbody>
${all.map(o=>`<tr>${OUT_COLS.map(c=>`<td class="${c==='id'||c==='kind'||c==='domain'||c==='status'?'k':''}">${String(o[c]??'').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</td>`).join('')}</tr>`).join('\n')}
</tbody></table>
<script>
const rows=[...document.querySelectorAll('#t tbody tr')],cols=${JSON.stringify(OUT_COLS)};
const cell=(r,c)=>r.children[cols.indexOf(c)].textContent;
function apply(){const q=document.getElementById('q').value.toLowerCase(),k=kind.value,d=domain.value,s=status.value,p=pit.value;let n=0;
for(const r of rows){const ok=(!q||r.textContent.toLowerCase().includes(q))&&(!k||cell(r,'kind')===k)&&(!d||cell(r,'domain')===d)&&(!s||cell(r,'status')===s)&&(!p||cell(r,'point_in_time_safe').startsWith(p));r.style.display=ok?'':'none';if(ok)n++;}
document.getElementById('n').textContent=n+' shown';}
for(const id of ['q','kind','domain','status','pit'])document.getElementById(id).addEventListener('input',apply);apply();
let asc=true;document.querySelectorAll('th').forEach(th=>th.addEventListener('click',()=>{const c=th.dataset.c;asc=!asc;const tb=document.querySelector('#t tbody');
[...tb.children].sort((a,b)=>asc?cell(a,c).localeCompare(cell(b,c)):cell(b,c).localeCompare(cell(a,c))).forEach(r=>tb.appendChild(r));}));
</script></body></html>`;
fs.writeFileSync(path.join(DIR, 'MODEL-REGISTRY.html'), html);
console.log(JSON.stringify({ files: perFile, merged: all.length, duplicates: dupes, by_kind: counts }, null, 1));
