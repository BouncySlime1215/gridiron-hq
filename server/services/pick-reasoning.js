/**
 * Every pick, in English, with an honest account of what actually drove it.
 *
 * The blind audit records that the model took Cleveland +3.5 and lost. That is
 * a result, not a reason, and a hundred of them tell you the model is bad
 * without telling you anything about WHY — which is the only thing that leads to
 * a better model. This turns each pick into a paragraph you can argue with.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DISTINCTION THIS FILE EXISTS TO PRESERVE
 *
 * There are two completely different things a reasoning trace can contain, and
 * conflating them is how explanation becomes theatre:
 *
 *   WHAT DROVE THE PICK. The ensemble's component models and their weights.
 *   These are causal: change them and the number changes. Attribution here is
 *   real arithmetic, and it is reported as a share of the projected margin.
 *
 *   WHAT WAS TRUE AT THE TIME. Cover records, efficiency gaps, rest, weather,
 *   division. The model does NOT read most of these. They are context that helps
 *   a human judge the pick, and presenting them as reasons would be inventing a
 *   rationale the machine never had — the single most common failure of every
 *   "explainable AI" layer ever bolted onto a model after the fact.
 *
 * So the output separates them explicitly and labels the second as descriptive.
 * When the context disagrees with the pick, that is stated too: it is the most
 * useful line in the whole trace, because it is where a human might override,
 * and it is also the evidence for whether a feature is worth adding as an input.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO TOKENS
 *
 * Deterministic templates, the same approach as decision-basis.js. Three
 * reasons: an explanation that costs money per pick will not be run over 1,400
 * of them; an explanation that varies between runs cannot be diffed to see what
 * changed; and a language model asked to justify a number will always produce a
 * confident justification, including for a number that came from a bug.
 */
import { spreadContext } from './nfl-spread-context.js';
import { explainPick as factorExplain } from './nfl-reasoning.js';

const r1 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(1));
const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));

/** Points, as a phrase, with the sign expressed in words rather than symbols. */
const pts = v => `${Math.abs(v).toFixed(1)} point${Math.abs(v) === 1 ? '' : 's'}`;

/**
 * Explain one spread or total pick.
 *
 * @param pick    the replayed bet: market, side, line, model_margin,
 *                market_margin, edge, disagreement, home, away, season, week
 * @param models  the ensemble's per-model rows, when available. Without them the
 *                trace still explains the edge; it just cannot attribute it.
 */
export function explainPick(pick, { models = null, includeContext = true } = {}) {
  if (!pick || pick.model_margin == null || pick.market_margin == null) {
    return { error: 'a pick needs both a model number and a market number to be explained' };
  }

  const { season, week, home, away, market = 'spread' } = pick;
  const edge = pick.model_margin - pick.market_margin;
  const backingHome = pick.side === home || edge > 0;

  /* ------------------------------------------------ what drove the pick */
  // The market decides WHICH component field the projection was built from.
  //
  // A totals bet stores the projected TOTAL in `model_margin` — the replay reuses
  // the field name for both markets — so attributing margin components to it
  // reconstructs to a completely different number. That is not a cosmetic
  // mismatch: it would have printed "these three models produced this line"
  // beneath a line those models had nothing to do with, which is precisely the
  // invented rationale this file exists to avoid. The verification check caught
  // it at 112 of 157 picks, which is the check earning its place.
  const drivers = attribute(models, pick.model_margin, market);

  /* ------------------------------------------- what was true at the time */
  const ctx = includeContext && season && week && home && away
    ? spreadContext(season, week, home, away)
    : null;

  const sentences = [];

  // 1. The call itself, in the terms a bettor uses.
  sentences.push(
    market === 'spread'
      ? `Took ${pick.side} ${pick.line > 0 ? '+' : ''}${pick.line}. The market made it ` +
        `${Math.abs(pick.market_margin).toFixed(1)} for the ${pick.market_margin > 0 ? 'home' : 'away'} ` +
        `side; the model projected ${Math.abs(pick.model_margin).toFixed(1)}, a disagreement of ${pts(edge)}.`
      : `Took the ${pick.side} ${pick.line}. The model projected ${r1(pick.model_margin)} against a ` +
        `market number of ${r1(pick.market_margin)}, a disagreement of ${pts(edge)}.`
  );

  // 2. Where the number came from — causal, when the components are available.
  if (drivers.available) {
    const top = drivers.contributions.slice(0, 3);
    sentences.push(
      `That projection is a weighted blend of ${drivers.count} component models. ` +
      top.map(d => `${d.model} (${Math.round(d.weight * 100)}% of the weight, ${r1(d.margin)})`).join(', ') +
      ` carried most of it.`
    );
    sentences.push(
      drivers.spread_points != null && drivers.spread_points > Math.abs(edge)
        ? `The components scatter by ${pts(drivers.spread_points)}, which is wider than the ` +
          `${pts(edge)} they collectively disagree with the market by. The models argue among ` +
          'themselves more than they argue with the price, so this edge is weak evidence.'
        : `The components scatter by ${pts(drivers.spread_points ?? 0)}, narrower than their ` +
          `${pts(edge)} disagreement with the market — they agree with each other and disagree ` +
          'with the price, which is the shape a real edge has.'
    );
  } else {
    sentences.push(
      'Component contributions were not recorded for this pick, so the number can be reported but ' +
      'not attributed. Only the edge against the market is explainable here.'
    );
  }

  /* ------------------------------------- the variables the model does read */
  // Folded in rather than shipped alongside. `nfl-reasoning.js` compares the two
  // teams on the feature variables the ensemble is actually built from, which
  // makes it a third category between the two this file separates: not the exact
  // weights, but not unrelated context either. Two parallel explanations of the
  // same pick, each unaware of the other, is how a reader ends up trusting
  // whichever one they happened to open.
  let factors = null;
  if (season && week && home && away) {
    try {
      const f = factorExplain({
        season, week, market, pickTeam: backingHome ? home : away,
        oppTeam: backingHome ? away : home, side: pick.side, line: pick.line
      });
      factors = {
        supporting: (f?.supporting ?? []).slice(0, 4),
        opposing: (f?.opposing ?? []).slice(0, 4),
        considered: f?.factors_considered ?? f?.considered ?? null,
        market_agreement: f?.market_agreement ?? null
      };
    } catch { /* the trace stands without it */ }
  }

  /* ---------------------------------------------------- context, labelled */
  const contextNotes = [];
  const agreements = [];
  const disagreements = [];

  if (ctx && !ctx.game?.insufficient) {
    const backed = backingHome ? ctx.home_ats : ctx.away_ats;
    const other = backingHome ? ctx.away_ats : ctx.home_ats;
    const backedName = backingHome ? home : away;
    const otherName = backingHome ? away : home;

    if (!backed?.insufficient && backed.overall?.avg_cover_margin != null) {
      const m = backed.overall.avg_cover_margin;
      // Said in the direction it actually went. "Beating the number by an
      // average of -7.0 points" is arithmetically fine and reads as gibberish;
      // a negative cover margin means they MISSED the number, and the sentence
      // should say so.
      contextNotes.push(
        `${backedName} has gone ${backed.overall.record} against the number this season, ` +
        `${m >= 0 ? 'beating' : 'missing'} it by an average of ${Math.abs(m).toFixed(1)} points.`);
      (m > 1 ? agreements : m < -1 ? disagreements : contextNotes)
        .push(`${backedName}'s season-long cover margin ${m > 0 ? 'supports' : 'runs against'} this side.`);
    }
    if (!other?.insufficient && other.overall?.avg_cover_margin != null) {
      contextNotes.push(
        `${otherName} is ${other.overall.record} with a ${other.overall.avg_cover_margin.toFixed(1)} ` +
        'average cover margin.');
    }

    // The split that is actually specific to this game.
    const situational = backingHome ? backed?.home : backed?.away;
    if (situational && situational.games >= 3) {
      contextNotes.push(
        `${backedName} is ${situational.record} ${backingHome ? 'at home' : 'on the road'} ` +
        `(${situational.avg_cover_margin?.toFixed(1)} average).`);
    }

    // The efficiency gap, which is the piece with real predictive content.
    for (const [name, eff] of [[home, ctx.home_efficiency], [away, ctx.away_efficiency]]) {
      if (eff?.insufficient || eff?.gap == null) continue;
      if (Math.abs(eff.gap) < 0.25) continue;
      const line = `${name} ${eff.gap > 0
        ? 'has been playing better than its record against the number'
        : 'has been covering more than its play deserves'} ` +
        `(efficiency in the ${Math.round(eff.epa_percentile * 100)}th percentile, covering ` +
        `${Math.round(eff.ats_cover_rate * 100)}% of the time).`;
      contextNotes.push(line);
      const helpsUs = (name === (backingHome ? home : away)) === (eff.gap > 0);
      (helpsUs ? agreements : disagreements).push(line);
    }

    for (const n of ctx.game.situational_notes) contextNotes.push(capitalise(n) + '.');
  }

  /* ------------------------------------------------- the honest counter-case */
  const counter = [];
  if (Math.abs(edge) < 1) {
    counter.push('The edge is under a point, which is smaller than the model\'s own error on a ' +
      'typical game. A disagreement this size is not evidence of anything.');
  }
  if (drivers.available && drivers.spread_points != null && drivers.spread_points > Math.abs(edge)) {
    counter.push('The component models disagree with each other more than they disagree with the ' +
      'market, so the blend is averaging noise rather than concentrating a signal.');
  }
  if (disagreements.length) {
    counter.push(`The situation argues the other way: ${disagreements[0].replace(/\.$/, '')}.`);
  }
  counter.push('The closing line is the sharpest public forecast of a football game that exists. ' +
    'A model disagreeing with it is more often wrong than right, and this one has been measured ' +
    'wrong — see the sealed audit on simulator ATS.');

  if (factors?.supporting?.length) {
    sentences.push(
      `On the variables the model reads, the strongest support is ` +
      factors.supporting.slice(0, 2).map(f => f.label ?? f.factor ?? f.name).filter(Boolean).join(' and ') +
      (factors.opposing?.length
        ? `, against ${factors.opposing.slice(0, 2).map(f => f.label ?? f.factor ?? f.name).filter(Boolean).join(' and ')}.`
        : '.'));
  }

  return {
    pick: {
      market, side: pick.side, line: pick.line,
      model_number: r2(pick.model_margin), market_number: r2(pick.market_margin),
      edge: r2(edge), result: pick.result ?? null
    },
    // The two halves, kept apart on purpose.
    what_drove_it: {
      causal: true,
      ...drivers,
      explanation: sentences.slice(1).join(' ')
    },
    // Between the two: variables the ensemble is built from, compared between the
    // teams. Closer to causal than a cover record, but still a reconstruction
    // rather than the actual weights, so it is labelled as its own category.
    variables_the_model_reads: factors,
    what_was_true: {
      causal: false,
      note: 'Descriptive only. The model does not read cover records, rest days or weather — these ' +
        'are here so a human can judge the pick, and so that a feature which repeatedly disagrees ' +
        'with the model can be identified as worth adding as an actual input.',
      notes: contextNotes,
      agrees_with_pick: agreements,
      disagrees_with_pick: disagreements,
      net: agreements.length - disagreements.length
    },
    counter_case: counter,
    // The whole thing as one readable block, for a table cell or a log line.
    english: [sentences.join(' '),
      contextNotes.length ? `Context at the time: ${contextNotes.join(' ')}` : null,
      `Against it: ${counter[0]}`
    ].filter(Boolean).join('\n\n')
  };
}

/**
 * Real attribution: which component models produced this number.
 *
 * A weighted mean's attribution is exact — each model contributes
 * `weight × margin` to the total — so unlike most explanation layers this is
 * arithmetic rather than an approximation of one.
 */
function attribute(models, projected, market = 'spread') {
  const valueKey = market === 'total' ? 'total' : 'margin';
  const weightKey = market === 'total' ? 'total_weight' : 'margin_weight';

  if (!Array.isArray(models) || !models.length) {
    return { available: false, count: 0, contributions: [], spread_points: null, market };
  }
  const usable = models.filter(m =>
    Number.isFinite(m?.[valueKey]) && Number.isFinite(m?.[weightKey]) && m[weightKey] > 0);
  if (!usable.length) {
    return { available: false, count: 0, contributions: [], spread_points: null, market,
      why: `No component carried a usable ${valueKey} and ${weightKey}, so this ${market} pick ` +
        'cannot be attributed. Reporting the margin components here instead would name models that ' +
        'did not produce this number.' };
  }

  const total = usable.reduce((s, m) => s + m[weightKey], 0);
  const contributions = usable.map(m => ({
    model: m.model ?? m.id ?? 'unnamed',
    margin: r2(m[valueKey]),
    weight: r2(m[weightKey] / total),
    // Signed points this model put into the final number.
    contribution: r2((m[weightKey] / total) * m[valueKey])
  })).sort((a, b) => b.weight - a.weight);

  const margins = usable.map(m => m[valueKey]);
  const mean = margins.reduce((a, b) => a + b, 0) / margins.length;
  const sd = Math.sqrt(margins.reduce((s, v) => s + (v - mean) ** 2, 0) / margins.length);

  return {
    available: true,
    market,
    count: usable.length,
    contributions,
    // Reported in points rather than as a unitless number so it can be compared
    // directly against the edge, which is the comparison that matters.
    spread_points: r2(sd),
    // A check, not decoration: if these disagree the weights are not what the
    // projection was actually built from, and the attribution is a fiction.
    reconstructed: r2(contributions.reduce((s, c) => s + c.contribution, 0)),
    reconstruction_matches: projected == null ? null
      : Math.abs(contributions.reduce((s, c) => s + c.contribution, 0) - projected) < 0.5
  };
}

const capitalise = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Explain a whole week of picks at once. */
export function explainWeek(picks, { modelsByGame = null } = {}) {
  const out = (picks ?? []).map(p => {
    const key = `${p.home}|${p.away}`;
    const models = modelsByGame?.get?.(key) ?? modelsByGame?.[key] ?? null;
    const e = explainPick(p, { models });
    return e.error ? { pick: p, error: e.error } : e;
  });
  const withContext = out.filter(x => !x.error);
  return {
    picks: out,
    summary: {
      explained: withContext.length,
      attributable: withContext.filter(x => x.what_drove_it.available).length,
      context_agreed: withContext.filter(x => x.what_was_true.net > 0).length,
      context_disagreed: withContext.filter(x => x.what_was_true.net < 0).length
    },
    note: 'Where the descriptive context disagreed with the pick, that is recorded rather than ' +
      'smoothed over. A feature that disagrees with the model and is right more often than the ' +
      'model is a feature worth promoting to an actual input.'
  };
}
