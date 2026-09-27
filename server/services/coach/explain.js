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
    verdict: 'Think of the depth premium as the extra value a two-for-one of bench players may cost.',
    why: t => { const r = table(t, 'nick_rules'); return r ? [{ text: `Capped at ${r.rows[0].depth_premium_max_pct}% over fair value, and only when your lineup points and title odds both rise.`, cites: [r.cite(0, 'depth_premium_max_pct')] }] : []; } },
  { key: 'overpay', fallback: 'No trade gives more market value than it gets back.', rx: /\boverpay\b/,
    verdict: 'Think of the overpay cap as the most extra market value you will give in a trade.',
    why: t => { const r = table(t, 'nick_rules'); return r ? [{ text: `Yours is ${r.rows[0].overpay_cap_pct}%: no trade gives more FantasyCalc value than it gets.`, cites: [r.cite(0, 'overpay_cap_pct')] }] : []; } },
  { key: 'blue_chip', fallback: 'Every player you get in a trade must be one.', rx: /\bblue[- ]?chips?\b/,
    verdict: 'Think of a blue chip as a player at or above the floor score on the plan\'s board.',
    why: t => { const r = table(t, 'nick_rules'); return r ? [{ text: `Your floor is ${r.rows[0].blue_chip_floor}: every player you get must score at least that.`, cites: [r.cite(0, 'blue_chip_floor')] }] : []; } },
  { key: 'guess', rx: /\bguess\b/,
    verdict: 'Treat the chance they say yes as a guess: the yes-model is not proven yet.',
    why: t => { const m = table(t, 'plan_moves'); const out = [{ text: 'It becomes a measured number once enough of your offers have been graded.', cites: [] }];
      if (m && m.rows[0].p_yes != null) out.unshift({ text: `Your top card: ${pct(m.rows[0].p_yes)} chance of a yes, marked a guess.`, cites: [m.cite(0, 'p_yes')] });
      return out; } },
  { key: 'p_yes', rx: /\bp\s*\(?\s*yes\s*\)?|\bchance he says yes\b/,
    verdict: 'Think of P(yes) as the chance the other manager accepts the offer as sent.',
    why: t => { const m = table(t, 'plan_moves'); const out = [{ text: 'It is marked a guess until the yes-model is proven on graded offers.', cites: [] }];
      if (m && m.rows[0].p_yes != null) out.unshift({ text: `Your top card: ${pct(m.rows[0].p_yes)} chance of a yes.`, cites: [m.cite(0, 'p_yes')] });
      return out; } },
  { key: 'clears_noise', rx: /\bclears? the noise\b/,
    verdict: 'Call a gain real when it beats twice its margin of error: that clears the noise.',
    why: t => { const m = table(t, 'plan_moves'); const out = [];
      if (m && m.rows[0].title_odds_change != null && m.rows[0].title_odds_change_se != null) {
        out.push({ text: `Your top card: ${pts(m.rows[0].title_odds_change)}, give or take ${pts(m.rows[0].title_odds_change_se).replace('+', '')}.`,
          cites: [m.cite(0, 'title_odds_change'), m.cite(0, 'title_odds_change_se')] });
      }
      out.push({ text: 'A gain that does not clear it could be simulation luck, so the plan does not count on it.', cites: [] });
      return out; } },
  { key: 'noise', rx: /\bnoise\b/,
    verdict: 'Think of the noise band as the simulation\'s margin of error around a number.',
    why: t => { const m = table(t, 'plan_moves'); const out = [{ text: 'A gain clears the noise when it is bigger than twice its standard error.', cites: [] }];
      if (m && m.rows[0].title_odds_change != null && m.rows[0].title_odds_change_se != null) {
        out.push({ text: `Your top card: ${pts(m.rows[0].title_odds_change)} of title odds, give or take ${pts(m.rows[0].title_odds_change_se).replace('+', '')}.`,
          cites: [m.cite(0, 'title_odds_change'), m.cite(0, 'title_odds_change_se')] });
      }
      return out; } },
  { key: 'se', fallback: 'A small SE means the number is steady from one run of the simulation to the next.', rx: /\bse\b|\bstandard error\b/,
    verdict: 'Think of SE as the margin of error on a number: the truth is usually within two SEs.',
    why: t => { const s = table(t, 'plan_summary'); return s && s.rows[0].title_odds_now != null && s.rows[0].title_odds_now_se != null
      ? [{ text: `Your title odds: ${pct(s.rows[0].title_odds_now)}, give or take ${pct(s.rows[0].title_odds_now_se)}.`, cites: [s.cite(0, 'title_odds_now'), s.cite(0, 'title_odds_now_se')] }] : []; } },
  { key: 'expected', rx: /\bexpected\b/,
    verdict: 'Think of expected title odds as the gain if they say yes, times the chance they do.',
    why: t => { const m = table(t, 'plan_moves'); return m && m.rows[0].expected != null
      ? [{ text: `Your top card expects ${pts(m.rows[0].expected)} of title odds.`, cites: [m.cite(0, 'expected')] }]
      : [{ text: 'A big gain they rarely accept can expect less than a small one they usually take.', cites: [] }]; } },
  { key: 'floor', fallback: 'A higher floor means fewer disaster weeks from that spot.', rx: /\bfloor\b/,
    verdict: 'Think of a player\'s floor as their bad-week score: they beat it in most weeks.',
    why: t => { const r = table(t, 'my_roster'); const row = r?.rows.findIndex(x => x.starter && x.floor_80 != null) ?? -1;
      return row >= 0 ? [{ text: `${r.rows[row].player}'s floor this week: ${r.rows[row].floor_80} points.`, cites: [r.cite(row, 'player'), r.cite(row, 'floor_80')] }] : []; } },
  { key: 'title_odds', fallback: 'The plan ranks every move by how much it raises them.', rx: /\btitle odds\b/,
    verdict: 'Think of title odds as your chance to win the league title this season.',
    why: t => {
      const s = table(t, 'plan_summary');
      if (!s || s.rows[0].title_odds_now == null) return [];
      const r = s.rows[0];
      const out = [];
      // COACH-SHAPE-2: 0 means no simulated season ended in a title, not a certain 0.00%.
      if (r.title_odds_now === 0) {
        out.push(r.title_odds_upper_95 != null && r.sim_runs != null
          ? { text: `Yours now: no title in ${r.sim_runs} simulated seasons, so under ${pct(r.title_odds_upper_95)}.`,
            cites: [s.cite(0, 'title_odds_now'), s.cite(0, 'sim_runs'), s.cite(0, 'title_odds_upper_95')] }
          : { text: 'Yours now: no simulated season ended in a title for your team.', cites: [s.cite(0, 'title_odds_zero')] });
      } else out.push({ text: `Yours now: ${pct(r.title_odds_now)} chance of winning the title.`, cites: [s.cite(0, 'title_odds_now')] });
      if (r.metric_label && r.metric_label !== 'Title odds') out.push({ text: `This league's plan chases ${r.metric_label.toLowerCase()} instead.`, cites: [s.cite(0, 'metric_label')] });
      return out;
    } }
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

/** True when the question names a term with a $0 definition. */
export const hasTerm = question => TERMS.some(t => t.rx.test(String(question ?? '').toLowerCase()));

/**
 * The $0 CHAT answer (COACH-SHAPE-2): a verb-first line that keeps the conversation useful, and the
 * served next move as the one why line when there is one (cited, so verify.js holds it).
 */
export async function chatReply({ question, leagueId = null } = {}) {
  const q = String(question ?? '').toLowerCase();
  const lead = THANKS.test(q) ? 'Anytime' : LAUGH.test(q) ? 'Glad that landed' : 'Got it';
  const ledger = newLedger();
  let why = [];
  if (leagueId != null) {
    try {
      await preloadContext({ leagueId, ledger });
      const s = table(ledger, 'plan_summary');
      const m = table(ledger, 'plan_moves');
      if (s?.rows[0]?.next_move === 'served' && m?.rows[0]?.partner_label) {
        const drafted = [{ text: `Your next move: the served offer to ${m.rows[0].partner_label}.`, cites: [m.cite(0, 'partner_label')] }];
        why = groundStarter(drafted, ledger).claims;
      }
    } catch (e) { console.warn(`[coach] chat reply: the plan could not be read (${e?.message ?? e})`); }
  }
  if (!why.length) why = [{ text: 'Answers from your plan cost nothing.', cites: [] }];
  const verdict = `Ask me next about your move, a target or your lineup (${lead.toLowerCase()}).`;
  return { answer: { claims: why.filter(w => w.cites.length), refusals: [], as_of: null, shape: shaped(verdict, why, question, { basis: 'small talk' }) },
    ledger: ledger.toJson(), verification: { ok: true, violations: [], warnings: [], numbers_checked: 0, deterministic: true, intent: 'chat', question } };
}
