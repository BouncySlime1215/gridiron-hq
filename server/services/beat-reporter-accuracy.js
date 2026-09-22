/**
 * Beat reporter source map — historical accuracy for injury_status,
 * role_change, and return_from_injury.
 *
 * Nick's ask (PART 5): "Score sources historically: whose reports actually
 * predicted outcomes vs. who cried wolf." `source-validation.js` already
 * answers a different question — is this handle who it claims to be — and
 * this does not repeat that check. This answers: when this handle said a
 * player would or wouldn't play (injury_status, return_from_injury) or take
 * on more/less of the offense (role_change), did that actually happen?
 *
 * All three share player_week_snaps as ground truth. injury_status and
 * return_from_injury both reduce to the same played-or-not read (shared via
 * playedOrNot()) and differ only in the vocabulary that decides which side of
 * "played" a claim commits to; role_change reads the swing in offense_pct
 * against the player's own prior week instead. The remaining two types
 * (transaction, suspension) each need their own ground-truth read and are
 * deliberately not attempted here — "prove a small slice before building on
 * it" (Composer protocol).
 *
 * Direction is read by keyword, not by a second model call. The extractor
 * (nfl-news-events.js) is already the one hallucination surface in this
 * pipeline; classifying its own output with another LLM call would let a
 * bad read compound with nothing to check it against. A resolver that
 * cannot classify a claim's direction reports 'unresolved' rather than
 * guessing, same discipline as contingency.js's availabilityBasis(): a
 * printed reason instead of a silent default.
 */
import { rows, row, run } from '../db/index.js';
import { normalizePlayerName } from './player-identity.js';
import { ROLE_RULES } from './nfl-news-signal.js';

/** Below this many resolved claims, a handle's rate is pooled toward the
 * claim-type baseline rather than reported on its own — one confirmed claim
 * read as "100% accurate" is not a measurement, it is noise dressed as one. */
const MIN_SAMPLE = 5;

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));

const SIDELINED = /\b(ruled out|will not play|won'?t play|inactive|sidelined|doubtful|placed on (the )?ir\b|injured reserve|out for (the )?(season|year)|miss(es|ing)? (the game|this week|sunday))\b/i;
const CLEAR = /\b(cleared to play|will play|active( for)?|expected to play|off (the )?injury report|no injury designation|good to go|full practice|probable)\b/i;
const UNCERTAIN = /\b(questionable|day-to-day|game-time decision)\b/i;

/**
 * Read the direction a claim's text commits to, deterministically.
 *
 * Checked in this order because a claim that names both a sidelined state
 * and a later clearance is about the sidelined state until proven otherwise
 * ("ruled out" is definite; "expected to play" showing up in the same
 * sentence as a floor generally does not happen in real wire copy, but if it
 * does, the more specific/definite claim should win over the softer one).
 * 'uncertain' comes before 'clear' for the same reason: "questionable" is a
 * weaker, hedged claim than "probable", and a claim that hedges should not
 * be read as if it had committed either way.
 */
export function classifyInjuryDirection(text) {
  const t = String(text ?? '');
  if (SIDELINED.test(t)) return 'sidelined';
  if (UNCERTAIN.test(t)) return 'uncertain';
  if (CLEAR.test(t)) return 'clear';
  return null;
}

function resolvePlayerId(playerName, teamId) {
  const wanted = normalizePlayerName(playerName);
  if (!wanted) return { id: null, position: null, reason: 'player name is empty' };
  const candidates = rows(`SELECT id, name, position FROM players WHERE team_id = ?`, teamId)
    .filter(p => normalizePlayerName(p.name) === wanted);
  if (candidates.length === 1) return { id: candidates[0].id, position: candidates[0].position, reason: null };
  if (candidates.length === 0) {
    return { id: null, position: null, reason: `player name did not resolve to a unique roster row (found 0 on this team)` };
  }
  return { id: null, position: null, reason: `player name matched ${candidates.length} roster rows on this team, ambiguous` };
}

/** player_week_snaps.offense_snaps only measures offensive plays (confirmed against
 * real nflverse data) — a defensive player who played a full game still reads as
 * absent/zero there, which would misread as "did not play". Injury-status and
 * role_change resolution are both scoped to the positions that table actually
 * speaks for. */
const OFFENSE_SNAP_POSITIONS = new Set(['QB', 'RB', 'FB', 'WR', 'TE']);

/**
 * Steps every claim_type resolver needs before it can even ask what happened:
 * find the team, the first game on or after the claim date, and the player —
 * none of which depends on what is actually being claimed. Never throws;
 * returns `{ ok: false, ... }` with the same unresolved shape every resolver
 * returns, or `{ ok: true, game, playerId, position }` to continue with.
 */
function locateGameAndPlayer(event, asOf) {
  const team = row(`SELECT id FROM nfl_teams WHERE abbr = ?`, event.team);
  if (!team) {
    return { ok: false, season: null, week: null,
      resolved_reason: `team abbreviation '${event.team}' is not recognized` };
  }

  const claimDate = String(event.published_at ?? '').slice(0, 10);
  const game = row(
    `SELECT season, week, date FROM schedule_games WHERE team_id = ? AND date >= ? ORDER BY date ASC LIMIT 1`,
    team.id, claimDate);
  if (!game) {
    return { ok: false, season: null, week: null,
      resolved_reason: 'no scheduled game on or after the claim date' };
  }
  if (game.date > String(asOf).slice(0, 10)) {
    return { ok: false, season: game.season, week: game.week,
      resolved_reason: `game has not been played yet (scheduled ${game.date})` };
  }

  const { id: playerId, position, reason: playerReason } = resolvePlayerId(event.player_name, team.id);
  if (!playerId) {
    return { ok: false, season: game.season, week: game.week, resolved_reason: playerReason };
  }
  if (!OFFENSE_SNAP_POSITIONS.has(position)) {
    return { ok: false, season: game.season, week: game.week,
      resolved_reason: `position '${position}' is not covered by offense-snap ground truth` };
  }

  return { ok: true, team, game, playerId, position };
}

/**
 * Ground truth shared by every claim_type that reduces to "did this player
 * log an offensive snap in the game the claim points at" — injury_status and
 * return_from_injury both resolve this way, just with different vocabularies
 * deciding which side of "played" a given claim commits to.
 */
function playedOrNot(team, game, playerId) {
  const snaps = row(`SELECT offense_snaps FROM player_week_snaps WHERE player_id = ? AND season = ? AND week = ?`,
    playerId, game.season, game.week);
  if (!snaps) {
    // player_week_snaps only carries a row for a player who logged at least one snap
    // (confirmed against real nflverse data: an "Out" player has no row at all, not a
    // zero row) — so absence only means "no data yet" when NOTHING for this team/week
    // has landed. When teammates already have rows, the box score exists and this
    // player's absence from it is itself the evidence: he did not play.
    const teamHasData = row(`SELECT 1 FROM player_week_snaps pws JOIN players p ON p.id = pws.player_id
                              WHERE p.team_id = ? AND pws.season = ? AND pws.week = ? LIMIT 1`,
      team.id, game.season, game.week);
    if (!teamHasData) return { known: false, reason: 'no snap data yet for that week' };
  }
  const played = (snaps?.offense_snaps ?? 0) > 0;
  const reason = played
    ? `player logged ${snaps.offense_snaps} offensive snaps in week ${game.week}`
    : snaps
      ? `player logged zero offensive snaps in week ${game.week}`
      : `no offensive-snap row for this player in week ${game.week} while teammates have one — did not play`;
  return { known: true, played, reason };
}

/**
 * Resolve one injury_status event against schedule + snap data.
 *
 * `event` is a row from nfl_news_events (or anything with the same shape:
 * event_id, reporter_handle, claim_type, claim_text, evidence_span,
 * player_name, team, published_at). Never throws on an unresolvable
 * claim — every unresolvable case comes back as resolved_state:
 * 'unresolved' with a printed resolved_reason, same discipline as
 * contingency.js's availabilityDegradation().
 */
export function resolveInjuryClaim(event, { asOf = new Date().toISOString() } = {}) {
  const base = { event_id: event.event_id, reporter_handle: event.reporter_handle ?? null,
    claim_type: event.claim_type, resolved_at: new Date().toISOString(), season: null, week: null };

  const direction = classifyInjuryDirection(event.evidence_span || event.claim_text);
  if (direction === null) {
    return { ...base, predicted_direction: null, resolved_state: 'unresolved',
      resolved_reason: 'no direction classified from the claim text' };
  }
  if (direction === 'uncertain') {
    return { ...base, predicted_direction: direction, resolved_state: 'unresolved',
      resolved_reason: 'claim text does not commit to a direction (questionable/day-to-day)' };
  }

  const located = locateGameAndPlayer(event, asOf);
  if (!located.ok) {
    return { ...base, predicted_direction: direction, resolved_state: 'unresolved',
      season: located.season, week: located.week, resolved_reason: located.resolved_reason };
  }
  const { team, game, playerId } = located;

  const outcome = playedOrNot(team, game, playerId);
  if (!outcome.known) {
    return { ...base, predicted_direction: direction, resolved_state: 'unresolved', season: game.season,
      week: game.week, resolved_reason: outcome.reason };
  }

  const predicted = direction === 'sidelined' ? 'did_not_play' : 'played';
  const actual = outcome.played ? 'played' : 'did_not_play';
  const resolved_state = predicted === actual ? 'confirmed' : 'contradicted';

  return { ...base, predicted_direction: direction, resolved_state, season: game.season, week: game.week,
    resolved_reason: outcome.reason };
}

/** Shared by every claim_type's batch resolver: run `resolverFn` over `events`
 * and upsert each verdict. Idempotent and safe to re-run: an already-decided
 * row is overwritten with the same verdict (a no-op, since the game that
 * decided it does not change), and an 'unresolved' row is naturally upgraded
 * once its ground-truth table has that week's data. */
function resolveAndStore(events, resolverFn, asOf) {
  let resolved = 0;
  for (const event of events) {
    const r = resolverFn(event, asOf ? { asOf } : {});
    run(`INSERT INTO beat_reporter_claim_resolutions
         (event_id, reporter_handle, claim_type, predicted_direction, resolved_state, resolved_reason, resolved_at, season, week)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(event_id) DO UPDATE SET
           reporter_handle=excluded.reporter_handle, predicted_direction=excluded.predicted_direction,
           resolved_state=excluded.resolved_state, resolved_reason=excluded.resolved_reason,
           resolved_at=excluded.resolved_at, season=excluded.season, week=excluded.week`,
      r.event_id, r.reporter_handle, r.claim_type, r.predicted_direction, r.resolved_state,
      r.resolved_reason, r.resolved_at, r.season, r.week);
    resolved++;
  }
  return { resolved, total: events.length };
}

/** Resolve every injury_status event and upsert the verdict. */
export function resolveInjuryClaims({ limit = 500, asOf } = {}) {
  const events = rows(`SELECT * FROM nfl_news_events WHERE claim_type = 'injury_status' ORDER BY event_id LIMIT ?`, limit);
  return resolveAndStore(events, resolveInjuryClaim, asOf);
}

const RETURNING = /\b(activated from (the )?(ir|injured reserve)\b|designated (for|to) return|eligible to return|cleared to return|will make his return|expected to return|returns? to action|off (the )?injured reserve|removed from (the )?injured reserve|practice window (has been |was )?opened?|returning (to action|this week))\b/i;
const STILL_OUT = /\b(will not return|has not been cleared to return|remains? on (the )?injured reserve|not (yet )?ready to return|to miss (another|more) week|stays? on ir|another week away)\b/i;

/**
 * Read the direction a return_from_injury claim's text commits to.
 *
 * No existing rule set covers this vocabulary — STATUS_RULES/ROLE_RULES
 * (nfl-news-signal.js) classify current availability and role, not
 * "activated from IR" language, so this is its own classifier, same as
 * classifyInjuryDirection is its own rather than a reuse of STATUS_RULES.
 */
export function classifyReturnDirection(text) {
  const t = String(text ?? '');
  if (RETURNING.test(t)) return 'returning';
  if (STILL_OUT.test(t)) return 'still_out';
  return null;
}

/**
 * Resolve one return_from_injury event. Same played-or-not ground truth as
 * resolveInjuryClaim (via the shared playedOrNot helper) — only the
 * vocabulary deciding which side of "played" the claim commits to differs.
 */
export function resolveReturnFromInjuryClaim(event, { asOf = new Date().toISOString() } = {}) {
  const base = { event_id: event.event_id, reporter_handle: event.reporter_handle ?? null,
    claim_type: event.claim_type, resolved_at: new Date().toISOString(), season: null, week: null };

  const direction = classifyReturnDirection(event.evidence_span || event.claim_text);
  if (direction === null) {
    return { ...base, predicted_direction: null, resolved_state: 'unresolved',
      resolved_reason: 'no return-from-injury direction classified from the claim text' };
  }

  const located = locateGameAndPlayer(event, asOf);
  if (!located.ok) {
    return { ...base, predicted_direction: direction, resolved_state: 'unresolved',
      season: located.season, week: located.week, resolved_reason: located.resolved_reason };
  }
  const { team, game, playerId } = located;

  const outcome = playedOrNot(team, game, playerId);
  if (!outcome.known) {
    return { ...base, predicted_direction: direction, resolved_state: 'unresolved', season: game.season,
      week: game.week, resolved_reason: outcome.reason };
  }

  const predicted = direction === 'returning' ? 'played' : 'did_not_play';
  const actual = outcome.played ? 'played' : 'did_not_play';
  const resolved_state = predicted === actual ? 'confirmed' : 'contradicted';

  return { ...base, predicted_direction: direction, resolved_state, season: game.season, week: game.week,
    resolved_reason: outcome.reason };
}

/** Resolve every return_from_injury event and upsert the verdict. */
export function resolveReturnFromInjuryClaims({ limit = 500, asOf } = {}) {
  const events = rows(`SELECT * FROM nfl_news_events WHERE claim_type = 'return_from_injury' ORDER BY event_id LIMIT ?`, limit);
  return resolveAndStore(events, resolveReturnFromInjuryClaim, asOf);
}

/** How large an offense_pct swing (0-1 scale, i.e. percentage points of snap
 * share) counts as a real role move rather than ordinary week-to-week noise.
 * Below this, the honest answer is 'no significant move either way' — forcing
 * a confirm/contradict out of a flat week would be exactly the kind of
 * overclaimed precision this whole feature exists to avoid. */
const ROLE_CHANGE_THRESHOLD = 0.10;

/**
 * Read the direction a role_change claim's text commits to, deterministically.
 *
 * Reuses ROLE_RULES (nfl-news-signal.js) rather than a second copy of the
 * vocabulary — the same discipline nfl-news-events.js's own polarityOf()
 * follows for its contradiction detector. A starter-confirmed or
 * expanded-role claim reads as role_up; benched or reduced-role reads as
 * role_down.
 */
export function classifyRoleDirection(text) {
  const t = String(text ?? '');
  for (const rule of ROLE_RULES) {
    if (rule.re.test(t)) return rule.delta > 0 ? 'role_up' : 'role_down';
  }
  return null;
}

/**
 * Resolve one role_change event against schedule + snap-share data.
 *
 * Ground truth is the player's own offense_pct: the most recent week with
 * data BEFORE the claim's game week, compared to the claim's own game week.
 * A swing at or past ROLE_CHANGE_THRESHOLD in the predicted direction is
 * confirmed, one that far in the opposite direction is contradicted, and
 * anything in between is unresolved rather than forced either way. Same
 * never-throws, always-a-printed-reason discipline as resolveInjuryClaim.
 */
export function resolveRoleChangeClaim(event, { asOf = new Date().toISOString() } = {}) {
  const base = { event_id: event.event_id, reporter_handle: event.reporter_handle ?? null,
    claim_type: event.claim_type, resolved_at: new Date().toISOString(), season: null, week: null };

  const direction = classifyRoleDirection(event.evidence_span || event.claim_text);
  if (direction === null) {
    return { ...base, predicted_direction: null, resolved_state: 'unresolved',
      resolved_reason: 'no role direction classified from the claim text' };
  }

  const located = locateGameAndPlayer(event, asOf);
  if (!located.ok) {
    return { ...base, predicted_direction: direction, resolved_state: 'unresolved',
      season: located.season, week: located.week, resolved_reason: located.resolved_reason };
  }
  const { game, playerId } = located;

  const before = row(`SELECT week, offense_pct FROM player_week_snaps
                       WHERE player_id = ? AND season = ? AND week < ? ORDER BY week DESC LIMIT 1`,
    playerId, game.season, game.week);
  if (!before) {
    return { ...base, predicted_direction: direction, resolved_state: 'unresolved', season: game.season,
      week: game.week,
      resolved_reason: `no prior-week snap data this season to compare against (claim landed at or before week ${game.week})` };
  }

  const after = row(`SELECT offense_pct FROM player_week_snaps WHERE player_id = ? AND season = ? AND week = ?`,
    playerId, game.season, game.week);
  if (!after) {
    return { ...base, predicted_direction: direction, resolved_state: 'unresolved', season: game.season,
      week: game.week, resolved_reason: `no snap-share row for week ${game.week} yet` };
  }

  const delta = after.offense_pct - before.offense_pct;
  const moved = `offense snap share moved from ${r2(before.offense_pct)} (week ${before.week}) ` +
    `to ${r2(after.offense_pct)} (week ${game.week})`;

  if (Math.abs(delta) < ROLE_CHANGE_THRESHOLD) {
    return { ...base, predicted_direction: direction, resolved_state: 'unresolved', season: game.season,
      week: game.week, resolved_reason: `${moved}, not a big enough move (${r2(delta)}) to grade either way` };
  }

  const actual = delta > 0 ? 'role_up' : 'role_down';
  const resolved_state = direction === actual ? 'confirmed' : 'contradicted';
  return { ...base, predicted_direction: direction, resolved_state, season: game.season, week: game.week,
    resolved_reason: `${moved} (${r2(delta)})` };
}

/** Resolve every role_change event and upsert the verdict. */
export function resolveRoleChangeClaims({ limit = 500, asOf } = {}) {
  const events = rows(`SELECT * FROM nfl_news_events WHERE claim_type = 'role_change' ORDER BY event_id LIMIT ?`, limit);
  return resolveAndStore(events, resolveRoleChangeClaim, asOf);
}

/**
 * A handle's historical accuracy, with an honest state for what backs it.
 *
 *  - 'none': zero resolved claims. Never a number — an unscored handle must
 *    never read as "measured and bad" (UI thread's requirement).
 *  - 'pooled': fewer than MIN_SAMPLE resolved claims. The raw rate is blended
 *    toward the claim_type-wide baseline (Bayesian shrinkage with MIN_SAMPLE
 *    pseudo-observations at the baseline rate), so one lucky or unlucky call
 *    is not reported as a measured 100% or 0%.
 *  - 'measured': MIN_SAMPLE or more resolved claims. The raw rate stands.
 */
export function sourceTrustScore(handle, { claimType = null } = {}) {
  const where = claimType ? `reporter_handle = ? AND claim_type = ?` : `reporter_handle = ?`;
  const args = claimType ? [handle, claimType] : [handle];
  const own = rows(`SELECT resolved_state FROM beat_reporter_claim_resolutions
                     WHERE ${where} AND resolved_state IN ('confirmed','contradicted')`, ...args);
  const confirmed = own.filter(r => r.resolved_state === 'confirmed').length;
  const sample_size = own.length;

  if (sample_size === 0) {
    return { state: 'none', score: null, sample_size: 0,
      reason: 'no resolved claims yet for this handle' };
  }

  const raw = confirmed / sample_size;
  if (sample_size >= MIN_SAMPLE) {
    return { state: 'measured', score: r2(raw), sample_size,
      reason: `${confirmed}/${sample_size} resolved claims confirmed` };
  }

  const poolWhere = claimType ? `claim_type = ?` : `1=1`;
  const poolArgs = claimType ? [claimType] : [];
  const pool = rows(`SELECT resolved_state FROM beat_reporter_claim_resolutions
                      WHERE ${poolWhere} AND resolved_state IN ('confirmed','contradicted')`, ...poolArgs);
  const baseline = pool.length ? pool.filter(r => r.resolved_state === 'confirmed').length / pool.length : 0.5;
  const blended = (raw * sample_size + baseline * MIN_SAMPLE) / (sample_size + MIN_SAMPLE);

  return { state: 'pooled', score: r2(blended), sample_size,
    reason: `only ${sample_size} resolved claim${sample_size === 1 ? '' : 's'} (fewer than ${MIN_SAMPLE}), ` +
      `blended toward the ${claimType ?? 'overall'} baseline of ${r2(baseline)}` };
}

/**
 * Order a list so scored items sort by trust, and unscored items never move.
 *
 * A naive sort puts every unscored item at one end, which is exactly the
 * "unscored reads as worst/best" failure the UI thread flagged. This instead
 * takes only the indices that DO have a score, sorts that subsequence
 * descending (ties keep original order), and drops the result back into
 * those same index positions — an unscored item's index never changes.
 */
export function orderByTrust(items, { scoreOf } = {}) {
  const slots = [];
  items.forEach((item, i) => {
    const s = scoreOf(item);
    if (s != null && Number.isFinite(s)) slots.push({ item, i, s });
  });
  const sorted = [...slots].sort((a, b) => b.s - a.s || a.i - b.i);
  const result = items.slice();
  slots.forEach((slot, k) => { result[slot.i] = sorted[k].item; });
  return result;
}
