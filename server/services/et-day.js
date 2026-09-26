/**
 * SPEND-SERVER: New York calendar days, named explicitly (never the server's own zone).
 * Pure: no database, so any module can use it without opening one.
 */
export const SPEND_TZ = 'America/New_York';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: SPEND_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** The New York calendar day of an instant (a Date, an ISO string, or SQLite's 'YYYY-MM-DD HH:MM:SS' UTC). */
export function etDay(at) {
  const d = at instanceof Date ? at : new Date(/Z$|[+-]\d\d:?\d\d$/.test(String(at)) ? at : `${String(at).replace(' ', 'T')}Z`);
  return fmt.format(d);
}

/** The New York day `n` days before `day` (calendar arithmetic, not hours). */
export function dayBefore(day, n = 1) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** The UTC instant a New York day starts (DST-safe: tries both offsets and keeps the one that is midnight there). */
export function etDayStart(day) {
  const base = Date.parse(`${day}T00:00:00Z`);
  for (const h of [4, 5, 3, 6]) {
    const t = base + h * 3600e3;
    if (etDay(new Date(t)) === day && etDay(new Date(t - 1000)) !== day) return new Date(t);
  }
  throw new Error(`no New York midnight found for ${day}`);
}

/** SQLite's UTC text form ('YYYY-MM-DD HH:MM:SS') of an instant, for comparing with created_at. */
export const sqliteUtc = d => d.toISOString().replace('T', ' ').slice(0, 19);

/** When today (New York) began and when it ends, as SQLite UTC text. */
export function etTodayBounds(now = new Date()) {
  const day = etDay(now);
  const start = etDayStart(day);
  const next = new Date(`${day}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const end = etDayStart(next.toISOString().slice(0, 10));
  return { day, start: sqliteUtc(start), end: sqliteUtc(end), endIso: end.toISOString() };
}
