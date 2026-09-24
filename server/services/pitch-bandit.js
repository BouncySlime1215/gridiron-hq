/**
 * M5, the pitch bandit: which framing to lead a trade message with, per manager.
 *
 * Four arms, one question: does this manager say yes more often when the
 * message opens on his need, on fairness, on timing, or says almost nothing?
 *
 *   need_first       open on the hole the deal fills for him
 *   fairness_first   open on "this is even for both sides"
 *   urgency_first    open on timing ("before lineups lock")
 *   face_safe_short  the ask and nothing else: no read of his roster, no
 *                    numbers, nothing that makes him look like he lost
 *
 * THOMPSON SAMPLING ON A BETA PER ARM, PER MANAGER. The prior is a hand-set
 * base rate, nudged up for the arms his negotiation profile's
 * `how_to_approach` describes (keyword match, so it is a reading, not a fit).
 * Every sent offer that settles moves the arm it was sent with: accepted
 * counts 1, countered 0.5 (he engaged), declined / expired / ignored 0. A
 * pending offer counts nothing, and a choice that was never sent counts
 * nothing: the producer drafts far more messages than Nick sends.
 *
 * CAPPED EXPLORATION. An arm is eligible only if its posterior mean clears a
 * floor: FLOOR_ABS absolutely, and FLOOR_REL of the best arm's mean. So once
 * an arm has lost enough, the bandit stops spending real offers on it. If no
 * arm clears the floor it plays the best mean and says so. Arms his profile's
 * `what_shuts_him_down` rules out are vetoed outright; face_safe_short is the
 * safe arm and is never vetoed.
 *
 * Every choice is a `pitch_choices` row (migration 090): arm, posterior,
 * samples, eligible arms, floor, reason. "I sent this" links the choice to the
 * offer (`recordSentOffer`), which is what makes it learnable.
 *
 * NOT FITTED. The base rate and the keyword boost are guesses; the prior is
 * weak (strength PRIOR_STRENGTH pseudo-offers) so a handful of real replies
 * outweigh it. Across a league of ~20 decided offers a week, a per-manager
 * posterior stays wide all season. That is what the floor is for.
 */
import { rows, run } from '../db/index.js';
import { offerKeyOf } from './trade-outcomes.js';
import { negotiationProfilesFor } from './counterparty-pricing.js';

export const PITCH_ARMS = Object.freeze(['need_first', 'fairness_first', 'urgency_first', 'face_safe_short']);

/** Hand-set prior: base accept rate, boosted rate for an arm his profile names, strength in pseudo-offers. */
export const PRIOR_BASE_MEAN = 0.30;
export const PRIOR_BOOST_MEAN = 0.45;
export const PRIOR_STRENGTH = 4;
/** An arm must clear FLOOR_ABS and FLOOR_REL x the best arm's posterior mean to be sampled. */
export const FLOOR_ABS = 0.10;
export const FLOOR_REL = 0.5;
/** Reward per settled status. Anything not listed (proposed, not_proposed) is not a result yet. */
export const REWARD = Object.freeze({ accepted: 1, countered: 0.5, declined: 0, expired: 0, ignored: 0 });

const SAFE_ARM = 'face_safe_short';

/** How_to_approach wording that points at each arm. */
const APPROACH_WORDS = {
  need_first: /\bneeds?\b|\bhole\b|\bdepth\b|\bthin\b|\broster\b|\bfills?\b|\bhelp(s)? (him|his)\b/gi,
  fairness_first: /\bfair(ness|ly)?\b|\beven\b|\bvalue\b|win-win|both sides|\bbalanced\b|\bnumbers\b|\bdata\b/gi,
  urgency_first: /\burgen(t|cy)\b|\bdeadline\b|\bfast\b|\bquick(ly)?\b|\bbefore\b|\bwindow\b|\btiming\b|\bstrike\b/gi,
  face_safe_short: /\bshort\b|\bbrief\b|\bdirect\b|\bconcise\b|to the point|\bprivate(ly)?\b|\bface\b|\bego\b|\brespect\b|\bcasual\b|low-key/gi,
};
/** What_shuts_him_down wording that rules an arm out. */
const VETO_WORDS = {
  urgency_first: /pressur|\brush|\bdeadline|urgen|ultimatum/i,
  need_first: /condescen|lectur|telling him (what|how)|his (team|roster) is (bad|weak)/i,
  fairness_first: /trade chart|value chart|spreadsheet|analytics|calculator/i,
};

const betaMean = a => a.alpha / (a.alpha + a.beta);
const textOf = v => (Array.isArray(v) ? v.join(' ') : v == null ? '' : String(v));

/**
 * The prior for one manager from his negotiation profile (or null).
 * Returns { arms: {arm: {alpha, beta, hits}}, vetoed, basis, fitted: false }.
 */
export function priorFromProfile(profile) {
  const approach = textOf(profile?.how_to_approach);
  const shuts = textOf(profile?.what_shuts_him_down);
  const arms = {};
  for (const arm of PITCH_ARMS) {
    const hits = [...new Set((approach.match(APPROACH_WORDS[arm]) ?? []).map(h => h.toLowerCase()))];
    const mean = hits.length ? PRIOR_BOOST_MEAN : PRIOR_BASE_MEAN;
    arms[arm] = { alpha: mean * PRIOR_STRENGTH, beta: (1 - mean) * PRIOR_STRENGTH, hits };
  }
  const vetoed = PITCH_ARMS.filter(a => a !== SAFE_ARM && VETO_WORDS[a]?.test(shuts));
  const boosted = PITCH_ARMS.filter(a => arms[a].hits.length);
  const basis = profile == null
    ? `no negotiation profile: flat hand-set prior (mean ${PRIOR_BASE_MEAN}, strength ${PRIOR_STRENGTH})`
    : `keyword prior from how_to_approach (hand-set, not fitted): ${boosted.length ? boosted.join(', ') : 'no arm named'}`
      + ` at mean ${PRIOR_BOOST_MEAN}, others ${PRIOR_BASE_MEAN}; strength ${PRIOR_STRENGTH}`
      + (vetoed.length ? `; vetoed by what_shuts_him_down: ${vetoed.join(', ')}` : '');
  return { arms, vetoed, basis, fitted: false };
}

/**
 * Load a manager's profile from the one reader. Returns { profile, note }: a
 * missing profile is a state (note says why), a read that throws is recorded
 * in the note and the flat prior is used, so the basis on the logged choice
 * says the profile could not be read.
 */
function loadProfile(leagueId, teamId) {
  let res;
  try {
    res = negotiationProfilesFor(leagueId);
  } catch (e) {
    return { profile: null, note: `profile read failed: ${String(e?.message ?? e)}` };
  }
  if (!res.available) return { profile: null, note: `no profile: ${res.reason}` };
  const hit = res.byRoster.get(String(teamId));
  return hit ? { profile: hit.profile, note: null } : { profile: null, note: 'no profile for this manager' };
}

const hasChoices = () => rows(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pitch_choices'`).length > 0;

/**
 * Posterior per arm for one manager: the prior plus every settled, sent offer
 * whose linked choice named that arm. `profile` undefined = read it; null = none.
 */
export function posteriorFor({ league_id, season, counterparty_team_id, profile } = {}) {
  let note = null;
  if (profile === undefined) ({ profile, note } = loadProfile(league_id, counterparty_team_id));
  const prior = priorFromProfile(profile);
  const arms = {};
  for (const a of PITCH_ARMS) arms[a] = { alpha: prior.arms[a].alpha, beta: prior.arms[a].beta, n: 0, reward: 0 };
  if (!hasChoices()) throw new Error('pitch-bandit: pitch_choices does not exist — migration 090 has not run here');
  const settled = rows(`SELECT c.arm, t.status FROM pitch_choices c JOIN trade_outcomes t ON t.id = c.outcome_id
    WHERE c.league_id = ? AND c.season = ? AND c.counterparty_team_id = ? AND t.sent_at IS NOT NULL`,
  league_id, season, String(counterparty_team_id));
  for (const s of settled) {
    const r = REWARD[s.status];
    if (r === undefined || !arms[s.arm]) continue;
    arms[s.arm].alpha += r;
    arms[s.arm].beta += 1 - r;
    arms[s.arm].n += 1;
    arms[s.arm].reward += r;
  }
  for (const a of PITCH_ARMS) arms[a].mean = betaMean(arms[a]);
  return { arms, vetoed: prior.vetoed, basis: note ? `${prior.basis} (${note})` : prior.basis };
}

/* ------------------------------------------------------------ sampling */

/** A small seeded PRNG (mulberry32), so a logged choice can be replayed. */
export function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng) {
  const u = 1 - rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Gamma(shape, 1) by Marsaglia-Tsang; shape < 1 via the U^(1/a) boost. */
function gamma(shape, rng) {
  if (shape < 1) return gamma(shape + 1, rng) * Math.pow(1 - rng(), 1 / shape);
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = normal(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = 1 - rng();
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

export function sampleBeta(alpha, beta, rng) {
  const x = gamma(alpha, rng), y = gamma(beta, rng);
  return x / (x + y);
}

/* ------------------------------------------------------------- choosing */

/**
 * Which framing to lead with, for one message to one manager.
 *
 *   deal        optional; its offer key becomes the choice's idea_id, so
 *               "I sent this" on the same deal links this choice
 *   profile     undefined = read it; null = no profile
 *   rng         () => [0,1); default Math.random
 *   log         false = choose without writing a row (dry runs, tests)
 *   force_arm   test seam: pick this arm, still logged with its posterior
 *
 * Returns { arm, choice_id, reason, eligible, floor, samples, posterior, basis }.
 */
export function chooseFraming({ league_id, season, counterparty_team_id, deal = null, idea_id = null,
  profile, rng = Math.random, log = true, force_arm = null, now = null } = {}) {
  if (league_id == null || season == null || counterparty_team_id == null) {
    throw new Error('pitch-bandit: league_id, season and counterparty_team_id are required');
  }
  if (force_arm != null && !PITCH_ARMS.includes(force_arm)) throw new Error(`unknown framing arm: ${force_arm}`);
  const post = posteriorFor({ league_id, season, counterparty_team_id, profile });
  const open = PITCH_ARMS.filter(a => !post.vetoed.includes(a));
  const best = Math.max(...open.map(a => post.arms[a].mean));
  const floor = Math.max(FLOOR_ABS, FLOOR_REL * best);
  const eligible = open.filter(a => post.arms[a].mean >= floor);

  const samples = {};
  let arm, reason;
  if (force_arm) {
    arm = force_arm;
    reason = 'forced';
  } else if (eligible.length) {
    for (const a of eligible) samples[a] = sampleBeta(post.arms[a].alpha, post.arms[a].beta, rng);
    arm = eligible.reduce((x, y) => (samples[y] > samples[x] ? y : x));
    reason = `Thompson draw over ${eligible.length} arm(s) above the floor ${floor.toFixed(3)}`
      + (open.length > eligible.length ? `; below it: ${open.filter(a => !eligible.includes(a)).join(', ')}` : '');
  } else {
    arm = open.reduce((x, y) => (post.arms[y].mean > post.arms[x].mean ? y : x));
    reason = `every open arm is below the floor ${floor.toFixed(3)}; playing the best posterior mean`;
  }
  if (post.vetoed.length) reason += `; vetoed: ${post.vetoed.join(', ')}`;

  const ideaId = idea_id ?? (deal ? offerKeyOf(deal) : null);
  const out = { arm, choice_id: null, reason, eligible, floor, samples, posterior: post.arms, basis: post.basis };
  if (!log) return out;
  const r = run(`INSERT INTO pitch_choices (league_id, season, counterparty_team_id, idea_id, arm, prior_basis,
      samples_json, posterior_json, eligible_json, floor, reason, chosen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  league_id, season, String(counterparty_team_id), ideaId, arm, post.basis,
  JSON.stringify(samples), JSON.stringify(post.arms), JSON.stringify(eligible), floor, reason,
  now ?? new Date().toISOString());
  out.choice_id = Number(r.lastInsertRowid);
  return out;
}

/* ------------------------------------------------------------- framing */

const OPENERS = {
  fairness_first: 'I tried to keep this one even for both sides.',
  urgency_first: 'Sending this now so you have it before lineups lock.',
};
const NEED_LINE = /^Looks like you could use/;

/**
 * Reshape the campaign producer's step message (`stepMessage`: { text, facts })
 * for one arm. It only reorders, drops, or adds one sentence with no number in
 * it, so every number left in the text is still backed by `facts`.
 */
export function frameMessage(message, arm) {
  if (!PITCH_ARMS.includes(arm)) throw new Error(`unknown framing arm: ${arm}`);
  const sentences = String(message?.text ?? '').split(/(?<=[.?!])\s+(?=[A-Z])/).filter(Boolean);
  const askIdx = sentences.map(s => s.trim().endsWith('?')).lastIndexOf(true);
  const ask = askIdx >= 0 ? sentences[askIdx] : null;
  const need = sentences.find(s => NEED_LINE.test(s)) ?? null;
  const rest = sentences.filter((s, i) => i !== askIdx && s !== need);
  let lines, facts = message?.facts ?? [];
  if (arm === 'face_safe_short') {
    lines = [ask ?? sentences.at(-1), 'No worries if it is not for you.'];
    facts = [];
  } else if (arm === 'need_first') {
    lines = [need, ...rest, ask];
  } else {
    lines = [OPENERS[arm], need, ...rest, ask];
  }
  return { ...message, text: lines.filter(Boolean).join(' '), facts, framing: arm };
}

/**
 * THE ONE CALL the campaign producer makes per step message: pick the framing
 * for this manager, log it against the deal, and return the reshaped message
 * with the choice id the page sends back on "I sent this".
 *
 * `message` is the producer's `stepMessage(step, ctx)` result; `deal` needs the
 * same id / partner / players the page will post, so the offer key matches.
 */
export function pitchFor({ league_id, season, counterparty_team_id, deal, message, profile, rng, now } = {}) {
  const choice = chooseFraming({ league_id, season, counterparty_team_id, deal, profile, rng, now });
  return {
    message: { ...frameMessage(message, choice.arm), pitch_choice_id: choice.choice_id },
    choice,
  };
}
