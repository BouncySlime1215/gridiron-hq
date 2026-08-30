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
