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
import { managerSignalsFor, openChatDb, chatDataKey, transactionsCollected, archetypesBuilt, jevEvaluated }
  from './manager-signals.js';
import { identityMap } from './manager-identity.js';
import { readProfile, peopleProfileFromChat } from './people/profile-reader.js';
import { talkReads, expectationGaps, rosterOwnership, HOT_GAP_PER_GAME } from './talk-vs-model.js';
import { declarationCredibility, untouchableStance } from './bluff-detector.js';
import { analyzeLeague } from '../routes/tradelab.js';
import { previewUnconfirmed, previewFields, previewText } from './preview-mode.js';

/**
 * RL-19-1: default-off preview of the r19-measured `positional_need` cap.
 * Read per call (like PREVIEW-01's own switch) so a test can flip it without
 * a process restart. Off by default: the served price does not change until
 * this or preview mode (preview-mode.js) is on.
 */
const RL19_1_ENV = 'GRIDIRON_RL19_1_ENABLED';
const rl19NeedPricingOn = () =>
  process.env[RL19_1_ENV] === '1' || previewUnconfirmed();
/**
 * RL-19-1 (validated): 1,326 real Sleeper 1-for-1 trades (2021-24) put the
 * need premium's 90% CI upper bound at 2.8% of value on cross-position deals,
 * against the 8% the code has always charged (rnd/loop/
 * r19-external-need-steers-who-not-price.md, arm 2c). Re-derived independently
 * by rnd/loop/scripts/r19v_need_price_rederive.py (data/r19v/…): CROSS-POS
 * x_con hi/lvl +0.0280, ALL x_con bN/lvl -0.0102 — near zero, and the "depth
 * lowers it" sign flips across the split, so that branch is unsupported and
 * dropped when this preview is on. 0.02 sits inside both CIs; still `fitted:
 * false` because this is a bound, not a fitted coefficient.
 */
const RL19_1_NEED_CAP = 0.02;

/** Hard ceiling on how far chat can move a package's perceived value. */
// TEST SEAM: no production importer. Used by `perceivedValue` below; exported so
// test/valuation-map.test.js can pin the package clamp without restating 0.15.
export const PERCEPTION_CAP = 0.15;
/** Receptiveness multiplier range. 1.0 is "no information". */
export const RECEPTIVENESS_RANGE = [0.7, 1.3];

/**
 * THE VALUATION MAP — what each manager thinks each player is worth.
 *
 * Master plan 00 D4: "for every player in the league, what THIS manager thinks
 * he is worth, next to what we think he is worth. The gap on each player is the
 * raw material of every trade."
 *
 * Their value = our value x a product of NAMED, individually capped factors.
 * Nothing here is fitted, and every factor says so (`fitted: false`): these are
 * hand-set sizes chosen to break ties and raise flags, exactly like the two
 * that already existed (`sentimentMultiplier` and `priceAdjustment`). They
 * cannot be fitted until enough proposals have been decided — 30 in 2026 so far,
 * 6 of them accepted (master plan F/Q1, "trade objective constants still
 * unfitted"). What IS enforced, and tested, is the shape:
 *
 *   - every factor names a source in this registry and carries its sample size;
 *   - no factor may exceed its own cap, and no player may move more than
 *     PLAYER_VALUATION_CAP in total, whatever the sources agree on;
 *   - a source below its minimum sample is reported INERT WITH A REASON rather
 *     than dropped, so a page can say why a signal is not firing;
 *   - the same evidence is never charged twice (see `playerValuation`).
 *
 * `min_n` is what the source's `n` must reach before it prices anything. The
 * one that matters today is `luck_self_view`: in week 2 of 2026 the archetype
 * build has ONE scored week, and one game of luck is noise, so it is inert
 * league-wide until week 5.
 *
 * `needs` names the data the source cannot work without, which is what the map
 * reports as absent for the four leagues with no chat corpus.
 */
// TEST SEAM: no production importer (trade-engine.js:1907 names it in a comment
// only). Eleven readers in this file; exported so the suite can assert every
// source's cap, min_n and fitted flag against the registry rather than a copy.
export const VALUATION_SOURCES = Object.freeze({
  talk_vs_model: { label: 'How he talks about the player, crossed with the model',
    cap: 0.10, min_n: 3, needs: 'league chat', fitted: false,
    why: 'praise means two opposite things; the expectation gap decides which' },
  chat_sentiment: { label: 'How he talks about the player (raw chat sentiment)',
    cap: 0.12, min_n: 1, needs: 'league chat', fitted: false,
    why: 'the fallback where there is talk but no model read to cross it with' },
  profile_roster_read: { label: 'What his negotiation profile says he over- and undervalues',
    cap: 0.10, min_n: 1, needs: 'league chat', fitted: false,
    why: 'a whole-corpus read naming specific players, not a per-message average' },
  outscoring_usage: { label: 'His own player is outscoring the usage that earns it',
    cap: 0.08, min_n: 2, needs: 'weekly expected points', fitted: false,
    why: 'a hot player is priced by his owner at his hot number' },
  luck_self_view: { label: 'His record is flattered (or punished) by luck',
    cap: 0.05, min_n: 4, needs: 'scored weeks in the archetype build', fitted: false,
    why: 'a manager whose record overstates his team prices that team high' },
  positional_need: { label: 'A hole (or a glut) at this position',
    cap: 0.08, min_n: 1, needs: 'a roster read for the league', fitted: false,
    why: 'a need raises what he pays there; depth lowers it' },
  recency_post_loss: { label: 'He just lost, or reacts to losses',
    cap: 0.05, min_n: 1, needs: 'ESPN standings', fitted: false,
    // The one source in this registry that does NOT move a player's price. It
    // lowers resistance to trading at all, which is receptiveness, so it is
    // applied there and reported in `receptiveness_factors`. Keeping it in one
    // registry keeps the caps and the provenance rules in a single place.
    why: 'a post-loss window lowers resistance — to the deal, not to the player' },
  untouchable_credibility: { label: 'He has called the player untouchable, and his word has held',
    cap: 0.10, min_n: 1, needs: 'league chat', fitted: false,
    why: 'a refusal that holds is a real price; a bluffer\'s refusal is an opening one' },
});

/**
 * Hard ceiling on how far every source together may move ONE player, whatever
 * they agree on. Larger than the package cap on purpose: a single player may be
 * a manager's whole story, a package of three must not be able to stack three.
 */
// TEST SEAM: no production importer. Used by `playerValuation` below; exported so
// test/valuation-map.test.js G1b can pin the per-player clamp and its ordering
// against PERCEPTION_CAP.
export const PLAYER_VALUATION_CAP = 0.20;

/**
 * What a manager has DONE this season, as a receptiveness term: "chance he
 * completes a trade", NOT acceptance. The constants are the Sleeper 2021-23
 * linear probability model of "is a side in a completed trade next week",
 * league-week demeaned, n = 27,468 team-weeks (rnd/loop r11 package section 2a;
 * the validator re-derived the activity-only AUC, 0.652 on 2024, on its own
 * code). The outcome mixes proposer and responder: Sleeper keeps no proposals.
 *
 *   base         P(trade next week) in a league-week where someone traded
 *   adds         per player added per week (2024 confirm: +0.0548)
 *   traded       has already completed a trade this season (2024: +0.1231)
 *   dead_start   a starter left in who did not play last week (2024: -0.0426)
 *
 * The grade of THIS function on the corpus and on 2026 is in
 * docs/tdd/2026-09-23-activity-receptiveness.tdd.md.
 */
export const ACTIVITY_FIT = Object.freeze({
  base: 0.2412, adds: 0.0686, traded: 0.1227, dead_start: -0.0264, n: 27468,
  source: 'Sleeper 2021-23 corpus, linear probability model, league-week demeaned',
});
/** Weeks the adds-per-week rate must average over before it prices anything (as tx_accept_rate's five). */
export const ACTIVITY_MIN_WEEKS = 5;
/**
 * DEFAULT-OFF. The pre-registered ship rule (docs/evidence/2026-09-23/
 * activity-receptiveness-preregistration.md) needed AUC >= 0.645 on the 2024
 * held-out corpus season for this exact function; it scored 0.644 (44% of rows
 * sit at ACTIVITY_CAP, and the ties cost the ranking). So the activity and
 * checked-out terms are computed and REPORTED on every manager, with what they
 * would do, but move nothing unless GRIDIRON_RECEPTIVENESS_ACTIVITY=1 (or the
 * caller passes `activity: true`). Read per call so a test or a run can flip it.
 */
export const ACTIVITY_FLAG = 'GRIDIRON_RECEPTIVENESS_ACTIVITY';
const ACTIVITY_UNCONFIRMED = 'default-off: 2024 held-out AUC 0.644 missed its 0.645 bar; unconfirmed forward';
const ACTIVITY_OFF_WHY = `not applied (${ACTIVITY_UNCONFIRMED})`;
/** Furthest the activity term may move the 0-1 receptiveness score (the chat term's reach). */
const ACTIVITY_CAP = 0.5;
/** Receptiveness is lo + (hi - lo) * score, so a relative change r in propensity is r / (hi - lo) in score. */
const SCORE_PER_RELATIVE = 1 / (RECEPTIVENESS_RANGE[1] - RECEPTIVENESS_RANGE[0]);

/** Points below zero last week at which the post-loss window is fully open. */
const POST_LOSS_FULL_MARGIN = 30;
/** Chat "reacting to loss" share that counts as a full habit. */
const POST_LOSS_CHAT_FULL = 0.10;
/** Luck, in wins above expectation, at which the flattered-self read is full strength. */
const LUCK_FULL_WINS = 2;
/**
 * How much of its cap a negotiation profile's roster read earns, by the
 * confidence the model itself reported. Measured on the real corpus
 * (2026-09-18): 2 high, 2 medium, 5 low, 1 unstated — so treating them alike
 * would price half the league on the model's own least certain reads.
 */
const PROFILE_CONFIDENCE = Object.freeze({ high: 1, medium: 0.7, low: 0.4 });

/** Percentile of x within xs, in [0,1]; 0.5 when xs carries no information. */
function percentile(xs, x) {
  const vals = xs.filter(Number.isFinite);
  if (vals.length < 3 || !Number.isFinite(x)) return 0.5;
  const spread = Math.max(...vals) - Math.min(...vals);
  if (spread <= 0) return 0.5;
  return vals.filter(v => v < x).length / (vals.length - 1);
}

/**
 * THE MODEL'S READ OF EACH MANAGER — DISPLAYED, NEVER PRICED.
 *
 * `manager_archetype_jev` answers, in a typed and stored form, the questions
 * this module exists to ask: does he overvalue what he already owns, does he
 * counter or decline outright, would he move a player cheaply after one bad
 * week. It has been written since the archetype build shipped and the trade
 * path never read it.
 *
 * It is brought in as a READ OF THE PERSON and it moves no number, which is a
 * deliberate refusal rather than an omission. Five of the eight questions carry
 * `basis: 'inference_only'` — the store's own column saying the record contains
 * no evidence bearing on the answer, so the model was told to stay near the
 * prior and did. A prior that moves a price is a number invented about someone.
 * `test/valuation-map.test.js` G11d pins it: deleting the whole store must not
 * change a price, a multiplier, a factor, an inert entry or receptiveness.
 *
 * If this is ever to price, it needs a decided-proposal sample to fit against,
 * exactly like every other entry in VALUATION_SOURCES — not a promotion.
 */
/**
 * How far an answer must depart from an even spread before it is reported as
 * saying anything. Total-variation distance, so 0.05 is "five percent of the
 * probability mass is somewhere other than where an even spread would put it".
 *
 * Not fitted, and it prices nothing: it decides whether a sentence appears, not
 * whether a number moves. It exists because 0.34/0.33/0.33 is what "spread the
 * probability evenly" looks like after a model rounds, and served as three
 * numbers it invites a page to draw a bar chart of noise and a reader to
 * conclude he counters slightly more often than not.
 */
const JEV_FLAT_TVD = 0.05;

function shapeJevAnswer(question, a) {
  const measured = a.basis === 'draft';
  // 'mean' is the score summary stored beside the per-level probabilities, not
  // an outcome anyone can land on, so it is not part of the distribution.
  const outcomes = Object.entries(a.p ?? {})
    .filter(([k, v]) => k !== 'mean' && Number.isFinite(v));
  // A boolean is stored as its 'true' leg alone. Its other leg is real and has
  // to be in the distribution, or every boolean reads as maximally lopsided.
  const dist = outcomes.length === 1 && outcomes[0][0] === 'true'
    ? [['true', outcomes[0][1]], ['false', 1 - outcomes[0][1]]]
    : outcomes;
  const k = dist.length;
  const spread = k > 1
    ? +(0.5 * dist.reduce((s, [, v]) => s + Math.abs(v - 1 / k), 0)).toFixed(4)
    : null;
  const informative = spread != null && spread >= JEV_FLAT_TVD;
  const top = dist.length
    ? (([outcome, probability]) => ({ outcome, probability }))(
      dist.reduce((best, cur) => (cur[1] > best[1] ? cur : best)))
    : null;
  const why = !measured
    ? 'this is a prior and not a reading of him: the record the model was shown holds no trades, no waiver '
      + 'claims and no timestamps, so nothing in it bears on the question'
      + (informative ? '' : ' — and the answer came back an even spread across the options, which is the '
        + 'honest answer when there is no evidence')
    : informative
      ? `read from his own draft record — ${a.n_picks ?? '?'} picks across ${a.n_seasons ?? '?'} seasons`
      : 'his draft record bears on this question and the answer still came back an even spread across the '
        + 'options, so it carries no information about him either way';
  return {
    question, basis: a.basis, measured,
    p: a.p ?? {}, top, score_mean: Number.isFinite(a.p?.mean) ? a.p.mean : null,
    n_seasons: a.n_seasons ?? null, n_picks: a.n_picks ?? null,
    spread, informative, why,
  };
}

/**
 * The model read for a set of rosters — the same call the counterparty layer
 * makes, exported because the manager page needs rosters the layer never
 * reaches. The layer is built from `manager_signals` keys, and a manager with
 * no signals still has a draft record somebody paid a gateway call to read.
 */
export function managerModelReads(leagueId, rosterIds = null) {
  const read = jevEvaluated(leagueId);
  const ids = rosterIds ?? [...read.by_roster.keys()];
  return new Map([...ids].map(id => [String(id), jevBlockFor(read, id)]));
}

/** One manager's block, or the absence that is not his fault. */
function jevBlockFor(read, rosterId) {
  const entry = read.by_roster.get(String(rosterId)) ?? null;
  if (!entry) {
    return Object.freeze({ priced: false, evaluated_by: read.evaluated_by, as_of: null, model: null,
      answers: [],
      // A league-level reason when there is one; otherwise the store covers this
      // league and stopped short of him, which is a fact about the run.
      reason: read.reason
        ?? 'the Jev pass has covered this league but not him — it is run one manager at a time and costs a '
           + 'gateway call each, so who it reached is a fact about the run and not about him' });
  }
  return Object.freeze({ priced: false, evaluated_by: read.evaluated_by, as_of: entry.as_of,
    model: entry.model,
    answers: Object.entries(entry.questions).map(([q, a]) => shapeJevAnswer(q, a)),
    reason: null });
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
export function counterpartyLayer(leagueId, { season, week, rosterContext = null, zero = [], activity = null } = {}) {
  // PREVIEW-01: the local-testing switch turns the terms on when neither the caller nor
  // the site flag has; each applied term then says it is a preview.
  const activityPreview = activity == null && process.env[ACTIVITY_FLAG] !== '1' && previewUnconfirmed();
  const activityOn = activity ?? (process.env[ACTIVITY_FLAG] === '1' || activityPreview);
  const signals = managerSignalsFor(leagueId);
  // One block per league, shared by every manager entry and frozen for that
  // reason. `luck_self_view` is priced off this store, so its age travels with
  // the reading rather than being left for a page to guess at.
  const archetypesAsOf = Object.freeze(archetypesBuilt(leagueId, season ?? null));
  // The model's read of each person, on its own clock: the Jev pass is opt-in
  // while the archetype build is not, so the two stamps drift apart by design.
  // Read once per league and handed out per manager; it prices nothing. The
  // manager page reads it through the same call, so the two cannot disagree.
  // Every league-wide read is built ONCE here and handed to whoever needs it,
  // so the deal read and the valuation map cannot end up on different answers.
  const gaps = expectationGaps(season, week);
  const ownedBy = rosterOwnership(leagueId);
  // Talk crossed with the model, and whether this person's word has held. Both
  // are loaded once for the league: the first decides the SIGN of a sentiment
  // adjustment, the second decides whether a refusal is real.
  const reads = talkReads(leagueId, season, week, { gaps, ownedBy });
  // Declarations live in the chat, so a league with no trusted chat identity
  // has none to weigh — and no reason to open the private chat DB at all.
  const credibility = identityMap(leagueId).size ? declarationCredibility() : null;
  // WHETHER THE RECORD WAS READ AT ALL, which is not the same as whether it is
  // empty — and it can fail to be read in two ways. `credibility == null` is "we
  // never asked": this league has no confirmed chat identity, so no lookup was
  // attempted. `available: false` is "we asked and could not read it": the
  // declaration record that says whether his refusals HOLD lives in the Mac-only
  // corpus, so on the deployed app it is absent while `manager_player_view`, in
  // this database, still holds his declared players.
  //
  // Both leave `untouchableStance` falling back to the prior
  // (1 - PRIOR_BLUFF_RATE = 0.65), which clears its 0.45 bar and prices the
  // player up under a sentence saying his word has held, when nothing about his
  // word was read. So both are `false` here and carry DIFFERENT sentences —
  // one is a machine, the other is a name Nick never confirmed — and the
  // difference travels to `playerValuation`, which withholds the adjustment.
  const declarationsRead = credibility != null && credibility.available !== false;
  const declarationsReason = declarationsRead
    ? null
    : credibility == null
      ? 'his declaration record was never looked up — this league has no confirmed chat identity for him, so whether his refusals hold is unknown'
      : 'his declaration record was never read — the chat corpus is not on this machine, so whether his refusals hold is unknown';
  // The whole-corpus model read of each person. One loader (negotiationProfilesFor),
  // which validates what it reads; an invalid profile simply is not there.
  const profiles = negotiationProfilesFor(leagueId);
  const needsByRoster = rosterContext ?? deriveRosterNeeds(leagueId);
  // The tier and WHETHER ANYONE SET IT are two facts, and only the first used to
  // survive this read. `?? 'fair'` below makes an elicited "fair" and an assumed
  // one the same value, and live manager_profiles has no rows at all, so every
  // league is the assumed case while reading like the stated one.
  const tiers = new Map(rows('SELECT roster_id, tradeability FROM manager_profiles WHERE league_id = ?', leagueId)
    .map(r => [String(r.roster_id), r.tradeability]));
  // Who owns what, inverted once: the valuation of a player he owns and of one
  // he might buy are different questions and must not be answered alike.
  const rosterOf = new Map();
  for (const [name, rid] of ownedBy ?? []) {
    if (!rosterOf.has(rid)) rosterOf.set(rid, new Set());
    rosterOf.get(rid).add(name);
  }
  const rosterSize = new Map();
  for (const [rid, names] of rosterOf) rosterSize.set(rid, names.size);

  const ids = [...signals.keys()];
  const jevBlocks = managerModelReads(leagueId, ids);
  // The activity term is relative to THIS league (Nick's leagues sit inside the
  // Sleeper range of add rates, but not at its mean), so it is centred on the
  // league's own managers. Nick's roster is in the mean: he is in the market too.
  const activityMean = leagueActivityMean(ids.map(id => signals.get(id)));
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

    // What he has done, before the observed accept-rate blend: activity is
    // "chance he completes a trade", so an observed rate of saying yes to
    // offers still outranks it. Both are reported; below their gates they are
    // withheld with the reason rather than dropped.
    const activityTerm = offUnless(activityOn, activityPreview,
      zero.includes('trade_activity') ? null : activityFactor(m, s.samples, activityMean));
    if (Number.isFinite(activityTerm?.effect)) score += activityTerm.effect;
    const checkedOut = offUnless(activityOn, activityPreview, zero.includes('checked_out') ? null : checkedOutFactor(m, s.samples));
    if (Number.isFinite(checkedOut?.effect)) score += checkedOut.effect;

    // Observed behaviour outranks talk. Only applied once there are enough
    // decided proposals for the rate to mean anything (the metric is withheld
    // below five by manager-signals.js, so its presence is itself the gate).
    let acceptWeight = 0;
    if (Number.isFinite(m.tx_accept_rate)) {
      const w = Math.min(1, (s.samples.tx_accept_rate ?? 0) / 15);
      acceptWeight = w;
      score = score * (1 - w) + m.tx_accept_rate * w;
    }
    // Nick's reads enter as a small nudge, never as a verdict.
    if (m.prior_disengaged) score -= 0.10 * m.prior_disengaged;
    if (m.prior_quiet) score -= 0.05 * m.prior_quiet;
    if (m.prior_seller) score += 0.08 * m.prior_seller;

    // The post-loss window. This is the one declared valuation source that does
    // not move a player's price: losing badly does not change what he thinks
    // Jonathan Taylor is worth, it changes whether he answers at all. So it is
    // applied to receptiveness and reported here, with its cap and its sample.
    // `zero` suppresses a source for the ablation — the only way to answer "does
    // this signal change any idea" without reasoning backwards from a score.
    const postLoss = zero.includes('recency_post_loss') ? null : postLossFactor(m, s.samples);
    if (postLoss) score += postLoss.effect;

    const [lo, hi] = RECEPTIVENESS_RANGE;
    const receptiveness = lo + (hi - lo) * Math.max(0, Math.min(1, score));
    // The hand-set tier is reported, not applied: trade-engine.js applies the
    // 0.55 "hard" factor to every deal, with or without this layer, and
    // applying it here as well discounted a hard manager to 0.30.
    const tier = tiers.get(id) ?? 'fair';
    // Provenance for the tier and for the blend, both already known here.
    // `tier_is_assumption` is deliberately redundant with `tier_source`: a
    // boolean is what a badge binds to and the string is what a tooltip prints,
    // and a consumer forced to derive one from the other is a consumer that will
    // eventually derive it wrong.
    const tierSource = tiers.has(id) ? 'elicited' : 'default';
    const pricedBy = acceptWeight >= 1 ? 'observed'
      : acceptWeight > 0 ? 'blended'
        : tierSource === 'elicited' ? 'elicited' : 'default';

    const ctx = needsByRoster?.get(String(id)) ?? null;
    profile.set(id, {
      roster_id: id, receptiveness: +receptiveness.toFixed(3), tier,
      tier_source: tierSource, tier_is_assumption: tierSource === 'default',
      accept_rate_weight: +acceptWeight.toFixed(2), priced_by: pricedBy,
      chat_msgs: msgs, chat_weight: +chatWeight.toFixed(2),
      open_to_trade_pct: +openP.toFixed(2), trade_talk_pct: +talkP.toFixed(2),
      accept_rate: m.tx_accept_rate ?? null, accept_rate_n: s.samples.tx_accept_rate ?? 0,
      players: s.players ?? new Map(),
      reads: reads.get(id) ?? new Map(),
      stance: untouchableStance(leagueId, id, credibility),
      declarations_read: declarationsRead,
      declarations_reason: declarationsReason,
      priors: Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith('prior_'))),
      untouchable_rate: m.chat_own_untouchable ?? null,
      // NOT a valuation-map input, and deliberately above the line that marks
      // them: this is a read OF him for a page to show, with the date it was
      // made and, per answer, whether anything was under it.
      jev: jevBlocks.get(String(id)),
      // ---- the valuation-map inputs, each already reduced to what it means ----
      owned: rosterOf.get(String(id)) ?? new Set(),
      roster_size: rosterSize.get(String(id)) ?? 0,
      gaps,
      needs: ctx?.needs ?? null,
      surplus: ctx?.surplus ?? null,
      window: ctx?.window ?? null,
      // luck_wins comes from the archetype build, which manager-signals.js
      // already copies into manager_signals for this league-season. Reading it
      // there rather than importing manager-archetypes.js keeps the weekly
      // feature store out of the trade path.
      luck: Number.isFinite(m.outcome_luck_wins)
        ? { value: m.outcome_luck_wins, n: s.samples.outcome_luck_wins ?? 0,
          // The BUILD's stamp, not manager_signals.computed_at: the signal build
          // can re-copy this value without the archetype build having re-measured
          // it, so its own stamp would advance while the measurement sat still.
          as_of: archetypesAsOf.as_of } : null,
      archetypes: archetypesAsOf,
      negotiation: profiles.byRoster.get(String(id))?.profile ?? null,
      negotiation_n: profiles.byRoster.get(String(id))?.messages_read ?? 0,
      receptiveness_factors: [
        ...(chatWeight > 0 ? [{ source: 'chat_engagement', label: 'How he talks in the league chat',
          effect: +(chatWeight * (0.65 * (openP - 0.5) + 0.35 * (talkP - 0.5))).toFixed(3),
          n: msgs, cap: 0.5, fitted: false,
          why: `open-to-trade rank ${openP.toFixed(2)}, trade-talk rank ${talkP.toFixed(2)}` }] : []),
        ...(Number.isFinite(m.tx_accept_rate) ? [{ source: 'observed_accept_rate',
          label: 'What he has actually done with offers', effect: null,
          n: s.samples.tx_accept_rate ?? 0, cap: null, fitted: false,
          why: `accepted ${(m.tx_accept_rate * 100).toFixed(0)}% of ${s.samples.tx_accept_rate} decided offers, `
            + 'blended over talk' }] : []),
        // `n: null`, not 3. A prior is a sentence Nick wrote down, not three of
        // anything observed: `manager-signals.js:374` stores every one of them with
        // a placeholder n of 3 and `source: 'nick'`, and mirroring that number onto
        // the factor made a hand-set read print as if it rested on a sample of
        // three. Nothing computes with this field — the priors move receptiveness
        // through `m.prior_*` at :185-187, before this array is built, and no
        // reader of `receptiveness_factors` anywhere reads a `nick_prior` n — so
        // saying "no sample" costs nothing and stops the one number on the factor
        // that is not evidence from looking like evidence.
        ...Object.entries(m).filter(([k, v]) => k.startsWith('prior_') && v)
          .map(([k, v]) => ({ source: 'nick_prior', label: `Nick's read: ${k.slice(6)}`,
            effect: null, n: null, cap: null, fitted: false, why: `${k.slice(6)} ${v}` })),
        ...(postLoss ? [postLoss] : []),
        ...(activityTerm ? [activityTerm] : []),
        ...(checkedOut ? [checkedOut] : []),
      ],
    });
  }
  return profile;
}

/**
 * A default-off term keeps its entry and says what it would have done, but
 * its effect is null so nothing adds it and every page renders it as not
 * scored. On only because of preview mode (PREVIEW-01), it is applied and labelled.
 */
function offUnless(on, preview, f) {
  if (f && on && preview && f.effect != null) {
    return { ...f, ...previewFields(ACTIVITY_UNCONFIRMED), why: previewText(f.why) };
  }
  if (!f || on || f.effect == null) return f;
  return { ...f, effect: null, would_effect: f.effect,
    why: `${ACTIVITY_OFF_WHY}; would move the score ${f.effect > 0 ? '+' : ''}${f.effect.toFixed(2)}. ${f.why}` };
}

/** League means of the two activity inputs, over the managers who have them. */
function leagueActivityMean(list) {
  const have = list.filter(s => Number.isFinite(s?.metrics?.tx_adds_per_week));
  if (!have.length) return null;
  return {
    adds: have.reduce((a, s) => a + s.metrics.tx_adds_per_week, 0) / have.length,
    traded: have.reduce((a, s) => a + (s.metrics.tx_completed_trades > 0 ? 1 : 0), 0) / have.length,
    managers: have.length,
  };
}

/**
 * The activity term: players added per week and whether he has completed a
 * trade, against the league's own mean, as a relative change in the chance he
 * completes a trade (ACTIVITY_FIT), moved into score units so that
 * receptiveness moves by that relative change, capped at ACTIVITY_CAP.
 * Returns null when there is no activity data; a withheld entry (effect null,
 * with the reason) under ACTIVITY_MIN_WEEKS.
 */
// TEST SEAM: exported so scripts/rnd/grade-activity-receptiveness.mjs grades
// exactly this function on the corpus; its production reader is counterpartyLayer.
export function activityFactor(metrics, samples, mean) {
  const rate = metrics?.tx_adds_per_week;
  if (!Number.isFinite(rate) || !mean) return null;
  const weeks = samples?.tx_adds_per_week ?? 0;
  const traded = metrics.tx_completed_trades > 0 ? 1 : 0;
  const label = 'How active he is (chance he completes a trade)';
  const facts = `${rate.toFixed(2)} pickups a week over ${weeks} week${weeks === 1 ? '' : 's'} `
    + `(league ${mean.adds.toFixed(2)}), ${traded ? 'has' : 'has not'} completed a trade this season`;
  if (weeks < ACTIVITY_MIN_WEEKS) {
    return { source: 'trade_activity', label, effect: null, n: weeks, cap: ACTIVITY_CAP, fitted: true,
      why: `withheld until ${ACTIVITY_MIN_WEEKS} weeks of pickups: ${weeks} of ${ACTIVITY_MIN_WEEKS} weeks so far; ${facts}` };
  }
  const relative = (ACTIVITY_FIT.adds * (rate - mean.adds) + ACTIVITY_FIT.traded * (traded - mean.traded))
    / ACTIVITY_FIT.base;
  const effect = Math.max(-ACTIVITY_CAP, Math.min(ACTIVITY_CAP, relative * SCORE_PER_RELATIVE));
  return { source: 'trade_activity', label, effect: +effect.toFixed(4), n: weeks, cap: ACTIVITY_CAP, fitted: true,
    why: `${facts}; busy managers complete trades about 3x as often as idle ones (not the same as saying yes to you)` };
}

/**
 * "Checked out": last week he started someone who did not play. A flag, not a
 * scale — the corpus coefficient is for one or more dead starts. When the
 * signal layer could not tell (starters scored zero, but there is no snap data
 * for that week) the entry is withheld with that reason; when he had no dead
 * start, or there is no final lineup, there is nothing to report.
 */
// TEST SEAM: exported for the corpus grade script, like activityFactor.
export function checkedOutFactor(metrics, samples) {
  const label = 'Checked out (left a starter in who did not play)';
  const dead = metrics?.lineup_dead_starts_last_week;
  if (!Number.isFinite(dead)) {
    const zero = metrics?.lineup_zero_point_starters_last_week;
    return zero > 0 ? { source: 'checked_out', label, effect: null,
      n: samples?.lineup_zero_point_starters_last_week ?? 0, cap: null, fitted: true,
      why: `${zero} starter${zero === 1 ? '' : 's'} scored 0 last week; whether they played is unknown (no snap data for that week)` }
      : null;
  }
  if (dead < 1) return null;
  const effect = (ACTIVITY_FIT.dead_start / ACTIVITY_FIT.base) * SCORE_PER_RELATIVE;
  return { source: 'checked_out', label, effect: +effect.toFixed(4), n: samples?.lineup_dead_starts_last_week ?? 0,
    cap: null, fitted: true,
    why: `${dead} starter${dead === 1 ? '' : 's'} last week did not play; teams like that complete about 11% fewer trades` };
}

/**
 * How far open the post-loss window is, as a receptiveness nudge.
 *
 * Two pieces of evidence, and the stronger wins rather than both being added:
 * last week's margin (a fact about this week) and how often he reacts to losses
 * in chat (a habit, worth half as much because it is not about now).
 */
function postLossFactor(metrics, samples) {
  const cap = VALUATION_SOURCES.recency_post_loss.cap;
  const margin = metrics.last_week_margin;
  const lost = Number.isFinite(margin) && margin < 0
    ? Math.min(1, -margin / POST_LOSS_FULL_MARGIN) : 0;
  const habit = Number.isFinite(metrics.chat_reacting_to_loss)
    ? Math.min(1, metrics.chat_reacting_to_loss / POST_LOSS_CHAT_FULL) * 0.5 : 0;
  const strength = Math.max(lost, habit);
  if (strength <= 0) return null;
  const n = (Number.isFinite(margin) ? 1 : 0) + (Number.isFinite(metrics.chat_reacting_to_loss)
    ? (samples?.chat_reacting_to_loss ?? 0) : 0);
  return {
    source: 'recency_post_loss', label: VALUATION_SOURCES.recency_post_loss.label,
    effect: +(cap * strength).toFixed(4), n, cap, fitted: false,
    why: lost >= habit
      ? `lost last week by ${Math.abs(margin).toFixed(0)}`
      : `reacts to losses in ${(metrics.chat_reacting_to_loss * 100).toFixed(0)}% of his messages`,
  };
}

/**
 * Needs and surplus per roster, when the caller has not already computed them.
 *
 * `analyzeLeague` is the one needs/surplus source the trade engine uses
 * (`trade-engine.js#rosterContext` calls exactly this); the inventory found
 * three copies of this logic and this must not become a fourth. The caller
 * passes `rosterContext` when it already has one, so the live trade path pays
 * for it once rather than twice.
 */
function deriveRosterNeeds(leagueId) {
  const lg = rows('SELECT * FROM leagues WHERE id = ?', leagueId)[0];
  if (!lg?.payload) return null;
  try {
    return new Map(analyzeLeague(lg).teams.map(t => [String(t.roster_id), {
      needs: new Set(t.needs.map(n => n.position)),
      surplus: new Set(t.surplus.map(s => s.position)),
      window: t.window,
    }]));
  } catch {
    // Same payload findTrades already checked for; a league that cannot be
    // analysed simply has no positional read, which the map reports as absent.
    return null;
  }
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
// TEST SEAM: no production importer. `readDeal` calls it twice (:731-732), which
// is how it reaches the app; exported so the package-level clamp can be tested
// directly rather than through a whole deal.
export function perceivedValue(players, managerProfile, { zero = [] } = {}) {
  const total = players.reduce((s, p) => s + (p.value ?? 0), 0);
  if (total <= 0) return { value: total, multiplier: 1, reasons: [] };
  let adjusted = 0;
  const reasons = [];
  for (const p of players) {
    const v = playerValuation(managerProfile, p, { zero });
    adjusted += (p.value ?? 0) * v.multiplier;
    if (Math.abs(v.multiplier - 1) >= 0.02) {
      const view = managerProfile?.players?.get(String(p.name ?? '').toLowerCase());
      const read = managerProfile?.reads?.get(String(p.name ?? '').toLowerCase()) ?? null;
      reasons.push({
        player: p.name, sentiment: view?.sentiment ?? read?.sentiment,
        mentions: view?.n ?? read?.mentions, last_mention: view?.last,
        multiplier: v.multiplier,
        verdict: read?.verdict ?? null,
        // Every factor that moved him, so an explanation can name them instead
        // of quoting a bare multiplier nobody can check.
        factors: v.factors,
        reading: v.factors.map(f => f.why).join('; ')
          || read?.why || (view?.sentiment > 2.2 ? 'he rates him'
          : view?.sentiment < 1.8 ? 'he is down on him' : 'neutral'),
      });
    }
  }
  const raw = total > 0 ? adjusted / total : 1;
  const capped = Math.max(1 - PERCEPTION_CAP, Math.min(1 + PERCEPTION_CAP, raw));
  return { value: +(total * capped).toFixed(2), multiplier: +capped.toFixed(3), reasons };
}

/**
 * What ONE manager thinks ONE player is worth — the cell of the valuation map,
 * and the single place a per-player multiplier is decided.
 *
 * `perceivedValue` (and so `readDeal`, and so the trade engine) goes through
 * here, and so does `valuationMap`, which is what stops the deal read and the
 * manager view from disagreeing.
 *
 * **The same evidence is never charged twice.** Three rules do that work:
 *   1. `talk_vs_model` and `chat_sentiment` are alternatives, not additions —
 *      the crossed read wins wherever it exists, because raw sentiment has the
 *      wrong SIGN for the case that costs real money (a manager talking up a
 *      player he is quietly shopping).
 *   2. `outscoring_usage` fires ONLY where there is no talk read, because the
 *      expectation gap is already the discriminator inside that read.
 *   3. `praise_means` from the negotiation profile is not its own factor; it
 *      modifies the talk read it is evidence about (a manager the model says
 *      hypes before selling gets half the attachment premium).
 *
 * @param {object} managerProfile an entry from `counterpartyLayer`
 * @param {object} player `{ name, position, value }` — our number is `value`
 * @param {string[]} [opts.zero] sources to suppress, for the ablation
 */
export function playerValuation(managerProfile, player, { zero = [] } = {}) {
  const ourValue = Number(player?.value ?? 0) || 0;
  const key = String(player?.name ?? '').toLowerCase();
  const off = new Set(zero);
  const factors = [];
  const inert = [];
  const add = (source, effect, n, why, asOf = null) => {
    // `zero` comes first and suppresses the source ENTIRELY, inert entry
    // included: the ablation's arithmetic depends on a zeroed source leaving no
    // trace at all, and an inert entry is a trace.
    if (off.has(source)) return;
    if (!Number.isFinite(effect)) return;
    const spec = VALUATION_SOURCES[source];
    // min_n is checked BEFORE the smallness return below, not after. A reading
    // that rests on too small a sample is reported inert with its reason
    // whatever its size, because the sample is the fact a page needs and the
    // size is not: luck of +0.01 wins on one week is an effect of 0.00025, and
    // in the other order it disappeared along with the reason it was not
    // firing. A caller with no reading at all passes n = 0 and lands here too,
    // which is how "we have never measured this" gets a sentence.
    if (n < spec.min_n) {
      // `as_of` rides the inert entry too. "Not enough scored weeks yet" and "not
      // enough as of a build three days ago" are different answers, and only the
      // second tells a reader whether re-running the build would change it.
      inert.push({ source, reason: `rests on ${n} of the ${spec.min_n} needed (${spec.needs})`, as_of: asOf });
      return;
    }
    // Above its sample and still neutral: a real reading that moves no price.
    // Deliberately not reported — `inert` means "not enough evidence", and
    // filing a confident zero under it would make the word mean two things.
    // Named in docs/tdd/luck-read-not-firing.tdd.md as the remaining gap.
    if (Math.abs(effect) < 0.001) return;
    const capped = Math.max(-spec.cap, Math.min(spec.cap, effect));
    factors.push({ source, label: spec.label, effect: +capped.toFixed(4), n, cap: spec.cap,
      fitted: spec.fitted, why, as_of: asOf });
  };

  const owns = managerProfile?.owned?.has(key) ?? false;
  const view = managerProfile?.players?.get(key) ?? null;
  const read = managerProfile?.reads?.get(key) ?? null;
  const profile = managerProfile?.negotiation ?? null;

  // ---------------------------------------------- 1. what he says about him
  if (read) {
    // priceAdjustment already bounded this; `praise_means` only shrinks or
    // sharpens it, never turns it into a second charge.
    let effect = (read.multiplier ?? 1) - 1;
    let note = read.why;
    const hypes = profile?.praise_means?.hypes_before_selling === true
      || profile?.praise_means?.reading === 'marketing';
    if (hypes && read.verdict === 'attachment') {
      effect *= 0.5;
      note += '; his profile says he hypes before selling, so the premium is halved';
    } else if (hypes && read.verdict === 'sales_pitch') {
      effect *= 1.25;
      note += '; his profile says the same — praise before selling';
    }
    add('talk_vs_model', effect, read.mentions ?? 0, note);
  } else if (view) {
    add('chat_sentiment', (view.multiplier ?? 1) - 1, view.n ?? 0,
      view.sentiment > 2.2 ? `he rates him (${view.n} mentions, no model read to cross it with)`
        : view.sentiment < 1.8 ? `he is down on him (${view.n} mentions)` : 'talked about, neutrally');
  }

  // ------------------------------- 2. the whole-corpus read of his own roster
  if (profile?.roster_read) {
    const hit = profileListHit(profile.roster_read, key);
    if (hit) {
      const cap = VALUATION_SOURCES.profile_roster_read.cap;
      // The model states its own confidence, and on the real corpus it says
      // `low` for five of the ten people. Pricing a low-confidence read as hard
      // as a high-confidence one would be ignoring the one thing the model
      // actually knows about how sure it is.
      const conf = PROFILE_CONFIDENCE[profile.confidence] ?? PROFILE_CONFIDENCE.low;
      const direction = hit.list === 'really_untouchable' || hit.list === 'overvalues' ? 1
        : hit.list === 'undervalues' ? -1 : -0.5;
      add('profile_roster_read', cap * direction * conf, managerProfile.negotiation_n ?? 1,
        `his negotiation profile (${profile.confidence ?? 'unstated'} confidence) lists him under `
        + `${hit.list.replace(/_/g, ' ')}: "${hit.text}"`);
    }
  }

  // ------------------------- 3. his own player is outscoring what earns it
  if (owns && !read) {
    const gap = managerProfile?.gaps?.get(key) ?? null;
    if (gap) {
      const cap = VALUATION_SOURCES.outscoring_usage.cap;
      const strength = Math.max(-1, Math.min(1, gap.gap_per_game / HOT_GAP_PER_GAME));
      add('outscoring_usage', cap * strength, gap.games,
        `${gap.gap_per_game > 0 ? '+' : ''}${gap.gap_per_game}/game against what his usage earns `
        + `over ${gap.games} games — his own number for his own player. `
        + '(Actual vs expected points from usage; NOT the trade-price hype in services/hype.js#playerHype '
        + '(trade price minus value), which answers a different question.)');
    }
  }

  // --------------------------------------- 4. a record flattered by luck
  // The guard is `owns` alone. A missing luck reading used to short-circuit here
  // and leave nothing behind, so the map fell through to its own last branch and
  // told the page "the data exists but no player in this league matched it" —
  // false in both halves for a league whose archetype build has produced no luck
  // row, which is four of the five live leagues. Calling `add` with n = 0
  // instead routes it through the min_n branch above and serves the true reason.
  if (owns) {
    const cap = VALUATION_SOURCES.luck_self_view.cap;
    const luck = managerProfile?.luck ?? null;
    const strength = Math.max(-1, Math.min(1, (luck?.value ?? 0) / LUCK_FULL_WINS));
    // n = 0 always lands in the min_n branch, which writes its own reason, so
    // this string is only ever read for a reading that exists. It is still
    // written defensively rather than assuming that: min_n is data, and a day
    // when someone sets luck_self_view.min_n to 0 should not print "undefined
    // wins against expectation over undefined scored weeks" to a page.
    add('luck_self_view', cap * strength, luck?.n ?? 0,
      luck
        ? `${luck.value > 0 ? '+' : ''}${luck.value} wins against expectation `
          + `over ${luck.n} scored weeks — he prices this roster the way his record reads`
        : 'no scored weeks measured for him yet, so his record has not been read for luck',
      luck?.as_of ?? managerProfile?.archetypes?.as_of ?? null);
  }

  // ------------------------------------------- 5. a hole he could fill here
  if (!owns && player?.position && (managerProfile?.needs || managerProfile?.surplus)) {
    const rl19On = rl19NeedPricingOn();
    const cap = rl19On ? RL19_1_NEED_CAP : VALUATION_SOURCES.positional_need.cap;
    const n = managerProfile.roster_size ?? 0;
    // Set from the layer, array from the serialised map view — the same answer
    // either way, because a caller holding the view must not get a crash.
    const listed = (v, pos) => (v instanceof Set ? v.has(pos) : Array.isArray(v) && v.includes(pos));
    if (listed(managerProfile.needs, player.position)) {
      add('positional_need', cap, n, `he is short at ${player.position}`);
    } else if (!rl19On && listed(managerProfile.surplus, player.position)) {
      // RL-19-1: the "depth lowers it" branch is dropped under the preview —
      // r19's re-derivation found the sign unsupported (flips across the
      // 2021-22 / 2023-24 split). Off the flag, the incumbent -cap*0.5 stays.
      add('positional_need', -cap * 0.5, n, `he is already deep at ${player.position}`);
    }
  }

  // ----------------------- 6. he has said this one is not available, and ...
  const stance = managerProfile?.stance ?? null;
  // THE GATE IS THE RECORD ITSELF, not a flag beside it. `stance.credibility` is
  // null in every case where nothing about THIS manager's word was read: no
  // confirmed chat identity for him, a corpus that is not on this machine, or a
  // record that holds no resolved declaration of his. In all three
  // `untouchableStance` fell back to 1 - PRIOR_BLUFF_RATE and would otherwise
  // price the refusal up. Keying on the record rather than on a league-level flag
  // also catches the mixed league, where some rosters are confirmed and his is not.
  if (stance && (stance.respect?.has(key) || stance.probe?.has(key))
      && stance.credibility == null) {
    // Read but never measured. Reported inert with the reason rather than priced
    // on the prior: "he has never reversed a refusal" and "we have never seen his
    // refusals" are opposite facts, and only the first justifies charging for one.
    inert.push({ source: 'untouchable_credibility',
      reason: managerProfile?.declarations_reason
        ?? 'his declaration record holds nothing about him — no declaration of his has been seen resolve, '
           + 'so whether his word holds is unknown',
      as_of: null });
  } else if (stance && (stance.respect?.has(key) || stance.probe?.has(key))) {
    const cap = VALUATION_SOURCES.untouchable_credibility.cap;
    const credibility = stance.credibility?.credibility ?? 0.65;
    // Never negative: a bluffer's refusal is an opening price, which means it
    // should not RAISE the price — not that it should lower it below everyone
    // else's. Below 0.45 the stance carries him in neither set and no factor
    // fires at all.
    const strength = stance.respect?.has(key) ? credibility : credibility * 0.5;
    add('untouchable_credibility', cap * strength,
      stance.credibility?.declarations ?? ((stance.respect?.size ?? 0) + (stance.probe?.size ?? 0)),
      stance.respect?.has(key)
        ? `he has called him untouchable and his word has held (credibility ${credibility.toFixed(2)})`
        : `he has called him untouchable, but his word holds only ${(credibility * 100).toFixed(0)}% of the time`);
  }

  const raw = factors.reduce((mult, f) => mult * (1 + f.effect), 1);
  const capped = Math.max(1 - PLAYER_VALUATION_CAP, Math.min(1 + PLAYER_VALUATION_CAP, raw));
  return {
    player: player?.name ?? null, position: player?.position ?? null,
    our_value: ourValue, their_value: +(ourValue * capped).toFixed(2),
    multiplier: +capped.toFixed(4), capped: Math.abs(raw - capped) > 1e-9,
    owns, factors, inert,
  };
}

/** Is this name a real player in our own table? Memoised per process. */
const realPlayerCache = new Map();
function isRealPlayer(lowerName) {
  if (realPlayerCache.has(lowerName)) return realPlayerCache.get(lowerName);
  let hit = false;
  try { hit = rows('SELECT 1 AS x FROM players WHERE lower(name) = ? LIMIT 1', lowerName).length > 0; }
  catch { hit = false; }
  realPlayerCache.set(lowerName, hit);
  return hit;
}

/**
 * Does one of the negotiation profile's roster lists name this player?
 *
 * The lists are prose written by the model — "Ashton Jeanty (demands Achane +
 * Chase Brown-level return, calls him 'my goat')". Matching the whole string
 * would attribute Achane and Chase Brown to the same list, which is the exact
 * false positive that would make this source untrustworthy. So only the part
 * BEFORE the first bracket or em dash is searched: the model writes the subject
 * first and the reasoning after, on every entry in the corpus checked
 * 2026-09-18.
 */
function profileListHit(rosterRead, key) {
  if (!key) return null;
  const order = ['really_untouchable', 'overvalues', 'undervalues', 'quietly_available'];
  for (const list of order) {
    for (const entry of rosterRead[list] ?? []) {
      const subject = String(entry).split(/\s+—\s+|\s+-\s+|\(/)[0].toLowerCase();
      if (subject.includes(key)) return { list, text: String(entry).slice(0, 120) };
    }
  }
  return null;
}

/** The set-like fields on a layer profile, as a sorted array of names. */
const setNames = v => (v instanceof Set ? [...v] : Array.isArray(v) ? v : []).map(String).sort();

/** A player's name as the chat corpus keys it. */
const nameKey = p => String(p?.name ?? '').toLowerCase();

/**
 * The model's negotiation profile, cut down to the lines a card can show.
 *
 * The stored profile carries every technique with its evidence quotes, which is
 * the right shape for a page that reads one manager and far too much to repeat on
 * each of twenty-five deals. What survives is the read itself plus the three
 * one-word calibrations — what a reader needs before he writes the message.
 */
function compactNegotiation(profile) {
  if (profile == null || typeof profile !== 'object') return null;
  return {
    headline: profile.headline ?? null,
    how_to_approach: profile.how_to_approach ?? null,
    best_bait: profile.best_bait ?? null,
    confidence: profile.confidence ?? null,
    no_holds: profile.says_no?.does_his_no_hold ?? null,
    praise_means: profile.praise_means?.reading ?? null,
    inflation: profile.calibration?.inflation ?? null,
    what_moves_him: (profile.what_moves_him ?? []).slice(0, 2),
    what_shuts_him_down: (profile.what_shuts_him_down ?? []).slice(0, 2),
  };
}

/**
 * THE WIRE FORM of a counterparty-layer profile, for the players in one deal.
 *
 * `counterpartyLayer` builds each manager out of the structures that are cheapest
 * to price with: `players` and `reads` are Maps, and `owned`, `needs`, `surplus`
 * and `stance.respect` / `stance.probe` are Sets. None of those survives
 * `JSON.stringify` — a Map serialises as `{}` — so each one has to be flattened
 * before a page can show it, and the per-player chat reads that are the whole
 * point of the layer never crossed the wire at all.
 *
 * It converts on the way OUT and leaves the layer's own shapes alone on purpose:
 * `playerValuation` looks those Maps up by name thousands of times in a single
 * findTrades run, and turning them into arrays at the source would be a real cost
 * paid for a display concern.
 *
 * `players` and `reads` cover every player in the league this manager has been
 * recorded talking about, so they are narrowed to the players actually in this
 * deal — the only ones a trade card can show — rather than shipped whole. A
 * player he has never mentioned is ABSENT rather than present and empty, so "no
 * read" cannot be misread as "he is neutral on him".
 */
// TEST SEAM: no production importer (client/src/components/trade/types.ts:64 names
// it in a comment only). `readDeal` calls it at :743, which is how its output
// reaches the client; exported so the wire shape can be pinned on its own.
export function serializeManagerRead(managerProfile, dealPlayers = []) {
  const cp = managerProfile;
  if (cp == null || typeof cp !== 'object') return null;
  const respect = new Set(setNames(cp.stance?.respect));
  const probe = new Set(setNames(cp.stance?.probe));
  const reads = cp.reads instanceof Map ? cp.reads : new Map();
  const said = cp.players instanceof Map ? cp.players : new Map();
  const owned = cp.owned instanceof Set ? cp.owned : null;

  const seen = new Set();
  const playerReads = [];
  for (const p of dealPlayers ?? []) {
    const key = nameKey(p);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const talk = reads.get(key) ?? null;
    const raw = said.get(key) ?? null;
    if (!talk && !raw) continue;
    playerReads.push({
      player: talk?.player ?? p?.name ?? null,
      owns: owned ? owned.has(key) : null,
      mentions: talk?.mentions ?? raw?.n ?? null,
      sentiment: talk?.sentiment ?? raw?.sentiment ?? null,
      verdict: talk?.verdict ?? null,
      confidence: talk?.confidence ?? null,
      why: talk?.why ?? null,
      action: talk?.action ?? null,
      // His own word on this player, and whether his word has held. `respect`
      // never reaches a league-wide idea — the finder drops those players
      // outright — but a ladder asked for by name can carry one, so both are
      // reported rather than only the one this path happens to produce.
      declared: respect.has(key) ? 'held' : probe.has(key) ? 'not_held' : null,
    });
  }

  return {
    tier: cp.tier ?? null,
    chat_weight: cp.chat_weight ?? null,
    open_to_trade_pct: cp.open_to_trade_pct ?? null,
    trade_talk_pct: cp.trade_talk_pct ?? null,
    priors: cp.priors && Object.keys(cp.priors).length ? cp.priors : null,
    untouchable_rate: cp.untouchable_rate ?? null,
    // Sets, flattened. An empty array means "read, and he needs nothing there";
    // null means the league could not be analysed at all. The two are not the
    // same answer and must not arrive looking alike.
    needs: cp.needs == null ? null : setNames(cp.needs),
    surplus: cp.surplus == null ? null : setNames(cp.surplus),
    window: cp.window ?? null,
    roster_size: cp.roster_size ?? null,
    luck: cp.luck ?? null,
    negotiation: compactNegotiation(cp.negotiation),
    negotiation_n: cp.negotiation_n ?? 0,
    // Already plain objects; passed through so the receptiveness number on a card
    // can be taken apart into the sources that built it, with each sample size.
    receptiveness_factors: cp.receptiveness_factors ?? [],
    word_stance_note: cp.stance?.note ?? null,
    player_reads: playerReads,
  };
}

/**
 * The counterparty read on one proposed deal.
 *
 * `perception_delta` is the number that matters: how much better the package he
 * receives looks to him than the one he gives up, as a percentage of what he is
 * giving. Positive means it reads as a win from his side of the table — which
 * is the precondition for acceptance, independent of whether it is good for us.
 *
 * It is null when nothing we know about him moves the price of any player in
 * the deal. His "perception" is then just our own value gap, which the trade
 * engine already prices through its capped fairness term and its value cost;
 * returning it anyway let the ±10% perception factor pay a second time for
 * handing him value — for every manager with no chat read, which after the
 * all-league build is every manager in four of the five leagues.
 * `perception_shift` is the part his views add beyond our own gap, in the same
 * units: the tie-breaker the perception factor was written to be.
 */
export function readDeal({ theirGive, theirGet, managerProfile, zero = [] }) {
  // `zero` was built into playerValuation and perceivedValue for the per-source
  // ablation and stopped here, so a findTrades run with a source suppressed
  // still priced every DEAL with it. Measured 2026-09-18 on a copy of
  // production with manager signals built: zeroing all four chat sources moved
  // exactly 0 of 223 deal scores across the five leagues, because this call was
  // the last one still reading them. Threading it through is what makes the
  // ablation a measurement rather than a formality.
  const give = perceivedValue(theirGive, managerProfile, { zero });
  const get = perceivedValue(theirGet, managerProfile, { zero });
  const base = give.value || 1;
  const delta = (get.value - give.value) / base;
  const sum = list => list.reduce((s, p) => s + (p.value ?? 0), 0);
  const ourDelta = (sum(theirGet) - sum(theirGive)) / (sum(theirGive) || 1);
  const informed = give.reasons.length > 0 || get.reasons.length > 0;
  return {
    // The layer profile, flattened into JSON-safe values FIRST so the explicit
    // fields below always win. Without it the receptiveness on a card was a bare
    // number with nothing behind it, and every per-player chat read the layer had
    // already computed stopped at this function.
    ...serializeManagerRead(managerProfile, [...(theirGive ?? []), ...(theirGet ?? [])]),
    receptiveness: managerProfile?.receptiveness ?? 1,
    their_perceived_give: give.value, their_perceived_get: get.value,
    perception_informed: informed,
    perception_delta: informed ? +(delta * 100).toFixed(1) : null,
    perception_shift: informed ? +((delta - ourDelta) * 100).toFixed(1) : null,
    perception_reasons: [...give.reasons.map(r => ({ ...r, side: 'they_give' })),
      ...get.reasons.map(r => ({ ...r, side: 'they_get' }))],
    chat_msgs: managerProfile?.chat_msgs ?? 0,
    accept_rate: managerProfile?.accept_rate ?? null,
    // The sample the rate rests on. It was computed on the layer (`:210`) and
    // stopped here, so no caller could tell four decided offers from sixty —
    // which is the whole difference between a usable anchor and a coincidence.
    accept_rate_n: managerProfile?.accept_rate_n ?? 0,
    word_credibility: managerProfile?.stance?.credibility?.credibility ?? null,
    word_note: managerProfile?.stance?.note ?? null,
  };
}

/**
 * THE MAP — every manager in one league crossed with every player, priced their
 * way next to ours.
 *
 * This is a VIEW over `playerValuation`, not a second engine: the trade finder
 * reaches the same function through `readDeal`, so a number here and a number
 * on a trade card cannot disagree.
 *
 * `players` is the priced universe and must be supplied by the caller — the
 * trade engine already builds it (`assetUniverse`), and importing it here would
 * make a cycle. A call without it is refused rather than guessed at.
 *
 * `sources_used` is what actually priced something, not what might have; every
 * declared source that priced nothing appears in `sources_absent` with the
 * reason, so a page can never present a chat-free league's map as if it had the
 * same evidence behind it as league 4's.
 */
// NO CALLER ANYWHERE IN THE APP — not in server/, not in client/, not in
// scripts/. routes/trades.js:415 names it in a comment and nothing more. This is
// not a dead export like the seams above: it is the whole per-player transparency
// surface (sources_used, sources_absent with a reason each, and the per-source
// ablation) and it is the harness that produced this layer's only measured
// evidence, the AUC study in docs/tdd/valuation-map.tdd.md section 6. It is
// reachable from tests and from a study run, and from no page Nick can open.
// Routed as a WIRING finding, not deleted: deleting it would destroy the ablation
// that is the evidence for the layer being a read rather than a price.
export function valuationMap(leagueId, { season, week, players, layer = null,
  rosterContext = null, zero = [] } = {}) {
  const empty = reason => ({
    league_id: leagueId, season: season ?? null, week: week ?? null,
    available: false, reason, my_roster_id: null,
    sources_used: [], sources_absent: [], managers: new Map(),
  });
  if (!Array.isArray(players) || !players.length) {
    return empty('no priced player universe supplied — the caller passes the assets it has already built');
  }
  const cp = layer ?? counterpartyLayer(leagueId, { season, week, rosterContext });
  if (!cp.size) {
    return empty('no manager signals for this league yet — scripts/build-manager-signals.mjs has not built it');
  }

  const myRoster = rows('SELECT my_team_id FROM leagues WHERE id = ?', leagueId)[0]?.my_team_id ?? null;
  const hasChat = identityMap(leagueId).size > 0;
  const managers = new Map();
  const used = new Set();
  const inertReason = new Map();
  let anyNeeds = false;

  for (const [id, mp] of cp) {
    if (myRoster != null && String(id) === String(myRoster)) continue;
    if (mp.needs?.size || mp.surplus?.size) anyNeeds = true;
    for (const f of mp.receptiveness_factors ?? []) {
      if (VALUATION_SOURCES[f.source]) used.add(f.source);
    }
    const byPlayer = new Map();
    for (const p of players) {
      const v = playerValuation(mp, p, { zero });
      for (const f of v.factors) used.add(f.source);
      for (const i of v.inert) if (!inertReason.has(i.source)) inertReason.set(i.source, i.reason);
      byPlayer.set(String(p.name ?? '').toLowerCase(), v);
    }
    managers.set(String(id), {
      roster_id: String(id), receptiveness: mp.receptiveness, tier: mp.tier,
      receptiveness_factors: mp.receptiveness_factors ?? [],
      needs: mp.needs ? [...mp.needs] : null, surplus: mp.surplus ? [...mp.surplus] : null,
      window: mp.window, chat_msgs: mp.chat_msgs,
      accept_rate: mp.accept_rate, accept_rate_n: mp.accept_rate_n,
      word_stance: mp.stance?.stance ?? null, word_note: mp.stance?.note ?? null,
      has_negotiation_profile: !!mp.negotiation,
      players: byPlayer,
    });
  }

  const absent = [];
  for (const [key, spec] of Object.entries(VALUATION_SOURCES)) {
    if (used.has(key)) continue;
    if (!hasChat && spec.needs === 'league chat') {
      absent.push({ source: key, reason: 'no chat corpus for this league (no confirmed chat identities)' });
    } else if (inertReason.has(key)) {
      absent.push({ source: key, reason: inertReason.get(key) });
    } else if (key === 'positional_need' && !anyNeeds) {
      absent.push({ source: key, reason: 'no roster read for this league (analyzeLeague produced none)' });
    } else {
      absent.push({ source: key, reason: 'the data exists but no player in this league matched it' });
    }
  }

  return {
    league_id: leagueId, season: season ?? null, week: week ?? null,
    available: true, reason: null, my_roster_id: myRoster == null ? null : String(myRoster),
    sources_used: [...used].sort(), sources_absent: absent, managers,
  };
}

/**
 * HOW NICK LOOKS — the 'ME' side of the same map.
 *
 * Master plan 00 D4, tactic 9: "pacing by his recent offers to that person,
 * never lead with a player the whole league knows he is shopping (Achane)".
 * None of that is a judgement about Nick; it is the part of his own behaviour
 * the other nine people can see, and it is the input the Coach needs before it
 * writes an opener.
 *
 * Three things, each from a named source and never invented:
 *   - what he has sent each manager, and how they answered (ESPN transactions,
 *     EXECUTE rows only — the de-duplication manager-signals.js documented);
 *   - what the league knows he is shopping (his own chat talk about his own
 *     players, plus the `ME` negotiation profile's own list);
 *   - the veto votes cast against deals he was part of.
 */
export function selfRead(leagueId, { season = null } = {}) {
  const lg = rows('SELECT season, payload, my_team_id FROM leagues WHERE id = ?', leagueId)[0] ?? null;
  const me = lg?.my_team_id == null ? null : String(lg.my_team_id);
  const out = {
    league_id: leagueId, available: false, reason: null, my_roster_id: me,
    to_each_manager: new Map(), known_shopping: [], veto_votes_against: 0, veto_voters: [],
    profile: null, sources: [],
    // How old the history behind all of this is. Nick's own offer record is read
    // from the same table nothing on the deployed app writes, so a pacing line
    // ("you last asked him on the 14th") is only as current as the last manual
    // collection. Served on the unavailable path too — a `null` here with no date
    // reads as "he has never offered anybody anything".
    transactions: null,
  };
  const yr = season ?? lg.season ?? null;
  out.transactions = Object.freeze(transactionsCollected(leagueId, yr));
  if (me == null) return { ...out, reason: 'this league has no roster marked as Nick\'s' };

  let tx = [];
  try {
    tx = rows(`SELECT tx_id, type, execution_type, team_id, related_tx_id, proposed_at, items_json
               FROM league_transactions_raw WHERE league_id = ? AND season = ?`, leagueId, yr);
  } catch { tx = []; }

  const partiesOf = t => {
    let items = [];
    try { items = JSON.parse(t.items_json || '[]'); } catch { items = []; }
    return new Set(items.flatMap(i => [i.fromTeamId, i.toTeamId])
      .filter(x => x != null && Number(x) > 0).map(String));
  };
  const proposals = tx.filter(t => t.type === 'TRADE_PROPOSAL' && t.execution_type === 'EXECUTE');
  const mine = proposals.filter(t => String(t.team_id) === me);
  const iAmParty = new Set(proposals.filter(t => String(t.team_id) === me || partiesOf(t).has(me))
    .map(t => t.tx_id));
  const answer = new Map();
  for (const t of tx) {
    if (t.execution_type !== 'EXECUTE' || !t.related_tx_id) continue;
    if (t.type === 'TRADE_ACCEPT') answer.set(t.related_tx_id, 'accepted');
    else if (t.type === 'TRADE_DECLINE') answer.set(t.related_tx_id, 'declined');
  }

  for (const p of mine) {
    for (const other of partiesOf(p)) {
      if (other === me) continue;
      const row = out.to_each_manager.get(other)
        ?? { roster_id: other, offers_sent: 0, accepted: 0, declined: 0, pending: 0,
          last_offer_at: null, source: 'tx' };
      row.offers_sent++;
      const a = answer.get(p.tx_id);
      if (a === 'accepted') row.accepted++; else if (a === 'declined') row.declined++; else row.pending++;
      if (!row.last_offer_at || String(p.proposed_at) > row.last_offer_at) row.last_offer_at = p.proposed_at;
      out.to_each_manager.set(other, row);
    }
  }

  const vetoes = tx.filter(t => t.type === 'TRADE_VETO' && iAmParty.has(t.related_tx_id));
  out.veto_votes_against = vetoes.length;
  out.veto_voters = vetoes.map(v => ({ roster_id: String(v.team_id), tx_id: v.related_tx_id }));

  // What the league can see him shopping. Only his OWN players, only where he
  // has said enough for it to be a pattern, and the model read of the whole
  // corpus counted alongside it rather than instead of it.
  const owned = rosterOwnership(leagueId);
  const profiles = negotiationProfilesFor(leagueId);
  out.profile = profiles.self ?? null;
  const shopping = new Map();
  for (const v of rows(`SELECT player_name, sentiment, n, last_mention FROM manager_player_view
                        WHERE league_id = ? AND roster_id = ? AND n >= 3`, leagueId, me)) {
    const key = v.player_name.toLowerCase();
    if (owned && owned.get(key) !== me) continue;
    if (!(v.sentiment <= 2.0)) continue;
    shopping.set(key, { player: v.player_name, source: 'chat', n: v.n,
      why: `he has talked him down ${v.n} times in the league chat (last ${v.last_mention})`,
      last_mention: v.last_mention });
  }
  const selfRoster = profiles.self?.profile?.roster_read ?? null;
  for (const list of ['quietly_available', 'undervalues']) {
    for (const entry of selfRoster?.[list] ?? []) {
      const subject = String(entry).split(/\s+—\s+|\s+-\s+|\(/)[0].trim();
      const key = subject.toLowerCase();
      if (!key) continue;
      // The lists are prose, and some entries are not players at all — the real
      // `ME` profile lists "Olave-adjacent throw-ins when he had him". An entry
      // that does not resolve to a real player is dropped rather than shown to
      // Nick as someone the league knows he is shopping. Ownership is NOT
      // required: he can be known for shopping a player he has since moved.
      if (!isRealPlayer(key)) continue;
      const already = shopping.get(key);
      if (already) {
        already.source = 'chat+profile';
        already.why += `; his own profile lists him under ${list.replace(/_/g, ' ')}`;
      } else {
        shopping.set(key, { player: subject, source: 'profile',
          n: profiles.self?.messages_read ?? 0,
          why: `the model read of his own messages lists him under ${list.replace(/_/g, ' ')}: "${String(entry).slice(0, 120)}"` });
      }
    }
  }
  out.known_shopping = [...shopping.values()].sort((a, b) => (b.n ?? 0) - (a.n ?? 0));

  if (tx.length) out.sources.push('tx');
  if (out.known_shopping.some(s => s.source !== 'profile')) out.sources.push('chat');
  if (profiles.self) out.sources.push('profile');
  out.available = out.sources.length > 0;
  if (!out.available) {
    out.reason = 'nothing the league can see: no captured transactions for this league and no chat corpus';
  }
  return out;
}

// untouchablesFor lived here until 2026-09-18. It had no caller: declared
// untouchables are decided by bluff-detector.js#untouchableStance, which reads
// the same rows and also weighs whether the manager's word has held.

/**
 * Signature of every counterparty input for one league, for a cache
 * fingerprint (the findTrades cache left these out, so a rebuild served stale
 * rankings). Stable across an idle rebuild — the builders only write when
 * something changed — and different after any real change: signals and player
 * views (one stamp, see buildManagerSignals), identities, hand-set tiers, and
 * for a chat league the chat data and the negotiation profiles.
 */
export function counterpartyDataKey(leagueId) {
  const part = (table, stamp) => {
    try {
      const r = rows(`SELECT COUNT(*) AS n, MAX(${stamp}) AS m FROM ${table} WHERE league_id = ?`, leagueId)[0];
      return `${r?.n ?? 0}:${r?.m ?? ''}`;
    } catch { return 'absent'; }
  };
  let chat = 'none';
  if (identityMap(leagueId).size) {
    const c = openChatDb();
    if (!c) chat = 'absent';
    else {
      try {
        let np = 'absent';
        try {
          const r = c.prepare('SELECT COUNT(*) AS n, MAX(built_at) AS m FROM negotiation_profiles').get();
          np = `${r.n}:${r.m ?? ''}`;
        } catch { np = 'absent'; }
        chat = `${chatDataKey(c)}|np:${np}`;
      } finally { c.close(); }
    }
  }
  return `ms:${part('manager_signals', 'computed_at')}|id:${part('league_member_identity', 'updated_at')}`
    + `|mp:${part('manager_profiles', 'updated_at')}|chat:${chat}`;
}

// The schema (v2), the enum parsing and Nick's read live in
// people/profile-reader.js — the one place that says what a stored read means.
// TEST SEAM: no production importer. `negotiationProfilesFor` below validates
// through the reader itself; this stays exported so the schema can be tested
// against a bad profile without writing one into a database.
export function negotiationProfileErrors(profile) {
  return readProfile(profile).errors;
}

/**
 * The counterparty view of people.profile (people/profile-reader.js is the one
 * reader of negotiation_profiles in the private chat DB, written by
 * scripts/build-negotiation-profiles.mjs with Sonnet 5; this file never parses
 * a stored profile itself).
 *
 * Returns, for one league:
 *   byRoster  roster_id -> { name, profile, built_at, messages_read, model, corpus_hash, unparsed, nick }
 *             for every VALID profile whose person is a trusted identity here.
 *             `profile` is normalised (people/profile-reader.js#readProfile):
 *             enum slots hold the enum, `<slot>_text` the stored sentence;
 *             `unparsed` lists slots whose sentence matched no enum word.
 *             No quiet gate here (quietBelow 0): pricing weighs a thin profile
 *             by its own messages_read.
 *   nickByRoster roster_id -> Nick's block (people/profile-reader.js#nickBlock)
 *             for every trusted non-Nick identity that has one. THE rule: the
 *             profile's nick_override, then manager_notes whose source starts
 *             'nick-chat-' (a JSON note is read as keys, any other note is kept
 *             as text, never read for meaning); override beats a note.
 *   notes_reason  why manager_notes contributed nothing, else null
 *   self      'ME' — Nick as the league-4 chat experiences him. Never a
 *             counterparty; it answers "how do I look to them".
 *   invalid   [{ name, errors }] — mapped rows that fail schema v2; not used
 *   unmapped  stored profiles with no trusted identity in this league
 *
 * A league with no trusted chat identity returns available=false: the profiles
 * are read from one chat, and attaching them to namesakes elsewhere would be
 * worse than having none.
 */
// TEST SEAM: no production importer. Two readers in this file (`counterpartyLayer`
// at :152 and `selfRead` at :926), which is how it reaches the app.
export function negotiationProfilesFor(leagueId) {
  const result = (available, reason = null) => ({
    league_id: leagueId, available, reason, byRoster: new Map(), self: null, invalid: [], unmapped: [],
    nickByRoster: new Map(), notes_reason: null,
  });
  const ids = identityMap(leagueId);
  if (!ids.size) return result(false, 'no chat corpus for this league (no confirmed chat identities)');
  const chat = openChatDb();
  if (!chat) return result(false, 'chat DB not found');
  const myTeam = rows('SELECT my_team_id FROM leagues WHERE id = ?', leagueId)[0]?.my_team_id ?? null;
  let people;
  try {
    people = peopleProfileFromChat(chat, { leagueId, ids, myTeam, quietBelow: 0 });
  } finally { chat.close(); }
  if (!people.available) {
    return result(false, /negotiation_profiles/.test(people.reason ?? '')
      ? 'no negotiation_profiles table (scripts/build-negotiation-profiles.mjs has not run)' : people.reason);
  }

  const out = result(true);
  out.notes_reason = people.notes_reason ?? null;
  const view = e => ({ name: e.name, profile: e.profile, built_at: e.built_at, messages_read: e.messages_read,
    model: e.model, corpus_hash: e.corpus_hash, unparsed: e.unparsed });
  const s = people.self;
  if (s?.errors.length) out.invalid.push({ name: s.name, errors: s.errors });
  else if (s?.profile && s.name === 'ME') {
    out.self = { ...view(s), roster_id: s.roster_id ?? (myTeam == null ? null : String(myTeam)),
      scope: 'how the league chat sees Nick' };
  } else if (s?.profile) out.unmapped.push(s.name); // another name on Nick's roster: never a counterparty
  for (const [rid, e] of people.byRoster) {
    if (e.errors.length) out.invalid.push({ name: e.name, errors: e.errors });
    if (e.nick) out.nickByRoster.set(rid, e.nick);
    if (e.profile) out.byRoster.set(rid, { ...view(e), roster_id: rid, nick: e.nick });
  }
  out.unmapped.push(...people.unmapped);
  return out;
}
