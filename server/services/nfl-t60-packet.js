/**
 * The T−60 evidence packet (Codex plan section 6.3, second half).
 *
 * "Collect ahead of T−60 and freeze records actually received by cutoff.
 *  Record computation start/end and forecast emission separately; never
 *  backdate a late capture or fill its missing cutoff packet from later
 *  arrivals. Record a missed capture as a missing prospective observation."
 *
 * The distinction this module exists to enforce, and the reason it is
 * separate from every other data accessor in the codebase: there are three
 * different clocks, and treating any two of them as one is how a historical
 * replay quietly becomes a claim about what was knowable.
 *
 *   EFFECTIVE   when the fact became true in the world (a game was played,
 *               an injury happened).
 *   PUBLISHED   when a source first made it available.
 *   RECEIVED    when THIS system actually recorded it.
 *
 * A prospective decision may use only what was RECEIVED by its cutoff. A
 * labeled historical replay may use what was PUBLISHED by the simulated
 * cutoff, if that availability is independently evidenced — a different and
 * weaker claim, which is why the packet says which one it is rather than
 * leaving a reader to assume.
 *
 * MISSING IS A RECORDED OBSERVATION, NOT AN ABSENCE. A source that had
 * nothing by the cutoff produces a `missing` entry with a reason. That is
 * what makes "we had no injury report for this game" a fact the evaluation
 * can see, instead of a silence indistinguishable from "the report said
 * nothing was wrong."
 */
import { rows } from '../db/index.js';
import { decisionCutoff, T60_PROTOCOL_VERSION } from './nfl-t60-protocol.js';

export const PACKET_VERSION = 'nfl-t60-packet-v1';

/**
 * How a value's availability is established. A prospective packet may only
 * contain `received_by_cutoff`; the others exist so a historical or
 * unqualified record is impossible to mistake for one.
 */
export const AVAILABILITY_CLAIMS = Object.freeze([
  /** This system recorded it before the cutoff. The only claim a real prospective decision may rest on. */
  'received_by_cutoff',
  /** A source published it before the cutoff and that publication is independently evidenced. Historical replay only. */
  'published_by_cutoff_evidenced',
  /** Present in the database, but with no trustworthy receipt or publication clock. Quarantined. */
  'availability_unknown',
  /** Nothing was available at all. A recorded observation in its own right. */
  'missing'
]);

/**
 * One source's contribution to a packet, with all three clocks preserved
 * rather than collapsed. `received_at` null with rows present is not an
 * oversight — it is the `availability_unknown` case, and it is reported
 * rather than assumed to be fine.
 */
function sourceEntry({ source, rowsFound, effectiveAt = null, publishedAt = null,
  receivedAt = null, cutoffAt, missingReason = null }) {
  if (!rowsFound) {
    return { source, claim: 'missing', rows: 0, effective_at: null, published_at: null,
      received_at: null, reason: missingReason ?? 'no rows for this source at or before the cutoff' };
  }
  const received = receivedAt && new Date(receivedAt).getTime() <= new Date(cutoffAt).getTime();
  const published = publishedAt && new Date(publishedAt).getTime() <= new Date(cutoffAt).getTime();
  const claim = received ? 'received_by_cutoff'
    : published ? 'published_by_cutoff_evidenced'
      : 'availability_unknown';
  return { source, claim, rows: rowsFound,
    effective_at: effectiveAt ?? null, published_at: publishedAt ?? null, received_at: receivedAt ?? null,
    reason: claim === 'availability_unknown'
      ? 'rows exist but carry no receipt or evidenced publication clock at or before the cutoff — quarantined ' +
        'rather than counted as knowable'
      : null };
}

/**
 * Freeze what was actually knowable about one game at its T−60 cutoff.
 *
 * `mode` is the claim being made, and it changes what is allowed in:
 *   'prospective' — only `received_by_cutoff` entries are eligible. Anything
 *                   weaker is retained in the packet but marked ineligible,
 *                   so the packet still shows what existed while refusing to
 *                   let it into the decision.
 *   'historical'  — `published_by_cutoff_evidenced` is additionally eligible,
 *                   and the packet says so in its own `claim` field. This is
 *                   the labeled hypothetical, never a prospective record.
 */
export function freezeT60Packet({ season, week, home, away, kickoff, scheduleVersion = null,
  mode = 'prospective', computationStartedAt = null, computationFinishedAt = null } = {}) {
  const cutoff = decisionCutoff(kickoff, { scheduleVersion });
  if (!cutoff) return { error: 'unresolvable kickoff — no cutoff, and therefore no packet' };
  const cutoffAt = cutoff.cutoff_at;

  const entries = [];

  // Quote tape: the one source in this project with a genuine, per-row
  // receipt clock, which is exactly why it is the only one that can support
  // a real prospective claim today.
  const quote = rows(`SELECT COUNT(*) n, MAX(q.snapshot_at) latest_snapshot, MAX(b.requested_at) latest_received
    FROM nfl_quote_tape q JOIN nfl_quote_batches b ON b.batch_id = q.batch_id
    WHERE julianday(q.commence_time)=julianday(?) AND b.requested_at <= ?`, kickoff, cutoffAt)[0];
  entries.push(sourceEntry({ source: 'nfl_quote_tape', rowsFound: quote?.n ?? 0,
    effectiveAt: quote?.latest_snapshot ?? null, receivedAt: quote?.latest_received ?? null, cutoffAt,
    missingReason: 'no quote captured for this game before its cutoff — a missed capture, recorded as such' }));

  // Injuries: rows exist for most seasons, but their receipt clock is the
  // known weak point (the audit's own finding: 2025 rows carry no
  // modified_at). Whatever clock exists is reported; where none does, the
  // entry is quarantined rather than counted.
  const injuries = rows(`SELECT COUNT(*) n, MAX(modified_at) latest_modified
    FROM nfl_injuries WHERE season=? AND week=?`, season, week)[0];
  entries.push(sourceEntry({ source: 'nfl_injuries', rowsFound: injuries?.n ?? 0,
    receivedAt: injuries?.latest_modified ?? null, cutoffAt,
    missingReason: 'no injury rows for this season/week' }));

  // Typed news events: first_seen_time is an extraction timestamp, which is a
  // receipt clock for THIS system even though it is not the article's
  // publication time — both are carried so neither is mistaken for the other.
  const news = rows(`SELECT COUNT(*) n, MAX(first_seen_time) latest_seen, MAX(published_at) latest_published
    FROM nfl_news_events WHERE first_seen_time <= ?`, cutoffAt)[0];
  entries.push(sourceEntry({ source: 'nfl_news_events', rowsFound: news?.n ?? 0,
    publishedAt: news?.latest_published ?? null, receivedAt: news?.latest_seen ?? null, cutoffAt,
    missingReason: 'no typed news event recorded before this cutoff' }));

  // Team-week features (play-by-play derived). These are rebuilt in bulk from
  // a full-season file with no per-row receipt clock at all, which is
  // precisely why they quarantine rather than qualify: the data is real, the
  // claim "we had it by Sunday 12:00" is not evidenced.
  const features = rows(`SELECT COUNT(*) n FROM nfl_team_week_features
    WHERE season=? AND week < ?`, season, week)[0];
  entries.push(sourceEntry({ source: 'nfl_team_week_features', rowsFound: features?.n ?? 0, cutoffAt,
    missingReason: 'no prior-week team features for this season' }));

  const eligibleClaims = mode === 'historical'
    ? ['received_by_cutoff', 'published_by_cutoff_evidenced']
    : ['received_by_cutoff'];
  const eligible = entries.filter(e => eligibleClaims.includes(e.claim));
  const quarantined = entries.filter(e => e.claim === 'availability_unknown');
  const missing = entries.filter(e => e.claim === 'missing');

  return {
    packet_version: PACKET_VERSION, protocol_version: T60_PROTOCOL_VERSION,
    season, week, matchup: `${away} at ${home}`,
    kickoff: cutoff.kickoff, cutoff_at: cutoffAt, schedule_version: scheduleVersion,
    mode,
    claim: mode === 'historical'
      ? 'LABELED HISTORICAL REPLAY: may use sources whose publication before the cutoff is independently ' +
        'evidenced. This is not a record of what this system actually held at the time.'
      : 'PROSPECTIVE: only sources this system had actually RECEIVED by the cutoff are eligible.',
    // Computation clocks kept apart from the cutoff, per section 6.3: a
    // forecast emitted after the cutoff may use the frozen packet, but the
    // packet's contents are fixed at the cutoff and are never backfilled
    // from anything that arrived afterward.
    computation_started_at: computationStartedAt,
    computation_finished_at: computationFinishedAt,
    emitted_after_cutoff: computationFinishedAt
      ? new Date(computationFinishedAt).getTime() > new Date(cutoffAt).getTime() : null,
    sources: entries,
    summary: {
      eligible: eligible.map(e => e.source),
      quarantined: quarantined.map(e => e.source),
      missing: missing.map(e => e.source),
      eligible_count: eligible.length, total_sources: entries.length
    }
  };
}
