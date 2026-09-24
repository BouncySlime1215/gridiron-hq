/**
 * TACTICS — the nine rules that turn the valuation map into a trade you would
 * actually send, and the one test that decides whether an idea is allowed to
 * exist at all.
 *
 * Nick, 2026-09-18 03:50: "Trades are designed by the people they are being
 * sent to while finding an edge… if someone loves a player then abuse that,
 * vice versa… sneak a guy in… all the moves and mind games, then how to
 * approach the negotiation based on our data and our intelligence read on this
 * person."
 *
 * The valuation map (counterparty-pricing.js#playerValuation) already answers
 * "what does HE think this player is worth". That is a number. This module
 * answers the next question — "so what do I do about it" — and it does it as
 * RULES, not as a model:
 *
 *   - every tactic names the players it fired on, our number, his number, and
 *     the factor that made them differ, with that factor's own sample size;
 *   - every threshold in TACTIC_THRESHOLDS is hand-set and says `fitted: false`,
 *     for the same reason the valuation map's caps are: 30 decided proposals in
 *     2026, 6 of them accepted, is not enough to fit anything (master plan D4,
 *     "too few decided proposals … so it is a band");
 *   - a tactic whose evidence is missing is reported ABSENT WITH ITS REASON,
 *     never silently dropped, so a card can say why a signal is not firing.
 *
 * THE EDGE TEST is the part that is not negotiable. Master plan 00 D4: "every
 * idea must be positive for Nick on OUR numbers — this-week and rest-of-season
 * lineup gain, horizon-weighted — while scoring well on THEIR numbers. An idea
 * that only wins on their perception is a gift, not a trade." `edgeTest` below
 * is that sentence in code, and `trade-engine.js` refuses to surface an idea
 * that fails it. Its fourth check is the one that was being violated on live
 * data before this item: the counterparty read may REORDER ideas, it may never
 * PROMOTE one that is not already positive for Nick.
 *
 * This module holds no state and opens no chat DB. The per-player valuation is
 * INJECTED (`valuationOf`) rather than imported, so a tactic and a trade card
 * can never be reading two different numbers for the same player.
 */
import { rows } from '../db/index.js';
// One accessor for "when were these rows collected", shared with the manager
// read and counterparty-pricing. Three hand-rolled MAX() queries is how three
// surfaces come to print three different dates for one collection.
import { transactionsCollected } from './manager-signals.js';
import { previewUnconfirmed } from './preview-mode.js';

/**
 * Whether the store this file reads exists at all.
 *
 * `league_transactions_raw` has NO migration: it is created by hand in
 * `scripts/collect-league-transactions.mjs`, which needs an ESPN cookie, so on
 * any machine where that has not been run the table is simply not there. This is
 * the same guard `manager-signals.js:167` already uses, and it replaces two bare
 * `catch { tx = []; }` blocks that turned "the collector has never run here" into
 * "this manager has no history" — a sentence about a person, produced by a
 * missing table. CLAUDE.md's rule is the general form: if a layer goes inert, the
 * surface must say so.
 */
const tableExists = name =>
  rows(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, name).length > 0;

const TX_ABSENT_REASON =
  'league_transactions_raw has never been created on this machine, so no transaction history has '
  + 'been collected — run scripts/collect-league-transactions.mjs (it needs an ESPN cookie). This '
  + 'is a missing collection, NOT a manager with no history.';

/**
 * Every hand-set number in this file, in one place, so a reviewer can see the
 * whole hand at once. NONE of these is fitted; they are sizes chosen to make a
 * rule fire on a real pattern and not on noise, and each one is named at the
 * place it is used.
 */
export const TACTIC_THRESHOLDS = Object.freeze({
  /** Smallest gap between his number and ours that counts as a read at all. */
  min_lift: 0.03,
  /** A throw-in is at most this share of the incoming package's market value. */
  sneak_share: 0.35,
  /** …and has to return at least this much more production per unit of price. */
  sneak_rate_edge: 1.25,
  /** Games of expected-points history before the outscoring-usage tactic may fire. */
  hype_min_games: 2,
  /** Points per game above what his usage earns, before "hot" means anything. */
  hype_min_gap: 3.0,
  /** Sentiment on Jev's 0-4 scale at which he has visibly talked a player up. */
  praise: 2.3,
  /** Decided offers before a response-time read is reported at all. */
  timing_min_decisions: 3,
  /** Timestamped actions before an active-hours read is reported. */
  timing_min_actions: 10,
  /** Hours after he declines during which sending again reads as pestering. */
  recent_decline_hours: 48,
  /** Share of the league's own observed vetoed skew at which a package is watched. */
  veto_watch_share: 0.6,
  /** How much a need-driven tactic is discounted when tactics are ranked. */
  positional_need_discount: 0.5,
});

/** The valuation-map sources that are a READ OF A PERSON rather than of a roster. */
const CHAT_SOURCES = new Set(['talk_vs_model', 'chat_sentiment', 'profile_roster_read',
  'untouchable_credibility']);
/** The blunt one. It fires on tens of thousands of cells per league at a near-uniform
 *  +-8%, so it is excluded from every "biggest gap" ranking (valuation-map handoff, T2). */
const NEED_SOURCE = 'positional_need';
/**
 * RL-19-1: same default-off switch as counterparty-pricing.js's — r19 found
 * need predicts WHICH position a manager trades for, not what he pays for it
 * (rnd/loop/r19-external-need-steers-who-not-price.md). Off by default, this
 * tactic keeps its incumbent "pays about N of market value" framing; on, it
 * reads as targeting, not price.
 */
const RL19_1_ENV = 'GRIDIRON_RL19_1_ENABLED';
const rl19NeedPricingOn = () =>
  process.env[RL19_1_ENV] === '1' || previewUnconfirmed();

/**
 * The nine tactics Nick named, plus the probe flag the untouchable rule needs.
 *
 * `needs` is the evidence the rule cannot work without, and it is what the
 * absent-reason is written from. `fitted: false` is on every one of them
 * because every one of them is a hand-set rule over numbers that already exist.
 */
export const TACTICS = Object.freeze({
  sell_the_crush: { label: 'Sell the crush', fitted: false,
    needs: 'a chat read or negotiation profile for this manager',
    why: 'he prices a player of ours above our own number, so that player is the centrepiece' },
  buy_the_sour: { label: 'Buy the sour', fitted: false,
    needs: 'a chat read or negotiation profile for this manager',
    why: 'he marks one of his own players down below our number, so he is cheap to buy' },
  sneak_in: { label: 'Sneak him in', fitted: false,
    needs: 'our rest-of-season rate and his price for the same player',
    why: 'a throw-in he treats as filler that our own numbers rate well above his price' },
  consolidate_for_need: { label: 'Consolidate into his hole', fitted: false,
    needs: 'a roster read for the league',
    why: 'two of our depth pieces into a position he is short at, back as one starter' },
  outscoring_usage: { label: "Sell while he's outscoring his usage", fitted: false,
    needs: 'at least two games of expected points, and praise from him',
    why: 'our player is outscoring the usage that earns it, and the man who praised him will pay for it' },
  timing: { label: 'Send it when he answers', fitted: false,
    needs: 'captured league transactions for this league',
    why: 'his own decision history says when he answers, and when sending again reads as pestering' },
  anchor_ladder: { label: 'Ask, fair, floor', fitted: false,
    needs: 'more than one priced package with this manager',
    why: 'open above what you will take, and know the point past which the deal stops being worth it' },
  veto_proof: { label: 'Survive the league vote', fitted: false,
    needs: "this league's own ESPN trade settings",
    why: 'the partner saying yes is not the last step; the other owners get a vote' },
  how_nick_looks: { label: 'How you look to him', fitted: false,
    needs: "Nick's own offer history, or the ME negotiation profile",
    why: 'what he can already see — how often you ask, who the league knows you are shopping' },
  probe_declared: { label: 'He said no, and his no does not hold', fitted: false,
    needs: 'a declared untouchable whose word has been walked back',
    why: 'asking anyway is right when his refusals have not held, and it is worth saying so out loud' },
});

/* ------------------------------------------------------------------ helpers */

/**
 * A timestamp as milliseconds, whatever shape it was written in.
 *
 * NOT a string compare, and this is not a style preference. `proposed_at` is
 * ISO-with-Z from ESPN, while anything written by SQLite's `datetime('now')` is
 * "YYYY-MM-DD HH:MM:SS" with no zone — and ' ' (0x20) sorts BEFORE 'T' (0x54),
 * so `ts < cutoff` silently pulls a same-day space-formatted row in ahead of an
 * ISO one whatever the clock says. The previous step's verifier measured that
 * leak on the real corpus (230 space-formatted rows written since 2026-09-17).
 * A bare timestamp is read as UTC, which is what SQLite writes.
 */
export function toTime(value) {
  if (value == null) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  const t = String(value).trim();
  if (!t) return null;
  const dateLike = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(t);
  const zoned = /([zZ]|[+-]\d{2}:?\d{2})$/.test(t);
  const normalised = dateLike ? `${t.replace(' ', 'T')}${zoned ? '' : 'Z'}` : t;
  const ms = Date.parse(normalised);
  return Number.isFinite(ms) ? ms : null;
}

/** A UTC hour of day (0-23, from getUTCHours) shown as Nick's clock time on the given day ("7 AM"). */
export function easternHour(utcHour, nowMs = Date.now()) {
  const d = new Date(nowMs); d.setUTCHours(utcHour, 0, 0, 0);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric' }).format(d);
}

const HOUR = 3600 * 1000;
const num = v => (Number.isFinite(v) ? v : null);
const sumValue = list => (list ?? []).reduce((s, p) => s + (Number(p?.value) || 0), 0);
const lower = s => String(s ?? '').toLowerCase();
const headlineOf = list => (list ?? []).slice().sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0] ?? null;
const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
function parsePayload(lg) {
  if (!lg?.payload) return null;
  try { return typeof lg.payload === 'string' ? JSON.parse(lg.payload) : lg.payload; } catch { return null; }
}

/* ------------------------------------------------------------- THE EDGE TEST */

/**
 * THE EDGE TEST — non-negotiable, and the only thing in this file that removes
 * an idea rather than describing one.
 *
 * Master plan 00 D4: "every idea must be positive for Nick on OUR numbers —
 * this-week and rest-of-season lineup gain, horizon-weighted — while scoring
 * well on THEIR numbers. An idea that only wins on their perception is a gift,
 * not a trade."
 *
 * Four checks, all of them on OUR numbers:
 *
 *   this_week            the starting lineup this Sunday gets better
 *   horizon              this week AND the playoff weeks, weighted by how much
 *                        of the season is left and how likely this roster is to
 *                        still be playing then (trade-horizon.js)
 *   after_value_cost     still positive once the market value we hand over is
 *                        charged (VALUE_GIVEAWAY_LAMBDA)
 *   not_only_perception  the SAME score with the counterparty read taken out
 *
 * The fourth one is the one that was being violated. Measured on a copy of
 * production before this was written: league 3's "Tyler Warren for Patrick
 * Mahomes" scored -0.046 without the counterparty read and +0.013 with it, and
 * surfaced — an idea that only won because the other manager was short at the
 * position. League 4 surfaced one idea with a NEGATIVE horizon gain and two
 * with a negative signed score. Perception is a tie-breaker between ideas that
 * are already good for Nick. It is never the reason one exists.
 *
 * A negative PLAYOFF leg on its own is not a failure: a win-now trade that is
 * worth more in weeks 2-14 than it costs in 15-17 is a real trade, and the
 * horizon weighting is the number the plan names. It is flagged on the card
 * instead.
 */
export function edgeTest({ ppgDelta, horizonGain, scoreSigned, scoreUnperceived } = {}) {
  const checks = [
    { name: 'this_week', value: num(ppgDelta),
      why: "this week's starting lineup has to get better on our own projection" },
    { name: 'horizon', value: num(horizonGain),
      why: 'this week and the playoff weeks together, weighted by how much of the season is left' },
    { name: 'after_value_cost', value: num(scoreSigned),
      why: 'still worth doing once the market value we hand over is charged for' },
    { name: 'not_only_perception', value: num(scoreUnperceived),
      why: 'the same score with the counterparty read taken out — his perception may reorder '
        + 'ideas, never promote one that loses on our numbers' },
  ].map(c => ({ ...c, threshold: 0, ok: Number.isFinite(c.value) && c.value > 0 }));
  return { passes: checks.every(c => c.ok), failed: checks.filter(c => !c.ok).map(c => c.name), checks };
}

/* ------------------------------------------------------------------- TIMING */

/**
 * When each manager actually answers, from his own behaviour.
 *
 * Three things, each gated on its own sample and each saying so when it is not
 * there:
 *   - how fast he decides an offer (TRADE_PROPOSAL -> TRADE_ACCEPT/DECLINE,
 *     joined on `related_tx_id`);
 *   - the hours of day he does anything at all in the league (every timestamped
 *     transaction, which is a much bigger sample than trade decisions alone);
 *   - when he last declined one of NICK's offers, which is the "wait" rule.
 *
 * `now` makes the read cutoff-safe: nothing after it is read. Timestamps are
 * compared as parsed dates (see `toTime`).
 */
export function timingRead(leagueId, { season = null, now = null } = {}) {
  const cutoff = toTime(now) ?? Infinity;
  const lg = rows('SELECT season, payload, my_team_id FROM leagues WHERE id = ?', leagueId)[0] ?? null;
  const me = lg?.my_team_id == null ? null : String(lg.my_team_id);
  const yr = season ?? lg?.season ?? null;
  // The absence is read BEFORE the query rather than caught after it, so the one
  // state this function may continue past is the only one it absorbs. A bare
  // catch here also swallowed every programming error in the query below and
  // reported it as an empty history.
  const txPresent = tableExists('league_transactions_raw');
  const collected = Object.freeze(transactionsCollected(leagueId, yr));
  // A table that exists but will not read (a drifted shape from the hand-run
  // collector) is the accessor's 'unreadable', not a thrown query: the accessor
  // has already probed it, and the one vocabulary is how two surfaces agree.
  const txUnreadable = txPresent && collected.read_state === 'unreadable';
  const tx = txPresent && !txUnreadable
    ? rows(`SELECT tx_id, type, execution_type, team_id, related_tx_id, proposed_at
            FROM league_transactions_raw WHERE league_id = ? AND (? IS NULL OR season = ?)`,
    leagueId, yr, yr)
    : [];

  const timed = tx.map(t => ({ ...t, at: toTime(t.proposed_at) }))
    .filter(t => t.at != null && t.at <= cutoff);
  const byId = new Map(timed.map(t => [t.tx_id, t]));
  // What counts as "him being in the app". NOT the draft: every manager's
  // picks land inside one league-wide sitting, so including them made all ten
  // managers in a league share the same busiest hour — which was the hour of
  // the draft, reported as a personal habit. Measured 2026-09-18: with DRAFT
  // rows in, leagues 1 and 5 gave every roster the same busiest hour from 16-21
  // actions, of which 16 were draft picks. NOT league PROCESS rows either
  // (waivers clear on the league's clock, not his).
  const ownAction = t => t.type !== 'DRAFT' && t.execution_type !== 'PROCESS';

  const out = new Map();
  const blank = id => ({
    roster_id: String(id), decisions_n: 0, median_hours: null,
    fastest_hours: null, slowest_hours: null, actions_n: 0, active_hours: null,
    // WHEN THE STORE IS ABSENT THESE SAY SO. They used to be null on a machine
    // with no collector run, which reads identically to "we looked and he has
    // never decided anything" — a claim about a person, made from a missing
    // table. Both reason fields carry it, because a consumer may read either.
    decisions_reason: !txPresent ? TX_ABSENT_REASON : txUnreadable ? collected.reason : null,
    read_state: !txPresent ? 'source_table_absent' : txUnreadable ? 'unreadable' : 'present',
    active_hours_reason: !txPresent ? TX_ABSENT_REASON : txUnreadable ? collected.reason : null,
    busiest_hour: null, last_decline_at: null,
    // When Nick last ASKED this person for something is already on
    // counterparty-pricing#selfRead (`to_each_manager[].last_offer_at`), which
    // is the one place that reads the offer items. Not duplicated here.
    source: 'league_transactions_raw', fitted: false,
    // WHEN THESE ROWS WERE COLLECTED, not when they were read. `now` bounds what
    // is read; this is when the rows arrived, and the deployed app never collects
    // any (fly.toml declares no `processes`; the only writer runs off-server by
    // hand). A manager with no decisions gets the date too: "we have not looked
    // since Thursday" and "he has done nothing" are different answers.
    transactions: collected,
  });
  // Every roster in the league, so "we have nothing on him" is a stated answer
  // rather than a missing key.
  for (const team of parsePayload(lg)?.teams ?? []) out.set(String(team.id), blank(team.id));

  const latencies = new Map();
  const actions = new Map();
  for (const t of timed) {
    if (t.team_id == null || Number(t.team_id) <= 0) continue;
    const rid = String(t.team_id);
    if (!out.has(rid)) out.set(rid, blank(rid));
    if (ownAction(t)) actions.set(rid, [...(actions.get(rid) ?? []), t.at]);

    if (t.execution_type !== 'EXECUTE' || !t.related_tx_id) continue;
    if (t.type !== 'TRADE_ACCEPT' && t.type !== 'TRADE_DECLINE') continue;
    const offer = byId.get(t.related_tx_id);
    if (!offer || offer.type !== 'TRADE_PROPOSAL' || offer.at == null) continue;
    const hours = (t.at - offer.at) / HOUR;
    if (!(hours >= 0)) continue;
    latencies.set(rid, [...(latencies.get(rid) ?? []), +hours.toFixed(2)]);
    const entry = out.get(rid);
    if (t.type === 'TRADE_DECLINE' && me != null && String(offer.team_id) === me
      && (entry.last_decline_at == null || t.at > toTime(entry.last_decline_at))) {
      entry.last_decline_at = t.proposed_at;
    }
  }

  const { timing_min_decisions: MIN_D, timing_min_actions: MIN_A } = TACTIC_THRESHOLDS;
  for (const [rid, entry] of out) {
    const lat = latencies.get(rid) ?? [];
    entry.decisions_n = lat.length;
    if (lat.length >= MIN_D) {
      entry.median_hours = +median(lat).toFixed(2);
      entry.fastest_hours = Math.min(...lat);
      entry.slowest_hours = Math.max(...lat);
    } else if (txPresent && !txUnreadable) {
      // ONLY WHEN THE STORE WAS ACTUALLY READ. This sentence says "we counted his
      // decided offers and there were not enough", which is a claim about the
      // manager. On a machine where the table does not exist nothing was counted,
      // and writing it here overwrote the absence that `blank()` had correctly
      // recorded — re-manufacturing the exact false claim the guard removed, one
      // loop later. A min_n sentence is only honest about a sample that was taken.
      entry.decisions_reason = `rests on ${lat.length} of the ${MIN_D} decided offers needed `
        + 'before a response time means anything';
    }
    const acts = actions.get(rid) ?? [];
    entry.actions_n = acts.length;
    if (acts.length >= MIN_A) {
      const hist = new Array(24).fill(0);
      for (const ms of acts) hist[new Date(ms).getUTCHours()]++;
      const busiest = hist.indexOf(Math.max(...hist));
      entry.active_hours = hist.map((n, h) => ({ hour_utc: h, n })).filter(h => h.n > 0);
      entry.busiest_hour = busiest;
    } else if (txPresent && !txUnreadable) {
      // ONLY WHEN THE STORE WAS ACTUALLY READ, for the same reason as the
      // decisions sentence above: this claims a sample was taken and came back
      // short, and on a machine with no collector run no sample was taken.
      entry.active_hours_reason = `rests on ${acts.length} of the ${MIN_A} moves he made on his own `
        + `clock needed before an active-hours window means anything (draft picks and league waiver `
        + `processing do not count)`;
    }
  }
  return out;
}

/**
 * Send it now, or wait until when — and why, in his own behaviour.
 *
 * One rule outranks the rest: he declined recently. Sending again inside the
 * window is the single most expensive thing Nick does in this league (his own
 * ME profile: "floods DMs with rapid-fire lowball and multi-target offers"), so
 * it is checked first and it is the one that can say "wait".
 */
export function sendWindow(timing, { now = null, postLoss = null } = {}) {
  const nowMs = toTime(now) ?? Date.now();
  const n = timing?.decisions_n ?? 0;
  if (!timing) {
    return { when: 'now', until: null, n: 0, fitted: false,
      why: 'nothing captured about when this manager answers, so there is no reason to wait' };
  }
  const declined = toTime(timing.last_decline_at);
  const wait = TACTIC_THRESHOLDS.recent_decline_hours;
  if (declined != null && nowMs - declined < wait * HOUR) {
    const ago = Math.max(0, Math.round((nowMs - declined) / HOUR));
    return { when: 'wait', until: new Date(declined + wait * HOUR).toISOString(), n, fitted: false,
      why: `he declined your last offer ${ago} hour${ago === 1 ? '' : 's'} ago — inside ${wait} hours `
        + 'another one reads as pestering, not as a new idea' };
  }
  const parts = [];
  if (Number.isFinite(timing.median_hours)) {
    parts.push(`he decides in about ${timing.median_hours} hour${timing.median_hours === 1 ? '' : 's'} `
      + `(${n} decided offers)`);
  } else if (timing.decisions_reason) {
    parts.push(timing.decisions_reason);
  }
  if (Number.isFinite(timing.busiest_hour)) {
    parts.push(`he is most often in the app around ${easternHour(timing.busiest_hour, nowMs)} ET `
      + `(${timing.actions_n} actions)`);
  }
  if (postLoss) parts.push(postLoss.why);
  return { when: 'now', until: null, n, fitted: false,
    why: parts.length ? parts.join('; ') : 'nothing in his history argues for waiting' };
}

/* --------------------------------------------------------------- VETO-PROOF */

/**
 * What it would take for the league to kill a deal here, and what it has
 * already killed.
 *
 * The threshold is NOT a constant: every league carries its own
 * `vetoVotesRequired` in its ESPN settings, and Nick's five leagues are 3, 6,
 * 2, 5 and 4. League 3 needs two of the other six owners; league 2 needs six of
 * eight. That difference changes what a package is allowed to look like, and it
 * is free — it is already synced.
 *
 * The observed side is one package. League 4, 2026-09-17: Nick to a league
 * mate, McConkey + Achane out for Etienne + Nico Collins back, 4 votes of the
 * 5 needed. `n` is printed everywhere that package is used as a reference,
 * because one is not a model.
 */
export function vetoClimate(lg, { season = null, priceOfPlayer = null } = {}) {
  const payload = parsePayload(lg);
  const teamCount = payload?.teams?.length ?? lg?.team_count ?? 0;
  const climate = {
    league_id: lg?.id ?? null,
    votes_required: payload?.settings?.tradeSettings?.vetoVotesRequired ?? null,
    // The owners who get a vote on a deal between me and one partner.
    other_owners: Math.max(0, teamCount - 2),
    team_count: teamCount, n: 0, priceable_n: 0, reference_n: 0, observed_max_votes: 0, observed: [],
    reference: null, reference_skew_pct: null, fitted: false,
    source: 'ESPN league settings + league_transactions_raw',
    transactions: null,
  };
  const yr = season ?? lg?.season ?? null;
  // Set BEFORE the `!tx.length` early return below. That return is exactly where
  // a league with nothing collected looked identical to a league with no veto
  // history, and those are opposite facts.
  climate.transactions = Object.freeze(transactionsCollected(lg?.id ?? null, yr));
  if (!tableExists('league_transactions_raw')) {
    // Same fix as above: the veto climate's `n: 0` and empty `observed` were
    // indistinguishable from a league where nobody has ever vetoed anything.
    return { ...climate, read_state: 'source_table_absent', reason: TX_ABSENT_REASON };
  }
  if (climate.transactions.read_state === 'unreadable') {
    return { ...climate, read_state: 'unreadable', reason: climate.transactions.reason };
  }
  const tx = rows(`SELECT tx_id, type, execution_type, team_id, related_tx_id, proposed_at, items_json
                   FROM league_transactions_raw WHERE league_id = ? AND (? IS NULL OR season = ?)`,
  lg?.id, yr, yr);
  if (!tx.length) return { ...climate, read_state: 'present', reason: null };

  const proposals = new Map(tx.filter(t => t.type === 'TRADE_PROPOSAL').map(t => [t.tx_id, t]));
  const votes = new Map();
  for (const t of tx) {
    if (t.type !== 'TRADE_VETO' || t.execution_type !== 'EXECUTE' || !t.related_tx_id) continue;
    votes.set(t.related_tx_id, (votes.get(t.related_tx_id) ?? 0) + 1);
  }
  for (const [txId, count] of votes) {
    const offer = proposals.get(txId) ?? null;
    let skew = null;
    if (offer && priceOfPlayer) {
      let items = [];
      try { items = JSON.parse(offer.items_json || '[]'); } catch { items = []; }
      const from = String(offer.team_id);
      let out = 0, back = 0;
      for (const i of items) {
        const v = priceOfPlayer(i.playerId);
        if (!Number.isFinite(v)) continue;
        if (String(i.fromTeamId) === from) out += v; else back += v;
      }
      // The engine's own unit: how much more market value the proposer sends
      // than he gets, as a percentage of what comes back (evaluate#their_value_pct).
      if (back > 0) skew = +(((out - back) / back) * 100).toFixed(1);
    }
    climate.observed.push({ tx_id: txId, votes: count, proposed_by: offer?.team_id ?? null,
      proposed_at: offer?.proposed_at ?? null, skew_pct: skew });
  }
  climate.observed.sort((a, b) => b.votes - a.votes);
  climate.n = climate.observed.length;
  // `priceable_n` is how many vetoed packages have a proposal row we can price
  // at all; `reference_n` is how many stand behind `reference_skew_pct`, which
  // is ALWAYS exactly one (the highest-voted priceable package, picked below).
  // League 4 vetoed 4 packages, 2 are priceable, and 1 supplies the 18% — the
  // sentence Nick reads used to credit all four with it (GATE G6: "the
  // reference … with n = 1 printed").
  climate.priceable_n = climate.observed.filter(o => Number.isFinite(o.skew_pct)).length;
  climate.observed_max_votes = climate.observed[0]?.votes ?? 0;
  const withSkew = climate.observed.find(o => Number.isFinite(o.skew_pct));
  if (withSkew) {
    climate.reference = withSkew;
    climate.reference_skew_pct = Math.abs(withSkew.skew_pct);
    climate.reference_n = 1;
  }
  else if (climate.observed.length) climate.reference = climate.observed[0];
  // read_state on EVERY path, not two of three. The absent and empty paths set it
  // and this one did not, so a consumer checking `read_state === 'present'` got
  // undefined on the one path where the data is actually there — a field that is
  // missing only when everything is fine is worse than no field at all. Found by
  // writing the absence test below, not by the sweep.
  return { ...climate, read_state: 'present', reason: null };
}

/** Where one package sits against what this league has already voted against. */
export function vetoRiskFor(climate, { theirValuePct = null, giveValue = null, getValue = null } = {}) {
  const skew = Number.isFinite(theirValuePct) ? Math.abs(theirValuePct)
    : (Number.isFinite(giveValue) && Number(getValue) > 0
      ? Math.abs(((giveValue - getValue) / getValue) * 100) : null);
  const votesRequired = climate?.votes_required ?? null;
  const owners = climate?.other_owners ?? null;
  // A league can set a threshold no quorum could reach (ESPN lets it). Say so
  // rather than printing "5 of the 4 other owners".
  const unreachable = Number.isFinite(votesRequired) && Number.isFinite(owners) && votesRequired > owners;
  const needed = votesRequired == null ? 'an unknown number of votes'
    : unreachable
      ? `${votesRequired} votes, which the ${owners} other owners cannot reach — a veto is impossible here`
      : `${votesRequired} of the ${owners} other owners`;
  // The packages that actually supply the reference skew, which is not the same
  // number as the packages that drew a veto vote (see vetoClimate#reference_n).
  const refN = Number.isFinite(climate?.reference_n) ? climate.reference_n
    : (Number.isFinite(climate?.reference_skew_pct) ? 1 : 0);
  const priceableN = Number.isFinite(climate?.priceable_n) ? climate.priceable_n : refN;
  const base = { votes_required: votesRequired, other_owners: owners, skew_pct: skew,
    veto_reachable: !unreachable, n: climate?.n ?? 0, reference_n: refN, priceable_n: priceableN,
    reference_skew_pct: climate?.reference_skew_pct ?? null, fitted: false };
  if (!climate?.n || !Number.isFinite(climate?.reference_skew_pct)) {
    return { ...base, level: 'unknown',
      why: `this league has never voted against a package, so there is nothing to price this one `
        + `against — killing it would take ${needed}` };
  }
  const ref = climate.reference_skew_pct;
  const watch = ref * TACTIC_THRESHOLDS.veto_watch_share;
  const level = !Number.isFinite(skew) ? 'unknown' : skew >= ref ? 'high' : skew >= watch ? 'watch' : 'low';
  const sample = refN === climate.n
    ? `the ${climate.n} package${climate.n === 1 ? '' : 's'} this league has voted on`
    : `the ${refN} of ${climate.n} vetoed packages this number comes from`;
  const why = level === 'high'
    ? `this sends ${skew.toFixed(0)}% more market value than it gets back, at or past the ${ref.toFixed(0)}% `
      + `of ${sample} (${climate.observed_max_votes} votes drawn; ${needed} to kill it)`
    : level === 'watch'
      ? `${skew.toFixed(0)}% skew against a ${ref.toFixed(0)}% reference from ${sample} — worth a sentence `
        + 'in the group chat before it lands'
      : level === 'low'
        ? `${skew.toFixed(0)}% skew, well inside the ${ref.toFixed(0)}% of ${sample}`
        : `no value skew to price, against ${sample}`;
  return { ...base, level, why };
}

/* ------------------------------------------------------------ ANCHOR LADDER */

/**
 * Ask / fair / floor over the packages the engine already priced for this
 * partner and this target.
 *
 * Deliberately NOT three probabilities. Master plan D4 says P(accept) is "a
 * band from the heuristic … with the observed accept rate as the anchor,
 * labelled as a band", and fitting one on 6 accepts would be inventing
 * precision. So the rungs are defined by what is true, not by a number we
 * cannot calibrate:
 *
 *   ask    the least we can send — the opening anchor
 *   fair   the package closest to EVEN on HIS numbers (perception_delta ~ 0),
 *          which is the acceptance-relevant quantity readDeal computes
 *   floor  the most we will send that is still positive for Nick
 *
 * Every rung has already passed the edge test before it gets here, which is
 * what "and still positive for Nick" means in the brief.
 */
export function anchorLadder(variants, { acceptRate = null, acceptRateN = 0 } = {}) {
  const rungs = (variants ?? []).filter(v => (v?.score_signed ?? 0) > 0)
    // What a rung COSTS is what we hand over minus what comes back, not the
    // gross give. Ranked on the gross give, a 2-for-2 that also returns a
    // throw-in looked like a far dearer offer than the 1-for-1 beside it, and
    // the ladder printed "ask 3,669, floor 10,184" for the same target.
    .map(v => ({ ...v, net_cost: (v.give_value ?? 0) - (v.get_value ?? sumValue(v.i_get)) }));
  if (rungs.length < 2) return null;
  const byGive = [...rungs].sort((a, b) => a.net_cost - b.net_cost);
  const ask = byGive[0];
  const floor = byGive[byGive.length - 1];
  const evenness = v => (Number.isFinite(v.perception_delta) ? Math.abs(v.perception_delta)
    : Number.isFinite(v.their_value_pct) ? Math.abs(v.their_value_pct) : Infinity);
  const fair = [...byGive].sort((a, b) => evenness(a) - evenness(b)
    || a.net_cost - b.net_cost)[0] ?? byGive[Math.floor(byGive.length / 2)];
  return {
    ask, fair, floor, rungs: byGive.length,
    anchor: {
      accept_rate: acceptRate, n: acceptRateN, calibrated: false, fitted: false,
      why: acceptRate == null
        ? 'no decided offers with this manager yet, so there is no accept rate to anchor on'
        : `${Math.round(acceptRate * 100)}% of ${acceptRateN} decided offers have been accepted — `
          + 'that is the anchor, not a calibrated probability for these three packages',
    },
  };
}

/* ---------------------------------------------------------- HOW NICK LOOKS */

/**
 * The levers the other nine people can pull on Nick, from the `ME` negotiation
 * profile's own `what_moves_him`.
 *
 * Attribution is strict: an entry belongs to a manager only when the entry
 * NAMES him. The real corpus does this — "Raj repeatedly used 'U need wins now
 * it hurts u to keep him' and it visibly worked" — and an entry that names
 * nobody stays league-wide rather than being pinned on whoever is being pitched.
 */
export function selfPressurePoints(self, { managerName = null, aliases = [], otherNames = [] } = {}) {
  const profile = self?.profile?.profile ?? null;
  const out = { attributed: [], league_wide: [], shuts_down: [], has_profile: !!profile };
  if (!profile) return out;
  const names = [managerName, ...aliases].filter(Boolean).map(lower);
  const others = otherNames.filter(Boolean).map(lower).filter(n => !names.includes(n));
  for (const entry of profile.what_moves_him ?? []) {
    const text = String(entry);
    const t = lower(text);
    const mine = names.some(n => n && t.includes(n));
    const theirs = others.some(n => t.includes(n));
    const row = { why: text.slice(0, 220), source: 'ME negotiation profile (what moves him)',
      fitted: false, attributed_to: mine ? managerName : null };
    if (mine) out.attributed.push(row);
    else if (!theirs) out.league_wide.push(row);
  }
  out.shuts_down = (profile.what_shuts_him_down ?? []).map(e => ({ why: String(e).slice(0, 220),
    source: 'ME negotiation profile (what shuts him down)', fitted: false }));
  return out;
}

/* ----------------------------------------------------------- THE RULES */

/** The factor a tactic is allowed to cite: a read of the PERSON, not of a roster. */
function chatFactor(valuation) {
  const fs = (valuation?.factors ?? []).filter(f => CHAT_SOURCES.has(f.source));
  if (!fs.length) return null;
  return fs.slice().sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect))[0];
}
const needFactor = v => (v?.factors ?? []).find(f => f.source === NEED_SOURCE) ?? null;
/** Production per 1,000 of market price, on OUR numbers. */
const ourRate = p => {
  const rate = Number(p?.ros_ppg ?? p?.adj_ppg ?? 0) || 0;
  const price = Math.max(0.25, (Number(p?.value) || 0) / 1000);
  return rate / price;
};
const pct = x => +((x - 1) * 100).toFixed(1);

/**
 * Every tactic that fires on ONE deal, with the numbers behind it — and every
 * tactic that does not, with the reason.
 *
 * `valuationOf` is injected: the trade engine hands in the same
 * `playerValuation` the valuation map and the trade card use, so a tactic can
 * never quote a different number for the same player than the card it sits on.
 */
export function tacticsForDeal({
  give = [], get = [], manager = null, valuationOf = null, self = null, timing = null,
  climate = null, partnerId = null, partnerName = null, theirValuePct = null,
  variants = null, now = null, otherManagerNames = [], postLoss = null, positionRate = null,
} = {}) {
  const price = typeof valuationOf === 'function' ? valuationOf : () => null;
  const vGive = give.map(p => ({ p, v: price(p) ?? {} }));
  const vGet = get.map(p => ({ p, v: price(p) ?? {} }));
  const tactics = [];
  const absent = [];
  const seenAbsent = new Set();
  const note = (keyName, reason) => {
    if (seenAbsent.has(keyName)) return;
    seenAbsent.add(keyName);
    absent.push({ key: keyName, reason });
  };
  const cell = (p, v, factor) => ({
    player: p.name, position: p.position ?? null,
    our_value: Math.round(Number(v.our_value ?? p.value ?? 0)),
    their_value: Math.round(Number(v.their_value ?? p.value ?? 0)),
    gap_pct: pct(Number(v.multiplier ?? 1)),
    factor: factor ? { source: factor.source, effect: factor.effect, n: factor.n, cap: factor.cap,
      fitted: factor.fitted === true, why: factor.why } : null,
  });
  const anyChatEvidence = [...vGive, ...vGet].some(x => chatFactor(x.v));
  const noChat = `this manager has no chat read or negotiation profile touching any player in this `
    + 'deal, so nothing prices his own view of them';
  const MIN = TACTIC_THRESHOLDS.min_lift;

  // ------------------------------------------------- 1. sell the crush
  const headGive = headlineOf(give);
  const crush = vGive.map(x => ({ ...x, f: chatFactor(x.v) }))
    .filter(x => x.f && x.f.effect > 0 && (x.v.multiplier ?? 1) - 1 >= MIN);
  if (crush.length) {
    const players = crush.map(x => ({ ...cell(x.p, x.v, x.f),
      centrepiece: headGive != null && x.p.name === headGive.name }));
    const lift = crush.reduce((s, x) => s + ((x.v.multiplier ?? 1) - 1), 0);
    tactics.push({ key: 'sell_the_crush', label: TACTICS.sell_the_crush.label, fitted: false,
      effect: +lift.toFixed(4), effect_net: +lift.toFixed(4),
      n: Math.min(...crush.map(x => x.f.n ?? 0)), players,
      numbers: { extra_value_to_him: Math.round(crush.reduce((s, x) =>
        s + ((x.v.their_value ?? 0) - (x.v.our_value ?? 0)), 0)) },
      why: crush.map(x => `${x.p.name}: he prices him at ${Math.round(x.v.their_value)} against our `
        + `${Math.round(x.v.our_value)} (${pct(x.v.multiplier) > 0 ? '+' : ''}${pct(x.v.multiplier)}%) — `
        + `${x.f.why}`).join('; ') });
  } else note('sell_the_crush', anyChatEvidence
    ? 'nothing he has said prices a player we are sending above our own number' : noChat);

  // -------------------------------------------------- 2. buy the sour
  const sour = vGet.map(x => ({ ...x, f: chatFactor(x.v) }))
    .filter(x => x.v.owns && x.f && x.f.effect < 0 && 1 - (x.v.multiplier ?? 1) >= MIN);
  if (sour.length) {
    const players = sour.map(x => cell(x.p, x.v, x.f));
    const lift = sour.reduce((s, x) => s + (1 - (x.v.multiplier ?? 1)), 0);
    tactics.push({ key: 'buy_the_sour', label: TACTICS.buy_the_sour.label, fitted: false,
      effect: +lift.toFixed(4), effect_net: +lift.toFixed(4),
      n: Math.min(...sour.map(x => x.f.n ?? 0)), players,
      numbers: { discount_he_takes: Math.round(sour.reduce((s, x) =>
        s + ((x.v.our_value ?? 0) - (x.v.their_value ?? 0)), 0)) },
      why: sour.map(x => `${x.p.name}: he prices his own player at ${Math.round(x.v.their_value)} against `
        + `our ${Math.round(x.v.our_value)} (${pct(x.v.multiplier)}%) — ${x.f.why}`).join('; ') });
  } else note('buy_the_sour', anyChatEvidence
    ? 'he has not marked down any player we are asking for' : noChat);

  // ------------------------------------------------------ 3. sneak-in
  //
  // "We rate him highly" is measured AGAINST HIS OWN POSITION, not against the
  // headline piece. Points per unit of market price is not comparable across
  // positions in a one-QB league: a starting QB scores like a WR1 and costs a
  // quarter as much, so comparing him to the running back he is riding along
  // with made every quarterback in the league a sneak-in. Measured 2026-09-18
  // before this was fixed: the rule fired on 18 of 60 league-3 ideas and 17 of
  // 32 in league 5, led by Jalen Hurts at "7.6 against 2.6 for Derrick Henry".
  const headGet = headlineOf(get);
  const getTotal = sumValue(get);
  const baseRate = p => positionRate?.get?.(p?.position) ?? null;
  const sneaks = vGet.filter(({ p, v }) => {
    if (!headGet || p.name === headGet.name || !getTotal) return false;
    if ((v.multiplier ?? 1) > 1 + 0.005) return false;               // he prices him UP: not filler
    if ((Number(p.value) || 0) / getTotal > TACTIC_THRESHOLDS.sneak_share) return false;
    const base = baseRate(p);
    return Number.isFinite(base) && base > 0
      && ourRate(p) >= TACTIC_THRESHOLDS.sneak_rate_edge * base;
  });
  if (sneaks.length) {
    tactics.push({ key: 'sneak_in', label: TACTICS.sneak_in.label, fitted: false,
      effect: +sneaks.reduce((s, x) => s
        + (ourRate(x.p) / Math.max(baseRate(x.p) ?? 1, 0.01) - 1) * 0.05, 0).toFixed(4),
      effect_net: null, n: sneaks.length,
      players: sneaks.map(({ p, v }) => ({ ...cell(p, v, chatFactor(v)),
        our_rate_per_1k: +ourRate(p).toFixed(2),
        position_median_rate_per_1k: +(baseRate(p) ?? 0).toFixed(2) })),
      numbers: { share_of_package: +(sumValue(sneaks.map(x => x.p)) / getTotal).toFixed(2) },
      why: sneaks.map(({ p }) => `${p.name} is ${Math.round((Number(p.value) || 0) / getTotal * 100)}% of `
        + `what we are getting and he does not price him up at all, but on our numbers he returns `
        + `${ourRate(p).toFixed(1)} points a game per 1,000 of price against a `
        + `${(baseRate(p) ?? 0).toFixed(1)} median for ${p.position}s in this league`).join('; ') });
  } else {
    note('sneak_in', get.length < 2
      ? 'a one-player return has no throw-in to sneak in'
      : !positionRate
        ? 'no positional price-per-point baseline for this league, so "cheap for what he returns" '
          + 'cannot be measured'
        : 'no incoming throw-in both reads as filler to him and beats the median price-per-point at '
          + 'his own position by enough to be worth naming');
  }

  // ------------------------------------------- 4. consolidate for need
  const needPieces = vGive.map(x => ({ ...x, f: needFactor(x.v) })).filter(x => x.f && x.f.effect > 0);
  if (give.length >= 2 && get.length === 1 && needPieces.length) {
    const premium = needPieces.reduce((s, x) => s + (x.v.our_value ?? 0) * x.f.effect, 0);
    const pieceList = needPieces.map(x => `${x.p.name} (${x.f.why})`).join(', ');
    // RL-19-1: off the flag this still reads as a price premium (the incumbent
    // claim). On it, r19 found need predicts WHICH position a manager trades
    // for, not what he pays for it (90% CI upper bound 2.8% of value on
    // cross-position deals, rnd/loop/r19-external-need-steers-who-not-price.md)
    // — so the sentence becomes a framing/targeting note, not a price claim.
    const why = rl19NeedPricingOn()
      ? `two of our pieces into a hole: ${pieceList}, back as one starter — he is short at these `
        + `positions, so a package shaped like this is more likely to land with him (framing, not a `
        + `price: a hole predicts which position he trades for, not what he pays for it)`
      : `two of our pieces into a hole: ${pieceList}, back as one starter — his need pays about `
        + `${Math.round(premium)} of market value over ours`;
    tactics.push({ key: 'consolidate_for_need', label: TACTICS.consolidate_for_need.label, fitted: false,
      effect: +needPieces.reduce((s, x) => s + x.f.effect, 0).toFixed(4),
      // Ranked at zero on purpose: the whole hit IS positional need, which fires
      // on tens of thousands of cells a league and would otherwise top every list.
      effect_net: 0,
      n: Math.min(...needPieces.map(x => x.f.n ?? 0)),
      players: needPieces.map(x => cell(x.p, x.v, x.f)),
      numbers: { need_premium_value: Math.round(premium), pieces: needPieces.length },
      why });
  } else {
    note('consolidate_for_need', give.length < 2 || get.length !== 1
      ? 'not a two-for-one, so there is nothing to consolidate'
      : 'he is not short at any position we are sending into');
  }

  // ------------------------------------------------- 5. outscoring his usage
  const hypeGames = TACTIC_THRESHOLDS.hype_min_games;
  const hypeHits = [];
  let hypeReason = null;
  for (const { p, v } of vGive) {
    const gap = manager?.gaps?.get(lower(p.name)) ?? null;
    if (!gap) continue;
    if ((gap.games ?? 0) < hypeGames) {
      hypeReason = `rests on ${gap.games ?? 0} of the ${hypeGames} games of expected points needed `
        + 'before "outscoring his usage" means anything';
      continue;
    }
    if ((gap.gap_per_game ?? 0) < TACTIC_THRESHOLDS.hype_min_gap) continue;
    const view = manager?.players?.get(lower(p.name)) ?? null;
    const praised = (view?.sentiment ?? 0) >= TACTIC_THRESHOLDS.praise || (chatFactor(v)?.effect ?? 0) > 0;
    if (!praised) continue;
    hypeHits.push({ p, v, gap, view });
  }
  if (hypeHits.length) {
    tactics.push({ key: 'outscoring_usage', label: TACTICS.outscoring_usage.label, fitted: false,
      effect: +hypeHits.reduce((s, h) => s + h.gap.gap_per_game / 100, 0).toFixed(4),
      effect_net: null, n: Math.min(...hypeHits.map(h => h.gap.games)),
      players: hypeHits.map(h => ({ ...cell(h.p, h.v, chatFactor(h.v)),
        gap_per_game: h.gap.gap_per_game, games: h.gap.games, his_mentions: h.view?.n ?? 0 })),
      numbers: { gap_per_game: hypeHits[0].gap.gap_per_game },
      why: hypeHits.map(h => `${h.p.name} is +${h.gap.gap_per_game}/game above what his usage earns over `
        + `${h.gap.games} games, and ${partnerName ?? 'he'} has talked him up`).join('; ')
        + '. (Actual vs expected points from usage — NOT the trade-price hype in services/hype.js#playerHype '
        + '(trade price minus value), which answers a different question.)' });
  } else {
    note('outscoring_usage', hypeReason
      ?? 'no player we are sending is both outscoring his usage and one this manager has praised');
  }

  // ------------------------------------------------------- 6. timing
  if (timing) {
    const send = sendWindow(timing, { now, postLoss });
    tactics.push({ key: 'timing', label: TACTICS.timing.label, fitted: false,
      effect: 0, effect_net: 0, n: timing.decisions_n ?? 0, players: [],
      numbers: { when: send.when, until: send.until, median_hours: timing.median_hours,
        fastest_hours: timing.fastest_hours, busiest_hour_utc: timing.busiest_hour,
        last_decline_at: timing.last_decline_at, decisions_n: timing.decisions_n,
        actions_n: timing.actions_n },
      why: send.why });
  } else note('timing', 'no captured transactions for this league, so there is nothing that says when '
    + 'this manager answers');

  // ------------------------------------------------- 7. the anchor ladder
  const ladder = anchorLadder(variants, { acceptRate: manager?.accept_rate ?? null,
    acceptRateN: manager?.accept_rate_n ?? 0 });
  if (ladder) {
    const money = r => Math.round(r.net_cost ?? 0);
    const rung = r => ({ net_cost: money(r), give: (r.i_give ?? []).map(p => p.name),
      get: (r.i_get ?? []).map(p => p.name), his_view_pct: r.perception_delta ?? null });
    tactics.push({ key: 'anchor_ladder', label: TACTICS.anchor_ladder.label, fitted: false,
      effect: 0, effect_net: 0, n: ladder.rungs, players: [],
      numbers: { ask: rung(ladder.ask), fair: rung(ladder.fair), floor: rung(ladder.floor),
        basis: 'market value handed over minus market value coming back', anchor: ladder.anchor },
      why: `open by sending ${ladder.ask.i_give.map(p => p.name).join(' + ')} (net `
        + `${money(ladder.ask)} of market value), settle around `
        + `${ladder.fair.i_give.map(p => p.name).join(' + ')} (net ${money(ladder.fair)}) where it is `
        + `closest to even on HIS numbers, and stop at `
        + `${ladder.floor.i_give.map(p => p.name).join(' + ')} (net ${money(ladder.floor)}) — every rung `
        + `above has already passed the edge test, so the floor is the most you can pay and still win. `
        + `${ladder.anchor.why}` });
  } else note('anchor_ladder', 'only one package with this manager survived the edge test, so there is '
    + 'no ladder to climb');

  // ---------------------------------------------------- 8. veto-proof
  if (climate?.votes_required != null) {
    const risk = vetoRiskFor(climate, { theirValuePct,
      giveValue: sumValue(give), getValue: sumValue(get) });
    tactics.push({ key: 'veto_proof', label: TACTICS.veto_proof.label, fitted: false,
      effect: 0, effect_net: 0, n: climate.n, players: [],
      numbers: { level: risk.level, votes_required: risk.votes_required, other_owners: risk.other_owners,
        skew_pct: risk.skew_pct, reference_skew_pct: risk.reference_skew_pct,
        observed_max_votes: climate.observed_max_votes },
      why: risk.why });
  } else note('veto_proof', "this league's ESPN settings do not carry a veto threshold, so there is "
    + 'nothing to price league-perceived fairness against');

  // ------------------------------------------------- 9. how Nick looks
  const pacing = self?.to_each_manager?.get?.(String(partnerId)) ?? null;
  const shopped = new Map((self?.known_shopping ?? []).map(s => [lower(s.player), s]));
  const leadIsShopped = headGive && shopped.get(lower(headGive.name));
  const alternative = leadIsShopped
    ? give.filter(p => p.name !== headGive.name && !shopped.has(lower(p.name)))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0] ?? null
    : null;
  const pressure = selfPressurePoints(self, { managerName: partnerName, otherNames: otherManagerNames });
  if (pacing || leadIsShopped || pressure.attributed.length) {
    const bits = [];
    if (pacing) {
      bits.push(`you have sent him ${pacing.offers_sent} offer${pacing.offers_sent === 1 ? '' : 's'} this `
        + `season (${pacing.accepted} taken, ${pacing.declined} turned down, ${pacing.pending} still open)`);
    }
    if (leadIsShopped) {
      bits.push(`do not lead with ${headGive.name} — ${leadIsShopped.why}`
        + (alternative ? `; lead with ${alternative.name} instead` : ''));
    }
    for (const a of pressure.attributed) bits.push(`he knows this works on you: ${a.why}`);
    tactics.push({ key: 'how_nick_looks', label: TACTICS.how_nick_looks.label, fitted: false,
      effect: 0, effect_net: 0, n: pacing?.offers_sent ?? pressure.attributed.length, players: [],
      numbers: { offers_sent: pacing?.offers_sent ?? 0, accepted: pacing?.accepted ?? 0,
        declined: pacing?.declined ?? 0, pending: pacing?.pending ?? 0,
        last_offer_at: pacing?.last_offer_at ?? null,
        avoid_leading_with: leadIsShopped ? headGive.name : null,
        lead_with: alternative?.name ?? null,
        pressure_points: pressure.attributed, shuts_him_down: pressure.shuts_down },
      why: bits.join('. ') });
  } else {
    note('how_nick_looks', self?.available === false
      ? (self.reason ?? 'nothing the league can see about how Nick trades here')
      : 'you have never made this manager an offer, and the league has nothing on you here');
  }

  // ------------------------------- the untouchable he does not mean
  const probe = get.filter(p => manager?.stance?.probe?.has?.(lower(p.name)));
  if (probe.length) {
    const credibility = manager?.stance?.credibility?.credibility ?? null;
    const declarations = manager?.stance?.credibility?.declarations ?? probe.length;
    tactics.push({ key: 'probe_declared', label: TACTICS.probe_declared.label, fitted: false,
      effect: 0, effect_net: 0, n: declarations, players: probe.map(p => ({ player: p.name })),
      numbers: { credibility, declarations },
      why: `he has called ${probe.map(p => p.name).join(' and ')} untouchable, but his word holds only `
        + `${credibility == null ? 'sometimes' : `${Math.round(credibility * 100)}% of the time`} across `
        + `${declarations} declaration${declarations === 1 ? '' : 's'} — worth asking, expecting a first no` });
  }

  return { tactics: rankTactics(tactics), tactics_absent: absent };
}

/**
 * Order tactics by what they are worth, NET OF POSITIONAL NEED.
 *
 * The valuation map's handoff to this step named the reason: `positional_need`
 * fires on 34,000-62,000 cells per league at a near-uniform +-8%, against 77 /
 * 54 / 8 / 1 cells for the four chat sources. Ranked on raw size it buries
 * every read of a person under a read of a roster. A hit that carries its own
 * `effect_net` (the part that is NOT positional need) is ranked on that; one
 * that does not is discounted.
 */
export function rankTactics(hits) {
  const discount = TACTIC_THRESHOLDS.positional_need_discount;
  const needDriven = new Set(['consolidate_for_need']);
  return (hits ?? [])
    .map(h => ({ ...h, rank_effect: Number.isFinite(h.effect_net)
      ? h.effect_net
      : (Number(h.effect) || 0) * (needDriven.has(h.key) ? discount : 1) }))
    .sort((a, b) => b.rank_effect - a.rank_effect || (b.n ?? 0) - (a.n ?? 0));
}
