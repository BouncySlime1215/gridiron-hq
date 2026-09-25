// NAMES-LEAK (night 10): league-mate and manager names never leave Nick's machine.
// plans.json carries them on purpose (TEAM-NAMES-2: Nick reads the manager he knows), so the
// denylist is built at run time from that file's own `teams` map and never written down. This
// test uses made-up names only; the repository is public.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  denylistFromPlans, scanPlansText, scanText, scanFiles, genericLabel, fieldCounts, trackedFiles
} from '../scripts/check-names-leak.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

// Made-up league: roster 7 "Marmot Mayhem" run by "Zedquill", roster 1 "The Fjords" run by "Orvella".
const plans = () => ({
  schema: 'warroom-plans/1',
  leagues: [{
    league: 4, me: '5',
    names: { 290: 'Chris Olave (WR)' },
    teams: { status: 'ok', source: 'campaign.plan', value: {
      7: { name: 'Marmot Mayhem', manager: 'Zedquill' },
      1: { name: 'The Fjords', manager: 'Orvella' },
      3: { name: 'Team 3' },
      9: { manager: 'Al' }
    } },
    flip_map: { status: 'ok', value: [
      { why: 'Buy Chris Olave from Zedquill, sell him to The Fjords.' },
      { why: 'Marmot Mayhem is thin at WR.' }
    ] },
    next_move: { status: 'unknown', reason: 'Nothing clears; Team 3 and zedquill both said no.' },
    targets: { status: 'ok', value: [{ his_side: 'There is no read of Team 3.' }] }
  }]
});

test('denylist comes from the teams map, skips generic labels and very short tokens', () => {
  const deny = denylistFromPlans(plans());
  const rosters = deny.map(d => `${d.roster}:${d.kind}`).sort();
  assert.deepEqual(rosters, ['1:manager', '1:team', '7:manager', '7:team']);
  assert.equal(genericLabel('Team 3'), true);
  assert.equal(genericLabel('Team 12'), true);
  assert.equal(genericLabel('Marmot Mayhem'), false);
});

test('plans text scan finds every name outside the teams map and reports roster ids, never the name', () => {
  const doc = plans();
  const hits = scanPlansText(doc, denylistFromPlans(doc));
  assert.equal(hits.length, 4); // Zedquill, The Fjords, Marmot Mayhem, zedquill (case-insensitive)
  assert.ok(hits.every(h => h.path.startsWith('$.leagues[0].') && !h.path.includes('.teams')));
  const out = JSON.stringify(hits);
  for (const n of ['Zedquill', 'zedquill', 'Fjords', 'Marmot', 'Orvella']) assert.ok(!out.includes(n), `hit report must not carry ${n}`);
  assert.deepEqual(fieldCounts(hits), { flip_map: 3, next_move: 1 });
});

test('word boundaries: a name inside a longer word is not a hit', () => {
  const deny = [{ term: 'Orvella', roster: '1', kind: 'manager', league: 4 }];
  assert.equal(scanText('Orvellaton is a town.', deny).length, 0);
  assert.equal(scanText('ask orvella first', deny).length, 1);
});

test('file scan names file and line, not the text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'names-leak-'));
  const a = path.join(dir, 'MORNING.md');
  fs.writeFileSync(a, 'line one\nZedquill said no\nline three\n');
  const b = path.join(dir, 'clean.md');
  fs.writeFileSync(b, 'Team 7 said no\n');
  const hits = scanFiles([a, b], denylistFromPlans(plans()));
  assert.deepEqual(hits.map(h => [path.basename(h.file), h.line, h.roster, h.kind]), [['MORNING.md', 2, '7', 'manager']]);
  assert.ok(!JSON.stringify(hits).includes('Zedquill'));
});

test('committed plans-shaped fixtures carry only generic team labels (no real teams map is ever committed)', () => {
  const files = trackedFiles(ROOT).filter(f => f.endsWith('.json') && /plans/i.test(path.basename(f)));
  assert.ok(files.length >= 2, `expected the war-room plan fixtures, found ${files.length}`);
  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    const leagues = Array.isArray(doc?.leagues) ? doc.leagues : [];
    for (const e of leagues) {
      const map = e?.teams?.value ?? {};
      for (const [r, t] of Object.entries(map)) {
        for (const k of ['name', 'manager']) {
          if (t?.[k] != null) assert.ok(genericLabel(t[k]), `${f} roster ${r} ${k} is not a generic 'Team N' label`);
        }
      }
    }
  }
});

test('CLI exits 1 on a file hit and prints no name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'names-leak-cli-'));
  const p = path.join(dir, 'plans.json');
  fs.writeFileSync(p, JSON.stringify(plans()));
  const f = path.join(dir, 'handoff.md');
  fs.writeFileSync(f, 'Offer to Marmot Mayhem.\n');
  let code = 0; let out = '';
  try { out = execFileSync(process.execPath, ['scripts/check-names-leak.mjs', '--plans', p, '--files', f], { cwd: ROOT, encoding: 'utf8' }); } catch (e) { code = e.status; out = `${e.stdout}${e.stderr}`; }
  assert.equal(code, 1);
  assert.match(out, /FAIL/);
  assert.ok(!out.includes('Marmot'));
});

test('CLI with no plans file says it has no denylist and fails closed (exit 2)', () => {
  let code = 0; let out = '';
  try { out = execFileSync(process.execPath, ['scripts/check-names-leak.mjs', '--plans', path.join(os.tmpdir(), 'no-such-plans.json'), '--tracked'], { cwd: ROOT, encoding: 'utf8' }); } catch (e) { code = e.status; out = `${e.stdout}${e.stderr}`; }
  assert.equal(code, 2);
  assert.match(out, /no denylist/i);
});
