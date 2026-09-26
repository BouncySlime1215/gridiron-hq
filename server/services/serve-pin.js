/**
 * SERVE-LOG REPRO (batch D item 31): the pin behind every served response.
 *
 * serve-log.js keeps each number as served, with its model and model version.
 * This adds what reproducing it needs, one row per response in `served_pins`
 * (migration 119), written in the same transaction as its numbers:
 *
 *   code      the commit this server process is running: GRIDIRON_CODE_SHA, else
 *             .git/HEAD read once (the code loaded at start is what serves)
 *   snapshot  sha256 of the league payload the number came from, with its as_of;
 *             hashed once per league sync, not per request
 *   args      the producer arguments the route used (runs, from_week, team, ...)
 *   seed      the seed the producer ran under, or `seed_basis` saying where it
 *             comes from when the route does not pick one
 *   flags     the process's GRIDIRON_* switches (on/off-shaped values only), since a
 *             flag such as the one world or RB-TITLE changes what the same code serves
 *
 * Behind GRIDIRON_SERVE_PIN=1 (own flag; preview mode does not switch it on).
 * The routes' title odds and trade cards are drawn on the league world, whose id
 * (the NFL week's seed) is the pinned seed. The weekly snapshot's title odds were
 * the last unseeded served draw: with the flag on they run on `titleOddsSeed`,
 * keyed to the league sync the way season-sim.js#tradeImpactSeed keys trade cards
 * (the same distribution, a draw that can be re-run). That is the only served
 * behaviour the flag changes. serve-repro.js reads the pins back.
 *
 * The snapshot covers the league payload only; projections and fit stores are
 * not fingerprinted, so their drift shows up as a `mismatch` at reproduce time.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db as processDb } from '../db/index.js';
import { keyedSeed } from './stats-util.js';

export const SERVE_PIN_ENV = 'GRIDIRON_SERVE_PIN';
export const PIN_VERSION = 1;
export const servePinOn = (env = process.env) => env[SERVE_PIN_ENV] === '1';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA_RE = /^[0-9a-f]{40}$/;

// ------------------------------------------------------------------ code
const readText = p => fs.readFileSync(p, 'utf8').trim();

/** The git directory of a checkout: `.git` itself, or where a worktree's `.git` file points. */
function gitDir(repoDir) {
  const dotGit = path.join(repoDir, '.git');
  const st = fs.statSync(dotGit);
  if (st.isDirectory()) return dotGit;
  const m = readText(dotGit).match(/^gitdir:\s*(.+)$/m);
  if (!m) throw new Error('.git is a file with no gitdir line');
  return path.resolve(repoDir, m[1]);
}

/** HEAD's commit, read from files (no git process): loose ref, packed-refs, or detached. */
function headSha(repoDir) {
  const dir = gitDir(repoDir);
  const head = readText(path.join(dir, 'HEAD'));
  if (SHA_RE.test(head)) return head;
  const ref = head.match(/^ref:\s*(\S+)$/)?.[1];
  if (!ref) throw new Error('HEAD is neither a sha nor a ref');
  // A linked worktree keeps HEAD locally and refs in the common dir.
  const common = fs.existsSync(path.join(dir, 'commondir')) ? path.resolve(dir, readText(path.join(dir, 'commondir'))) : dir;
  for (const base of [dir, common]) {
    const loose = path.join(base, ref);
    if (fs.existsSync(loose)) return readText(loose);
  }
  const packed = path.join(common, 'packed-refs');
  if (fs.existsSync(packed)) {
    for (const line of readText(packed).split('\n')) {
      const [sha, name] = line.split(' ');
      if (name === ref && SHA_RE.test(sha)) return sha;
    }
  }
  throw new Error(`${ref} not found`);
}

let codeCache = null;
let codeRepoDir = REPO_ROOT;
/**
 * { sha, source: 'env' | 'git' } or { sha: null, reason }. Cached for the
 * process after the first read (pass `fresh` to re-read), because the code a
 * running server serves is the code it loaded, whatever HEAD says later.
 */
export function codePin({ env = process.env, repoDir = codeRepoDir, fresh = false } = {}) {
  if (codeCache && !fresh) return codeCache;
  let out;
  const fromEnv = String(env.GRIDIRON_CODE_SHA ?? '').trim().toLowerCase();
  if (SHA_RE.test(fromEnv)) out = { sha: fromEnv, source: 'env' };
  else {
    try {
      const sha = headSha(repoDir);
      out = SHA_RE.test(sha) ? { sha, source: 'git' } : { sha: null, reason: 'HEAD did not resolve to a commit sha' };
    } catch (err) {
      out = { sha: null, reason: `no commit sha: set GRIDIRON_CODE_SHA or run from a git checkout (${err.message})` };
    }
  }
  if (!fresh) codeCache = out;
  return out;
}

// ------------------------------------------------------------------ snapshot
const SNAP_CACHE_CAP = 64;
const snapCache = new Map();
let hashes = 0;

/** { sha256, bytes, as_of } of the league payload, or { sha256: null, reason }. One hash per sync. */
export function snapshotPin(lg) {
  if (!lg?.payload) return { sha256: null, as_of: lg?.fetched_at ?? null, reason: 'league not synced' };
  const text = typeof lg.payload === 'string' ? lg.payload : JSON.stringify(lg.payload);
  const key = `${lg.id}|${lg.fetched_at ?? ''}|${text.length}`;
  let hit = snapCache.get(key);
  if (!hit) {
    hashes++;
    hit = { sha256: crypto.createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) };
    snapCache.set(key, hit);
    if (snapCache.size > SNAP_CACHE_CAP) snapCache.delete(snapCache.keys().next().value);
  }
  return { ...hit, as_of: lg.fetched_at ?? null };
}
/** Tests: how many payloads have been hashed. */
export const snapshotHashCount = () => hashes;

/** Tests only. */
export function __resetServePin({ codeRepoDir: dir = REPO_ROOT } = {}) {
  codeCache = null; codeRepoDir = dir; snapCache.clear(); hashes = 0;
}

// ------------------------------------------------------------------ flags
/** Switch-shaped values only: a path, key or token never lands in a pin. */
const SWITCH_VALUE = /^(0|1|on|off|true|false|yes|no|shadow|preview|deltas|enforce|live|study)$/i;
const SECRET_NAME = /KEY|TOKEN|SECRET|PASS|COOKIE|CRED|AUTH/;

/** { GRIDIRON_X: '1', ... } for every set GRIDIRON_* switch, sorted by name. */
export function flagPin(env = process.env) {
  return Object.fromEntries(Object.keys(env).filter(k => /^GRIDIRON_[A-Z0-9_]+$/.test(k) && !SECRET_NAME.test(k)
    && k !== 'GRIDIRON_CODE_SHA' && SWITCH_VALUE.test(String(env[k]).trim())).sort().map(k => [k, String(env[k]).trim()]));
}

/** The switches that differ between two flag pins: [{ name, served, now }]. */
export function flagDiff(served = {}, now = {}) {
  return [...new Set([...Object.keys(served), ...Object.keys(now)])].sort()
    .filter(k => served[k] !== now[k]).map(k => ({ name: k, served: served[k] ?? null, now: now[k] ?? null }));
}

// ------------------------------------------------------------------ seed
/** The seed the weekly snapshot's title odds run on with the flag on: one per league sync and settings. */
export function titleOddsSeed(lg, { runs, fromWeek = null } = {}) {
  return keyedSeed('title-odds', lg.id, lg.fetched_at ?? '', runs ?? '', fromWeek ?? '');
}

/** Where a surface's randomness comes from when the route does not hand over a seed. */
function seedBasis(surface, payload, args, seed) {
  if (seed != null) return 'recorded';
  if (surface === 'title_odds') return args?.one_world ? 'one-world week seed (league-world.js)' : 'unrecorded';
  if (surface === 'title_trades') return 'derived from the league sync (tradeImpactSeed)';
  if (surface === 'trade_find') return 'not seeded by the route';
  if (surface === 'war_room') return 'plans file';
  return 'unrecorded';
}

const finiteSeed = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * The pin for one served response. `args` are the producer arguments, `context`
 * the serve-log extractor context (needed to read a re-run back into rows).
 */
export function pinFor(surface, lg, payload, { args = null, context = {}, seed = null } = {}) {
  const s = finiteSeed(seed ?? (surface === 'trade_impact' ? payload?.seed : null));
  return {
    pin_version: PIN_VERSION, surface, code: codePin(), snapshot: snapshotPin(lg), flags: flagPin(),
    args: args ?? {}, context: context ?? {}, seed: s, seed_basis: seedBasis(surface, payload, args, s),
  };
}

/** The row served_pins stores for one queue entry. */
export const pinRow = e => [e.request_id, e.league_id, e.surface, e.served_at,
  e.pin.code.sha ?? null, e.pin.snapshot.sha256 ?? null, e.pin.seed, JSON.stringify(e.pin)];

export const PIN_INSERT = `INSERT OR IGNORE INTO served_pins
  (request_id, league_id, surface, served_at, code_sha, snapshot_sha256, seed, pin)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

/** The pins of one served response (one per surface), parsed. Parameterised. */
export function readPins(leagueId, requestId, { database = processDb } = {}) {
  return database.prepare(`SELECT request_id, league_id, surface, served_at, code_sha, snapshot_sha256, seed, pin
    FROM served_pins WHERE league_id = ? AND request_id = ? ORDER BY surface`).all(leagueId, String(requestId))
    .map(r => ({ ...r, pin: JSON.parse(r.pin) }));
}
