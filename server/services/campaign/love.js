/**
 * LOVE-RULE (ONE-PLAN section 5 night 5, section 4d night 5): a BUY / PASS / AVOID tag on a
 * buy-low candidate, from three things only:
 *   - usage: WR/TE target SHARE (sticky, r 0.82 y/y in our data, spot-check row 2); RB/QB
 *     ffopportunity expected points per game ("usage through week N");
 *   - draft capital: `overall_pick` from DRAFT-ID-MAP (unknown when that read is off);
 *   - a healthy role: the injury report now, radar role flags once #377 is merged.
 *
 * Luck (actual minus expected points) is ONE sentence with weight 0 (CT-29). TD-over-expected is
 * a sell-high LABEL with weight 0 (spot-check row 1: 79% of 10+ TD seasons regress). Neither is
 * read by `loveTag`'s decision; test/love-rule.test.js sweeps 2,000 players to prove it.
 *
 * A TAG only, never a search constraint (section 7 parks that). SHADOW behind GRIDIRON_LOVE_TAG:
 * the producer writes `_run.inputs.love` and nothing served reads it. Every tag is 'ungraded'
 * until the luck-free r52 re-run gives a held-out hit rate with a CI.
 */

export const LOVE_ENV = 'GRIDIRON_LOVE_TAG';
export const loveEnabled = (env = process.env) => env[LOVE_ENV] === '1';

/** Every threshold the rule judges with, in one place, so a local run can print exactly what it used. */
export const LOVE_RULE = Object.freeze({
  version: 1,
  basis: 'GUESS: thresholds set by hand before any league-4 measurement; graded by the luck-free r52 re-run',
  min_games: 2,
  // [weak below, strong at or above]; share for WR/TE, expected points per game for RB/QB.
  usage: Object.freeze({
    WR: Object.freeze({ input: 'target_share', weak: 0.12, strong: 0.20 }),
    TE: Object.freeze({ input: 'target_share', weak: 0.10, strong: 0.17 }),
    RB: Object.freeze({ input: 'expected_ppg', weak: 7, strong: 12 }),
    QB: Object.freeze({ input: 'expected_ppg', weak: 12, strong: 17 }),
  }),
  // overall_pick: early at or before, late after (a 10-team league: rounds 1-3 and 11+).
  draft: Object.freeze({ early: 30, late: 100 }),
  // Injury report statuses that make the role unhealthy now.
  unhealthy_reports: Object.freeze(['out', 'doubtful', 'ir', 'injured reserve', 'pup', 'suspended']),
  luck_even_ppg: 1.5,
  sell_high_tds: 2,
});

const UNGRADED = Object.freeze({ status: 'ungraded',
  reason: 'the luck-free r52 re-run (r52 harness without the LUCK regressor) has not run yet; it needs the local fit' });

const r1 = x => Math.round(x * 10) / 10;
const pct = x => `${Math.round(x * 100)}%`;
const finite = x => typeof x === 'number' && Number.isFinite(x);

function usageOf(p) {
  const rule = LOVE_RULE.usage[p.position];
  if (!rule) return { level: 'unknown', basis: `no usage rule for position ${p.position ?? 'unknown'}` };
  if (!((p.games ?? 0) >= LOVE_RULE.min_games)) {
    return { level: 'unknown', basis: `${p.games ?? 0} prior games of usage, fewer than ${LOVE_RULE.min_games}` };
  }
  const v = p[rule.input];
  const label = rule.input === 'target_share' ? 'target share' : 'expected points per game';
  if (!finite(v)) return { level: 'unknown', basis: `${label} not read` };
  const shown = rule.input === 'target_share' ? pct(v) : r1(v);
  const level = v >= rule.strong ? 'strong' : v < rule.weak ? 'weak' : 'mid';
  return { level, basis: `${label} ${shown} through ${p.through ?? 'unknown'} (${p.games} games)`, value: v };
}

function draftOf(p) {
  if (!finite(p.overall_pick)) return { level: 'unknown', basis: 'draft capital not read' };
  const { early, late } = LOVE_RULE.draft;
  const level = p.overall_pick <= early ? 'early' : p.overall_pick > late ? 'late' : 'mid';
  return { level, basis: `overall pick ${p.overall_pick}` };
}

function roleOf(p) {
  const role = p.role ?? { status: 'unknown' };
  const report = role.report_status ?? null;
  if (role.status === 'unhealthy') return { level: 'unhealthy', basis: `role not healthy: ${report ?? 'radar flag'}` };
  if (role.status === 'healthy') return { level: 'healthy', basis: report ? `on the report as ${report}, still active` : 'healthy role' };
  return { level: 'unknown', basis: 'role not read' };
}

/** Actual minus expected points per game: one sentence, weight 0. Null when either side is missing. */
function luckSentence(p) {
  if (!finite(p.actual_ppg) || !finite(p.expected_ppg)) return null;
  const d = p.actual_ppg - p.expected_ppg;
  const over = `${p.games} games`;
  if (Math.abs(d) < LOVE_RULE.luck_even_ppg) {
    return `Scoring about what his usage predicts (${r1(p.actual_ppg)} vs ${r1(p.expected_ppg)} expected over ${over}); luck, weight 0 in the tag.`;
  }
  return `Scoring ${r1(Math.abs(d))} pts/g ${d > 0 ? 'above' : 'below'} his expected ${r1(p.expected_ppg)} over ${over}; luck, weight 0 in the tag.`;
}

/** TDs over expected: a sell-high label, weight 0. */
function sellHigh(p) {
  if (!finite(p.actual_tds) || !finite(p.expected_tds)) return null;
  const d = p.actual_tds - p.expected_tds;
  if (d < LOVE_RULE.sell_high_tds) return null;
  return { label: 'sell_high', text: `+${r1(d)} TDs over expected: most 10+ TD seasons regress (79% in our data); label only, weight 0` };
}

/**
 * @param p { player, position, games, through, target_share, expected_ppg, overall_pick, role,
 *            actual_ppg?, expected_tds?, actual_tds? }  (actual_* feed the sentence and label only)
 * @param opts.grade optional { status: 'graded', hit_rate, ci, n } from the luck-free r52 re-run
 * @returns { player, tag: 'BUY'|'PASS'|'AVOID'|'UNRATED', reasons, usage, draft, role, luck, sell_high, grade, rule_version }
 */
export function loveTag(p, { grade = UNGRADED } = {}) {
  const usage = usageOf(p), draft = draftOf(p), role = roleOf(p);
  let tag;
  if (role.level === 'unhealthy') tag = 'AVOID';
  else if (usage.level === 'unknown') tag = 'UNRATED';
  else {
    const score = { strong: 2, mid: 1, weak: 0 }[usage.level] + { early: 1, mid: 0, unknown: 0, late: -1 }[draft.level];
    tag = score >= 2 ? 'BUY' : usage.level === 'weak' && draft.level !== 'early' ? 'AVOID' : 'PASS';
    // An unread role cannot earn a BUY: it caps at PASS and says why.
    if (tag === 'BUY' && role.level === 'unknown') tag = 'PASS';
  }
  return {
    player: p.player, tag, reasons: [usage.basis, draft.basis, role.basis],
    usage: { level: usage.level, basis: usage.basis }, draft, role,
    luck: luckSentence(p), sell_high: sellHigh(p), grade, rule_version: LOVE_RULE.version,
  };
}

/**
 * For `_run.inputs.love`: ids and counts only (the repo is public; no names).
 * @param inputs readLoveInputs() result: { players: Map id -> input, sources }
 */
export function loveSummary(inputs, { grade = UNGRADED } = {}) {
  const tags = [...inputs.players.values()].map(p => loveTag(p, { grade }));
  const counts = { BUY: 0, PASS: 0, AVOID: 0, UNRATED: 0 };
  for (const t of tags) counts[t.tag]++;
  return {
    lane: 'shadow', rule_version: LOVE_RULE.version, rule_basis: LOVE_RULE.basis, grade, counts,
    sources: inputs.sources ?? {},
    tags: tags.map(t => ({ player: t.player, tag: t.tag, reasons: t.reasons, luck: t.luck, sell_high: t.sell_high?.text ?? null })),
  };
}

/** The players a plans entry shows: targets, flip rows, the next move's and alternatives' targets. */
export function loveIdsOf(entry) {
  const v = f => (f?.status === 'ok' ? f.value : null);
  const ids = [
    ...(v(entry.targets) ?? []).map(t => t.player),
    ...(v(entry.flip_map) ?? []).map(f => f.player),
    v(entry.next_move)?.target,
    ...(v(entry.alternatives) ?? []).map(m => m.target),
  ];
  return [...new Set(ids.filter(id => id != null).map(Number))];
}
