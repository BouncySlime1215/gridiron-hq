/**
 * Pricing a trade the way the OTHER manager sees it.
 *
 * The trade engine has always valued both sides with our number. That is the
 * right way to answer "is this good for me" and the wrong way to answer "will
 * he say yes", which is the question that decides whether a suggestion is worth
 * anything. A deal we price as a steal is not a steal if nobody accepts it, and
 * a deal we price as even is a gift if he thinks he won.
 *
 * So this module answers two separate questions and keeps them separate:
 *
 *   perception  - what is this package worth TO HIM, given what he has said
 *                 about these specific players and how he behaves generally
 *   receptiveness - how likely is this person to engage with a trade at all
 *
 * Both are bounded on purpose. Chat sentiment is weak evidence: a few texts
 * must be able to break a tie, never to overturn a valuation. The caps below
 * are the contract that keeps a chatty manager from dominating the ranking.
 */
import { rows } from '../db/index.js';
import { managerSignalsFor, sentimentMultiplier } from './manager-signals.js';
import { talkReads } from './talk-vs-model.js';
import { declarationCredibility, untouchableStance } from './bluff-detector.js';

/** Hard ceiling on how far chat can move a package's perceived value. */
export const PERCEPTION_CAP = 0.15;
/** Receptiveness multiplier range. 1.0 is "no information". */
export const RECEPTIVENESS_RANGE = [0.7, 1.3];

/** Percentile of x within xs, in [0,1]; 0.5 when xs carries no information. */
function percentile(xs, x) {
  const vals = xs.filter(Number.isFinite);
  if (vals.length < 3 || !Number.isFinite(x)) return 0.5;
  const spread = Math.max(...vals) - Math.min(...vals);
  if (spread <= 0) return 0.5;
  return vals.filter(v => v < x).length / (vals.length - 1);
}

/**
 * Per-league counterparty layer, built once per findTrades call.
 *
 * Absolute chat rates are compressed (open-to-trade runs 0.13-0.34 across a
 * whole league), so receptiveness is computed from each manager's RANK inside
 * his own league rather than the raw number. Ranking is what the finder needs
 * anyway: it is choosing between these ten people, not against an abstract
 * baseline.
 */
export function counterpartyLayer(leagueId, { season, week } = {}) {
  const signals = managerSignalsFor(leagueId);
  // Talk crossed with the model, and whether this person's word has held. Both
  // are loaded once for the league: the first decides the SIGN of a sentiment
  // adjustment, the second decides whether a refusal is real.
  const reads = talkReads(leagueId, season, week);
  const credibility = declarationCredibility();
  const tiers = new Map(rows('SELECT roster_id, tradeability FROM manager_profiles WHERE league_id = ?', leagueId)
    .map(r => [String(r.roster_id), r.tradeability]));

  const ids = [...signals.keys()];
  const openVals = ids.map(id => signals.get(id).metrics.chat_open_to_trade);
  const talkVals = ids.map(id => signals.get(id).metrics.chat_trade_talk);

  const profile = new Map();
  for (const id of ids) {
    const s = signals.get(id);
    const m = s.metrics;
    const msgs = m.chat_msgs ?? 0;
    // Someone with 40 messages has not told us much. Shrink the whole chat
    // contribution toward "no information" until there is a real corpus.
    const chatWeight = Math.min(1, msgs / 300);
    const openP = percentile(openVals, m.chat_open_to_trade);
    const talkP = percentile(talkVals, m.chat_trade_talk);
    let score = 0.5 + chatWeight * (0.65 * (openP - 0.5) + 0.35 * (talkP - 0.5));

    // Observed behaviour outranks talk. Only applied once there are enough
    // decided proposals for the rate to mean anything (the metric is withheld
    // below five by manager-signals.js, so its presence is itself the gate).
    if (Number.isFinite(m.tx_accept_rate)) {
      const w = Math.min(1, (s.samples.tx_accept_rate ?? 0) / 15);
      score = score * (1 - w) + m.tx_accept_rate * w;
    }
    // Nick's reads enter as a small nudge, never as a verdict.
    if (m.prior_disengaged) score -= 0.10 * m.prior_disengaged;
    if (m.prior_quiet) score -= 0.05 * m.prior_quiet;
    if (m.prior_seller) score += 0.08 * m.prior_seller;

    const [lo, hi] = RECEPTIVENESS_RANGE;
    let receptiveness = lo + (hi - lo) * Math.max(0, Math.min(1, score));
    const tier = tiers.get(id) ?? 'fair';
    if (tier === 'hard') receptiveness *= 0.55;

    profile.set(id, {
      roster_id: id, receptiveness: +receptiveness.toFixed(3), tier,
      chat_msgs: msgs, chat_weight: +chatWeight.toFixed(2),
      open_to_trade_pct: +openP.toFixed(2), trade_talk_pct: +talkP.toFixed(2),
      accept_rate: m.tx_accept_rate ?? null, accept_rate_n: s.samples.tx_accept_rate ?? 0,
      players: s.players ?? new Map(),
      reads: reads.get(id) ?? new Map(),
      stance: untouchableStance(leagueId, id, credibility),
      priors: Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith('prior_'))),
      untouchable_rate: m.chat_own_untouchable ?? null,
    });
  }
  return profile;
}

/**
 * What one package is worth to a given manager, relative to our valuation.
 *
 * Returns a multiplier and the reasons behind it, because an unexplained
 * multiplier is not usable in an explanation and would be the first thing to
 * silently rot. `sentimentMultiplier` already discounts small samples; the cap
 * here bounds the package as a whole so a three-player package cannot stack
 * three sentiment terms into a 40% swing.
 */
export function perceivedValue(players, managerProfile) {
  const total = players.reduce((s, p) => s + (p.value ?? 0), 0);
  // Either source is enough on its own: a talk-vs-model read can exist for a
  // player nobody has a raw sentiment row for, and vice versa.
  if (total <= 0 || (!managerProfile?.players?.size && !managerProfile?.reads?.size)) {
    return { value: total, multiplier: 1, reasons: [] };
  }
  let adjusted = 0;
  const reasons = [];
  for (const p of players) {
    const key = String(p.name ?? '').toLowerCase();
    const view = managerProfile.players.get(key);
    // The talk-vs-model read wins wherever it exists, because raw sentiment has
    // the wrong SIGN for the one case that costs real money: a manager talking
    // up a player he is quietly shopping. Sentiment alone reads that as
    // attachment and charges us a premium for exactly the guy he wants gone.
    const read = managerProfile.reads?.get(key) ?? null;
    const mult = read?.multiplier ?? view?.multiplier ?? 1;
    adjusted += (p.value ?? 0) * mult;
    if (Math.abs(mult - 1) >= 0.02) {
      reasons.push({
        player: p.name, sentiment: view?.sentiment ?? read?.sentiment,
        mentions: view?.n ?? read?.mentions, last_mention: view?.last,
        multiplier: +mult.toFixed(3),
        verdict: read?.verdict ?? null,
        reading: read?.why ?? (view?.sentiment > 2.2 ? 'he rates him'
          : view?.sentiment < 1.8 ? 'he is down on him' : 'neutral'),
      });
    }
  }
  const raw = total > 0 ? adjusted / total : 1;
  const capped = Math.max(1 - PERCEPTION_CAP, Math.min(1 + PERCEPTION_CAP, raw));
  return { value: +(total * capped).toFixed(2), multiplier: +capped.toFixed(3), reasons };
}

/**
 * The counterparty read on one proposed deal.
 *
 * `perception_delta` is the number that matters: how much better the package he
 * receives looks to him than the one he gives up, as a percentage of what he is
 * giving. Positive means it reads as a win from his side of the table — which
 * is the precondition for acceptance, independent of whether it is good for us.
 */
export function readDeal({ theirGive, theirGet, managerProfile }) {
  const give = perceivedValue(theirGive, managerProfile);
  const get = perceivedValue(theirGet, managerProfile);
  const base = give.value || 1;
  const delta = (get.value - give.value) / base;
  return {
    receptiveness: managerProfile?.receptiveness ?? 1,
    their_perceived_give: give.value, their_perceived_get: get.value,
    perception_delta: +(delta * 100).toFixed(1),
    perception_reasons: [...give.reasons.map(r => ({ ...r, side: 'they_give' })),
      ...get.reasons.map(r => ({ ...r, side: 'they_get' }))],
    chat_msgs: managerProfile?.chat_msgs ?? 0,
    accept_rate: managerProfile?.accept_rate ?? null,
    word_credibility: managerProfile?.stance?.credibility?.credibility ?? null,
    word_note: managerProfile?.stance?.note ?? null,
  };
}

/**
 * Players this manager has publicly treated as untouchable recently.
 *
 * Asking for someone's declared untouchable is the single cheapest way to look
 * like you do not read the chat, so these are removed from the search entirely
 * rather than ranked down — the same treatment Nick's own exclusions get.
 */
export function untouchablesFor(leagueId, rosterId, { days = 30, threshold = 2.9 } = {}) {
  return new Set(rows(`SELECT player_name FROM manager_player_view
                       WHERE league_id = ? AND roster_id = ? AND sentiment >= ? AND n >= 3
                         AND last_mention >= date('now', ?)`,
  leagueId, String(rosterId), threshold, `-${days} days`).map(r => r.player_name.toLowerCase()));
}
