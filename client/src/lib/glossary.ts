/**
 * ONE RECORD PER QUANTITY. Every label the app prints reads from here.
 *
 * The reason is a live defect, not a style preference. `floor` currently means
 * the 10th percentile of a single week in the trade engine and the 20th
 * percentile of a season on the career line, and both appear on one screen under
 * one word. A manager reading "floor 8.1" and "floor 11.4" has no way to know
 * those are different questions. A label written inline in a component is how
 * that happened, so a label written inline in a component is a bug.
 *
 * Each entry carries five things, and the last three are the ones that usually
 * go missing:
 *
 *   name       what a manager reads
 *   plain      one sentence, no statistics vocabulary (see BANNED below)
 *   raw        the server field or column this actually is, so the deep dive can
 *              show it as a footnote and an engineer can grep it
 *   unit       so a percentage never renders next to a points-per-game number
 *              with the same styling
 *   precision  decimal places. Fixed per quantity, because "8.1" and "8.13" on
 *              the same page read as two different measurements.
 *
 * WHAT THIS FILE IS NOT: it is not a place to state what a number means to your
 * team. "Good" and "bad" belong to the page. This file says what was measured.
 */

/**
 * Words that are never allowed in a `plain` sentence.
 *
 * Nick's rule, verbatim: explanations that "make sense to someone who never
 * deals with stats. Detailed but not like wtf." These are the words that read as
 * rigour to the person who wrote them and as noise to everyone else. The test
 * enforces this list, which is the only reason it stays true.
 */
export const BANNED_WORDS = [
  'percentile', 'distribution', 'prior', 'shrinkage', 'calibrated', 'variance',
  'posterior', 'quantile', 'stochastic', 'heteroskedastic', 'regression'
] as const;

/**
 * `percent` means the SERVER SENDS A FRACTION. Every percentage in this app
 * arrives 0-1 (`p_active`, `title_odds`, `title_delta`) and `formatValue`
 * multiplies. A server field that ever arrives already in percent must not be
 * given this unit, or it renders a hundred times too large — which is the kind
 * of error that looks like a model bug for a week.
 */
export type Unit = 'points' | 'points_per_game' | 'percent' | 'count' | 'rank' | 'weeks' | 'none';

export interface Term {
  /** What a manager reads. Sentence case, never a column name. */
  name: string;
  /** One sentence, plain words, no word from BANNED_WORDS. */
  plain: string;
  /** The server field this is. Shown only at the bottom of a deep dive. */
  raw: string;
  unit: Unit;
  /** Decimal places when this renders as a number. */
  precision: number;
}

/**
 * The terms, keyed by a stable id that components import by name.
 *
 * Keys are the id, NOT the raw column, precisely because two ids can share a raw
 * column shape and one raw name can mean two things — which is the `floor`
 * collision this file exists to end. Both floors are here, separately, under
 * names that say which is which.
 */
export const GLOSSARY = {
  projected_points: {
    name: 'Projected points (this week)',
    // Producer: server/services/lineup-brain.js:356 startSitWeekPoints() ->
    // `week_points` (:363) = current_week_ppg (already times his chance to
    // play, 0 on a bye) x the betting-line multiplier when there is one. The
    // one week-total construction every page shares (lineup-posture.js imports
    // it). Replaces the former start_score entry, which described the same
    // number under a second id; `projection.mean` was never a served field.
    // Not the season total at stats.projected_points — that is
    // projected_points_season below, a different number under a different key.
    plain: 'How many points we expect this player to score this week, after his chance to play is taken into account.',
    raw: 'lineup.week_points',
    unit: 'points', precision: 1
  },
  projected_points_season: {
    name: 'Projected points (season)',
    // Producer: server/routes/stats.js:98 statsFor() `projected_points: projPts`,
    // the `player_season_stats` row with kind = 'projected', written by
    // syncStats() from ESPN's full-season projection (statSourceId 1,
    // statSplitTypeId 0, `appliedTotal`) fetched from the `leaguedefaults`
    // endpoint — ESPN's default scoring, not this league's settings. Rendered
    // as "Proj pts" at PlayerCard.tsx:138 and StatTable.tsx:46. Same leaf name
    // as the weekly number, which is why it has its own key.
    plain: 'The points ESPN projects for this player over the whole season, scored the ESPN default way rather than by your league rules. It is not the number for this week.',
    raw: 'stats.projected_points',
    unit: 'points', precision: 0
  },
  week_floor: {
    name: 'Quiet week',
    // Producer: the assetUniverse() asset field `floor`,
    // server/services/trade-engine.js:462 `floor: weekDist?.p10 ?? w?.floor ?? null`.
    // Two producers serve it: (1) the week draw's p10, which includes the
    // chance he does not suit up at all, so it can be 0.0 for a healthy
    // starter; (2) when there is no week projection, server/routes/edge.js:145
    // volatility() `floor: +q(0.2)` (:164), the 20th percentile of LAST
    // season's played weeks only (did-not-play weeks are not in gamelog).
    // See r7-internal-glossary-defines-numbers-code-no-longer-makes.md #1.
    plain: 'A bad week for this player — the bottom one week in ten this week, which can mean he does not suit up at all. With no projection for this week yet, it is his bottom one in five of the games he played last season instead.',
    raw: 'asset.floor',
    unit: 'points', precision: 1
  },
  week_ceiling: {
    name: 'Big week',
    // Producer: same asset, trade-engine.js:462 `ceiling: weekDist?.p90 ?? w?.ceiling ?? null`;
    // fallback is edge.js volatility() `ceiling: +q(0.8)` (:165), last season.
    plain: 'A week that goes well for this player — about one week in ten looks like this or better. With no projection for this week yet, it is his top one in five of the games he played last season instead.',
    raw: 'asset.ceiling',
    unit: 'points', precision: 1
  },
  season_floor: {
    name: 'Preseason band (low)',
    // Producer: server/services/lineup-brain.js:187 `p20: r1(preseason.p20)`, a
    // FULL-SEASON TOTAL from the preseason model, frozen before Week 1 and never
    // updated in-season (rendered as "preseason X-Y pts" at
    // client/src/components/lineup/EvidenceStrip.tsx:111). There is no
    // `career.p20` anywhere in the server, and no rest-of-season or per-game
    // p20 is served — see r7-internal-glossary-defines-numbers-code-no-longer-
    // makes.md #2.
    plain: 'The low end of what our draft-day model expected for his whole season, before any games were played. It does not update in-season.',
    raw: 'evidence.preseason.p20',
    unit: 'points', precision: 1
  },
  chance_to_play: {
    name: 'Chance to play',
    plain: 'How likely this player is to be active on Sunday, from the injury report and how often he has played before.',
    raw: 'availability.p_active',
    unit: 'percent', precision: 0
  },
  title_odds: {
    name: 'Title chance',
    plain: 'How often your team wins the championship when we play the rest of the season out thousands of times.',
    raw: 'sim.title_odds',
    unit: 'percent', precision: 1
  },
  playoff_odds: {
    name: 'Playoff chance',
    plain: 'How often your team makes the playoffs when we play the rest of the season out thousands of times.',
    raw: 'sim.playoff_odds',
    unit: 'percent', precision: 1
  },
  title_delta: {
    name: 'Change in title chance',
    // Producer: server/services/season-sim.js:476 reuses one `pairedSeed` for
    // the before/after run, but the per-player draw order comes from `roster`
    // (:313), built from each team's OWN player-list order, which the trade
    // changes; that reorders `active` for correlatedSampler (:356). The same
    // seed does not guarantee the same player gets the same draw once the
    // roster order shifts, so this cannot yet promise the difference is purely
    // the move — see r7-internal-glossary-defines-numbers-code-no-longer-
    // makes.md #4 (assessed from R6's title-odds-pairing-broken finding).
    // No size is given for that noise: it has not been measured. Add a figure
    // only once season-sim's pairing noise is measured on a real run.
    plain: 'How much this move changes your championship number, from replaying the same simulated seasons before and after — figure some of the change is simulation noise rather than the move itself.',
    raw: 'trade_impact.title_delta',
    unit: 'percent', precision: 1
  },
  expected_wins: {
    name: 'Expected wins',
    // Producer: server/services/season-sim.js:126 `initialRecords` seeds the sim
    // from each team's REAL record (used at :364 `startingRecords`), and the
    // season total at :431 is summed on top of it. This is the season total
    // including games already played, not a rest-of-season count — see
    // r7-internal-glossary-defines-numbers-code-no-longer-makes.md #3.
    plain: 'How many games your team is on pace to win this season, counting the games you have already played.',
    raw: 'sim.expected_wins',
    unit: 'count', precision: 1
  },
  accept_chance: {
    name: 'Chance they say yes',
    plain: 'How likely this manager is to accept this offer, from what you have told us about how they trade and any offers they have actually answered.',
    raw: 'counterparty.accept',
    unit: 'percent', precision: 0
  },
  shotgun_rate: {
    name: 'Shotgun rate',
    plain: 'How often this offence lines the quarterback up several yards behind the ball, out of the plays the source tagged.',
    raw: 'nfl_play_by_play.shotgun',
    unit: 'percent', precision: 0
  },
  no_huddle_rate: {
    name: 'No-huddle rate',
    plain: 'How often this offence snaps the ball without stopping to huddle first.',
    raw: 'nfl_play_by_play.no_huddle',
    unit: 'percent', precision: 0
  },
  deep_rate: {
    name: 'Deep throw rate',
    plain: 'How often this offence throws the ball far down the field rather than short.',
    raw: "nfl_play_by_play.pass_depth = 'deep'",
    unit: 'percent', precision: 0
  },
  points_allowed_to_position: {
    name: 'Given up to this position',
    // Producer: server/services/matchups.js:189 `allowed: +allowed.toFixed(1)`
    // (there is no `ppg_allowed` field — rendered as "d.allowed" plus " ppg
    // allowed" at client/src/pages/TradeLab.tsx:1128). It blends recent seasons with a
    // 0.5 recency decay (constants at matchups.js:94-102), computed unshrunk at
    // :186 `const allowed = b.w ? b.wpts / b.w : 0` — only the `mult` column is
    // shrunk (:193, K_DVP=200). So it is not "so far" (this season only), and the module's
    // own header (matchups.js:9-14) says it was tested and did not make
    // projections more accurate — see r7-internal-glossary-defines-numbers-
    // code-no-longer-makes.md #6.
    plain: 'A blend of recent seasons of what this defence has given up to this position, with recent seasons counting more. We tested it and it did not make projections more accurate.',
    raw: 'matchups.dvp.allowed',
    unit: 'points_per_game', precision: 1
  }
} as const satisfies Record<string, Term>;

export type TermId = keyof typeof GLOSSARY;

/** The record for an id. Throws on an unknown id rather than rendering the id. */
export function term(id: TermId): Term {
  const t = GLOSSARY[id];
  if (!t) throw new Error(`no glossary entry for "${id}" — add one rather than writing the label inline`);
  return t;
}

const SUFFIX: Record<Unit, string> = {
  points: '', points_per_game: '/g', percent: '%', count: '', rank: '', weeks: ' wk', none: ''
};

/**
 * A number formatted the way its quantity is always formatted.
 *
 * `null` renders as an em dash, never as 0 or as an empty cell. A missing number
 * and a zero are different facts and this project has shipped the bug where they
 * looked the same.
 */
export function formatValue(
  id: TermId,
  value: number | null | undefined,
  { signed = false }: { signed?: boolean } = {}
): string {
  const t = term(id);
  if (value == null || !Number.isFinite(value)) return '—';
  const scaled = t.unit === 'percent' ? value * 100 : value;
  const sign = signed && scaled > 0 ? '+' : '';
  return sign + scaled.toFixed(t.precision) + SUFFIX[t.unit];
}
