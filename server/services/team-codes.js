/**
 * The one team-code map and the one name resolver.
 *
 * Every feed spells a team differently: nflverse writes WAS, ESPN writes WSH,
 * Kambi writes LA for the Rams, PFR writes JAC, the play-by-play still has OAK
 * and SD for seasons before the moves. Until now eight normalizers and five
 * alias maps lived beside their call sites, each fixing the spelling that had
 * bitten that file, and the Washington postgame-truth join and the officials
 * crosswalk were both repaired in place (PROFITABILITY_PLAN Priority 0).
 *
 * The app's canonical code is nflverse's current abbreviation for the
 * franchise: WAS, LAR, LAC, LV, JAX. A relocated franchise keeps its identity
 * (OAK -> LV, SD -> LAC, STL -> LAR) because the roster and the organisation
 * moved with it; a ratings walk that resets at the move is a bug, not history.
 */
import { rows } from '../db/index.js';

/** Alias -> canonical code. Keys are upper-case as feeds write them. */
export const TEAM_CODE_ALIASES = Object.freeze({
  WSH: 'WAS', WASH: 'WAS',
  LA: 'LAR', STL: 'LAR', SL: 'LAR',
  SD: 'LAC',
  OAK: 'LV', LVR: 'LV',
  JAC: 'JAX',
  BLT: 'BAL', ARZ: 'ARI', HST: 'HOU', CLV: 'CLE',
  GNB: 'GB', KAN: 'KC', NWE: 'NE', NOR: 'NO', SFO: 'SF', TAM: 'TB'
});

/** Legacy code -> current code, for one-off reconciliation of stored rows. */
export const LEGACY_CODE_PAIRS = Object.freeze([
  ['LA', 'LAR'], ['STL', 'LAR'], ['JAC', 'JAX'], ['OAK', 'LV'], ['SD', 'LAC'], ['WSH', 'WAS']
]);

/** The canonical code for any abbreviation a feed might send. Unknown codes pass through upper-cased. */
export function canonicalTeamCode(value) {
  const code = String(value ?? '').trim().toUpperCase();
  return TEAM_CODE_ALIASES[code] ?? code;
}

/** Lower-case alphanumerics only: the comparison form for names from any feed. */
export const normalizeToken = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

let _resolver = null;

/**
 * Resolve any feed's spelling of a team ("WSH", "NY Giants", "Los Angeles Rams",
 * "Seattle", "seahawks") to `{abbr, name}` from nfl_teams, with `abbr` canonical.
 * Returns null rather than guessing when nothing matches.
 */
export function teamResolver() {
  if (_resolver) return _resolver;
  const teams = rows('SELECT abbr, name FROM nfl_teams').map(t => ({ ...t, abbr: canonicalTeamCode(t.abbr) }));
  const byAbbr = new Map(), byName = new Map(), byNick = new Map(), byCity = new Map();
  for (const t of teams) {
    byAbbr.set(normalizeToken(t.abbr), t);
    byName.set(normalizeToken(t.name), t);
    const words = String(t.name).split(/\s+/);
    byNick.set(normalizeToken(words.at(-1)), t);
    byCity.set(normalizeToken(words.slice(0, -1).join(' ')), t);
  }
  const abbrLookup = raw => {
    const code = canonicalTeamCode(raw);
    // "NY" alone is ambiguous between the Giants and the Jets.
    if (code === 'NY') return null;
    return byAbbr.get(normalizeToken(code)) ?? null;
  };
  _resolver = candidate => {
    const raw = String(candidate ?? '').trim();
    if (!raw) return null;
    const n = normalizeToken(raw);
    if (byName.has(n)) return byName.get(n);
    const asAbbr = abbrLookup(raw);
    if (asAbbr) return asAbbr;
    // "SEA Seahawks", "NY Giants", "Los Angeles Rams", "Seattle"
    const words = raw.split(/\s+/);
    const nick = normalizeToken(words.at(-1));
    if (byNick.has(nick)) return byNick.get(nick);
    if (byCity.has(n)) return byCity.get(n);
    const lead = abbrLookup(words[0]);
    if (lead) return lead;
    // Last resort for feeds that send partial names: a unique containment.
    const contained = teams.filter(t => normalizeToken(t.name).includes(n) || n.includes(normalizeToken(t.name)));
    return contained.length === 1 ? contained[0] : null;
  };
  return _resolver;
}

export function clearTeamResolverCache() { _resolver = null; }

/** The canonical code for a name or code, or null. Convenience over `teamResolver()`. */
export function teamCodeFor(value) {
  return teamResolver()(value)?.abbr ?? null;
}

/** ESPN's spelling of a canonical code, for joins against ESPN-sourced rows (play-by-play, scoreboard). */
const ESPN_CODES = Object.freeze({ WAS: 'WSH' });
export function espnTeamCode(value) {
  const code = canonicalTeamCode(value);
  return ESPN_CODES[code] ?? code;
}
