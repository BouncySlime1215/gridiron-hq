export function appDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.APP_TIMEZONE || 'Pacific/Honolulu',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

/**
 * Convert a date and wall-clock time in a named IANA zone to a real UTC Date.
 *
 * nflverse schedule times are Eastern wall time (for example `13:00`), not
 * UTC. Appending `Z` moves every kickoff four or five hours early and can let
 * evidence windows, news cutoffs and forward-pick locks disagree about when a
 * game actually starts. Intl supplies the historical DST offset without adding
 * another runtime dependency.
 */
export function zonedDateTime(date, time = '12:00', timeZone = 'America/New_York') {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(time ?? ''));
  if (!day || !clock) return null;
  const month = Number(day[2]), dateOfMonth = Number(day[3]);
  const hour = Number(clock[1]), minute = Number(clock[2]), second = Number(clock[3] ?? 0);
  if (month < 1 || month > 12 || dateOfMonth < 1 || dateOfMonth > 31 ||
      hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  const target = Date.UTC(Number(day[1]), month - 1, dateOfMonth, hour, minute, second);
  const targetDate = new Date(target);
  if (targetDate.getUTCFullYear() !== Number(day[1]) || targetDate.getUTCMonth() !== month - 1 ||
      targetDate.getUTCDate() !== dateOfMonth) return null;
  let instant = target;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  for (let pass = 0; pass < 3; pass++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant))
      .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
    const rendered = Date.UTC(parts.year, parts.month - 1, parts.day,
      parts.hour, parts.minute, parts.second);
    const correction = target - rendered;
    instant += correction;
    if (correction === 0) break;
  }
  const result = new Date(instant);
  return Number.isNaN(result.getTime()) ? null : result;
}

/** nflverse `gameday` + `gametime` specifically use US Eastern wall time. */
export function nflKickoffDate(gameday, gametime = '23:59') {
  return zonedDateTime(gameday, gametime, 'America/New_York');
}

/**
 * The half-open `[from, to)` string range that matches every ISO-8601
 * spelling of one exact whole-second instant in a TEXT column -- with or
 * without a fractional-seconds component -- WITHOUT wrapping that column in a
 * SQL function.
 *
 * `nfl_quote_tape.commence_time` holds both "...:00Z" (as sent verbatim by
 * most feeds) and "...:00.000Z" (round-tripped through `Date#toISOString()`,
 * which every kickoff computed in this codebase is). The obvious join --
 * `julianday(commence_time) = julianday(?)` -- treats both spellings as the
 * same instant correctly, but wrapping the column in `julianday()` makes
 * every index on it unusable, forcing a full scan of the whole table on
 * every call. Migration 029 and `nfl-t60-packet.js` already fixed exactly
 * this for the T-60 evidence packet's own kickoff lookup by comparing the
 * raw column against a one-second range instead; this is that same fix,
 * shared, so every other caller matching this column gets the identical
 * correct-and-indexable behavior rather than a second, easy-to-forget copy
 * of the reasoning.
 *
 * Half-open and one second wide because every kickoff this project computes
 * lands on a whole second (`nflKickoffDate`/`zonedDateTime` never produce
 * fractional seconds, and `contractKey()`'s own `kickoff` field is always
 * `new Date(...).toISOString()`) -- so `[T.000Z, (T+1s).000Z)` is exactly
 * "this whole second, spelled any way," and never reaches into the next one.
 * Returns `null` for an unparsable instant rather than a range that would
 * silently match nothing (or, worse, everything).
 */
export function instantSpellingRange(instant) {
  const at = new Date(instant).getTime();
  if (!Number.isFinite(at)) return null;
  return { from: new Date(at).toISOString(), to: new Date(at + 1000).toISOString() };
}
