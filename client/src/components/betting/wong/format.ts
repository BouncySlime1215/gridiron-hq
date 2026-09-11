/**
 * Formatting for the NFL Wong hub.
 *
 * The repo's convention is that a rate is a fraction (0.7218, not 72.18) —
 * `betting-hub.js` stores win rates that way and `LineShop.tsx` renders them
 * with a `* 100`. Everything here follows that, with one deliberate exception
 * documented on `evPercentText`.
 */

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** American odds, always signed: +160, -120. */
export const american = (v: number | null | undefined) =>
  !finite(v) ? '—' : v > 0 ? `+${v}` : `${v}`;

/** A spread or a teased number, always signed: -7.5, +2.5, PK. */
export const line = (v: number | null | undefined) =>
  !finite(v) ? '—' : v === 0 ? 'PK' : v > 0 ? `+${v}` : `${v}`;

/** A fraction rendered as a percentage. */
export const pct = (v: number | null | undefined, digits = 1) =>
  !finite(v) ? '—' : `${(v * 100).toFixed(digits)}%`;

export const signedPct = (v: number | null | undefined, digits = 1) =>
  !finite(v) ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`;

export const units = (v: number | null | undefined, digits = 2) =>
  !finite(v) ? '—' : `${v.toFixed(digits)}u`;

export const signedUnits = (v: number | null | undefined, digits = 2) =>
  !finite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}u`;

export const dollars = (v: number | null | undefined) => {
  if (!finite(v)) return '—';
  const digits = Math.abs(v) >= 1000 ? 0 : 2;
  return v.toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: digits, maximumFractionDigits: digits
  });
};

export const signedDollars = (v: number | null | undefined) =>
  !finite(v) ? '—' : `${v > 0 ? '+' : ''}${dollars(v)}`;

/**
 * EV as a percentage of stake.
 *
 * The contract carries both `ev` (expected units per unit staked) and
 * `ev_percent`, and does not say whether the latter is 4.2 or 0.042. When the
 * two are the same number, `ev_percent` is plainly the fraction and needs the
 * ×100; when they differ, it is already a percentage and is trusted as one.
 * Falling back to `ev` covers a payload that omits `ev_percent` entirely.
 */
export function evPercentText(ev: number | null | undefined, evPercent: number | null | undefined) {
  if (!finite(evPercent)) return finite(ev) ? signedPct(ev, 2) : '—';
  if (finite(ev) && Math.abs(evPercent - ev) < 1e-9) return signedPct(evPercent, 2);
  return `${evPercent > 0 ? '+' : ''}${evPercent.toFixed(2)}%`;
}

/** "4m ago" / "3.2h ago" / "6d ago" from an ISO timestamp. */
export function ago(iso: string | null | undefined) {
  if (!iso) return 'never';
  const parsed = new Date(iso).getTime();
  if (!Number.isFinite(parsed)) return 'unknown';
  return sinceMinutes((Date.now() - parsed) / 60000);
}

/** The same phrasing from a minute count the server already computed. */
export function sinceMinutes(minutes: number | null | undefined) {
  if (!finite(minutes)) return 'age unknown';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 60 * 48) return `${(minutes / 60).toFixed(1)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

export type Freshness = 'fresh' | 'recent' | 'aging' | 'stale' | 'unknown';

/**
 * How much a quote's age should worry you. The thresholds are deliberately
 * generous — the server owns the real staleness rule and says so in
 * `blocked_reasons`; this only decides how loudly the age is drawn.
 */
export function freshness(minutes: number | null | undefined): Freshness {
  if (!finite(minutes)) return 'unknown';
  if (minutes <= 15) return 'fresh';
  if (minutes <= 90) return 'recent';
  if (minutes <= 240) return 'aging';
  return 'stale';
}

/**
 * Whether a provenance string describes a quote read straight from the book
 * or one that reached us through somebody else. These are different strength
 * claims and the board must not draw them the same way.
 */
export function isFirstHand(provenance: string | null | undefined) {
  if (!provenance) return false;
  return /first[\s_-]?(party|hand)|direct|quote[\s_-]?tape|api|official/i.test(provenance);
}

export function provenanceLabel(provenance: string | null | undefined) {
  if (!provenance) return 'Unknown source';
  return isFirstHand(provenance) ? 'First-hand' : 'Second-hand';
}

/** Kickoff, in the reader's own timezone. */
export function kickoff(iso: string | null | undefined) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

export const bookLabel = (book: string) => BOOK_NAMES[book?.toLowerCase()] ?? titleCase(book ?? '');

const BOOK_NAMES: Record<string, string> = {
  draftkings: 'DraftKings', fanduel: 'FanDuel', pinnacle: 'Pinnacle', betmgm: 'BetMGM',
  caesars: 'Caesars', betrivers: 'BetRivers', espnbet: 'ESPN BET', bovada: 'Bovada',
  pointsbet: 'PointsBet', circa: 'Circa', wynnbet: 'WynnBET', fanatics: 'Fanatics'
};

export function titleCase(value: string) {
  return String(value).replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** snake_case_key -> "Snake case key", for rendering a payload we do not own. */
export function humanizeKey(key: string) {
  const spaced = String(key).replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Best-effort rendering of a value from a block whose shape is not pinned
 * down (`pace`). The key name decides the unit: anything that reads like a
 * rate becomes a percentage, anything that reads like units gets a `u`,
 * anything that reads like money gets a `$`.
 */
export function formatLooseValue(key: string, value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') {
    return /^\d{4}-\d{2}-\d{2}T/.test(value) ? kickoff(value) : value;
  }
  if (!finite(value)) return String(value);
  const name = key.toLowerCase();
  if (/rate|percent|probability|roi|share/.test(name)) return pct(value, 1);
  if (/dollar|_usd|bankroll_dollars/.test(name)) return dollars(value);
  if (/unit/.test(name)) return signedUnits(value);
  // A year is an identifier, not a quantity. `toLocaleString()` renders 2026 as
  // "2,026", which reads as a count of something and is the kind of detail that
  // makes a panel look machine-generated.
  if (/^season$|year|week1?$/.test(name)) return String(value);
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toFixed(2);
}

/**
 * A leg teased onto a whole number can push; one on a half-point cannot.
 * This is the only separator between qualifying legs the research supports,
 * so it is the only one this hub draws.
 */
export function canPush(teasedTo: number | null | undefined) {
  return finite(teasedTo) && Number.isInteger(teasedTo);
}
