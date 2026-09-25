/**
 * COACH-PRESETS (#390): claims for the War Room drawer's fixed questions that
 * the four starter intents do not cover (CoachDrawer.tsx FIXED_QUESTIONS):
 *
 *   safe_to_send  "Is it safe to send?"                the next move's offer, whether its gain clears
 *                                                       the noise bar, what the confirm dice say, what
 *                                                       happens on a no or no reply, the brain caveat
 *   said_lately   "What did league-mates say lately?"  PULSE-01's labelled statements (brief-inputs.js)
 *   broken        "What's broken right now?"           the brain report and the number audit
 *
 * Same contract as brief-claims.js: every sentence cites the cells it stands
 * on and is grounded by brief.js#checkClaim before it ships. Cost $0.
 */
import { brain, deal, statements, teamOf } from './brief-claims.js';

const ok = f => f?.status === 'ok';
const val = f => (ok(f) ? f.value : undefined);
const pts = d => `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)} pts`;
const pct = p => `${Math.round(p * 100)}%`;

function record(ledger, tool, rows) {
  const e = ledger.record({ tool, tables: [tool], columns: Object.keys(rows[0] ?? {}), rows });
  return (i, col) => `${e.id}#${i}.${col}`;
}

const VERDICT = {
  holds: 'it holds up', shrank: 'it shrinks but stays above doing nothing', failed: 'it does not beat doing nothing'
};

/**
 * The confirm-dice card for a move: the producer re-prices the deck on fresh
 * dice (campaign/confirm.js) and writes one card per alternatives entry, in
 * the same order, and serves the confirmed expected as the move's own. The
 * card is taken only when both agree; otherwise null and no line is said.
 */
function confirmCard(entry, move) {
  const conf = entry._run?.confirm;
  const expected = val(move?.expected);
  if (conf?.status !== 'ok' || !Array.isArray(conf.cards) || typeof expected !== 'number') return null;
  const i = (val(entry.alternatives) ?? []).findIndex(m => String(m?.move_id) === String(move.move_id));
  const card = i < 0 ? null : conf.cards[i];
  return card && Math.abs(card.confirmed_expected - expected) < 1e-12 ? card : null;
}

/** "Is it safe to send?": the next move, held to the numbers that say whether sending it can hurt. */
export function safeToSend(entry, ledger) {
  const section = 'safe_to_send';
  if (entry.error) {
    const c = record(ledger, 'plan_read', [{ error: String(entry.error) }]);
    return [{ section, text: `The last plan run failed, so there is nothing to send: ${entry.error}`, cites: [c(0, 'error')] }];
  }
  const nm = entry.next_move;
  if (!ok(nm) || !nm.value?.steps?.length) {
    const reason = nm?.reason ?? 'the plans file has no next move for this league.';
    const c = record(ledger, 'plan_read', [{ status: nm?.status ?? 'missing', reason }]);
    return [{ section, text: `Nothing to send: ${reason}`, cites: [c(0, 'reason')] }];
  }
  const move = nm.value;
  const step = move.steps[0];
  const out = [];
  const d = deal(ledger, entry, step, 'plan_safe');
  out.push({ section, cites: d.cites, text: `The offer on the table: ${d.text}.` });

  const delta = step.title_odds_delta;
  if (ok(delta) && delta.unit === 'title_odds') {
    const c = record(ledger, 'plan_safe_gain', [{ delta: delta.value, clears: delta.clears_2se === true ? 1 : 0 }]);
    out.push({ section, cites: [c(0, 'delta'), c(0, 'clears')],
      text: delta.clears_2se === true
        ? `If he says yes, title odds move ${pts(delta.value)}, past the noise bar.`
        : `If he says yes, title odds move ${pts(delta.value)}, but that is inside the noise: it may be no gain at all.` });
  }

  const card = confirmCard(entry, move);
  if (card && VERDICT[card.verdict]) {
    const unit = move.expected?.unit;
    const c = record(ledger, 'plan_confirm', [{ verdict: card.verdict, confirmed_expected: card.confirmed_expected }]);
    const num = unit === 'title_odds' ? `: expected ${pts(card.confirmed_expected)} of title odds` : '';
    out.push({ section, cites: [c(0, 'verdict'), ...(num ? [c(0, 'confirmed_expected')] : [])],
      text: `Re-priced on fresh dice, ${VERDICT[card.verdict]}${num}.` });
  }

  const table = val(step.reply_table) ?? {};
  const no = val(table.decline);
  if (no?.do) {
    const after = ok(no.odds_after) && no.odds_after.unit === 'title_odds' ? no.odds_after.value : null;
    const c = record(ledger, 'plan_safe_decline', [{ do: teamNamed(entry, no.do), odds_after: after }]);
    out.push({ section, cites: [c(0, 'do'), ...(after != null ? [c(0, 'odds_after')] : [])],
      text: `If he says no: ${teamNamed(entry, no.do)}${after != null ? ` Title odds are then ${pct(after)}.` : ''}` });
  }
  const quiet = val(table.silence);
  if (quiet?.do) {
    const c = record(ledger, 'plan_safe_silence', [{ do: teamNamed(entry, quiet.do) }]);
    out.push({ section, cites: [c(0, 'do')], text: `If he goes quiet: ${teamNamed(entry, quiet.do)}` });
  }
  const p = step.p_yes;
  if (ok(p) && p.guess === true) {
    const c = record(ledger, 'plan_safe_yes', [{ p_yes: p.value, guess: 1 }]);
    out.push({ section, cites: [c(0, 'p_yes'), c(0, 'guess')],
      text: `His ${pct(p.value)} chance of a yes is a guess until the yes-model is proven.` });
  }
  const caveat = brain(entry, ledger).find(x => /isn't proven here yet/.test(x.text));
  if (caveat) out.push({ ...caveat, section });
  const when = val(step.send_when);
  if (when) {
    const c = record(ledger, 'plan_safe_when', [{ send_when: when }]);
    out.push({ section, cites: [c(0, 'send_when')], text: `When: ${when}` });
  }
  return out;
}

/** Planner prose writes rosters as "Team N"; say them the way the rest of the brief does. */
const teamNamed = (entry, text) => String(text).replace(/\bTeam (\d+)\b/g, (_, id) => teamOf(entry, id));

/** "What's broken right now?": the brain report and the number audit, as the morning brief says them. */
export function broken(entry, ledger) {
  const out = [];
  if (entry.error) {
    const c = record(ledger, 'plan_read', [{ error: String(entry.error) }]);
    out.push({ section: 'broken', text: `The last plan run failed: ${entry.error}`, cites: [c(0, 'error')] });
  }
  return [...out, ...brain(entry, ledger).map(x => ({ ...x, section: 'broken' }))];
}

/** "What did league-mates say lately?": PULSE-01's labelled statements, or why they were not read. */
export function saidLately(read, ledger) {
  const section = 'said_lately';
  if (read?.status !== 'ok') {
    // The reader's reason names producers and migrations; Coach says it in plain words and cites it.
    const reason = String(read?.reason ?? 'not read');
    const c = record(ledger, 'pulse_read', [{ reason }]);
    const text = /has not run since/.test(reason) ? "The league chat hasn't been read since this window opened, so there is nothing new to report."
      : /has not run for/.test(reason) ? "The league chat hasn't been read for this league yet, so Coach has nothing league-mates said."
        : "The league chat read isn't set up on this computer, so Coach has nothing league-mates said.";
    return [{ section, text, cites: [c(0, 'reason')] }];
  }
  return statements(read, ledger).map(x => ({ ...x, section }));
}
