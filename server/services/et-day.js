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
