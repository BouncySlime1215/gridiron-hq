/**
 * COACH-CHAIN view: a chain result (chain-engine.js#runChain) as the ChainView component's props
 * (client/src/components/coach/ChainView.tsx): { steps, hole, fills, totals, fills_note }.
 *
 * One producer, drawn as served: every label and number the card shows is written here from the chain's
 * own numbers; the component computes nothing. No ids reach the screen (a player with no name on file is
 * "a player"), no engine field names, every number carries its label, and a league-mate's team is only
 * ever its label (Coach and the card say "they").
 */

const S = x => String(x);
/** Rounded as verify.js reads a number, so the card and Coach's lines always print the same digits. */
const fixed = (x, d = 1) => (Math.round(x * 10 ** d) / 10 ** d).toFixed(d);
const signed = (x, d = 1) => `${x >= 0 ? '+' : ''}${fixed(x, d)}`;
const pct = x => `${fixed(x * 100)}%`;
const toneOf = x => (x > 0 ? 'good' : x < 0 ? 'bad' : 'neutral');

/** Nick's rule reasons (never-give.js RULE_REASONS, claim reasons) in his words. */
export const RULE_WORDS = Object.freeze({
  never_give: 'gives a player you never trade', never_get: 'gets a player you never take back',
  sold_this_season: 'buys back a player you sold this season', below_blue_chip: 'gets a player under your Blue chip floor',
  unscored: 'gets a player with no Blue chip score', no_fc_value: 'a player has no FantasyCalc value',
  overpay: 'you give more FantasyCalc value than you get', rules_unreadable: 'your rules could not be read',
  claim_not_flipped: 'the claimed player is kept, not flipped', protected_drop: 'the claim drops a player you protect',
  claim_sold: 'the claim brings back a player you sold', claim_overpay: 'the claim drops more value than it adds',
});

export function namer(res) {
  const names = res?.names ?? {};
  return id => names[S(id)] ?? 'a player';
}
const listOf = (ids, nm) => ids.map(nm).join(' + ');
const teamOf = (res, t) => res?.teams?.[S(t)] ?? 'another team';

/** One move in words: "A + B for C", a claim as "Claim X (drop Y)". */
export function moveText(m, nm) {
  if (m.claim) return `Claim ${listOf(m.get, nm)} (drop ${listOf(m.give, nm)})`;
  const trade = `${listOf(m.give, nm)} for ${listOf(m.get, nm)}`;
  return m.via_claim ? `${moveText(m.via_claim, nm)}, then ${trade}` : trade;
}

const chips = (lineup, playoff, { total = false } = {}) => [
  { label: 'Lineup', text: `${signed(total ? lineup.total_delta : lineup.step_delta)} pts/wk`, tone: toneOf(total ? lineup.total_delta : lineup.step_delta) },
  { label: 'Playoff odds', text: `${signed((total ? playoff.total_delta : playoff.step_delta) * 100)} pts`, tone: toneOf(total ? playoff.total_delta : playoff.step_delta) },
];

const chanceText = p => (p?.value != null ? `Chance they say yes: ${pct(p.value)} (estimate)` : null);

/** The hole in words: "RB1: Kyle Monangai, 10.7 pts/game, 10th of 10 teams". */
export function holeView(h, nm, { after = null } = {}) {
  if (!h) return null;
  const ord = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
  const who = h.player ? nm(h.player) : 'nobody';
  const repl = h.replacement ? `; best free agent ${fixed(h.replacement.ppg)} (${nm(h.replacement.player)})` : '';
  return {
    title: `${after ? `Hole after ${after}` : 'Your hole'}: ${h.label}`,
    detail: `${who}, ${fixed(h.ppg)} pts/game: ${ord(h.rank)} of ${h.of} teams; league median starter there ${fixed(h.league_median)}${repl}.`,
  };
}

function fillView(res, f, nm) {
  const title = f.kind === 'flip_claim' ? moveText({ ...f.steps[1], via_claim: { ...f.steps[0], claim: true } }, nm) : moveText(f, nm);
  return { title, partner: `with ${teamOf(res, f.team)}`, chips: chips(f.lineup, f.playoff), chance: chanceText({ value: f.p }),
    needs_ok: !!f.rules?.needs_ok, kind: f.kind === 'flip_claim' ? 'Flip claim' : 'Trade' };
}

/** Why there is no fill, in numbers Nick can act on. */
export function noFillNote(step, nm) {
  const r = step?.reach;
  const label = step?.hole?.label ?? 'the hole';
  if (!step || step.fills_status === 'ok') return null;
  if (/stops at/.test(step.fills_status ?? '')) return `The chain stops at three steps.`;
  const parts = [`No ${label} fill passes your rules and beats doing nothing.`];
  if (r?.cheapest?.value != null) parts.push(`Your three best tradable players are worth ${Math.round(r.top3_value).toLocaleString('en-US')} (FantasyCalc); the cheapest Blue chip who fits costs ${Math.round(r.cheapest.value).toLocaleString('en-US')} (${nm(r.cheapest.player)}).`);
  if (r?.hidden_by_rules) parts.push(`${r.hidden_by_rules} more who would fit are hidden by your rules.`);
  return parts.join(' ');
}

/** The ChainView props for a chain result. `{ error }` results render as the note alone. */
export function chainView(res) {
  if (!res || res.error) return { steps: [], hole: null, fills: [], totals: null, fills_note: res?.error ?? 'No chain.' };
  const nm = namer(res);
  const steps = res.steps.map(s => {
    if (s.error) return { index: s.index, source: s.source, title: moveText(s.move, nm), partner: '', chips: [], after: '', needs_ok: false, blocked: s.error, chance: null, send: null };
    const broken = s.rules && !s.rules.ok ? s.rules.reasons.map(r => RULE_WORDS[r] ?? 'breaks one of your rules') : [];
    const sendable = s.index === 1 && !broken.length && !s.rules?.needs_ok && !s.move.claim;
    return {
      index: s.index, source: s.source, title: moveText(s.move, nm),
      partner: s.move.claim ? 'waiver claim' : `with ${teamOf(res, s.move.team)}`,
      chips: chips(s.lineup, s.playoff),
      after: `After: ${fixed(s.lineup.after)} pts/wk, ${pct(s.playoff.after)} playoff odds`,
      needs_ok: !!s.rules?.needs_ok,
      blocked: broken.length ? `Breaks your rules: ${[...new Set(broken)].join('; ')}` : null,
      note: s.beats_previous ? null : 'Does not raise your odds on its own.',
      chance: chanceText(s.p),
      hole: holeView(s.hole, nm, { after: `step ${s.index}` }),
      send: s.index === 1 ? { enabled: sendable, text: `${listOf(s.move.give, nm)} for ${listOf(s.move.get, nm)}` } : null,
    };
  });
  const last = res.steps.filter(s => !s.error).at(-1) ?? null;
  const t = res.totals;
  const L = res.lookahead ?? null;
  // The lookahead's values are on the objective: odds (a fraction, said in points) or lineup points a week.
  const pts = L?.stats?.metric === 'points' ? x => `${signed(x ?? 0)} pts/wk` : x => `${signed((x ?? 0) * 100)} pts`;
  const odds = L?.stats?.metric === 'title' ? 'title odds' : L?.stats?.metric === 'points' ? 'lineup points' : 'playoff odds';
  // LOOKAHEAD: step 1 (Nick's move) also reads "with the best follow-ups", and the first moves ranked by what they set up.
  if (L?.yours && steps[0] && res.steps[0]?.source === 'you') {
    steps[0].chips = [...steps[0].chips,
      { label: 'With best follow-ups', text: pts(L.yours.if_yes_delta), tone: toneOf(L.yours.if_yes_delta) },
      { label: 'Expected', text: pts(L.yours.cont_delta), tone: toneOf(L.yours.cont_delta ?? 0) }];
  }
  const ids = l => l.map(S).sort().join();
  const sameMove = (x, y) => !!x && !!y && S(x.team) === S(y.team) && ids(x.give) === ids(y.give) && ids(x.get) === ids(y.get);
  const ranked = L ? L.first_moves.map((f, k) => ({ rank: k + 1, title: moveText(f.move, nm), partner: `with ${teamOf(res, f.move.team)}`,
    yours: !!f.yours || sameMove(f.move, L.yours?.move), needs_ok: !!f.move.needs_ok, chance: chanceText({ value: f.p }),
    chips: [{ label: 'Now', text: pts(f.now_delta), tone: toneOf(f.now_delta) },
      { label: 'With best follow-ups', text: pts(f.if_yes_delta), tone: toneOf(f.if_yes_delta) },
      { label: 'Expected', text: pts(f.cont_delta), tone: toneOf(f.cont_delta) }],
    then: f.line.slice(1).map(m => moveText(m, nm)) })) : [];
  return {
    ranked,
    baseline: L ? `Doing nothing now, then the best moves: ${pts(L.baseline.value_delta)} of ${odds} expected. Ranked by expected ${odds} after up to ${L.depth} moves, with each league-mate's chance to say yes counted.` : null,
    steps,
    hole: last ? holeView(last.hole, nm, { after: `step ${last.index}` }) : holeView(res.nothing?.hole, nm),
    fills: last && last.fills_status === 'ok' ? last.fills.map(f => fillView(res, f, nm)) : [],
    fills_note: last ? noFillNote(last, nm) : null,
    totals: t ? {
      title: `Whole chain vs doing nothing (${t.steps} step${t.steps === 1 ? '' : 's'})`,
      chips: chips({ total_delta: t.lineup.delta }, { total_delta: t.playoff.delta }, { total: true }),
      detail: `Lineup ${fixed(t.lineup.nothing)} to ${fixed(t.lineup.after)} pts/wk; playoff odds ${pct(t.playoff.nothing)} to ${pct(t.playoff.after)}.`,
      needs_ok: !!t.needs_ok,
    } : null,
  };
}
