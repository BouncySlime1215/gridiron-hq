/**
 * COACH-V2 $0 paths for two intents (section 1): EXPLAIN when the term is one the
 * app serves (its value is a bundle cell), and CHAT ("thanks", "lol ok").
 *
 * EXPLAIN: a plain definition plus this league's own value, read from the
 * preloaded bundle (preload.js) and cited like any Coach line, so verify.js holds
 * it. A term not on the list goes to the model as before.
 *
 * CHAT: a one-line acknowledgement and a pointer to what Coach can do. No model.
 *
 * Both come back in the answer format (answer-shape.js): a verdict, why lines.
 */
import { newLedger } from './ledger.js';
import { preloadContext } from './preload.js';
import { groundStarter } from './starter-answers.js';

const pct = p => `${(p * 100).toFixed(p < 0.01 ? 2 : 1)}%`;
const pts = d => `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)} pts`;

/** The rows of one preloaded table, and a cite maker for them. */
function table(ledger, name) {
  const q = ledger.queries.find(x => x.tables?.[0] === name);
  if (!q || q.rows?.[0]?.status === 'none') return null;
  return { rows: q.rows, cite: (i, col) => `${q.id}#${i}.${col}` };
}

/** Each term: when it matches, the verdict (a definition that starts with a verb) and why lines from the bundle. */
const TERMS = [
  { key: 'depth_premium', fallback: 'It applies only to bench players, never to a blue chip or a protected player.', rx: /\bdepth premium\b/,
    verdict: 'Read the depth premium as extra value a two-for-one of bench players may cost.',
    why: t => { const r = table(t, 'nick_rules'); return r ? [{ text: `Capped at ${r.rows[0].depth_premium_max_pct}% over fair value, and only when your lineup points and title odds both rise.`, cites: [r.cite(0, 'depth_premium_max_pct')] }] : []; } },
  { key: 'overpay', fallback: 'No trade gives more market value than it gets back.', rx: /\boverpay\b/,
    verdict: 'Read the overpay cap as the most market value you may give beyond what you get.',
    why: t => { const r = table(t, 'nick_rules'); return r ? [{ text: `Yours is ${r.rows[0].overpay_cap_pct}%: no trade gives more FantasyCalc value than it gets.`, cites: [r.cite(0, 'overpay_cap_pct')] }] : []; } },
  { key: 'blue_chip', fallback: 'Every player you get in a trade must be one.', rx: /\bblue[- ]?chips?\b/,
    verdict: 'Read a blue chip as a player at or above the floor score on the plan\'s board.',
    why: t => { const r = table(t, 'nick_rules'); return r ? [{ text: `Your floor is ${r.rows[0].blue_chip_floor}: every player you get must score at least that.`, cites: [r.cite(0, 'blue_chip_floor')] }] : []; } },
  { key: 'p_yes', rx: /\bp\s*\(?\s*yes\s*\)?|\bchance he says yes\b/,
    verdict: 'Read P(yes) as the chance the other manager accepts the offer as sent.',
    why: t => { const m = table(t, 'plan_moves'); const out = [{ text: 'It is marked a guess until the yes-model is proven on graded offers.', cites: [] }];
      if (m && m.rows[0].p_yes != null) out.unshift({ text: `Your top card: ${pct(m.rows[0].p_yes)} chance of a yes.`, cites: [m.cite(0, 'p_yes')] });
      return out; } },
  { key: 'noise', rx: /\bnoise\b|\bclears? the noise\b/,
    verdict: 'Read the noise band as the simulation\'s margin of error around a number.',
    why: t => { const m = table(t, 'plan_moves'); const out = [{ text: 'A gain clears the noise when it is bigger than twice its standard error.', cites: [] }];
      if (m && m.rows[0].title_odds_change != null && m.rows[0].title_odds_change_se != null) {
        out.push({ text: `Your top card: ${pts(m.rows[0].title_odds_change)} of title odds, give or take ${pts(m.rows[0].title_odds_change_se).replace('+', '')}.`,
          cites: [m.cite(0, 'title_odds_change'), m.cite(0, 'title_odds_change_se')] });
      }
      return out; } },
  { key: 'se', fallback: 'A small SE means the number is steady from one run of the simulation to the next.', rx: /\bse\b|\bstandard error\b/,
    verdict: 'Read SE as the margin of error on a number: the truth is usually within two of them.',
    why: t => { const s = table(t, 'plan_summary'); return s && s.rows[0].title_odds_now != null && s.rows[0].title_odds_now_se != null
      ? [{ text: `Your title odds: ${pct(s.rows[0].title_odds_now)}, give or take ${pct(s.rows[0].title_odds_now_se)}.`, cites: [s.cite(0, 'title_odds_now'), s.cite(0, 'title_odds_now_se')] }] : []; } },
  { key: 'expected', rx: /\bexpected\b/,
    verdict: 'Read expected title odds as the average gain across his yes and his no.',
    why: t => { const m = table(t, 'plan_moves'); return m && m.rows[0].expected != null
      ? [{ text: `Your top card expects ${pts(m.rows[0].expected)} of title odds.`, cites: [m.cite(0, 'expected')] }]
      : [{ text: 'A big gain he rarely accepts can expect less than a small one he usually takes.', cites: [] }]; } },
  { key: 'floor', fallback: 'A higher floor means fewer disaster weeks from that spot.', rx: /\bfloor\b/,
    verdict: 'Read a player\'s floor as his bad-week score: he beats it in most weeks.',
    why: t => { const r = table(t, 'my_roster'); const row = r?.rows.findIndex(x => x.starter && x.floor_80 != null) ?? -1;
      return row >= 0 ? [{ text: `${r.rows[row].player}'s floor this week: ${r.rows[row].floor_80} points.`, cites: [r.cite(row, 'player'), r.cite(row, 'floor_80')] }] : []; } },
  { key: 'title_odds', fallback: 'The plan ranks every move by how much it raises them.', rx: /\btitle odds\b/,
    verdict: 'Read title odds as your chance to win the league title this season.',
    why: t => { const s = table(t, 'plan_summary'); return s && s.rows[0].title_odds_now != null
      ? [{ text: `Yours now: ${pct(s.rows[0].title_odds_now)} of title odds.`, cites: [s.cite(0, 'title_odds_now')] }] : []; } }
];

const shaped = (verdict, why, question, extra = {}) => ({ verdict: { text: verdict, cites: [] }, stance: 'none', basis: extra.basis ?? 'definition', why, risks: [] });

/**
 * The $0 EXPLAIN answer for a question that names a served term, or null.
 * -> { answer (with shape), ledger, verification, term }
 */
export async function explainTerm({ question, leagueId }) {
  const q = String(question ?? '').toLowerCase();
  const term = TERMS.find(t => t.rx.test(q));
  if (!term) return null;
  const ledger = newLedger();
  await preloadContext({ leagueId, ledger });
  const draft = term.why(ledger);
  const cited = draft.filter(w => w.cites.length);
  const { claims, dropped, numbers_checked } = groundStarter(cited, ledger);
  const why = [...claims, ...draft.filter(w => !w.cites.length)].slice(0, 3);
  if (!why.length && term.fallback) why.push({ text: term.fallback, cites: [] });
  const answer = { claims, refusals: [], as_of: null, shape: shaped(term.verdict, why, question) };
  return { answer, ledger: ledger.toJson(), term: term.key, dropped,
    verification: { ok: true, violations: [], warnings: [], numbers_checked, deterministic: true, intent: 'explain', question } };
}

const THANKS = /\b(thanks?|thank you|thx)\b/;
const LAUGH = /\b(lol|lmao|haha)\b/;

/** The $0 CHAT answer. */
export function chatReply({ question }) {
  const q = String(question ?? '').toLowerCase();
  const verdict = THANKS.test(q) ? 'Happy to help.' : LAUGH.test(q) ? 'Glad that landed.' : 'Got it.';
  const why = [{ text: 'Ask about your next move, a target or your lineup next.', cites: [] }];
  return { answer: { claims: [], refusals: [], as_of: null, shape: shaped(verdict, why, question, { basis: 'small talk' }) },
    ledger: newLedger().toJson(), verification: { ok: true, violations: [], warnings: [], numbers_checked: 0, deterministic: true, intent: 'chat', question } };
}
