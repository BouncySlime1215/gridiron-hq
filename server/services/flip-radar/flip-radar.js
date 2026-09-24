/**
 * FLIP-01: the flip radar as a producer. Nightly, and again on news about a
 * player rostered in the target league.
 *
 * One league (FLIP_LEAGUE_ID, league 4: NORTH-STAR-PLAN "the north star
 * targets league 4"). Default-off: it runs only under the local preview switch
 * (preview-mode.js#previewUnconfirmed), because every P(accept) it prints is
 * today's unfitted acceptance model and its clone prices are
 * playerValuation's multiplier until CLONE-01b fits land.
 *
 * Each run writes one `flip_map_snapshots` row (migration 085), failed runs
 * included. `latestFlipMap` reads the newest good one, and `flipMapEntry`
 * hands the campaign producer (PR #233) the `flip_map` section and the names
 * it needs, already in the plans contract's shape (plans-schema.js, PR #238).
 */
import { row, rows, run } from '../../db/index.js';
import { previewUnconfirmed } from '../preview-mode.js';
import { normalizePlayerName } from '../player-identity.js';
import { computeFlipMap } from './flip-map.js';
import { toFlipMapSection } from './flip-section.js';
import { daysToDeadline } from './flip-score.js';

export const FLIP_LEAGUE_ID = 4;
export const NIGHTLY_MINUTES = 24 * 60;
/** Two news runs are at least this far apart, so a news burst costs one run. */
export const NEWS_GAP_MINUTES = 60;
export const OFF_REASON = 'flip radar is default-off: unfitted P(accept) and pre-CLONE-01b clone prices (preview only)';

/**
 * Whether to run now. Pure. `lastAt` is the newest snapshot's generated_at
 * (any run, failed included, so a failing world is not retried every tick).
 */
export function decideRun({ lastAt, now = Date.now(), newsHits = 0, force = false }) {
  if (force) return { run: true, trigger: 'manual' };
  const ageMin = lastAt ? (now - Date.parse(lastAt)) / 60_000 : Infinity;
  if (!(ageMin < NIGHTLY_MINUTES)) return { run: true, trigger: 'nightly' };
  if (newsHits > 0 && ageMin >= NEWS_GAP_MINUTES) return { run: true, trigger: 'news' };
  return { run: false, reason: newsHits > 0 ? 'news seen, inside the news gap' : 'fresh, no news since' };
}

/** Normalised names of every player rostered in the league (ESPN payload). */
export function rosteredNames(payload) {
  let p = payload;
  if (typeof p === 'string') {
    try { p = JSON.parse(p); } catch (e) {
      if (e instanceof SyntaxError) return new Set();
      throw e;
    }
  }
  const out = new Set();
  for (const t of p?.teams ?? []) {
    for (const e of t.roster?.entries ?? []) {
      const n = normalizePlayerName(e.playerPoolEntry?.player?.fullName);
      if (n) out.add(n);
    }
  }
  return out;
}

/** News signals newer than `sinceIso` about a player rostered in the league. */
export function newsSince(leagueId, sinceIso) {
  const lg = row('SELECT payload FROM leagues WHERE id = ?', leagueId);
  if (!lg?.payload) return [];
  const names = rosteredNames(lg.payload);
  if (!names.size) return [];
  const since = sinceIso ?? '1970-01-01T00:00:00Z';
  return rows(`SELECT id, player_name, signal_type FROM nfl_news_signals
    WHERE created_at > datetime(?) ORDER BY id`, since)
    .filter(s => names.has(normalizePlayerName(s.player_name)));
}

export function lastSnapshot(leagueId) {
  return row(`SELECT * FROM flip_map_snapshots WHERE league_id = ? ORDER BY id DESC LIMIT 1`, leagueId) ?? null;
}

/** The newest snapshot that did not fail, parsed. */
export function latestFlipMap(leagueId = FLIP_LEAGUE_ID) {
  const r = row(`SELECT * FROM flip_map_snapshots WHERE league_id = ? AND error IS NULL
    ORDER BY id DESC LIMIT 1`, leagueId);
  if (!r) return null;
  return { ...r, section: JSON.parse(r.section_json), names: JSON.parse(r.names_json),
    managers: JSON.parse(r.managers_json) };
}

/**
 * What the campaign producer merges into league 4's plans entry: the
 * `flip_map` section and the names its player ids need. Never a bare null:
 * no snapshot yet is `unknown` with the reason.
 */
export function flipMapEntry(leagueId = FLIP_LEAGUE_ID) {
  if (!previewUnconfirmed()) return { flip_map: { status: 'unknown', reason: OFF_REASON, source: 'sim.title' }, names: {} };
  const snap = latestFlipMap(leagueId);
  if (!snap) {
    const last = lastSnapshot(leagueId);
    const reason = last?.error ? `flip radar failed: ${last.error}` : 'flip radar has not run yet';
    return { flip_map: { status: last?.error ? 'failed' : 'unknown', reason, source: 'sim.title' }, names: {} };
  }
  return { flip_map: snap.section, names: snap.names };
}

/**
 * One radar run: build the world, compute, write the snapshot. `world` is
 * injectable (tests); by default flip-world.js builds it from the DB.
 */
export async function runFlipRadar({ leagueId = FLIP_LEAGUE_ID, trigger = 'manual', triggerRef = null,
  now = Date.now(), world = null, opts = {} } = {}) {
  const t0 = Date.now();
  const generatedAt = new Date(now).toISOString();
  const write = r => run(`INSERT INTO flip_map_snapshots
    (league_id, trigger, trigger_ref, generated_at, days_to_deadline, pairs_n, flips_n,
     section_json, names_json, managers_json, runtime_ms, rescores, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  leagueId, trigger, triggerRef, generatedAt, r.days ?? null, r.pairs_n ?? 0, r.flips_n ?? 0,
  r.section ?? null, r.names ?? null, r.managers ?? null, Date.now() - t0, r.rescores ?? null, r.error ?? null);

  let w;
  try {
    w = world ?? (await import('./flip-world.js')).flipWorld(leagueId);
  } catch (e) {
    write({ error: `world build threw: ${e.message}` });
    throw e;
  }
  if (w.error) { write({ error: w.error }); return { ok: false, error: w.error, trigger }; }

  const days = daysToDeadline(row('SELECT payload FROM leagues WHERE id = ?', leagueId)?.payload, now);
  let result;
  try {
    result = computeFlipMap({ ...w.ctx, days }, opts);
  } catch (e) {
    write({ error: `flip map threw: ${e.message}`, rescores: w.rescores?.() });
    throw e;
  }
  const { section, ids } = toFlipMapSection(result, { asOf: generatedAt });
  const managerIds = Object.values(result.managers).flatMap(list => list.map(x => String(x.player)));
  const names = Object.fromEntries([...new Set([...ids, ...managerIds])].map(id => [id, w.names(id)]));
  const flipsN = section.status === 'ok' ? section.value.length : 0;
  write({ days: result.days, pairs_n: result.pairs.length, flips_n: flipsN,
    section: JSON.stringify(section), names: JSON.stringify(names),
    managers: JSON.stringify(result.managers), rescores: w.rescores?.() });
  return { ok: true, trigger, pairs: result.pairs.length, flips: flipsN,
    realised: result.flips.filter(f => f.legs).length, days: result.days, runtime_ms: Date.now() - t0 };
}

/**
 * The scheduler tick (job `flip_radar`). Off unless preview is on; then runs
 * nightly, or sooner when news lands on a rostered player.
 */
export async function flipRadarTick({ leagueId = FLIP_LEAGUE_ID, now = Date.now(), force = false, world = null } = {}) {
  if (!previewUnconfirmed()) return { skipped: true, reason: OFF_REASON };
  const last = lastSnapshot(leagueId);
  const news = newsSince(leagueId, last?.generated_at ?? null);
  const d = decideRun({ lastAt: last?.generated_at ?? null, now, newsHits: news.length, force });
  if (!d.run) return { skipped: true, reason: d.reason, news: news.length };
  const ref = d.trigger === 'news'
    ? JSON.stringify(news.slice(0, 20).map(s => ({ id: s.id, type: s.signal_type }))) : null;
  return runFlipRadar({ leagueId, trigger: d.trigger, triggerRef: ref, now, world });
}
