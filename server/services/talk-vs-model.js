/**
 * Is he attached to this player, or selling him?
 *
 * Nick, 2026-09-17: "maybe someone is trying to offload someone and props them
 * up as a bluff — need to use the model to understand if this is real."
 *
 * This fixes a sign error in the counterparty layer. Sentiment alone was being
 * read one way: he praises a player, so the player costs more to acquire. But
 * praise has two completely different causes and they point in OPPOSITE
 * directions:
 *
 *   attachment   he rates the guy and does not want to move him
 *                -> genuinely expensive, and worth paying up for
 *   sales pitch  he is building a case before he shops him
 *                -> cheap to acquire, and we should not want him
 *
 * Read as attachment, a sales pitch makes us pay a premium for exactly the
 * player his owner has decided to dump. That is the worst outcome the whole
 * counterparty layer could produce, so it needs a discriminator that does not
 * come from the chat at all.
 *
 * The discriminator is the model. Specifically the gap between expected fantasy
 * points (what his usage earns) and actual (what he scored). A player far above
 * his expectation has been finishing drives and catching touchdowns at a rate
 * his usage does not support, which is the classic sell-high profile — and it
 * is precisely the player an alert manager talks up before moving. When the
 * talk and the usage disagree, believe the usage.
 *
 * Deliberately NOT claimed here: that any individual read is right. A manager
 * can be genuinely excited about a guy who is also overperforming. What this
 * produces is a flag with the evidence attached, so the explanation can say
 * "he has mentioned him 14 times, positively, and the player is 15 points above
 * what his usage earns" and let that speak for itself.
 */
import { rows } from '../db/index.js';

/** Points above expectation, per game, where regression risk becomes the story. */
export const HOT_GAP_PER_GAME = 3.0;
/** Sentiment on Jev's 0-4 scale; 2 is neutral. */
export const PRAISE = 2.3;
export const SOUR = 1.75;

/**
 * Season-to-date expectation gap for every player, as of a cutoff.
 *
 * Strictly prior by construction: only weeks before `week` are summed, so a
 * read for week 3 never sees week 3's box score. Returns per-game rates because
 * a player with one big week and a player with six modest ones are different
 * stories and totals would hide that.
 */
export function expectationGaps(season, week) {
  const out = new Map();
  for (const r of rows(`SELECT lower(player_name) AS name, position,
                          SUM(expected_fantasy_points) AS xfp,
                          SUM(actual_fantasy_points)   AS act,
                          COUNT(*) AS games
                        FROM nfl_ffopportunity_weekly
                        WHERE season = ? AND week < ?
                        GROUP BY lower(player_name), position`, season, week)) {
    if (!r.games) continue;
    out.set(r.name, {
      position: r.position, games: r.games,
      xfp_per_game: +(r.xfp / r.games).toFixed(2),
      actual_per_game: +(r.act / r.games).toFixed(2),
      gap_per_game: +((r.act - r.xfp) / r.games).toFixed(2),
    });
  }
  return out;
}

/**
 * Cross what a manager says about a player with what the model says about him.
 *
 * `owns` matters: praise for someone else's player is interest, praise for your
 * own is either attachment or a pitch, and only the second pair is ambiguous.
 */
export function readTalk({ sentiment, mentions, openToTrade = null, owns, gap }) {
  const praise = sentiment >= PRAISE;
  const sour = sentiment <= SOUR;
  const hot = gap && gap.games >= 2 && gap.gap_per_game >= HOT_GAP_PER_GAME;
  const cold = gap && gap.games >= 2 && gap.gap_per_game <= -HOT_GAP_PER_GAME;
  // Below three mentions there is no pattern to read, only a remark.
  const thin = !mentions || mentions < 3;

  if (!owns) {
    if (praise && !thin) return { verdict: 'wants_him', confidence: hot ? 'watch' : 'clear',
      why: `talks him up and does not own him${hot ? ', though the player is running hot' : ''}` };
    if (sour && !thin) return { verdict: 'not_interested', confidence: 'clear', why: 'talks him down, does not own him' };
    return { verdict: 'no_read', confidence: 'thin', why: 'not enough said' };
  }

  if (praise && hot) {
    return {
      verdict: 'sales_pitch', confidence: thin ? 'weak' : openToTrade > 0.2 ? 'strong' : 'moderate',
      why: `praises his own player (${mentions} mentions) while the player is +${gap.gap_per_game}/game `
        + `above what his usage earns over ${gap.games} games — the profile of a case being built, not a keeper`,
      action: 'do not pay the premium, and think hard about wanting him at all',
    };
  }
  if (praise && !thin) {
    return {
      verdict: 'attachment', confidence: cold ? 'strong' : 'moderate',
      why: `praises his own player (${mentions} mentions)${cold ? ' who is actually UNDER his expected points, so this is belief rather than marketing' : ' and the usage backs it'}`,
      action: 'expect to pay above market, or trade around him',
    };
  }
  if (sour && cold) {
    return {
      verdict: 'buy_low', confidence: 'strong',
      why: `down on his own player (${mentions} mentions) who is ${gap.gap_per_game}/game BELOW what his usage earns `
        + '— the complaint is about results, and the usage says the results are the part that is wrong',
      action: 'this is the buy',
    };
  }
  if (sour && !thin) {
    return { verdict: 'genuine_sour', confidence: hot ? 'weak' : 'moderate',
      why: `down on his own player${hot ? ', but the player is running hot, so the complaint may be about role rather than points' : ' and the usage agrees'}`,
      action: 'available, and probably for good reason' };
  }
  return { verdict: 'no_read', confidence: 'thin', why: 'neutral or too few mentions' };
}

/**
 * How much the verdict should move the price we expect to pay.
 *
 * Returns a multiplier on OUR side of the perception calculation. The numbers
 * are small on purpose — this is chat evidence crossed with a noisy season-to-
 * date gap, and it exists to break ties and raise flags, not to reprice a
 * roster. A sales pitch gets the sharpest adjustment because it is the one case
 * where the naive reading is actively backwards.
 */
export function priceAdjustment(read) {
  const strength = read.confidence === 'strong' ? 1 : read.confidence === 'moderate' ? 0.6 : 0.3;
  switch (read.verdict) {
    case 'sales_pitch': return { multiplier: 1 - 0.10 * strength, note: 'discount: he is selling, not keeping' };
    case 'attachment': return { multiplier: 1 + 0.10 * strength, note: 'premium: he means it' };
    case 'buy_low': return { multiplier: 1 - 0.08 * strength, note: 'discount: he is sour on a player the usage likes' };
    case 'genuine_sour': return { multiplier: 1 - 0.05 * strength, note: 'discount: he wants him gone' };
    case 'wants_him': return { multiplier: 1 + 0.05 * strength, note: 'he covets this player — useful as bait' };
    default: return { multiplier: 1, note: null };
  }
}

/**
 * Every read for one league, keyed roster_id -> player name -> read.
 *
 * Ownership comes from the synced ESPN payload rather than from the chat, so a
 * manager cannot talk his way into owning someone.
 */
export function talkReads(leagueId, season, week) {
  const lg = rows('SELECT payload FROM leagues WHERE id = ?', leagueId)[0];
  if (!lg?.payload) return new Map();
  const payload = JSON.parse(lg.payload);
  const ownedBy = new Map();
  for (const t of payload.teams ?? []) {
    for (const e of t.roster?.entries ?? []) {
      const nm = e.playerPoolEntry?.player?.fullName;
      if (nm) ownedBy.set(nm.toLowerCase(), String(t.id));
    }
  }
  const gaps = expectationGaps(season, week);
  const out = new Map();
  for (const v of rows(`SELECT roster_id, player_name, sentiment, n FROM manager_player_view
                        WHERE league_id = ?`, leagueId)) {
    const name = v.player_name.toLowerCase();
    const read = readTalk({
      sentiment: v.sentiment, mentions: v.n,
      owns: ownedBy.get(name) === String(v.roster_id),
      gap: gaps.get(name) ?? null,
    });
    if (read.verdict === 'no_read') continue;
    if (!out.has(v.roster_id)) out.set(v.roster_id, new Map());
    out.get(v.roster_id).set(name, { ...read, ...priceAdjustment(read), player: v.player_name, mentions: v.n, sentiment: v.sentiment });
  }
  return out;
}
