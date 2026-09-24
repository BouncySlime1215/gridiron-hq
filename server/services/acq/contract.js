/**
 * ACQ-01 -> the War Room plans contract (#238, server/services/campaign/plans-schema.js).
 *
 * The planner's output becomes three contract sections of one league entry:
 *   alternatives  the deck, best first, up to MAX_ALTERNATIVES moves
 *   next_move     the head of the deck
 *   targets       every target searched, with gain if landed and P(reach)
 * plus finder_best_expected when the caller measured the served finder. Every
 * other section is written 'unknown' with the reason that ACQ-01 does not
 * produce it, so the entry validates on its own and a reader can tell "not this
 * producer's" from "computed as nothing".
 *
 * Per step: P(yes) with its band, Nick's title-odds change vs today and his title
 * odds after, and a reply table whose decline row is the backup path (another
 * deck card when it is one, otherwise the path spelled out). The message, the
 * send time, the counter and silence rows are not ACQ-01's (Coach, timing and
 * the campaign playbook write them), so they are 'unknown' with that reason.
 *
 * Pure: turns plain objects into plain objects.
 */
import { SCHEMA_VERSION, SECTIONS, MAX_ALTERNATIVES, validateLeague } from '../campaign/plans-schema.js';

export const PRODUCER = 'acq-01-planner';
export const PRODUCER_VERSION = '1';

const S = { plan: 'plan.path', accept: 'clone.accept', title: 'sim.title', fc: 'market.fc' };
const ok = (value, source, extra = {}) => ({ status: 'ok', value, source, ...extra });
const unknown = (reason, source) => ({ status: 'unknown', reason, source });
const r4 = x => +Number(x).toFixed(4);
const numF = (v, se, source = S.title) => (Number.isFinite(v)
  ? ok(r4(v), source, se != null && Number.isFinite(se) ? { se: r4(Math.max(0, se)), clears_2se: Math.abs(v) > 2 * se && se > 0 } : {})
  : unknown('not computed on this run', source));
const probF = (v, source) => (Number.isFinite(v) ? ok(r4(Math.min(1, Math.max(0, v))), source) : unknown('not computed on this run', source));
const pct = v => `${(v * 100).toFixed(1)}%`;

const NOT_ACQ = {
  attention: 'the campaign producer ranks leagues; ACQ-01 plans one league',
  destination: 'the campaign producer writes the destination; ACQ-01 writes paths',
  feasibility: 'the points objective is the campaign producer\'s',
  finder_best_expected: 'the served finder was not run alongside this plan (pass --finder)',
  itinerary: 'the itinerary is the campaign producer\'s',
  stop_tradeoffs: 'stop trade-offs are the campaign producer\'s',
  flip_map: 'the flip map is FLIP-01\'s; ACQ-01 uses flips only as steps inside a path',
  catch_up: 'the catch-up list is the campaign producer\'s',
  speed_curve: 'the speed curve is the campaign producer\'s',
  brain_report: 'the brain report is EVAL-01\'s',
  next_move: 'no path to any target has a positive expected title-odds change',
  alternatives: 'no path to any target has a positive expected title-odds change',
  targets: 'no target was searched'
};

export const moveId = (plan, i) => `acq:${plan.target}:${i + 1}`;

function stepText(s, name) {
  const g = s.give.map(name).join(' + '), r = s.get.map(name).join(' + ');
  return s.kind === 'claim' ? `claim ${r}, dropping ${g}` : `team ${s.partner}: give ${g} for ${r}`;
}

function declineReply(plan, i, backup, deckIds, name) {
  if (!backup) {
    const where = i === 0 ? 'Keep your roster' : `Keep what steps 1-${i} brought in`;
    return ok({ do: `${where}: no other scored path to ${name(plan.target)} starts from here.` }, S.plan);
  }
  const q = backup.plan;
  const rest = q.steps.slice(i).map(s => stepText(s, name)).join(', then ');
  const v = { do: `Go to the backup: ${rest}.`, odds_after: numF(backup.expected, null) };
  const id = deckIds.get(q);
  if (id) v.move_id = id;
  return ok(v, S.plan);
}

function contractStep(plan, s, i, backup, deckIds, name) {
  const isClaim = s.kind === 'claim';
  const pYes = isClaim && s.basis === 'assumed'
    ? unknown(s.p_reason ?? 'no waiver-competition model; the path math assumes the claim lands', S.accept)
    : probF(s.p, S.accept);
  const next = plan.steps[i + 1];
  const out = {
    partner: String(s.partner),
    give: s.give.map(String),
    get: s.get.map(String),
    p_yes: pYes,
    title_odds_delta: numF(s.delta, s.se),
    title_after: probF(s.title_after, S.title),
    message: unknown('Coach writes the message (COACH-01); ACQ-01 does not', 'coach.text'),
    opening: ok({ give: s.give.map(String), get: s.get.map(String), text: isClaim ? 'A waiver claim: add him, drop the listed player.' : `The planner's package: screen-fair on his market value (${s.shape}).` }, S.plan),
    walk_away: ok({ text: isClaim ? 'Only the listed drop; if the claim fails, the path stops here.' : 'This package is the most this path spends on this step; a counter asking for more is a new path.', max_give: s.give.map(String) }, S.plan),
    send_when: unknown('timing rules (spike, role news, deadline) are not modelled in ACQ-01 yet', S.plan),
    reply_table: ok({
      accept: ok({ do: next ? `Send step ${i + 2}: ${stepText(next, name)}.` : `Done: you hold ${name(plan.target)}.`,
        odds_after: numF(s.delta, s.se) }, S.plan),
      decline: declineReply(plan, i, backup, deckIds, name),
      counter: unknown('counter rules are the campaign playbook\'s (CAMPAIGN-01b)', S.plan),
      silence: unknown('silence rules are the campaign playbook\'s (CAMPAIGN-01b)', S.plan)
    }, S.plan)
  };
  if (!isClaim && Number.isFinite(s.low) && Number.isFinite(s.high)) out.p_yes_band = { low: r4(s.low), high: r4(s.high) };
  return out;
}

function contractMove(plan, rank, deckIds, name) {
  return {
    move_id: deckIds.get(plan),
    rank,
    target: String(plan.target),
    target_owner: String(plan.owner),
    chained: plan.chained,
    steps: plan.steps.map((s, i) => contractStep(plan, s, i, plan.backups?.[i] ?? null, deckIds, name)),
    p_complete: probF(plan.p_complete, S.accept),
    delta_final: numF(plan.delta_final, plan.steps.at(-1)?.se ?? null),
    expected: numF(plan.expected, plan.expected_se, S.plan),
    reasoning: unknown('REASON-01 writes the reasoning panels; ACQ-01 writes the path', S.plan)
  };
}

function targetWhy(t, name) {
  if (!t.best) return `No screen-fair path to ${name(t.target)} was scored on this run.`;
  const b = t.best;
  const shape = b.steps.map(s => s.shape).join(' then ');
  return `Worth ${pct(t.gain_if_landed ?? 0)} title odds if landed; best path (${shape}) completes ${pct(b.p_complete)} of the time for ${pct(b.expected)} expected.`;
}

/**
 * One league entry: the planner's sections plus every other section 'unknown'.
 * @param {object} res  planAcquisition's result
 * @param {object} meta { league, me, name(id) -> string, finderBest?: { expected, se }, asOf? }
 */
export function leagueEntry(res, { league, me, name, finderBest = null, asOf = null }) {
  const deck = res.deck.slice(0, MAX_ALTERNATIVES);
  const deckIds = new Map(deck.map((p, i) => [p, moveId(p, i)]));
  // A backup that is also a deck card is the same plan object only by content; map by first-step signature.
  const bySig = new Map(deck.map(p => [JSON.stringify(p.steps.map(s => [s.kind, s.partner, s.give, s.get])), deckIds.get(p)]));
  for (const p of res.plans) {
    const id = bySig.get(JSON.stringify(p.steps.map(s => [s.kind, s.partner, s.give, s.get])));
    if (id && !deckIds.has(p)) deckIds.set(p, id);
  }
  const names = {};
  const addName = id => { names[String(id)] = name(id); };
  const entry = { league: Number(league), me: String(me), names };
  for (const k of Object.keys(SECTIONS)) entry[k] = unknown(NOT_ACQ[k] ?? 'not produced by ACQ-01', S.plan);

  const moves = deck.map((p, i) => contractMove(p, i + 1, deckIds, name));
  for (const p of deck) for (const s of p.steps) [...s.give, ...s.get].forEach(addName);
  for (const p of deck) addName(p.target);
  for (const p of deck) for (const b of p.backups ?? []) if (b) b.plan.steps.forEach(s => [...s.give, ...s.get].forEach(addName));
  if (moves.length) {
    entry.alternatives = ok(moves, S.plan, asOf ? { as_of: asOf } : {});
    entry.next_move = ok(moves[0], S.plan, asOf ? { as_of: asOf } : {});
  } else if (res.stats?.truncated) {
    entry.alternatives = unknown(`the search stopped early (${res.stats.truncated}) before any path was scored`, S.plan);
    entry.next_move = unknown(entry.alternatives.reason, S.plan);
  }
  const tlist = res.targets.filter(t => !t.error);
  if (tlist.length) {
    tlist.forEach(t => addName(t.target));
    const head = deck[0]?.target;
    entry.targets = ok(tlist.map(t => ({
      player: String(t.target), owner: String(t.owner),
      gain_if_landed: numF(t.gain_if_landed, t.gain_se),
      p_reach: probF(t.p_reach, S.accept),
      mode_fit: unknown('risk modes are the campaign producer\'s', S.plan),
      why: ok(targetWhy(t, name), S.plan),
      approved: false,
      is_plan_target: head != null && String(head) === String(t.target)
    })), S.plan);
  }
  if (finderBest && Number.isFinite(finderBest.expected)) entry.finder_best_expected = numF(finderBest.expected, finderBest.se, S.plan);
  return entry;
}

/** A whole plans document for one or more league entries; an entry that fails the contract is written as its error. */
export function plansDoc(entries, { generatedAt = new Date().toISOString() } = {}) {
  const leagues = entries.map(e => {
    const v = validateLeague(e);
    if (v.ok) return e;
    return { league: e.league, me: e.me, names: e.names ?? {},
      error: `ACQ-01 entry failed the contract: ${v.errors.slice(0, 3).map(x => `${x.path} ${x.message}`).join('; ')}` };
  });
  return { schema: SCHEMA_VERSION, generated_at: generatedAt, producer: PRODUCER, producer_version: PRODUCER_VERSION, leagues };
}
