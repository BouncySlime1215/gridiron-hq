/**
 * Shared logic for the MLB Props section, ported from Diamond Signal's
 * assets/picks.js (glederer04/Baseball-Props) into typed, React-friendly form.
 *
 * The odds math and the result-matching logic are the parts worth preserving
 * faithfully — a saved parlay needs the same American/decimal conversion the
 * original used, and grading a leg against final results needs the same
 * fallback chain (exact match, then a looser one) or picks silently stop
 * grading the moment a matchup string or slate date doesn't line up exactly.
 *
 * One deliberate simplification: the original tries IndexedDB first and falls
 * back to localStorage (working around old Safari private-browsing caps on
 * localStorage). Plain localStorage is what the rest of this app already uses
 * for local preferences, so that's all this uses too — one storage backend,
 * not two.
 */

export interface BoardRow {
  selection: string; matchup: string; game_time: string; market: string; side: string;
  line: number | null; american_price: number | null; model_probability: number | null;
  implied_probability: number | null; probability_difference: number | null;
  signal: string; captured_at: string; slate_date: string | null;
}

export interface ProjectionRow {
  slate_date: string; slate_label: string; selection: string; matchup: string; game_time: string;
  market: string; recommended_side: string; recommendation: string;
  expected_count: number | null; reference_line: number | null; line_gap: number | null;
  model_probability: number | null; confidence: number | null; projection_note: string;
  status: string; american_price: number | null;
}

export interface PipelineStatus {
  historical_data_through: string; model_training_through: string; line_feed_status: string;
  last_line_refresh: string; site_data_generated_at: string; sportsbook_name: string;
  priced_edge_count: string;
}

export interface ResultRow {
  slate_date: string; matchup: string; selection: string; market: string;
  actual_count: number | null; actual_nrfi: number | null;
}

export interface Leg {
  id: string;
  slateDate: string; selection: string; matchup: string; gameTime: string;
  market: string; marketLabel: string; side: string; line: number;
  recommendation: string; modelProbability: number; confidence: number;
  odds: string;
}

export interface Ticket {
  id: string;
  savedAt: string;
  legs: Leg[];
  totalAmericanOdds: string;
  totalDecimalOdds: number | null;
}

/* ------------------------------------------------------------- formatting */

export const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${(100 * v).toFixed(1)}%`);
export const americanFmt = (v: number | null | undefined) => (v == null ? '—' : v > 0 ? `+${v}` : `${v}`);

export const MARKET_LABEL: Record<string, string> = {
  batter_total_bases: 'Batter Total Bases',
  pitcher_strikeouts: 'Pitcher Strikeouts',
  totals_1st_1_innings: 'NRFI / YRFI',
  nrfi: 'NRFI / YRFI'
};
export const normalizeMarket = (m: string) => (m === 'totals_1st_1_innings' ? 'nrfi' : m);
export const formatMarket = (m: string) => MARKET_LABEL[normalizeMarket(m)] ?? m ?? 'Unknown market';

export const formatDate = (v: string) => {
  if (!v) return 'Unknown slate';
  const d = new Date(`${v}T12:00:00`);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
};
export const formatDateTime = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString();
};

/* ------------------------------------------------------------- odds math */

export const cleanOdds = (v: string | number | null | undefined): number | null => {
  const parsed = Number(String(v ?? '').replace(/[^\d+-]/g, ''));
  return Number.isFinite(parsed) && parsed !== 0 ? parsed : null;
};
export const americanToDecimal = (odds: number) => (odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds));
export const decimalToAmerican = (decimal: number | null): string => {
  if (!decimal || !Number.isFinite(decimal) || decimal <= 1) return '—';
  return decimal >= 2 ? `+${Math.round((decimal - 1) * 100)}` : `${Math.round(-100 / (decimal - 1))}`;
};

/** Combined odds for a set of legs — every leg needs a valid price or there's no total yet. */
export function totalOdds(legs: Leg[]): { decimal: number | null; american: string } {
  const decimals = legs.map(l => cleanOdds(l.odds)).filter((v): v is number => v != null).map(americanToDecimal);
  if (decimals.length !== legs.length || !legs.length) return { decimal: null, american: '—' };
  const decimal = decimals.reduce((p, v) => p * v, 1);
  return { decimal, american: decimalToAmerican(decimal) };
}

/* -------------------------------------------------------- team/matchup keys */

const ALIAS: Record<string, string> = {
  athletics: 'athletics', oaklandathletics: 'athletics', as: 'athletics',
  angels: 'angels', losangelesangels: 'angels',
  astros: 'astros', houstonastros: 'astros',
  bluejays: 'bluejays', torontobluejays: 'bluejays',
  braves: 'braves', atlantabraves: 'braves',
  brewers: 'brewers', milwaukeebrewers: 'brewers',
  cardinals: 'cardinals', stlouiscardinals: 'cardinals',
  cubs: 'cubs', chicagocubs: 'cubs',
  diamondbacks: 'diamondbacks', dbacks: 'diamondbacks', arizonadiamondbacks: 'diamondbacks',
  dodgers: 'dodgers', losangelesdodgers: 'dodgers',
  giants: 'giants', sanfranciscogiants: 'giants',
  guardians: 'guardians', clevelandguardians: 'guardians',
  mariners: 'mariners', seattlemariners: 'mariners',
  marlins: 'marlins', miamimarlins: 'marlins',
  mets: 'mets', newyorkmets: 'mets',
  nationals: 'nationals', washingtonnationals: 'nationals',
  padres: 'padres', sandiegopadres: 'padres',
  phillies: 'phillies', philadelphiaphillies: 'phillies',
  pirates: 'pirates', pittsburghpirates: 'pirates',
  rangers: 'rangers', texasrangers: 'rangers',
  rays: 'rays', tampabayrays: 'rays',
  redsox: 'redsox', bostonredsox: 'redsox',
  reds: 'reds', cincinnatireds: 'reds',
  rockies: 'rockies', coloradorockies: 'rockies',
  royals: 'royals', kansascityroyals: 'royals',
  tigers: 'tigers', detroittigers: 'tigers',
  twins: 'twins', minnesotatwins: 'twins',
  whitesox: 'whitesox', chicagowhitesox: 'whitesox',
  yankees: 'yankees', newyorkyankees: 'yankees'
};
export const normalizeText = (v: string) => String(v ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/gi, '').toLowerCase();
const normalizeTeamName = (v: string) => ALIAS[normalizeText(v)] ?? normalizeText(v);
/** Order-independent key for a matchup, so "A at B" and "B at A" grade the same. */
export const matchupSignature = (v: string) => {
  const normalized = String(v ?? '').replace(/\bversus\b/gi, ' at ').replace(/\bvs\.?\b/gi, ' at ').replace(/\s@\s/g, ' at ');
  const parts = normalized.split(/\s+at\s+/i).map(normalizeTeamName).filter(Boolean);
  return parts.length === 2 ? parts.sort().join('|') : normalizeText(v);
};

export const legKey = (leg: Leg) => [leg.slateDate, leg.market, leg.selection, leg.matchup, leg.side, leg.line].join('|');

/* ---------------------------------------------------------------- grading */

export type LegStatus = 'Pending' | 'Won' | 'Lost' | 'Push';
export interface Grade { status: LegStatus; detail: string; }

interface ResultIndex {
  exact: Map<string, ResultRow>;
  loose: Map<string, ResultRow>;
  playerByDate: Map<string, ResultRow>;
  nrfiByDate: Map<string, ResultRow>;
}

/** Four lookup strategies from loosest-key to most-specific, mirroring the original. */
export function buildResultIndex(rows: ResultRow[]): ResultIndex {
  const exact = new Map<string, ResultRow>();
  const loose = new Map<string, ResultRow>();
  const playerBuckets = new Map<string, ResultRow[]>();
  const nrfiByDate = new Map<string, ResultRow>();

  for (const row of rows) {
    const market = normalizeMarket(row.market);
    exact.set([row.slate_date, market, row.selection, row.matchup].join('|'), row);
    const looseKey = [market, normalizeText(row.selection), normalizeText(row.matchup)].join('|');
    if (!loose.has(looseKey)) loose.set(looseKey, row);
    if (market === 'nrfi') {
      nrfiByDate.set([row.slate_date, matchupSignature(row.matchup), row.selection].join('|'), row);
    } else {
      const key = [row.slate_date, market, normalizeText(row.selection)].join('|');
      const bucket = playerBuckets.get(key) ?? [];
      bucket.push(row);
      playerBuckets.set(key, bucket);
    }
  }
  const playerByDate = new Map<string, ResultRow>();
  for (const [key, bucket] of playerBuckets) {
    const uniqueMatchups = new Set(bucket.map(r => r.matchup));
    // Only trust this bucket when there's no ambiguity — one row, or every row
    // agrees on the matchup (a doubleheader would otherwise grade the wrong game).
    if (bucket.length === 1 || uniqueMatchups.size === 1) playerByDate.set(key, bucket[0]);
  }
  return { exact, loose, playerByDate, nrfiByDate };
}

function findResultRow(leg: Leg, results: ResultIndex): ResultRow | undefined {
  const market = normalizeMarket(leg.market);
  const exactKey = [leg.slateDate, market, leg.selection, leg.matchup].join('|');
  const looseKey = [market, normalizeText(leg.selection), normalizeText(leg.matchup)].join('|');
  const datedMatch = market === 'nrfi'
    ? results.nrfiByDate.get([leg.slateDate, matchupSignature(leg.matchup), leg.side].join('|'))
    : results.playerByDate.get([leg.slateDate, market, normalizeText(leg.selection)].join('|'));
  if (leg.slateDate) return results.exact.get(exactKey) ?? datedMatch;
  return results.exact.get(exactKey) ?? datedMatch ?? results.loose.get(looseKey);
}

export function gradeLeg(leg: Leg, results: ResultIndex): Grade {
  const row = findResultRow(leg, results);
  if (!row) return { status: 'Pending', detail: 'Awaiting final result' };

  if (normalizeMarket(leg.market) === 'nrfi') {
    const actualNrfi = row.actual_nrfi;
    if (actualNrfi == null) return { status: 'Pending', detail: 'Awaiting final result' };
    const won = leg.side === 'NRFI' ? actualNrfi === 1 : actualNrfi === 0;
    return { status: won ? 'Won' : 'Lost', detail: actualNrfi === 1 ? 'No run in the 1st' : 'Run scored in the 1st' };
  }
  const actual = row.actual_count;
  if (actual == null) return { status: 'Pending', detail: 'Awaiting stat' };
  const pushed = actual === leg.line;
  const won = leg.side === 'Over' ? actual > leg.line : actual < leg.line;
  return { status: pushed ? 'Push' : won ? 'Won' : 'Lost', detail: `${leg.side} ${leg.line} · actual ${actual}` };
}

export function ticketStatus(grades: Grade[]): LegStatus {
  if (grades.some(g => g.status === 'Lost')) return 'Lost';
  if (grades.some(g => g.status === 'Pending')) return 'Pending';
  if (grades.every(g => g.status === 'Push')) return 'Push';
  return 'Won';
}

/* -------------------------------------------------------------- storage */

const SLIP_KEY = 'gh:props:slip';
const TICKETS_KEY = 'gh:props:tickets';

function readJson<T>(key: string, fallback: T): T {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? 'null');
    return parsed ?? fallback;
  } catch { return fallback; }
}
const writeJson = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));

export const loadSlip = (): Leg[] => readJson(SLIP_KEY, []);
export const saveSlipStorage = (slip: Leg[]) => writeJson(SLIP_KEY, slip);
export const loadTickets = (): Ticket[] => readJson(TICKETS_KEY, []);
export const saveTicketsStorage = (tickets: Ticket[]) => writeJson(TICKETS_KEY, tickets);

export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
