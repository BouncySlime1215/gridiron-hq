// SECRETS SCAN (plan item 38): CI fails when a committed file carries a credential.
// Every sample secret below is assembled at run time from pieces, so this file itself holds no
// literal match and needs no allowlist entry. The repository is public.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RULES, scanLine, scanFiles, fingerprint, parseAllowlist, entropy } from '../scripts/check-secrets.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

// Deterministic high-entropy filler: not a real key, just random-looking characters.
const rnd = (n, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') => {
  let s = ''; let x = 2463534242;
  for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; s += alphabet[(x >>> 0) % alphabet.length]; }
  return s;
};
const HEX = '0123456789ABCDEF';
const j = (...p) => p.join('');

// One synthetic sample per rule id. Adding a rule without a sample fails the coverage test below.
const SAMPLES = {
  'anthropic-key': `ANTHROPIC_API_KEY=${j('sk-', 'ant-', 'api03-')}${rnd(93, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-')}`,
  'openai-key': `key: "${j('sk-', 'proj-')}${rnd(48)}"`,
  'github-token': `token ${j('gh', 'p_')}${rnd(36)}`,
  'github-pat': `${j('github', '_pat_')}${rnd(82, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_')}`,
  'aws-access-key': `aws_access_key_id = ${j('AK', 'IA')}${rnd(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')}`,
  'private-key': j('-----BEGIN ', 'RSA PRIVATE', ' KEY-----'),
  'slack-token': `${j('xox', 'b-')}${rnd(12, '0123456789')}-${rnd(24)}`,
  'google-api-key': `${j('AI', 'za')}${rnd(35)}`,
  'stripe-live-key': `${j('sk', '_live_')}${rnd(32)}`,
  'fly-token': `${j('Fly', 'V1 ')}fm2_${rnd(120, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/')}`,
  'espn-s2-cookie': `${j('espn', '_s2')}=${rnd(60)}%2B${rnd(60)}%2F${rnd(60)}`,
  'espn-swid': `${j('SW', 'ID')}: "{${rnd(8, HEX)}-${rnd(4, HEX)}-${rnd(4, HEX)}-${rnd(4, HEX)}-${rnd(12, HEX)}}"`,
  'jwt': `Authorization: Bearer ${j('ey', 'J')}${rnd(30)}.${j('ey', 'J')}${rnd(60)}.${rnd(43, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-')}`,
  'generic-assigned-secret': `const apiSecret = "${rnd(40, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/')}";`
};

test('B1: every rule catches its synthetic sample', () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), RULES.map(r => r.id).sort(), 'one sample per rule');
  for (const [id, line] of Object.entries(SAMPLES)) {
    const hits = scanLine(line);
    assert.ok(hits.some(h => h.rule === id), `${id} missed its sample`);
  }
});

test('B2: placeholders and low-entropy fakes are not hits', () => {
  const fakes = [
    'ANTHROPIC_API_KEY=your-key-here',
    `ANTHROPIC_API_KEY=${j('sk-', 'ant-', 'api03-')}${'x'.repeat(93)}`,
    `aws_access_key_id = ${j('AK', 'IA')}EXAMPLEEXAMPLE00`,
    `${j('SW', 'ID')}: "{00000000-0000-0000-0000-000000000000}"`,
    `${j('espn', '_s2')}=<paste your espn_s2 cookie here>`,
    'const password = process.env.DB_PASSWORD;',
    `const token = "${'a'.repeat(40)}";`,
    'sha: 3f786850e387550fdab836ed7e6dc881de23001b', // a git sha is not a secret
    `integrity: sha512-${rnd(86)}==`
  ];
  for (const f of fakes) assert.deepEqual(scanLine(f), [], `false positive on: ${f.slice(0, 30)}`);
});

test('B3: a report names file, line, rule and a fingerprint, never the secret', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-scan-'));
  const a = path.join(dir, 'config.js');
  fs.writeFileSync(a, `line one\n${SAMPLES['github-token']}\nline three\n`);
  const hits = scanFiles([a]);
  assert.equal(hits.length, 1);
  assert.deepEqual([path.basename(hits[0].file), hits[0].line, hits[0].rule], ['config.js', 2, 'github-token']);
  assert.match(hits[0].fp, /^[0-9a-f]{12}$/);
  const secret = SAMPLES['github-token'].split(' ')[1];
  assert.ok(!JSON.stringify(hits).includes(secret));
  assert.ok(!JSON.stringify(hits).includes(secret.slice(4, 20)));
});

test('allowlist: a fingerprint + path entry silences exactly that hit and needs a reason', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-allow-'));
  const a = path.join(dir, 'fixture.txt');
  fs.writeFileSync(a, `${SAMPLES['google-api-key']}\n${SAMPLES['stripe-live-key']}\n`);
  const fp = fingerprint(SAMPLES['google-api-key'].match(/AIza\S+/)[0]);
  const allow = parseAllowlist(`# comment\ngoogle-api-key ${fp} ${a}  # revoked demo key\n`);
  const hits = scanFiles([a], { allow });
  assert.deepEqual(hits.map(h => h.rule), ['stripe-live-key']);
  assert.throws(() => parseAllowlist(`google-api-key ${fp} ${a}\n`), /reason/);
});

test('entropy separates random keys from repeated filler', () => {
  assert.ok(entropy(rnd(40)) > 4);
  assert.ok(entropy('x'.repeat(40)) < 1);
});

test('B4: every tracked file on this tree scans clean, under the time budget', () => {
  const t0 = Date.now();
  let code = 0; let out = '';
  try { out = execFileSync(process.execPath, ['scripts/check-secrets.mjs', '--tracked'], { cwd: ROOT, encoding: 'utf8' }); } catch (e) { code = e.status; out = `${e.stdout}${e.stderr}`; }
  const ms = Date.now() - t0;
  assert.equal(code, 0, out);
  assert.match(out, /PASS/);
  assert.ok(ms < 30_000, `scan took ${ms} ms`);
});

test('CLI exits 1 on a hit and prints no secret', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-cli-'));
  const f = path.join(dir, '.env.example');
  fs.writeFileSync(f, `${SAMPLES['anthropic-key']}\n`);
  let code = 0; let out = '';
  try { out = execFileSync(process.execPath, ['scripts/check-secrets.mjs', '--files', f], { cwd: ROOT, encoding: 'utf8' }); } catch (e) { code = e.status; out = `${e.stdout}${e.stderr}`; }
  assert.equal(code, 1);
  assert.match(out, /FAIL/);
  assert.match(out, /anthropic-key/);
  assert.ok(!out.includes(SAMPLES['anthropic-key'].split('=')[1].slice(0, 24)));
});

test('CI workflow runs the secrets scan and the names scan', () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /npm run check:secrets/);
  assert.match(ci, /check-names-leak\.mjs[^\n]*--denylist-env NAMES_DENYLIST/);
  assert.match(ci, /NAMES_DENYLIST: \$\{\{ secrets\.NAMES_DENYLIST \}\}/);
});
