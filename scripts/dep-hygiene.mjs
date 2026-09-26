#!/usr/bin/env node
/**
 * DEP-HYGIENE (batch D item 39): "npm audit / outdated report; upgrade only with tests green."
 *
 *   node scripts/dep-hygiene.mjs                     # report (markdown) from live `npm audit` + `npm outdated`
 *   node scripts/dep-hygiene.mjs --json              # the same, as JSON
 *   node scripts/dep-hygiene.mjs --audit-json a.json --outdated-json o.json   # report from saved npm output
 *   node scripts/dep-hygiene.mjs --out report.md     # write the report to a file instead of stdout
 *   GRIDIRON_DEP_HYGIENE=on node scripts/dep-hygiene.mjs --apply
 *
 * --apply upgrades only inside the declared ranges (`npm update <names>`, then `npm audit fix`, never
 * --force), then runs typecheck, lint, check:wiring, test and build. The first red gate restores
 * package.json and package-lock.json byte for byte and reinstalls with `npm ci`. Nothing is committed.
 * Major bumps and exact pins are listed and never applied. Without GRIDIRON_DEP_HYGIENE=on, --apply
 * refuses and the run is a report.
 *
 * Exit 0: report written (and, with --apply, the upgrade kept or nothing to do). Exit 1: --apply ran
 * and a gate was red (files restored), or --fail-on <severity> matched. Exit 2: the audit could not
 * run (no registry, bad output): the report says "Audit unavailable" instead of claiming zero.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info'];
const RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));

/** The gates an upgrade must pass, in order: the repo's own `npm run check` minus the smoke boot. */
export const GATES = [
  { name: 'typecheck', args: ['run', 'typecheck'] },
  { name: 'lint', args: ['run', 'lint'] },
  { name: 'check:wiring', args: ['run', 'check:wiring'] },
  { name: 'test', args: ['test'] },
  { name: 'build', args: ['run', 'build'] }
];

export const applyEnabled = (env = process.env) => env.GRIDIRON_DEP_HYGIENE === 'on';

const emptyCounts = () => Object.fromEntries([...SEVERITIES, 'total'].map(k => [k, 0]));

/** 'dev' when the lockfile marks the installed node dev-only (dev or devOptional), else 'prod'. */
function scopeOf(lock, nodes) {
  const pkgs = lock?.packages ?? {};
  const known = (nodes ?? []).map(n => pkgs[n]).filter(Boolean);
  if (!known.length) return 'unknown';
  return known.every(p => p.dev || p.devOptional) ? 'dev' : 'prod';
}

function fixKind(fa) {
  if (fa === true) return { fix: 'in-range', fix_to: null };
  if (fa && typeof fa === 'object') {
    return { fix: fa.isSemVerMajor ? 'major' : 'in-range', fix_to: `${fa.name}@${fa.version}` };
  }
  return { fix: 'none', fix_to: null };
}

/** npm 7+ `npm audit --json` -> { available, reason, counts, prod_counts, rows }. */
export function classifyAudit(raw, lock) {
  const down = reason => ({ available: false, reason, counts: null, prod_counts: null, rows: [] });
  if (raw == null || raw === '') return down('npm audit gave no output');
  let doc = raw;
  if (typeof raw === 'string') {
    try { doc = JSON.parse(raw); } catch (e) { return down(`npm audit output is not JSON (${e.message})`); }
  }
  if (doc?.error) return down(`npm audit failed: ${doc.error.code ?? 'error'} ${doc.error.summary ?? ''}`.trim());
  if (!doc?.vulnerabilities || typeof doc.vulnerabilities !== 'object') {
    return down('npm audit output has no vulnerabilities map');
  }
  const rows = Object.values(doc.vulnerabilities).map(v => ({
    name: v.name,
    severity: v.severity,
    scope: scopeOf(lock, v.nodes),
    direct: Boolean(v.isDirect),
    range: v.range,
    ...fixKind(v.fixAvailable),
    via: (v.via ?? []).filter(x => typeof x === 'string'),
    advisories: (v.via ?? []).filter(x => x && typeof x === 'object')
      .map(x => ({ id: x.source, title: x.title, severity: x.severity, range: x.range, url: x.url }))
  }));
  rows.sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9) || a.name.localeCompare(b.name));
  const counts = emptyCounts();
  const prod_counts = emptyCounts();
  for (const r of rows) {
    for (const c of r.scope === 'dev' ? [counts] : [counts, prod_counts]) {
      if (r.severity in c) c[r.severity] += 1;
      c.total += 1;
    }
  }
  return { available: true, reason: null, counts, prod_counts, rows };
}

const parse = v => {
  const m = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(String(v ?? '').trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null } : null;
};

/** patch / minor / major / none from `from` to `to`. Under ^, a 0.x minor bump is breaking: major. */
export function bumpKind(from, to) {
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return 'unknown';
  if (a.major !== b.major) return 'major';
  if (a.major === 0 && a.minor !== b.minor) return 'major';
  if (a.minor !== b.minor) return 'minor';
  if (a.patch !== b.patch || a.pre !== b.pre) return 'patch';
  return 'none';
}

const isExactPin = spec => /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(String(spec ?? '').trim());

/** `npm outdated --json` + package.json -> { rows }: one row per outdated direct dependency. */
export function classifyOutdated(raw, pkg, lock) {
  const doc = typeof raw === 'string' ? (raw.trim() ? JSON.parse(raw) : {}) : (raw ?? {});
  const specOf = name => pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name] ?? null;
  const rows = Object.entries(doc).map(([name, o]) => ({
    name,
    current: o.current ?? null,
    wanted: o.wanted ?? null,
    latest: o.latest ?? null,
    spec: specOf(name),
    scope: pkg?.dependencies?.[name] ? 'prod' : scopeOf(lock, [`node_modules/${name}`]) === 'prod' ? 'prod' : 'dev',
    pinned: isExactPin(specOf(name)),
    in_range: Boolean(o.current && o.wanted && o.current !== o.wanted),
    wanted_bump: bumpKind(o.current, o.wanted),
    latest_bump: bumpKind(o.current, o.latest)
  }));
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { rows };
}

/** What --apply would do: in-range updates, `npm audit fix` if an advisory is fixable in range, the rest listed. */
export function upgradePlan(outdated, audit) {
  const update = outdated.rows.filter(r => r.in_range && !r.pinned).map(r => r.name).sort();
  const skip = [];
  for (const r of outdated.rows) {
    if (r.in_range && !r.pinned) continue;
    if (r.pinned && r.latest_bump !== 'none') skip.push({ name: r.name, reason: 'pinned', to: r.latest });
    else if (r.latest_bump === 'major') skip.push({ name: r.name, reason: 'major', to: r.latest });
    else if (r.latest_bump !== 'none') skip.push({ name: r.name, reason: 'outside range', to: r.latest });
  }
  for (const r of audit.rows ?? []) {
    if (r.fix === 'none') skip.push({ name: r.name, reason: 'no fix', to: null });
    else if (r.fix === 'major') skip.push({ name: r.name, reason: 'major', to: r.fix_to });
  }
  const audit_fix = (audit.rows ?? []).some(r => r.fix === 'in-range');
  const seen = new Set();
  const unique = skip.filter(s => !seen.has(`${s.name}|${s.reason}`) && seen.add(`${s.name}|${s.reason}`));
  return { update, audit_fix, skip: unique };
}

const FILES = ['package.json', 'package-lock.json'];

function defaultRun(cmd, args, { cwd }) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) return { status: 127, stdout: '', stderr: String(r.error.message) };
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const NPM_ERROR = /^npm (ERR!|error)/m;
const tail = s => String(s ?? '').trim().split('\n').slice(-20).join('\n');

/**
 * Apply `plan` inside `cwd`, then run every gate. The first red step restores package.json and
 * package-lock.json byte for byte and runs `npm ci` so node_modules matches them again.
 */
export function applyUpgrades({ cwd, plan, run = defaultRun }) {
  if (!plan.update.length && !plan.audit_fix) return { ok: true, nothing_to_do: true, restored: false, steps: [] };
  const saved = Object.fromEntries(FILES.map(f => [f, fs.readFileSync(path.join(cwd, f))]));
  const steps = [];
  const restore = (failed_gate, r) => {
    for (const f of FILES) fs.writeFileSync(path.join(cwd, f), saved[f]);
    const ci = run('npm', ['ci'], { cwd });
    steps.push({ name: 'npm ci (restore)', status: ci.status });
    return {
      ok: false, failed_gate, restored: true, reinstall_ok: ci.status === 0,
      detail: tail(`${r.stdout}\n${r.stderr}`), steps
    };
  };
  const mutations = [];
  if (plan.update.length) mutations.push({ name: 'npm update', args: ['update', ...plan.update] });
  // `npm audit fix` exits 1 when an advisory is left that only --force could fix, after fixing the
  // rest (measured on main e466da4b: react-router needs 7.x). That residual is the audit's answer, not
  // a failed install, so only an `npm error` line fails the step; the gates judge the result.
  if (plan.audit_fix) {
    mutations.push({ name: 'npm audit fix', args: ['audit', 'fix'], ok: r => r.status === 0 || !NPM_ERROR.test(r.stderr) });
  }
  for (const step of [...mutations, ...GATES]) {
    const r = run('npm', step.args, { cwd });
    steps.push({ name: step.name, status: r.status });
    if (!(step.ok ? step.ok(r) : r.status === 0)) return restore(step.name, r);
  }
  return { ok: true, nothing_to_do: false, restored: false, steps };
}

const cell = s => String(s ?? '').replace(/\|/g, '\\|');
const countLine = c => SEVERITIES.filter(s => c[s]).map(s => `${c[s]} ${s}`).join(', ') || 'none';

export function renderReport({ audit, outdated, plan = null, applied = null }) {
  const out = ['# Dependency hygiene report', ''];
  out.push('## Audit', '');
  if (!audit.available) {
    out.push(`Audit unavailable: ${audit.reason}. This is not a clean result.`, '');
  } else {
    out.push(`${audit.counts.total} advisories: ${countLine(audit.counts)}.`);
    out.push(`Runtime (prod): ${countLine(audit.prod_counts)}.`);
    out.push('Scope is npm\'s: the client (React, the router, Vite) is in devDependencies, so "dev" still ships to the browser.', '');
    if (audit.rows.length) {
      out.push('| package | severity | scope | path | fix | advisories |', '|---|---|---|---|---|---|');
      for (const r of audit.rows) {
        const fix = r.fix === 'in-range' ? 'in range' : r.fix === 'major' ? `major (${r.fix_to})` : 'none';
        const adv = r.advisories.map(a => `[${cell(a.title)}](${a.url})`).join('; ') || `via ${r.via.join(', ')}`;
        out.push(`| ${r.name} | ${r.severity} | ${r.scope} | ${r.direct ? 'direct' : 'transitive'} | ${fix} | ${adv} |`);
      }
      out.push('');
    }
  }
  out.push('## Outdated (direct dependencies)', '');
  if (!outdated.rows.length) out.push('Everything is at its latest version.', '');
  else {
    out.push('| package | scope | spec | current | wanted | latest | to latest |', '|---|---|---|---|---|---|---|');
    for (const r of outdated.rows) {
      out.push(`| ${r.name} | ${r.scope} | ${cell(r.spec)}${r.pinned ? ' (pinned)' : ''} | ${r.current} | ${r.wanted} | ${r.latest} | ${r.latest_bump} |`);
    }
    out.push('');
  }
  if (plan) {
    out.push('## Upgrade plan (in range only)', '');
    out.push(plan.update.length ? `- \`npm update ${plan.update.join(' ')}\`` : '- No in-range direct updates.');
    out.push(plan.audit_fix ? '- `npm audit fix` (no --force)' : '- No advisory fixable in range.');
    for (const s of plan.skip) out.push(`- Not applied: ${s.name} (${s.reason}${s.to ? `, ${s.to}` : ''})`);
    out.push('');
  }
  if (applied) {
    out.push('## Apply', '');
    if (applied.nothing_to_do) out.push('Nothing to apply.');
    else if (applied.ok) {
      out.push(`Kept: every gate green (${applied.steps.map(s => s.name).join(', ')}).`);
      if (applied.after?.available) {
        out.push(`After: ${applied.after.counts.total} advisories (${countLine(applied.after.counts)}); ` +
          `runtime (prod): ${countLine(applied.after.prod_counts)}. Left: ${applied.after.rows.map(r => `${r.name} (${r.fix === 'in-range' ? 'in range' : r.fix})`).join(', ') || 'none'}.`);
      } else if (applied.after) out.push(`After: audit unavailable (${applied.after.reason}).`);
    }
    else {
      out.push(`Restored: ${applied.failed_gate} was red; package.json and package-lock.json are back to their earlier bytes` +
        `${applied.reinstall_ok ? ' and reinstalled' : ', but `npm ci` also failed: run it by hand'}.`);
      out.push('', '```', applied.detail, '```');
    }
    out.push('');
  }
  return out.join('\n');
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function main(argv = process.argv.slice(2), { cwd = process.cwd(), env = process.env, run = defaultRun } = {}) {
  const lock = readJson(path.join(cwd, 'package-lock.json'));
  const pkg = readJson(path.join(cwd, 'package.json'));
  const auditFile = argValue(argv, '--audit-json');
  const outdatedFile = argValue(argv, '--outdated-json');
  // npm audit / outdated exit 1 when they find something; that is their normal answer, so read stdout.
  const auditRaw = auditFile ? fs.readFileSync(auditFile, 'utf8') : run('npm', ['audit', '--json'], { cwd }).stdout;
  const outdatedRaw = outdatedFile ? fs.readFileSync(outdatedFile, 'utf8') : run('npm', ['outdated', '--json'], { cwd }).stdout;
  const audit = classifyAudit(auditRaw, lock);
  const outdated = classifyOutdated(outdatedRaw, pkg, lock);
  const plan = upgradePlan(outdated, audit);

  let applied = null;
  if (argv.includes('--apply')) {
    if (!applyEnabled(env)) {
      console.error('--apply refused: GRIDIRON_DEP_HYGIENE is not "on". Dry run only; nothing changed.');
    } else if (!audit.available) {
      console.error(`--apply refused: ${audit.reason}.`);
    } else {
      applied = applyUpgrades({ cwd, plan, run });
      if (applied.ok && !applied.nothing_to_do) {
        applied.after = classifyAudit(run('npm', ['audit', '--json'], { cwd }).stdout,
          readJson(path.join(cwd, 'package-lock.json')));
      }
    }
  }

  const body = argv.includes('--json')
    ? JSON.stringify({ audit, outdated, plan, applied }, null, 2)
    : renderReport({ audit, outdated, plan, applied });
  const outFile = argValue(argv, '--out');
  if (outFile) fs.writeFileSync(outFile, `${body}\n`);
  else console.log(body);

  if (!audit.available) return 2;
  if (applied && !applied.ok) return 1;
  const failOn = argValue(argv, '--fail-on');
  if (failOn) {
    if (!(failOn in RANK)) throw new Error(`--fail-on takes one of ${SEVERITIES.join(', ')}`);
    if (audit.rows.some(r => RANK[r.severity] <= RANK[failOn])) return 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main();
}
