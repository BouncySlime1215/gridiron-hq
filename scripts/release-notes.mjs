#!/usr/bin/env node
/**
 * RELEASE NOTES (Batch D plan item 60): build the "what changed for you" note for one merged batch.
 *
 *   node scripts/release-notes.mjs                         # since the last note, to HEAD; dry run
 *   node scripts/release-notes.mjs --from <sha> --to <sha> # an explicit batch; dry run
 *   GRIDIRON_RELEASE_NOTES=1 node scripts/release-notes.mjs --apply   # write it for Today
 *   [--plans <plans.json>] league-mate names for the names check (default: the War Room plans file)
 *   [--file <notes.json>]  where notes live (default: GRIDIRON_RELEASE_NOTES_FILE or server/data/release-notes.json)
 *   [--repo <dir>]         the checkout to read (default: this one)
 *
 * Dry run prints the note and writes nothing. `--apply` needs the flag on (exit 2 otherwise) and exits 1,
 * leaving the file as it was, when the notes file can't be read. The rules for each commit live in
 * server/services/release-notes.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { denylistFromPlans } from './check-names-leak.mjs';
import { appendNote, buildReleaseNote, lastNoteTo, releaseNotesFlag, releaseNotesPath } from '../server/services/release-notes.js';
import { warRoomPlansPath } from '../server/services/warroom-flag.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const o = { from: null, to: 'HEAD', repo: ROOT, plans: warRoomPlansPath(), file: releaseNotesPath(), apply: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') o.apply = true;
    else if (['--from', '--to', '--repo', '--plans', '--file'].includes(a)) o[a.slice(2)] = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return o;
}

/** [{ sha, subject, body }] newest first, merges left out (their commits are listed on their own). */
export function readCommits(repo, from, to) {
  const raw = execFileSync('git', ['log', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', `${from}..${to}`], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return raw.split('\x1e').map(s => s.replace(/^\n+/, '')).filter(s => s.trim()).map(row => {
    const [sha, subject, body = ''] = row.split('\x1f');
    return { sha: sha.trim(), subject: subject.trim(), body: body.trim() };
  });
}

/** The denylist from the plans file, or null (the note is then held and says so). */
function readDenylist(file) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    console.error(`names check: the plans file could not be read (${e.code ?? e.name}); the note will be held.`);
    return null;
  }
  const deny = denylistFromPlans(doc);
  if (!deny.length) console.error('names check: the plans file has no teams map; the note will be held.');
  return deny;
}

function main() {
  const o = parseArgs(process.argv);
  const flag = releaseNotesFlag();
  if (o.apply && !flag.enabled) {
    console.log(`${flag.reason} Set GRIDIRON_RELEASE_NOTES=1 to write a note; nothing written.`);
    process.exit(2);
  }
  let from = o.from;
  try { from ??= lastNoteTo(o.file); } catch (e) { console.error(e.message); process.exit(1); }
  if (!from) { console.log('No earlier note: pass --from <sha> for the first batch.'); process.exit(2); }
  const git = (...a) => execFileSync('git', a, { cwd: o.repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let fromSha, toSha, commits;
  try {
    fromSha = git('rev-parse', '--verify', `${from}^{commit}`);
    toSha = git('rev-parse', '--verify', `${o.to}^{commit}`);
    commits = readCommits(o.repo, fromSha, toSha);
  } catch (e) {
    console.error(`git could not read ${from}..${o.to}: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
    process.exit(1);
  }
  if (!commits.length) { console.log(`No new commits since ${fromSha.slice(0, 8)}; no note.`); return; }
  const note = buildReleaseNote({ commits, from: fromSha, to: toSha, denylist: readDenylist(o.plans) });

  console.log(`${note.status === 'held' ? note.reason : note.summary}`);
  for (const item of note.items) console.log(`  [${item.area}] ${item.text}`);
  console.log(`commits ${note.counts.commits}: lines ${note.counts.items}, duplicates ${note.counts.duplicates}, off ${note.counts.off}, behind the scenes ${note.counts.behind}, held ${note.counts.held} (names ${note.held.names}, wording ${note.held.wording})`);
  if (!o.apply) { console.log('dry run: nothing written (add --apply to write it for Today).'); return; }
  try { appendNote(o.file, note); } catch (e) { console.error(e.message); process.exit(1); }
  console.log(`written: ${o.file}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
