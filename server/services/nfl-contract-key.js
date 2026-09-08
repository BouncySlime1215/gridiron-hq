/**
 * The canonical exact contract, and the refusal to guess.
 *
 * Package A of the master plan starts here because every later package joins
 * rows across feeds, and every one of those joins is wrong by default. A
 * spread is not a market; "KC -3.5 at -110, full game, overtime included,
 * pushes on an exact three" is a market. Two feeds spelling the same game
 * differently, two books posting the same number on different periods, an
 * alternate line stored beside the main line, a first-half total joined to a
 * full-game total — all of those produce a plausible row that quietly averages
 * two different bets together, and nothing downstream can detect it.
 *
 * So this module builds one key that includes everything that changes what you
 * are actually paid: league, event, participant, market, period, side, line,
 * overtime treatment and settlement rule. Rows only join when all of those
 * agree.
 *
 * The second job is failing closed. `teamResolver()` already returns null
 * rather than guessing a franchise, and this keeps that discipline: an
 * unreadable team, an unknown period, a line on a moneyline or a missing line
 * on a spread returns a typed reason, never a silently repaired contract. The
 * quarantine report in nfl-evidence-dataset.js counts those reasons, because a
 * row we dropped is evidence about coverage and a row we invented is not.
 *
 * OVERTIME IS A DECLARED ASSUMPTION, NOT A MEASURED FACT. US books commonly
 * settle full-game and second-half markets including overtime and quarter and
 * first-half markets excluding it, and that convention is encoded below with
 * `overtime_rule_source: 'us_default_convention'`. It has not been verified
 * against each book's own house rules. Any contract that actually reaches a
 * stake needs its rule confirmed at the book, and the field is exposed so a
 * later confirmation can overwrite the default instead of hiding inside it.
 */
import crypto from 'node:crypto';
import { teamResolver } from './team-codes.js';

export const CONTRACT_KEY_VERSION = 'nfl-contract-v1';

/**
 * Period -> overtime treatment.
 *
 * The treatment is part of the key, not a comment: a full-game moneyline and a
 * regulation-only moneyline are different contracts that can carry the same
 * price on the same game, and joining them is undetectable after the fact.
 */
export const PERIODS = Object.freeze({
  full_game: 'included',
  first_half: 'excluded',
  second_half: 'included',
  q1: 'excluded',
  q2: 'excluded',
  q3: 'excluded',
  q4: 'excluded',
  regulation: 'excluded'
});

const HALF_POINT = value => Math.abs(value * 2 - Math.round(value * 2)) < 1e-9;

/**
 * The market registry.
 *
 * `sides` is exhaustive on purpose. A side we have never seen is a parsing
 * failure, and letting it through as a lower-cased string is how a "draw" row
 * from a soccer feed ends up in an NFL spread average.
 */
export const MARKETS = Object.freeze({
  spreads: {
    settlement: 'margin_vs_line', sides: ['home', 'away'], line: 'required',
    participant: 'team_pair', bounds: [-60, 60], push: 'integer_line'
  },
  totals: {
    settlement: 'total_points_vs_line', sides: ['over', 'under'], line: 'required',
    participant: 'team_pair', bounds: [20, 100], push: 'integer_line'
  },
  h2h: {
    settlement: 'winner', sides: ['home', 'away'], line: 'forbidden',
    participant: 'team_pair', bounds: null, push: 'tie_after_overtime'
  },
  team_totals: {
    settlement: 'team_points_vs_line', sides: ['over', 'under'], line: 'required',
    participant: 'team', bounds: [0, 80], push: 'integer_line'
  },
  player_props: {
    settlement: 'player_stat_vs_line', sides: ['over', 'under'], line: 'required',
    participant: 'player', bounds: [0, 600], push: 'integer_line', void: 'void_if_no_participation'
  }
});

/** Provider market spellings we accept. Anything else is `unknown_market`. */
const MARKET_ALIASES = Object.freeze({
  spread: 'spreads', spreads: 'spreads', point_spread: 'spreads',
  alternate_spreads: 'spreads', spread_alt: 'spreads',
  total: 'totals', totals: 'totals', over_under: 'totals',
  alternate_totals: 'totals', total_alt: 'totals',
  h2h: 'h2h', moneyline: 'h2h', ml: 'h2h', money_line: 'h2h',
  team_totals: 'team_totals', team_total: 'team_totals'
});

const SIDE_ALIASES = Object.freeze({
  home: 'home', away: 'away', over: 'over', under: 'under', o: 'over', u: 'under'
});

const norm = value => String(value ?? '').trim().toLowerCase().replace(/\s+/g, '_');

const fail = (reason, detail) => ({ ok: false, reason, detail: detail ?? null });

/**
 * The Eastern-time calendar date of a kickoff.
 *
 * Feeds disagree about a kickoff instant by minutes, so the instant is a poor
 * identity. They do not disagree about which day a game was played, once the
 * 1:15am-UTC Monday-night problem is removed by asking for the US Eastern date
 * rather than the UTC one.
 */
export function easternGameDate(commenceTime) {
  const when = new Date(commenceTime);
  if (!Number.isFinite(when.getTime())) return null;
  return when.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * The identity of a game, independent of any market.
 *
 * Duplicate-event detection compares this. Two provider event ids that map to
 * one event key are the same game seen twice; two event keys that share a
 * provider id are a provider bug. Both are worth knowing and neither is
 * visible while events are addressed by whichever string a feed sent.
 */
export function eventKey({ homeTeam, awayTeam, commenceTime } = {}) {
  const resolve = teamResolver();
  const home = resolve(homeTeam), away = resolve(awayTeam);
  if (!home) return fail('unresolved_team', `home=${homeTeam ?? ''}`);
  if (!away) return fail('unresolved_team', `away=${awayTeam ?? ''}`);
  if (home.abbr === away.abbr) return fail('same_team_both_sides', home.abbr);
  const date = easternGameDate(commenceTime);
  if (!date) return fail('invalid_event_time', String(commenceTime ?? ''));
  return { ok: true, key: `nfl|${date}|${away.abbr}@${home.abbr}`,
    league: 'nfl', game_date: date, home: home.abbr, away: away.abbr,
    kickoff: new Date(commenceTime).toISOString() };
}

/**
 * The exact contract. Every field that changes the payout is in the key.
 *
 * `line` is stored as the side posts it: home -3.5 and away +3.5 are two
 * contracts, not one contract seen from two directions, and they have
 * different prices. `mirrorContract()` converts between them when a no-vig
 * pair is actually wanted.
 */
export function contractKey({ homeTeam, awayTeam, commenceTime, market, period = 'full_game',
  side, line = null, participant = null, stat = null } = {}) {
  const event = eventKey({ homeTeam, awayTeam, commenceTime });
  if (!event.ok) return event;

  const marketId = MARKET_ALIASES[norm(market)];
  if (!marketId) return fail('unknown_market', String(market ?? ''));
  const spec = MARKETS[marketId];

  const periodId = norm(period);
  const overtime = PERIODS[periodId];
  if (!overtime) return fail('unknown_period', String(period ?? ''));

  const sideId = SIDE_ALIASES[norm(side)];
  if (!sideId || !spec.sides.includes(sideId)) return fail('invalid_side', `${marketId}/${side ?? ''}`);

  const value = line == null || line === '' ? null : Number(line);
  if (spec.line === 'required') {
    if (value == null || !Number.isFinite(value)) return fail('line_required', marketId);
    if (!HALF_POINT(value)) return fail('invalid_line', `${marketId} line ${value} is not a half point`);
    if (spec.bounds && (value < spec.bounds[0] || value > spec.bounds[1]))
      return fail('invalid_line', `${marketId} line ${value} outside ${spec.bounds.join('..')}`);
  } else if (value != null && Number.isFinite(value)) {
    return fail('line_forbidden', `${marketId} carried line ${value}`);
  }

  // A team total without a team, or a player prop without a player, is a row
  // that cannot be settled. It is not a contract with a missing label.
  let participantId = null;
  if (spec.participant === 'team') {
    const resolved = teamResolver()(participant);
    if (!resolved) return fail('missing_participant', `team_totals participant=${participant ?? ''}`);
    if (resolved.abbr !== event.home && resolved.abbr !== event.away)
      return fail('participant_not_in_event', `${resolved.abbr} not in ${event.key}`);
    participantId = resolved.abbr;
  } else if (spec.participant === 'player') {
    participantId = String(participant ?? '').trim();
    if (!participantId) return fail('missing_participant', 'player_props participant');
    if (!String(stat ?? '').trim()) return fail('missing_stat', 'player_props stat');
    participantId = `${participantId}|${norm(stat)}`;
  }

  const parts = [event.key, marketId, periodId, participantId ?? '-', sideId,
    value == null ? '-' : value.toFixed(1), `ot_${overtime}`, spec.settlement];
  const key = parts.join('|');
  return { ok: true, key,
    key_hash: crypto.createHash('sha256').update(key).digest('hex').slice(0, 16),
    version: CONTRACT_KEY_VERSION,
    event_key: event.key, league: 'nfl', game_date: event.game_date, kickoff: event.kickoff,
    home: event.home, away: event.away,
    market: marketId, period: periodId, side: sideId, line: value,
    participant: participantId, stat: stat == null ? null : norm(stat),
    overtime, overtime_rule_source: 'us_default_convention',
    settlement: spec.settlement, push_rule: spec.push, void_rule: spec.void ?? null,
    alternate_line: null };
}

/**
 * The other side of the same contract.
 *
 * Needed for no-vig pricing, and only correct when the mirrored line is the
 * exact opposite number. Anything else is two different bets, which is why
 * this refuses rather than approximating.
 */
export function mirrorContract(contract) {
  if (!contract?.ok) return fail('invalid_contract');
  const flip = { home: 'away', away: 'home', over: 'under', under: 'over' };
  return contractKey({
    homeTeam: contract.home, awayTeam: contract.away, commenceTime: contract.kickoff,
    market: contract.market, period: contract.period, side: flip[contract.side],
    line: contract.line == null ? null : (contract.market === 'spreads' ? -contract.line : contract.line),
    participant: contract.participant?.split('|')[0] ?? null,
    stat: contract.stat
  });
}

/** Human-readable quarantine reasons, for the dataset report and the UI. */
export const QUARANTINE_REASONS = Object.freeze({
  unresolved_team: 'A team name could not be matched to a franchise, so the game is unknown.',
  same_team_both_sides: 'The row lists one team on both sides of the game.',
  invalid_event_time: 'The kickoff timestamp is missing or unreadable.',
  unknown_market: 'The market is not one this project prices.',
  unknown_period: 'The period is unknown, so the overtime and settlement rules are unknown.',
  invalid_side: 'The side does not belong to this market.',
  line_required: 'A market that needs a number arrived without one.',
  line_forbidden: 'A market with no number arrived carrying one.',
  invalid_line: 'The number is not a half point, or is outside a possible range.',
  missing_participant: 'A team or player market arrived without naming the team or player.',
  participant_not_in_event: 'The named team does not play in this game.',
  missing_stat: 'A player market arrived without naming the statistic.',
  invalid_price: 'The price is missing, zero, or not a possible American price.',
  future_snapshot: 'The row claims to have been captured after the moment it is being read at.',
  after_kickoff: 'The quote was captured at or after kickoff, so it was not a pregame price.',
  book_ahead_of_snapshot: 'The book timestamp is later than the snapshot that contained it.'
});
