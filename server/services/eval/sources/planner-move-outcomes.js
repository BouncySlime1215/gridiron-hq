/**
 * SOURCE-TABLES: the `planner_move_outcomes` producer, E4-live's source
 * (server/services/eval/e4-planner.js#live).
 *
 * One row per league-week, in two phases:
 *
 *   capture  the first tick that sees a week's plan (and the week not yet final) stores
 *            what each arm would have done that week, and the paired seed:
 *              planner  the War Room's served next move (plans file next_move, first step),
 *                       or "none" when the planner served no move (it said: do nothing)
 *              finder   the Trade Lab finder's best single offer, picked by the SAME rule the
 *                       producer's finder baseline uses (league-adapter.mjs#pickFinderBest)
 *              greedy   the best value-fair 1-for-1 by Nick's projected lineup points, no
 *                       simulator (greedyMove below; the rule scripts/eval/e4-planner-replay.mjs
 *                       uses: screen -12% to +18%, lineup gain > 0)
 *            A later capture of the same week never rewrites the row: what was served first
 *            is what gets graded.
 *   settle   once the week is final (its 'final' lineups are in league_roster_snapshots), each
 *            arm's first step is re-priced on the post-week world with its paired seed
 *            (season-sim.js#tradeImpact: with vs without, same dice). gain = title-odds delta
 *            if that step had been accepted. "none" = 0 (doing nothing gains nothing, by
 *            definition). An arm whose capture failed, or whose players no longer sit on the
 *            two rosters, is NULL with the reason in settle_note, and E4-live does not count
 *            that week (it grades only rows where all three gains are numbers).
 *
 * Every arm is scored the same way (first step, if accepted, same seed), so the planner is
 * compared with its baselines like for like. It is NOT E4's replay ("realized over the rest
 * of the season"): the season has not been played yet; see the PR's "Assumed".
 *
 * Off by default: the refresh tick runs this only with GRIDIRON_SOURCE_TABLES=1 (flag.js).
 * It feeds a grader and moves no served number.
 */

import { PINNED_NEVER_GIVE, PINNED_NEVER_GET } from '../../campaign/never-give.js';

export const TABLE = 'planner_move_outcomes';
export const ARMS = Object.freeze(['planner', 'finder', 'greedy']);
/** The greedy baseline's fairness window on the market screen (e4-planner-replay.mjs#greedyMove). */
export const GREEDY_SCREEN = Object.freeze({ low: -12, high: 18 });
/** Ticks a week may retry a failed re-price before it settles as ungraded. */
export const MAX_SETTLE_ATTEMPTS = 4;

export const DDL = `CREATE TABLE IF NOT EXISTS planner_move_outcomes (
  league_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  me TEXT NOT NULL,
  planner_arm TEXT NOT NULL,
  finder_arm TEXT NOT NULL,
  greedy_arm TEXT NOT NULL,
  seed INTEGER,
  plans_generated_at TEXT,
  captured_at TEXT NOT NULL,
  planner_gain REAL,
  planner_gain_se REAL,
  finder_gain REAL,
  finder_gain_se REAL,
  greedy_gain REAL,
  greedy_gain_se REAL,
  settle_note TEXT,
  settle_attempts INTEGER NOT NULL DEFAULT 0,
  settled_at TEXT,
  PRIMARY KEY (league_id, season, week)
)`;

export function ensureTable(database) {
  database.exec(DDL);
}

const ids = list => (list ?? []).map(x => String(x?.id ?? x));
const moveOf = (partner, give, get) => ({ partner: String(partner), give: ids(give), get: ids(get) });

/** An arm as stored: { state: 'move', move } | { state: 'none', why } | { state: 'error', why }. */
export const armMove = move => ({ state: 'move', move });
export const armNone = why => ({ state: 'none', why: String(why) });
export const armError = why => ({ state: 'error', why: String(why).slice(0, 300) });

/** The planner arm from one plans-file league entry (the served view: next_move). */
export function plannerArm(entry) {
  if (!entry) return armError('no plans entry for this league');
  if (entry.error) return armError(`plans entry error: ${entry.error}`);
  const nm = entry.next_move;
  if (nm?.status === 'ok') {
    const s = nm.value?.steps?.[0];
    if (!s || s.partner == null) return armError('served next move has no first step');
    return armMove(moveOf(s.partner, s.give, s.get));
  }
  if (nm?.status === 'unknown') {
    // A planner that REFUSED to plan (failed closed for lack of inputs) did not choose "do
    // nothing": grading that week as gain 0 would compare a baseline against a refusal.
    // Those weeks are ungraded (#395 review): the trade ledger was missing, or the fresh
    // confirm dice did not run.
    const run = entry._run ?? null;
    if (Number(run?.dropped_by_reason?.trade_ledger_missing) > 0) {
      return armError('planner failed closed: trade ledger missing, so it did not plan this week');
    }
    if (run?.confirm && run.confirm.status !== 'ok') {
      return armError(`planner failed closed: confirm dice ${run.confirm.status}${run.confirm.reason ? ` (${run.confirm.reason})` : ''}`);
    }
    return armNone(nm.reason ?? 'the planner served no move');
  }
  return armError('plans entry has no next_move');
}

/** The finder arm from league-adapter.mjs#pickFinderBest's result. */
export function finderArm(best) {
  if (!best) return armError('finder not run');
  if (best.error) return armError(`finder: ${best.error}`);
  if (!best.move) return armNone('finder found no deal');
  return armMove(best.move);
}

/**
 * Greedy baseline (pure). teams: [{ roster_id, players: [{ id, name, position, value }] }];
 * lineupPoints(players) -> Nick's projected lineup points; me: his roster id.
 * Best 1-for-1 inside GREEDY_SCREEN (screen = (give - get) / get, market value) that raises
 * his lineup points. Nick's hard filters are main's one pinned list (campaign/never-give.js): never
 * give PINNED_NEVER_GIVE (160, 80, 277), never get PINNED_NEVER_GET (290), both by id.
 */
export function greedyMove({ teams, me, lineupPoints, positions = ['QB', 'RB', 'WR', 'TE'],
  neverGive = PINNED_NEVER_GIVE, neverGet = PINNED_NEVER_GET, screen = GREEDY_SCREEN }) {
  const mine = teams.find(t => String(t.roster_id) === String(me));
  if (!mine) return armError(`team ${me} not in the league's rosters`);
  const blockGive = new Set(neverGive.map(String));
  const blockGetIds = new Set(neverGet.map(String));
  const tradable = p => positions.includes(p.position) && Number(p.value) > 0;
  // No market value on any of his players means the values failed to load, not that no fair
  // deal exists: that is an ungradable arm, never a "do nothing" that would settle as gain 0.
  if (!mine.players.some(p => positions.includes(p.position) && Number(p.value) > 0)) {
    return armError(`no market values on team ${me}'s players`);
  }
  const gives = mine.players.filter(p => tradable(p) && !blockGive.has(String(p.id)));
  const now = lineupPoints(mine.players);
  let best = null;
  for (const t of teams) {
    if (String(t.roster_id) === String(me)) continue;
    for (const get of t.players) {
      if (!tradable(get) || blockGetIds.has(String(get.id))) continue;
      for (const give of gives) {
        const pct = (Number(give.value) - Number(get.value)) / Number(get.value) * 100;
        if (!(pct >= screen.low && pct <= screen.high)) continue;
        const g = lineupPoints([...mine.players.filter(p => p.id !== give.id), get]) - now;
        if (g > 0 && (!best || g > best.g)) best = { g, move: moveOf(t.roster_id, [give.id], [get.id]) };
      }
    }
  }
  return best ? armMove(best.move) : armNone('no fair 1-for-1 raises the lineup');
}

/**
 * Capture one league-week (first capture wins). Returns true when a row was written.
 * arms: { planner, finder, greedy } in the armMove/armNone/armError shape.
 */
export function captureWeek(database, { league_id, season, week, me, arms, seed = null, plans_generated_at = null,
  now = () => new Date().toISOString() }) {
  ensureTable(database);
  for (const a of ARMS) if (!arms?.[a]?.state) throw new Error(`captureWeek: arm ${a} missing`);
  const r = database.prepare(`INSERT OR IGNORE INTO planner_move_outcomes (league_id, season, week, me, planner_arm,
      finder_arm, greedy_arm, seed, plans_generated_at, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(league_id, season, week, String(me), JSON.stringify(arms.planner), JSON.stringify(arms.finder),
      JSON.stringify(arms.greedy), seed, plans_generated_at, now());
  return Number(r.changes) > 0;
}

export function hasWeek(database, { league_id, season, week }) {
  ensureTable(database);
  return !!database.prepare('SELECT 1 FROM planner_move_outcomes WHERE league_id = ? AND season = ? AND week = ?')
    .get(league_id, season, week);
}

/** Is this league-week final: its final lineups are stored (collect-roster-snapshots.mjs). */
export function weekIsFinal(database, { league_id, season, week }) {
  const t = database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'league_roster_snapshots'`).get();
  if (!t) return false;
  return !!database.prepare(`SELECT 1 FROM league_roster_snapshots
    WHERE league_id = ? AND season = ? AND scoring_period_id = ? AND source = 'final' LIMIT 1`).get(league_id, season, week);
}

/** Captured rows not yet settled whose week is now final. */
export function dueRows(database) {
  ensureTable(database);
  return database.prepare('SELECT * FROM planner_move_outcomes WHERE settled_at IS NULL ORDER BY league_id, season, week').all()
    .filter(r => weekIsFinal(database, r));
}

/** Players of a move not on the side they must come from, in plain words; [] when it can be priced. */
export function moveProblems(teams, me, move) {
  const roster = id => new Set((teams.find(t => String(t.roster_id) === String(id))?.players ?? []).map(p => String(p.id)));
  const mine = roster(me), his = roster(move.partner);
  const out = [];
  for (const id of move.give) if (!mine.has(String(id))) out.push(`give ${id} no longer on team ${me}`);
  for (const id of move.get) if (!his.has(String(id))) out.push(`get ${id} no longer on team ${move.partner}`);
  return out;
}

/**
 * Settle one captured row. deps: { teams(row) -> rosters now, reprice(row, move) -> { title_delta,
 * title_delta_se } | { error } }. Writes the gains (NULL where an arm cannot be graded) and a note.
 * A failed re-price is transient: the row stays unsettled (settle_attempts + 1) and the next tick
 * retries it, up to MAX_SETTLE_ATTEMPTS; only then does it settle with that arm NULL. Players who
 * left the rosters, or an arm whose capture failed, settle NULL at once (retrying cannot fix them).
 */
export function settleRow(database, row, { teams, reprice, now = () => new Date().toISOString(),
  maxAttempts = MAX_SETTLE_ATTEMPTS }) {
  const out = {}, notes = [];
  let rosters = null, transient = false;
  for (const a of ARMS) {
    let arm;
    try { arm = JSON.parse(row[`${a}_arm`]); } catch (e) { arm = armError(`unreadable arm: ${e.message}`); }
    if (arm.state === 'none') { out[a] = { gain: 0, se: 0 }; continue; }
    if (arm.state !== 'move') { out[a] = { gain: null, se: null }; notes.push(`${a}: ${arm.why}`); continue; }
    rosters = rosters ?? teams(row);
    const problems = moveProblems(rosters, row.me, arm.move);
    if (problems.length) { out[a] = { gain: null, se: null }; notes.push(`${a}: ${problems.join('; ')}`); continue; }
    let r;
    try { r = reprice(row, arm.move); } catch (e) { r = { error: String(e?.message ?? e) }; }
    if (!r || r.error || !Number.isFinite(r.title_delta)) {
      out[a] = { gain: null, se: null };
      transient = true;
      notes.push(`${a}: reprice failed (${String(r?.error ?? 'no title_delta').slice(0, 120)})`);
      continue;
    }
    out[a] = { gain: r.title_delta, se: Number.isFinite(r.title_delta_se) ? r.title_delta_se : null };
  }
  const attempts = Number(row.settle_attempts ?? 0) + 1;
  const note = notes.length ? notes.join(' | ').slice(0, 1000) : null;
  if (transient && attempts < maxAttempts) {
    database.prepare(`UPDATE planner_move_outcomes SET settle_attempts = ?, settle_note = ?
      WHERE league_id = ? AND season = ? AND week = ?`)
      .run(attempts, `attempt ${attempts} of ${maxAttempts}: ${note}`.slice(0, 1000), row.league_id, row.season, row.week);
    return { graded: false, retry: true, gains: out, notes };
  }
  database.prepare(`UPDATE planner_move_outcomes SET planner_gain = ?, planner_gain_se = ?, finder_gain = ?,
      finder_gain_se = ?, greedy_gain = ?, greedy_gain_se = ?, settle_note = ?, settle_attempts = ?, settled_at = ?
    WHERE league_id = ? AND season = ? AND week = ?`)
    .run(out.planner.gain, out.planner.se, out.finder.gain, out.finder.se, out.greedy.gain, out.greedy.se,
      note, attempts, now(), row.league_id, row.season, row.week);
  return { graded: ARMS.every(a => out[a].gain != null), retry: false, gains: out, notes };
}
