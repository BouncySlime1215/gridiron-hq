#!/usr/bin/env node
/**
 * SECRETS SCAN (plan item 38): fail CI when a committed file carries a credential.
 *
 * The repository is public, so a report never prints the matched value: it names the file, the line,
 * the rule and a 12-hex fingerprint (sha256 prefix of the match). A known false positive is silenced by
 * one line in .secrets-allowlist: `<rule> <fingerprint> <path>  # reason` (the reason is required).
 *
 *   node scripts/check-secrets.mjs --tracked                     # every git-tracked file (CI)
 *   node scripts/check-secrets.mjs --range origin/main...HEAD    # files a push would add or change
 *   node scripts/check-secrets.mjs --files a.env b.json          # a handoff set
 *
 * Exit 0: no hit. Exit 1: a hit. Exit 2: bad arguments or a malformed allowlist.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Shannon entropy in bits per character. */
export function entropy(s) {
  if (!s) return 0;
  const n = new Map();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const k of n.values()) { const p = k / s.length; h -= p * Math.log2(p); }
  return h;
}

const PLACEHOLDER = /example|placeholder|your[-_]?|xxxx|changeme|dummy|redacted|<[^>]*>|\$\{|process\.env/i;

/**
 * Each rule: a regex whose group 1 (or whole match) is the value, and the entropy the value must
 * reach. Entropy floors keep repeated-character fakes ('x' * 90) out; PLACEHOLDER keeps docs out.
 */
export const RULES = [
  { id: 'anthropic-key', re: /sk-ant-(?:api|admin)\d{2}-([A-Za-z0-9_-]{80,})/g, minH: 3.5 },
  { id: 'openai-key', re: /\bsk-(?:proj-|svcacct-)?([A-Za-z0-9_-]{40,})/g, minH: 3.5 },
  { id: 'github-token', re: /\bgh[pousr]_([A-Za-z0-9]{36,})/g, minH: 3.5 },
  { id: 'github-pat', re: /\bgithub_pat_([A-Za-z0-9_]{60,})/g, minH: 3.5 },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)([0-9A-Z]{16})\b/g, minH: 3.0 },
  { id: 'private-key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g, minH: 0 },
  { id: 'slack-token', re: /\bxox[abposr]-([0-9A-Za-z-]{20,})/g, minH: 3.5 },
  { id: 'google-api-key', re: /\bAIza([0-9A-Za-z_-]{35})\b/g, minH: 3.5 },
  { id: 'stripe-live-key', re: /\b[rs]k_live_([0-9A-Za-z]{20,})/g, minH: 3.5 },
  { id: 'fly-token', re: /FlyV1 (fm\d_[A-Za-z0-9_+/=-]{40,})/g, minH: 3.5 },
  { id: 'espn-s2-cookie', re: /espn_s2["']?\s*[:=]\s*["']?([A-Za-z0-9%+/=]{100,})/gi, minH: 4.0 },
  { id: 'espn-swid', re: /SWID["']?\s*[:=]\s*["']?(\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?)/g, minH: 3.4 },
  { id: 'jwt', re: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,})/g, minH: 4.0 },
  {
    id: 'generic-assigned-secret',
    re: /(?:api[_-]?key|api[_-]?secret|apiSecret|apiKey|client[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd)["']?\s*[:=]\s*["']([A-Za-z0-9_\-+/=]{32,})["']/gi,
    minH: 4.2
  }
];

export const fingerprint = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);

/** [{ rule, fp }] for one line; the value itself never leaves this function. */
export function scanLine(line) {
  if (typeof line !== 'string' || line.length < 16) return [];
  const hits = [];
  for (const r of RULES) {
    r.re.lastIndex = 0;
    for (const m of line.matchAll(r.re)) {
      const value = m[1] ?? m[0];
      if (r.minH && (PLACEHOLDER.test(m[0]) || entropy(value) < r.minH)) continue;
      hits.push({ rule: r.id, fp: fingerprint(m[0]) });
    }
  }
  return hits;
}

/** Map `${rule} ${fp} ${relpath}` -> reason. Throws on an entry with no reason. */
export function parseAllowlist(text) {
  const allow = new Map();
  for (const [i, raw] of String(text ?? '').split('\n').entries()) {
    const ln = raw.trim();
    if (!ln || ln.startsWith('#')) continue;
    const [body, ...why] = ln.split('#');
    const reason = why.join('#').trim();
    const [rule, fp, file] = body.trim().split(/\s+/);
    if (!rule || !fp || !file) throw new Error(`.secrets-allowlist line ${i + 1}: expected "<rule> <fingerprint> <path>  # reason"`);
    if (!reason) throw new Error(`.secrets-allowlist line ${i + 1}: every entry needs a # reason`);
    allow.set(`${rule} ${fp} ${file}`, reason);
  }
  return allow;
}

const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|sqlite|db|zip|gz|woff2?|ttf|otf|mp4|mov|wasm|icns)$/i;
// package-lock integrity hashes are sha512 base64 and would only ever be noise here.
const SKIP_NAMES = new Set(['package-lock.json']);

/** [{ file, line, rule, fp }] over text files; skipped files are pushed to `skipped` with the reason. */
export function scanFiles(files, { allow = new Map(), root = process.cwd(), skipped = [] } = {}) {
  const hits = [];
  for (const file of files) {
    if (BINARY.test(file)) { skipped.push({ file, why: 'binary' }); continue; }
    if (SKIP_NAMES.has(path.basename(file))) { skipped.push({ file, why: 'lockfile' }); continue; }
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { skipped.push({ file, why: e.code ?? 'unreadable' }); continue; }
    if (text.includes('\u0000')) { skipped.push({ file, why: 'binary' }); continue; }
    const rel = path.isAbsolute(file) ? path.relative(root, file) : file;
    text.split('\n').forEach((ln, i) => {
      for (const h of scanLine(ln)) {
        if (allow.has(`${h.rule} ${h.fp} ${rel}`) || allow.has(`${h.rule} ${h.fp} ${file}`)) continue;
        hits.push({ file, line: i + 1, ...h });
      }
    });
  }
  return hits;
}

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0').filter(Boolean);

function parseArgs(argv) {
  const o = { files: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tracked') o.tracked = true;
    else if (a === '--range') o.range = argv[++i];
    else if (a === '--allowlist') o.allowlist = argv[++i];
    else if (a === '--files') { while (argv[i + 1] && !argv[i + 1].startsWith('--')) o.files.push(argv[++i]); }
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

function main() {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  let o; let allow;
  try {
    o = parseArgs(process.argv);
    const allowPath = o.allowlist ?? path.join(root, '.secrets-allowlist');
    allow = fs.existsSync(allowPath) ? parseAllowlist(fs.readFileSync(allowPath, 'utf8')) : new Map();
  } catch (e) { console.log(`ERROR: ${e.message}`); process.exit(2); }

  const files = [...o.files];
  if (o.tracked) files.push(...git(root, ['ls-files', '-z']).map(f => path.join(root, f)));
  if (o.range) files.push(...git(root, ['diff', '--name-only', '--diff-filter=AMR', '-z', o.range]).map(f => path.join(root, f)));
  if (!files.length) { console.log('nothing to scan: pass --tracked, --range or --files'); process.exit(2); }

  const t0 = Date.now();
  const skipped = [];
  const hits = scanFiles(files, { allow, root, skipped });
  const ms = Date.now() - t0;
  const scanned = files.length - skipped.length;
  if (!hits.length) {
    console.log(`PASS secrets: 0 hits in ${scanned} text files, ${RULES.length} rules, ${allow.size} allowlisted, ${skipped.length} binary/lockfile skipped, ${ms} ms`);
    process.exit(0);
  }
  console.log(`FAIL secrets: ${hits.length} hits in ${new Set(hits.map(h => h.file)).size} of ${scanned} files (values not printed)`);
  for (const h of hits.slice(0, 40)) {
    const rel = path.relative(root, h.file) || h.file;
    console.log(`  ${rel}:${h.line}: ${h.rule} fingerprint ${h.fp}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error file=${rel},line=${h.line}::${h.rule} (fingerprint ${h.fp})`);
  }
  console.log('Rotate any real credential first. A false positive goes in .secrets-allowlist as "<rule> <fingerprint> <path>  # reason".');
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
