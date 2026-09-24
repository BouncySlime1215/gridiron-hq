/**
 * Assemble one reasoning panel from the card, its facts, and what the model
 * wrote (or did not). Every section is a WAR-ROOM-UI 2.2 typed field: a
 * `failed` or `unknown` section carries no value, and its reason has no
 * digits, so the card can render it as the design says (grey or red, words
 * only). The verify.js detail lives in `grounding`, for the log and the
 * grader, not on screen.
 */
export const PRODUCER = 'reasoning';
export const PRODUCER_VERSION = '1';
/** Below this many logged offers from him, P(yes) is shown as thin. */
export const THIN_OFFERS = 5;

export const MODEL_SECTIONS = Object.freeze(['case_for', 'his_side', 'devils_advocate', 'news_check', 'counter']);
export const SECTIONS = Object.freeze([...MODEL_SECTIONS.slice(0, 4), 'confidence', 'counter']);

export function field({ status, value, reason, asOf, source = 'coach.text', n }) {
  const f = { status, producer: PRODUCER, producer_version: PRODUCER_VERSION, source, as_of: asOf };
  if (value !== undefined && status !== 'failed' && status !== 'unknown') f.value = value;
  if (reason) f.reason = reason;
  if (n != null) f.n = n;
  return f;
}

/** Section 5: straight from the fields, never through the model. */
export function confidenceSection(card, league, asOf) {
  const cal = league.calibration?.['clone.accept'] ?? {};
  const partner = league.partners?.[card.partner_team] ?? {};
  const n = card.p_yes_n ?? (typeof partner.offers_logged === 'number' ? partner.offers_logged : null);
  if (card.p_yes == null) {
    return field({ status: 'unknown', asOf, source: 'clone.accept', reason: 'The plan has no chance-he-says-yes for this card.' });
  }
  const calibrated = cal.calibrated === true;
  const value = {
    p_yes: card.p_yes, p_yes_n: n, p_yes_basis: card.p_yes_basis,
    calibrated, calibration_status: cal.status ?? 'not reported',
    title_delta: card.title_delta, title_delta_se: card.title_delta_se, clears_2se: card.clears_2se,
    why: [
      n == null ? 'No count of his past offers came with this plan, so the chance rests on the market alone.'
        : n < THIN_OFFERS ? 'Few of his offers are on record, so the chance is thin.'
          : 'Enough of his offers are on record to read his price.',
      calibrated ? 'The trade model has passed its calibration check.'
        : 'The trade model has not passed its calibration check yet, so treat the chance as a guess.',
      card.clears_2se === true ? 'The title-odds gain clears the noise.'
        : card.clears_2se === false ? 'The title-odds gain is inside the noise.' : 'The plan did not say whether the gain clears the noise.'
    ].join(' ')
  };
  const thin = n == null || n < THIN_OFFERS;
  return field({ status: thin ? 'thin' : 'ok', value, asOf, source: 'clone.accept', n: n ?? undefined });
}

const REASON_FOR = Object.freeze({
  capped: "Today's reasoning allowance for this league is spent. It resets at midnight.",
  failed_call: 'The reasoning call failed, so this section was not written.',
  unparsed: 'The reasoning reply could not be read, so this section was not written.',
  not_returned: 'The reasoning reply left this card out.',
  dry_run: 'Dry run: no reasoning call was made.',
  ungrounded: 'This section failed its fact check (a number or cite it used is not in the plan), so it is hidden.',
  no_reply_table: 'The plan has no reply table for this card yet.',
  no_partner: 'The plan has nothing on his roster, values or moves yet.'
});

/**
 * @param {object} args
 * @param {object} args.card, args.league, args.news
 * @param {string[]} args.omit          sections left out on purpose (reason keys in omitReason)
 * @param {object|null} args.grounded   groundSections() output, or null when nothing was written
 * @param {string|null} args.missing    REASON_FOR key when nothing was written
 */
export function assemblePanel({ card, league, news, omit, omitReason, grounded, missing, asOf, fingerprint, cost }) {
  const sections = {};
  const grounding = {};
  const newsIds = news.map(n => String(n.id));

  for (const name of MODEL_SECTIONS) {
    if (omit.includes(name)) {
      sections[name] = field({ status: 'unknown', asOf, reason: REASON_FOR[omitReason[name]] });
      continue;
    }
    if (name === 'news_check' && !news.length) {
      sections[name] = field({ status: 'ok', asOf, value: { window_hours: 48, checked: 0, contradictions: [] } });
      continue;
    }
    if (!grounded) {
      sections[name] = field({ status: 'unknown', asOf, reason: REASON_FOR[missing] });
      continue;
    }
    const g = grounded[name];
    grounding[name] = { ok: g.ok, violations: g.violations, numbers_checked: g.numbers_checked };
    if (!g.ok) {
      sections[name] = field({ status: 'failed', asOf, reason: REASON_FOR.ungrounded });
      continue;
    }
    const value = name === 'news_check'
      ? { window_hours: 48, checked: news.length, contradictions: g.value.contradictions }
      : g.value;
    sections[name] = field({ status: 'ok', asOf, value });
  }
  sections.confidence = confidenceSection(card, league, asOf);

  // News the model did not get to read counts against the card: a story in
  // the window that nobody checked is exactly when to look before sending.
  const news_ = sections.news_check;
  const quoteIds = news_.status === 'ok' ? news_.value.contradictions.map(c => c.quote_id) : newsIds;
  return {
    card_id: card.id, league_id: league.league_id, rank: card.rank, as_of: asOf, fingerprint,
    check_first: quoteIds.length > 0,
    check_first_quote_ids: quoteIds,
    sections,
    grounding,
    cost
  };
}
