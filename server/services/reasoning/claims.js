/**
 * REASON-02 grounding: every claim a reasoning panel shows becomes a stored,
 * checkable prediction with the rule that settles it.
 *
 * The prediction is read from what a claim CITES, never from its words.
 * REASON-01 already forces every claim to cite fact ids (ground.js), and a
 * fact id names a typed field, so the cite is the claim's machine-readable
 * meaning:
 *
 *   counter.likely citing reply.<i>.*   -> counter_with: he answers the offer
 *                                          with reply_table[i].reply (and, when
 *                                          the row names one, asks for .pos)
 *   any claim citing his.hole.<i>.*     -> wants_position: he adds a player at
 *                                          roster_holes[i].pos within the window
 *   each check_first quote id           -> check_first: the news touching a card
 *                                          player turned out to matter
 *
 * Everything else (the case for, our own pre-planned answer, conditionals in
 * would_change, claims citing only card numbers) is stored as `uncheckable`
 * with why, so coverage is measured rather than assumed. A section that failed
 * grounding or was never written showed no words, so it makes no claims.
 */
import { cardsForLeague } from './cards.js';

export const RULES = Object.freeze({
  counter_with: 'offer_reply_v1',
  wants_position: 'acquires_position_v1',
  check_first: 'news_material_v1',
  uncheckable: 'none'
});

/** Days after the panel's as_of that each rule waits for its evidence. */
export const WINDOW_DAYS = Object.freeze({ counter_with: 7, wants_position: 14, check_first: 10 });

const REPLIES = new Set(['counter', 'decline', 'accept']);
const REPLY_CITE = /^reply\.(\d+)\./;
const HOLE_CITE = /^his\.hole\.(\d+)\./;

const list = v => (Array.isArray(v) ? v : []);
const addDays = (iso, days) => new Date(Date.parse(iso) + days * 86400000).toISOString();

function claimsOfSection(name, value) {
  if (name === 'counter') return [value?.likely, value?.answer];
  if (name === 'devils_advocate') {
    return [...list(value?.claims).map(c => ({ c })), ...list(value?.would_change).map(c => ({ c, conditional: true }))];
  }
  return list(value?.claims);
}

function citeIndex(cites, re) {
  for (const id of list(cites)) {
    const m = re.exec(String(id));
    if (m) return Number(m[1]);
  }
  return null;
}

function predictionFor({ section, index, claim, conditional, card, partner }) {
  const team = card.partner_team == null ? null : String(card.partner_team);
  if (section === 'counter' && index === 1) return { kind: 'uncheckable', prediction: { why: 'own_action' } };
  if (conditional) return { kind: 'uncheckable', prediction: { why: 'conditional' } };
  if (section === 'counter' && index === 0) {
    const i = citeIndex(claim.cites, REPLY_CITE);
    const row = i == null ? null : card.reply_table[i];
    if (!team || !REPLIES.has(row?.reply)) return { kind: 'uncheckable', prediction: { why: 'no_checkable_cite' } };
    return {
      kind: 'counter_with',
      prediction: {
        partner_team: team, reply: row.reply, pos: typeof row.pos === 'string' ? row.pos : null,
        card_players: { give: card.give.map(String), get: card.get.map(String) }
      }
    };
  }
  const h = citeIndex(claim.cites, HOLE_CITE);
  const pos = h == null ? null : list(partner?.roster_holes)[h]?.pos;
  if (team && typeof pos === 'string' && pos) return { kind: 'wants_position', prediction: { team, pos } };
  return { kind: 'uncheckable', prediction: { why: 'no_checkable_cite' } };
}

function row({ panel, card, section, index, text, cites, kind, prediction }) {
  return {
    league_id: panel.league_id, card_id: String(panel.card_id), fingerprint: String(panel.fingerprint ?? ''),
    section, claim_index: index, claim_text: String(text ?? ''), cites: list(cites).map(String),
    made_at: panel.as_of, kind, subject_team: card.partner_team == null ? null : String(card.partner_team),
    prediction, resolve_rule: RULES[kind],
    resolve_by: kind === 'uncheckable' ? null : addDays(panel.as_of, WINDOW_DAYS[kind])
  };
}

function checkFirstRows({ panel, card, league }) {
  const news = panel.sections?.news_check;
  const said = new Map(news?.status === 'ok'
    ? list(news.value?.contradictions).map(c => [String(c.quote_id), c.claim]) : []);
  const onCard = new Set([...card.give, ...card.get].map(String));
  return list(panel.check_first_quote_ids).map((qid, index) => {
    const id = String(qid);
    const item = list(league.news).find(n => String(n?.id) === id);
    const players = list(item?.player_ids).map(String).filter(p => onCard.has(p));
    const claim = said.get(id);
    const base = { panel, card, section: 'check_first', index,
      text: claim?.text ?? 'News in the window was not checked against this card',
      cites: claim?.cites ?? [`news.${id}.headline`] };
    return players.length
      ? row({ ...base, kind: 'check_first', prediction: { quote_id: id, player_ids: players } })
      : row({ ...base, kind: 'uncheckable', prediction: { why: 'no_card_player', quote_id: id } });
  });
}

/** Every claim one panel showed, each as a prediction row (not yet stored). */
export function claimsFromPanel({ panel, card, league }) {
  const partner = league.partners?.[card.partner_team] ?? null;
  const out = [];
  for (const section of ['case_for', 'his_side', 'devils_advocate', 'counter']) {
    // A failed or unknown section carries no value (panel.js field()), so it
    // yields no claims here without a separate status check.
    claimsOfSection(section, panel.sections?.[section]?.value).forEach((entry, index) => {
      const claim = entry?.c ?? entry;
      if (!claim || typeof claim !== 'object' || typeof claim.text !== 'string') return;
      const p = predictionFor({ section, index, claim, conditional: Boolean(entry?.conditional), card, partner });
      out.push(row({ panel, card, section, index, text: claim.text, cites: claim.cites, ...p }));
    });
  }
  out.push(...checkFirstRows({ panel, card, league }));
  return out;
}

/**
 * Store every claim of every panel. A reused panel (same fingerprint) is a
 * no-op; a panel whose card is gone from the plans is reported in `unmatched`.
 */
export function recordClaims(database, { plans, panels, now = new Date(), leagueId = null }) {
  const byLeague = new Map(list(plans?.leagues).map(l => [String(l.league_id), l]));
  const ins = database.prepare(`INSERT OR IGNORE INTO reasoning_claims
    (league_id, card_id, fingerprint, section, claim_index, claim_text, cites_json, made_at, kind,
     subject_team, prediction_json, resolve_rule, resolve_by, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const created = now.toISOString();
  let inserted = 0;
  let skipped = 0;
  const unmatched = [];
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const l of list(panels?.leagues)) {
      if (leagueId != null && String(l.league_id) !== String(leagueId)) continue;
      const league = byLeague.get(String(l.league_id));
      const cards = league ? cardsForLeague(league).cards : [];
      for (const panel of list(l.panels)) {
        const card = cards.find(c => String(c.id) === String(panel.card_id));
        if (!card || !panel.as_of) { unmatched.push({ league_id: l.league_id, card_id: panel.card_id }); continue; }
        for (const r of claimsFromPanel({ panel: { ...panel, league_id: l.league_id }, card, league })) {
          const res = ins.run(r.league_id, r.card_id, r.fingerprint, r.section, r.claim_index, r.claim_text,
            JSON.stringify(r.cites), r.made_at, r.kind, r.subject_team, JSON.stringify(r.prediction),
            r.resolve_rule, r.resolve_by, r.kind === 'uncheckable' ? 'uncheckable' : 'open', created);
          if (res.changes) inserted += 1; else skipped += 1;
        }
      }
    }
    database.exec('COMMIT');
  } catch (e) {
    database.exec('ROLLBACK');
    throw e;
  }
  return { inserted, skipped, unmatched };
}
