/**
 * RELEASE NOTES (Batch D plan item 60): after each merged batch, a plain-English "what changed for you"
 * note (no names), shown once in Today.
 *
 * Every commit in a batch lands in exactly one bucket:
 *   items   a line Nick will notice (a `Release-note:` trailer, or a cleaned feat/fix/perf/ui subject)
 *   off     built but switched off (shadow, or behind its own off flag): changed nothing he sees
 *   behind  tests, docs, chores, refactors, CI, and `Release-note: none`
 *   held    a line that failed the dev-text gate or named a league-mate: counted, never shown
 *
 * Nothing half-cleaned is ever shown: a subject that still reads as dev text after cleaning is held, not
 * guessed at. League-mate names come from the plans file's teams map (check-names-leak.mjs) and are
 * never stored; with no denylist the whole note is held and says why.
 *
 * Behind GRIDIRON_RELEASE_NOTES (off by default). Pre-registered bars: docs/tdd/2026-09-26-release-notes.tdd.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dataPath } from '../platform/paths.js';
import { scanText } from '../../scripts/check-names-leak.mjs';

export const RELEASE_NOTES_ENV = 'GRIDIRON_RELEASE_NOTES';
export const RELEASE_NOTES_OFF_REASON = 'Release notes are switched off.';

/** The seven areas plus one for changes that touch several. */
export const AREAS = ['Today', 'Trades', 'My team', 'League', 'Players', 'Draft', 'Settings', 'Across the app'];

export function releaseNotesFlag(env = process.env) {
  return env?.[RELEASE_NOTES_ENV] === '1' ? { enabled: true } : { enabled: false, reason: RELEASE_NOTES_OFF_REASON };
}

export function releaseNotesPath(env = process.env) {
  return env?.GRIDIRON_RELEASE_NOTES_FILE || dataPath('release-notes.json');
}

/* ------------------------------------------------------------ dev-text gate */

const ALLOWED_CAPS = new Set(['ESPN', 'FLEX', 'NFL', 'PPR', 'IDP']);
const DEV_TEXT = [
  ['file name', /\b[\w-]+\.(?:m?js|cjs|tsx?|jsx|json|md|sql|sh|py|sqlite|csv)\b/i],
  ['path', /\w\/[\w.-]+\/|(?:^|\s)\.{0,2}\/\w/],
  ['snake_case', /\b[a-z0-9]+_[a-z0-9_]+\b/i],
  ['camelCase', /\b[a-z]+[A-Z][A-Za-z]*\b/],
  ['code name', /\b(?!FantasyCalc\b)[A-Z][a-z]+[A-Z][A-Za-z]*\b|\b[A-Z]\d[a-z]?\b/],
  ['never displayed', /\bFantasyPros\b/i],
  ['env name', /\bGRIDIRON_|\b[A-Z]{2,}_[A-Z0-9_]+\b/],
  ['unit code', /\b[A-Z][A-Z0-9]*-[A-Z0-9][A-Za-z0-9-]*\b|\bU\d+[a-z]?\b/],
  ['TDD marker', /\b(?:RED|GREEN)\b/],
  ['hash', /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/],
  ['PR number', /#\d+/],
  ['dollar amount', /\$\s?\d/],
  ['model name', /\b(?:Claude|Haiku|Sonnet|Opus|Jev|GPT|Anthropic|LLM)\b/i],
  ['owner name', /\bNick\b/],
  ['internal word', /\b(?:shadow|flag|env|migration|endpoint|route|schema|fixture|preview|producer|plans file|tests?|rebased?|merged|estimator|ledger|study|cells|radar|deltas|batch [A-Z]|item \d+|unit \d+)\b/i],
];

/** The kinds of dev text in a string, [] when it reads as plain English. */
export function devTextHits(text) {
  if (typeof text !== 'string') return ['not text'];
  const hits = DEV_TEXT.filter(([, re]) => re.test(text)).map(([kind]) => kind);
  const caps = (text.match(/\b[A-Z]{4,}\b/g) ?? []).filter(w => !ALLOWED_CAPS.has(w));
  if (caps.length) hits.push('all-caps word');
  return hits;
}

/* ------------------------------------------------------------ one commit */

const USER_TYPES = new Set(['feat', 'fix', 'perf', 'ui']);
const SUBJECT = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.*)$/s;
const TRAILER = /^Release-note:[ \t]*(.*)$/gim;
/** A body line that is a bulleted constituent commit (squash bodies): it may be from a merged main. */
const BULLET = /^\s*[*-]\s+\w+(?:\([^)]*\))?!?:/;
const OFF = /\bshadow\b|\b(?:behind|flag)\s+GRIDIRON_|\bflags?\s+(?:stays?\s+|is\s+|kept\s+)?off\b|\boff by default\b|\bstays?\s+off\b|\(off[;),]|GRIDIRON_[A-Z0-9_]+\s+(?:is\s+)?(?:off|shadow)\b|\bdry[- ]run\b/i;

const SCOPE_AREA = {
  today: 'Today', brief: 'Today', trades: 'Trades', trade: 'Trades', warroom: 'Trades', 'war-room': 'Trades',
  team: 'My team', lineup: 'My team', roster: 'My team', league: 'League', standings: 'League',
  players: 'Players', rankings: 'Players', news: 'Players', draft: 'Draft', settings: 'Settings',
};
const KEYWORD_AREA = [
  [/War Room|\btrades?\b|overpay|News edge|offer|Needs-your-OK/i, 'Trades'],
  [/Start\/Sit|lineup|starter|bench|waiver/i, 'My team'],
  [/Rankings|\bplayers?\b/i, 'Players'],
  [/\bdraft/i, 'Draft'],
  [/Settings/i, 'Settings'],
  [/standings|playoff|league/i, 'League'],
  [/\bbrief\b|\bToday\b/i, 'Today'],
];

function areaFor(scope, text) {
  const s = String(scope ?? '').toLowerCase().trim();
  if (SCOPE_AREA[s]) return SCOPE_AREA[s];
  return KEYWORD_AREA.find(([re]) => re.test(text))?.[1] ?? 'Across the app';
}

/** Leading token that names a unit, not a change: STEP-OVERPAY, U4, U1b+U1c, COACH-V2, GREEN. */
const CODE_TOKEN = /^(?:[A-Z][A-Z0-9]*-[A-Za-z0-9+-]+|U\d+[a-z]?(?:\+U\d+[a-z]?)*|RED|GREEN|unit|\d+[a-z]?)$/;
const isCodeHead = head => {
  const tokens = head.trim().split(/\s+/);
  return tokens.length > 0 && tokens.length <= 4 && tokens.every(t => CODE_TOKEN.test(t)) && tokens.some(t => /[A-Z]/.test(t));
};

/** "Nick's" -> "your", "Nick approves" -> "you approve"; the gate holds anything left over. */
function secondPerson(text) {
  return text
    .replace(/\bNick's\b/g, 'your')
    .replace(/\bNick (is|has|was|does)\b/g, (_, v) => `you ${{ is: 'are', has: 'have', was: 'were', does: 'do' }[v]}`)
    .replace(/\bNick (\w+?[^s])s\b/g, 'you $1')
    .replace(/\bNick\b/g, 'you');
}

/** A subject reduced to what it changes: type, unit code, PR number and asides removed. */
export function cleanSubject(rest) {
  let t = String(rest ?? '').replace(/\s*\(#\d+\)\s*$/, '');
  for (let prev = null; prev !== t;) { prev = t; t = t.replace(/\s+\([^()]*\)/g, ''); }
  const head = t.match(/^([^,:]{1,40})[,:]\s+(.+)$/s);
  if (head && isCodeHead(head[1])) t = head[2];
  for (let tokens = t.split(/\s+/); tokens.length && CODE_TOKEN.test(tokens[0]) && /[A-Z]/.test(tokens[0]);) {
    tokens.shift();
    t = tokens.join(' ');
  }
  return finishLine(secondPerson(t));
}

function finishLine(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim().replace(/[\s;,.:]+$/, '');
  return t ? `${t[0].toUpperCase()}${t.slice(1)}.` : '';
}

/** Where one commit goes. `denylist` is checkNames' input; the caller has already ensured it is usable. */
export function classifyCommit(commit, denylist) {
  const sha = String(commit?.sha ?? '');
  const subject = String(commit?.subject ?? '');
  const body = String(commit?.body ?? '');
  const trailers = [...body.matchAll(TRAILER)].map(m => m[1].trim());
  const parsed = subject.match(SUBJECT);
  const type = parsed?.[1]?.toLowerCase() ?? null;
  const scope = parsed?.[2] ?? null;

  let text;
  if (trailers.length) {
    const said = trailers[trailers.length - 1];
    if (/^none$/i.test(said)) return { bucket: 'behind', sha, reason: 'marked none' };
    text = finishLine(said);
  } else {
    if (!type || !USER_TYPES.has(type)) return { bucket: 'behind', sha, reason: type ? `${type} change` : 'no type' };
    const offText = [subject, ...body.split('\n').filter(l => !BULLET.test(l))].join('\n');
    if (OFF.test(offText)) return { bucket: 'off', sha };
    text = cleanSubject(parsed[3]);
  }
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 4 || text.length > 160 || devTextHits(text).length) return { bucket: 'held', sha, reason: 'wording' };
  if (scanText(text, denylist).length) return { bucket: 'held', sha, reason: 'names' };
  return { bucket: 'item', sha, area: areaFor(scope, text), text };
}

/* ------------------------------------------------------------ one batch */

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function summaryFor(c) {
  const parts = [c.items ? `${plural(c.items, 'change')} you'll notice` : 'Nothing new on your screens'];
  if (c.off) parts.push(`${plural(c.off, 'more is', 'more are')} built but switched off until they prove out`);
  const quiet = c.behind + c.held + c.duplicates;
  if (quiet) parts.push(`${plural(quiet, 'change')} behind the scenes`);
  return `${parts.join('. ')}.`;
}

/**
 * The note for one merged batch. `commits` is [{ sha, subject, body }] oldest or newest first (order is
 * kept); `denylist` is denylistFromPlans' output: null or empty holds the whole note.
 */
export function buildReleaseNote({ commits, from, to, denylist, now = Date.now() }) {
  const list = Array.isArray(commits) ? commits : [];
  const id = createHash('sha256').update(`${from}..${to}`).digest('hex').slice(0, 12);
  const base = { id, from: String(from ?? ''), to: String(to ?? ''), generated_at: new Date(now).toISOString(), seen_at: null };
  if (!Array.isArray(denylist) || denylist.length === 0) {
    return {
      ...base, status: 'held', reason: 'Held back: the names check could not run, so nothing is shown.',
      summary: 'Held back until the names check can run.', items: [], off: [], behind: [], held: { names: 0, wording: 0, lines: [] },
      counts: { commits: list.length, items: 0, duplicates: 0, off: 0, behind: 0, held: list.length },
    };
  }
  const items = [];
  const byText = new Map();
  const off = [];
  const behind = [];
  const held = { names: 0, wording: 0, lines: [] };
  let duplicates = 0;
  for (const commit of list) {
    const c = classifyCommit(commit, denylist);
    if (c.bucket === 'item') {
      const key = c.text.toLowerCase();
      if (byText.has(key)) { byText.get(key).shas.push(c.sha); duplicates++; continue; }
      const item = { area: c.area, text: c.text, shas: [c.sha] };
      byText.set(key, item);
      items.push(item);
    } else if (c.bucket === 'off') off.push({ sha: c.sha });
    else if (c.bucket === 'behind') behind.push({ sha: c.sha, reason: c.reason });
    else { held[c.reason]++; held.lines.push({ sha: c.sha, reason: c.reason }); }
  }
  items.sort((a, b) => AREAS.indexOf(a.area) - AREAS.indexOf(b.area));
  const counts = { commits: list.length, items: items.length, duplicates, off: off.length, behind: behind.length, held: held.lines.length };
  return { ...base, status: 'ready', summary: summaryFor(counts), items, off, behind, held, counts };
}

/* ------------------------------------------------------------ the notes file */

/** { notes: [...] }. A missing file is an empty list; anything unreadable throws (never "no news"). */
export function readNotes(file = releaseNotesPath()) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { notes: [] };
    throw new Error(`The release notes could not be read (${e.code ?? 'error'}).`, { cause: e });
  }
  let doc;
  try { doc = JSON.parse(raw); } catch (e) {
    throw new Error('The release notes could not be read (not valid JSON).', { cause: e });
  }
  if (!Array.isArray(doc?.notes)) throw new Error('The release notes could not be read (no notes list).');
  return doc;
}

function writeNotes(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Adds a note (replacing one with the same id). Throws, leaving the file as it was, if it can't be read. */
export function appendNote(file, note) {
  const doc = readNotes(file);
  writeNotes(file, { notes: [...doc.notes.filter(n => n.id !== note.id), note] });
  return note;
}

/** The newest ready note not yet seen, or null. Throws when the file can't be read. */
export function latestUnseen(file = releaseNotesPath()) {
  const { notes } = readNotes(file);
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i];
    if (n?.status === 'ready' && !n.seen_at && n.counts?.items > 0) return n;
  }
  return null;
}

/** The newest note's `to`, the default start of the next batch; null with no notes. */
export function lastNoteTo(file = releaseNotesPath()) {
  const { notes } = readNotes(file);
  return notes.length ? notes[notes.length - 1].to || null : null;
}

/** Marks a note seen. 'missing' for an unknown id; a note already seen stays as it was. */
export function markSeen(file, id, now = Date.now()) {
  const doc = readNotes(file);
  const note = doc.notes.find(n => n.id === id);
  if (!note) return 'missing';
  if (note.seen_at) return 'already';
  note.seen_at = new Date(now).toISOString();
  writeNotes(file, doc);
  return 'seen';
}

/** The view a Today card reads: only what it draws (no shas). */
export function noteForToday(note) {
  if (!note) return null;
  return { id: note.id, generated_at: note.generated_at, summary: note.summary, items: note.items.map(({ area, text }) => ({ area, text })), counts: note.counts };
}
