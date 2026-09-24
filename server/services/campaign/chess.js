/**
 * UI-ENG-5 / FIX-290-2: CHESS-01a's searched paths as the plans contract's `chess`
 * section (plans-schema.js). Pure; run by the campaign producer (produce-plans.mjs),
 * never on the request thread. The War Room view passes the section through and
 * ChessPath.tsx words it.
 *
 * Input is what the producer read for one league:
 *   null                         the chess search was not run for this producer run
 *   { state: 'absent' }          title-chess.js (CHESS-01a, #258) is not merged
 *   { state: 'off', reason }     GRIDIRON_CHESS_ENABLED is off (and preview is off)
 *   { state: 'on', block }       findTradeSequences(...).chess, the titleChess() output
 *
 * What it adds to the search's numbers, and nothing else:
 *   - `clears_2se` on every step's change: |change| > 2 x its SE, the rule every other
 *     title-odds delta uses (season-sim.js TRADE_DELTA_NOISE_SE). The search keeps
 *     only the cumulative SE, so this is the change against today clearing noise, not
 *     the step's own rise (no per-step paired SE exists).
 *   - `week`: one step per week from the current week. CHESS-01a has no clock; this is
 *     a declared assumption (an offer is answered, and the next step sent, within a week).
 *   - the trade deadline: a trade or flip step after `deadline_week` is not written and
 *     the path is cut there. A cut path's totals are recomputed from its kept steps with
 *     the search's own rule (stop at the first refusal; a claim is assumed to clear):
 *     p_complete = product of P(yes), expected = sum of P(reach k) x step gain, full =
 *     the last kept change. Its paired comparison with the best single offer was for the
 *     whole path, so it is dropped (null).
 *   - the backup at step k: the first other path, in the search's order, that makes the
 *     same moves before k and a different move at k. Chosen, not computed.
 *   - `argument`: the "why" under the steps is JEV-01c's writer, which does not exist
 *     yet, so it is unknown with that reason and the steps still draw.
 */
import { MAX_ALTERNATIVES } from './plans-schema.js';

/** CHESS-01-b's pass flag. Set by hand once the replay test passes; preview mode never sets it. */
export const CHESS_REPLAY_ENV = 'GRIDIRON_CHESS_REPLAY_PASSED';
export const chessReplayPassed = (env = process.env) => env[CHESS_REPLAY_ENV] === '1';

/** What the panel says instead of a path until CHESS-01-b passes (ENGINE-SPECS UI-ENG-5). */
export const CHESS_FALLBACK = 'Path search is off: it has not beaten single trades in the replay test yet (CHESS-01-b).';

const SE_MULTIPLE = 2;
const fin = v => typeof v === 'number' && Number.isFinite(v);
const ok = (value, source, meta = {}) => ({ status: 'ok', value, source, ...meta });
const unknown = (reason, source) => ({ status: 'unknown', source, reason });
const week = v => (Number.isInteger(v) && v >= 1 && v <= 18 ? v : null);
const ids = xs => (Array.isArray(xs) ? xs.map(String) : []);

const WHY = {
  absent: 'Title-odds chess (CHESS-01a, #258) is not merged, so no path was searched.',
  not_run: 'The chess search was not run for this producer run.',
  empty: 'The search found no path that completes.',
  deadline: 'Every searched path needs a trade after the trade deadline, so none is shown.',
  claim_p: 'Rival claims are not modelled; the search assumes the claim clears.',
  level: 'CHESS-01a keeps the change against today, not the level of your title odds.',
  no_backup: 'No backup searched for this step: no other path makes the same moves before it and a different one here.',
  argument: 'The argument under the steps is written by JEV-01c\'s writer, which is not built yet; the steps stand on their numbers.',
};

function change(value, se) {
  if (!fin(value)) return unknown('The search wrote no title-odds change for this step.', 'sim.title');
  const out = ok(value, 'sim.title', { unit: 'title_odds', guess: true });
  if (fin(se) && se >= 0) out.se = se;
  out.clears_2se = fin(se) && se > 0 && Math.abs(value) > SE_MULTIPLE * se;
  return out;
}
const prob = (v, source, missing) => (fin(v) && v >= 0 && v <= 1 ? ok(v, source, { unit: 'probability', guess: true }) : unknown(missing, source));
const pYes = s => (s.p_basis === 'not_modelled' ? unknown(WHY.claim_p, 'clone.accept')
  : prob(s.p_accept, 'clone.accept', 'The search wrote no chance he says yes for this step.'));

/** One step's move: ids only. A claim gets the player it adds and gives the one it drops. */
function move(s) {
  if (s.kind === 'claim') {
    return { kind: 'claim', partner: null, give: s.drop == null ? [] : [String(s.drop)], get: [String(s.claim)] };
  }
  return { kind: s.kind === 'flip' ? 'flip' : 'trade', partner: s.partner_id == null ? null : String(s.partner_id),
    give: ids(s.give), get: ids(s.get) };
}
const moveKey = s => JSON.stringify(move(s));

/** The path cut at the deadline: its kept steps, or null when not even the first survives. */
function cutAtDeadline(path, now, deadline) {
  if (deadline == null || now == null) return path.steps;
  const k = path.steps.findIndex((s, i) => s.kind !== 'claim' && now + i > deadline);
  return k === -1 ? path.steps : k === 0 ? null : path.steps.slice(0, k);
}

/** A cut path's totals from its kept steps, by the search's own rule. */
function keptTotals(steps) {
  let reach = 1, ev = 0, before = 0;
  for (const s of steps) {
    reach *= s.p_basis === 'not_modelled' ? 1 : s.p_accept;
    ev += reach * (s.title_delta_after - before);
    before = s.title_delta_after;
  }
  const last = steps[steps.length - 1];
  return { p_complete: +reach.toFixed(4), expected: +ev.toFixed(4), full: last.title_delta_after, full_se: last.title_delta_se };
}

function backupFor(paths, path, k) {
  const prefix = path.steps.slice(0, k).map(moveKey).join('|');
  const own = moveKey(path.steps[k]);
  for (let j = 0; j < paths.length; j++) {
    const other = paths[j];
    if (other === path || other.steps.length <= k) continue;
    if (other.steps.slice(0, k).map(moveKey).join('|') !== prefix) continue;
    const alt = other.steps[k];
    if (moveKey(alt) === own) continue;
    return ok({ path_rank: j + 1, ...move(alt), p_yes: pYes(alt), change_after: change(alt.title_delta_after, alt.title_delta_se) }, 'plan.path');
  }
  return unknown(WHY.no_backup, 'plan.path');
}

/** Players a step names that the league's `names` does not: the search's own names, else the id label. */
function extraNames(paths, names) {
  const out = {};
  const add = (id, name) => {
    const k = String(id);
    if (!Object.hasOwn(names, k) && !Object.hasOwn(out, k)) out[k] = typeof name === 'string' && name.trim() ? name : `Player ${k}`;
  };
  for (const p of paths) {
    for (const s of p.steps) {
      if (s.kind === 'claim') { add(s.claim, s.claim_name); if (s.drop != null) add(s.drop, s.drop_name); continue; }
      (s.give ?? []).forEach((id, i) => add(id, s.give_names?.[i]));
      (s.get ?? []).forEach((id, i) => add(id, s.get_names?.[i]));
    }
  }
  return out;
}

/**
 * @returns {{ field: object, names: Record<string,string> }} the section, and the names its
 *   steps need that the league's `names` lacks (the producer merges them into the entry).
 */
export function chessSection(input, { names = {}, week: now = null, deadline_week = null, replayPassed = false } = {}) {
  const none = field => ({ field, names: {} });
  if (!input) return none(unknown(WHY.not_run, 'plan.path'));
  if (input.state === 'absent') return none(unknown(WHY.absent, 'plan.path'));
  if (input.state !== 'on') return none(unknown(String(input.reason ?? 'Title-odds chess is off.'), 'plan.path'));
  const block = input.block;
  if (!block || block.status === 'off') return none(unknown(String(block?.reason ?? 'Title-odds chess is off.'), 'plan.path'));
  if (block.status === 'failed') {
    return none({ status: 'failed', source: 'plan.path',
      reason: `The chess search failed (${String(block.error ?? 'no reason given')}), so its paths are hidden. Trust the Next move deck meanwhile.` });
  }
  const searched = (Array.isArray(block.paths) ? block.paths : []).filter(p => Array.isArray(p?.steps) && p.steps.length);
  if (!searched.length) return none(unknown(WHY.empty, 'plan.path'));

  const w = week(now), dl = week(deadline_week);
  const kept = searched
    .map(p => ({ p, steps: cutAtDeadline(p, w, dl) }))
    .filter(x => x.steps)
    .slice(0, MAX_ALTERNATIVES)
    .map(({ p, steps }) => ({ src: p, steps, cut: p.steps.length - steps.length }));
  if (!kept.length) return none(unknown(WHY.deadline, 'plan.path'));

  const paths = kept.map(({ src, steps, cut }, i) => {
    const t = cut ? keptTotals(steps) : null;
    return {
      rank: i + 1,
      p_complete: prob(t ? t.p_complete : src.p_complete, 'plan.path', 'The search wrote no chance the whole path lands.'),
      expected: fin(t ? t.expected : src.expected_title_delta)
        ? ok(t ? t.expected : src.expected_title_delta, 'plan.path', { unit: 'title_odds', guess: true })
        : unknown('The search wrote no expected gain for this path.', 'plan.path'),
      full: t ? change(t.full, t.full_se) : { ...change(src.full_title_delta, src.full_title_delta_se),
        ...(typeof src.full_clears_noise === 'boolean' ? { clears_2se: src.full_clears_noise } : {}) },
      vs_single: !t && src.vs_best_single ? {
        expected: fin(src.vs_best_single.expected_title_delta)
          ? ok(src.vs_best_single.expected_title_delta, 'plan.path', { unit: 'title_odds', guess: true })
          : unknown('No expected comparison with the best single offer.', 'plan.path'),
        full: change(src.vs_best_single.full_title_delta, src.vs_best_single.full_title_delta_se ?? undefined),
      } : null,
      argument: unknown(WHY.argument, 'coach.text'),
      steps: steps.map((s, k) => ({
        n: k + 1, week: w == null ? null : week(w + k), ...move(s),
        p_yes: pYes(s),
        change_after: change(s.title_delta_after, s.title_delta_se),
        title_after: prob(s.title_after, 'sim.title', WHY.level),
        backup: null,
      })),
      cut_at_deadline: cut,
      _steps: steps,
    };
  });
  const forBackup = paths.map(p => ({ steps: p._steps }));
  for (const [j, p] of paths.entries()) {
    p.steps.forEach((s, k) => { s.backup = backupFor(forBackup, forBackup[j], k); });
    delete p._steps;
  }
  const value = { replay_passed: replayPassed === true, week: w, deadline_week: dl, paths,
    ...(block.rival_claims === 'not_modelled' ? { rival_claims: 'not_modelled' } : {}) };
  return { field: ok(value, 'plan.path', block.preview ? { guess: true } : {}), names: extraNames(kept.map(k => ({ steps: k.steps })), names) };
}
