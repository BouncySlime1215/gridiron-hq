/**
 * WR-COACH fast path: plain screen commands that need no model call.
 *
 * "show me the flip map for league 3", "only RBs", "undo", "next" are routed
 * straight to Coach's War Room tools, so they apply instantly and spend
 * nothing. Anything this does not recognise returns null and goes to the
 * model as usual. A request to SEND anything returns a refusal: Coach never
 * sends to a league-mate.
 *
 * Returns { tool, input } (run it through runCoachTool), { refuse: reason }, or null.
 */
const PANEL_WORDS = [
  ['flip_map', /\bflip(s| map)?\b/],
  ['itinerary', /\b(stops?|route|itinerary)\b/],
  ['targets', /\btargets?\b/],
  ['catch_up', /\b(catch.?up|speed curve|behind)\b/],
  ['brain_check', /\b(brain( check)?|health)\b/],
  ['destination', /\bdestination\b/],
  ['cards', /\b(my cards|pins|tray)\b/],
  ['next_move', /\b(next move|the offer|the deal)\b/]
];
const POS_WORDS = [
  ['QB', /\b(qbs?|quarterbacks?)\b/], ['RB', /\b(rbs?|running ?backs?)\b/],
  ['WR', /\b(wrs?|receivers?|wideouts?)\b/], ['TE', /\b(tes|te|tight ?ends?)\b/]
];

/**
 * COACH-PARTNER: is Coach being asked to do the SENDING? "send it for me",
 * "submit it", "propose it on ESPN", "can you send it" are; "a trade to send to
 * <manager>" and "what should I send him" are not: there "send" is what Nick
 * will do, and the question asks for a trade idea.
 */
const SEND_VERBS = '(?:send|submit|propose|post|message|text|dm)';
const POLITE = /^(?:(?:ok(?:ay)?|yes|yeah|yep|sure|please|pls|plz|just|now|then|so|alright|hey|coach|go ahead and|can you|could you|would you|will you|can u|could u|would u|will u|you|u)[\s,]+)+/;
/** A question asking for a trade idea ("what trade would you send to X for me"): never a send request. */
const IDEA_QUESTION = /^(?:what|which|any|anything|gimme|give me|find|show me|is there|are there|got)\b/;
const IDEA_WORDS = /\b(?:trades?|offers?|deals?|packages?|ideas?)\b/;

export function asksCoachToSend(t) {
  if (IDEA_QUESTION.test(t) && IDEA_WORDS.test(t) && !/\b(?:send|submit|propose|post) (?:it|this|that|them)\b/.test(t)) return false;
  if (/\b(?:i want|i'?d like|i would like|i need) (?:you|u|coach) to (?:send|submit|propose|post|message|text|dm)\b/.test(t)) return true;
  if (/\b(?:you|u) should (?:send|submit|propose|post)\b/.test(t)) return true;
  if (/\bgo (?:send|submit|propose|post)\b/.test(t) || /\bhit send\b/.test(t)) return true;
  if (/\b(?:send|submit|propose|post|message|text|dm)(?: (?:it|this|that|them|him|her|the (?:offer|trade|deal|message|text)|my (?:offer|trade)))?(?: (?:to|over to) [\w' ]{1,30}?)? (?:for me|on my behalf)\b/.test(t)) return true;
  if (/\b(?:send|submit|propose|post)\b[^.?!]*\b(?:on|in|through|via|to) espn\b/.test(t) && !/\b(?:i|we)\b/.test(t)) return true;
  const bare = t.replace(POLITE, '');
  if (/^send me\b/.test(bare)) return false; // "send me a trade idea": Coach sends Nick an answer, not an offer.
  if (new RegExp(`^${SEND_VERBS}\\b`).test(bare) && bare !== t) return true;
  if (/^(?:send|submit|propose|post)\b/.test(t)) return true;
  return /^(?:message|text|dm) (?:him|her|them)\b/.test(bare);
}

const panelIn = t => PANEL_WORDS.find(([, rx]) => rx.test(t))?.[0] ?? null;
const posIn = t => POS_WORDS.find(([, rx]) => rx.test(t))?.[0] ?? null;

export function routeIntent(raw) {
  const t = String(raw ?? '').toLowerCase().trim();
  if (!t || t.length > 200) return null;
  if (asksCoachToSend(t) && !/\b(card|panel)\b/.test(t)) {
    return { refuse: "Coach never sends offers. Tap Copy on the message and send it yourself in ESPN." };
  }
  if (/^(undo|take (that|it) back|revert)\b/.test(t)) return { tool: 'warroom_view', input: { type: 'undo' } };
  if (/^(next|skip( this| it)?|show me another|another one|pass)\b/.test(t) && !/next move/.test(t)) {
    return { tool: 'warroom_view', input: { type: 'next' } };
  }
  if (/\b(reset|default) (the )?layout\b/.test(t)) return { tool: 'warroom_view', input: { type: 'reset_layout' } };
  const panel = panelIn(t);
  if (/\b(bigger|larger|more room|blow up)\b/.test(t) && panel) {
    return { tool: 'warroom_view', input: { type: 'arrange_layout', panel, size: 'large' } };
  }
  if (/\b(only|just)\b/.test(t) && posIn(t)) {
    return { tool: 'warroom_view', input: { type: 'filter', panel: panel ?? 'flip_map', position: posIn(t) } };
  }
  if (/\b(clear (the )?filter|all positions|show everyone)\b/.test(t)) {
    return { tool: 'warroom_view', input: { type: 'filter', panel: panel ?? 'flip_map', position: null } };
  }
  if (/\bsort by (chance|p\(yes\)|likely|yes)\b/.test(t)) {
    return { tool: 'warroom_view', input: { type: 'sort', panel: panel ?? 'flip_map', by: 'p_yes' } };
  }
  if (/^(why|explain)\b/.test(t)) return { tool: 'warroom_view', input: { type: 'explain', panel: panel ?? 'next_move' } };
  const league = t.match(/\bleague (\d{1,2})\b/);
  if (panel && /^(show|open|go to|bring up|pull up|take me to)\b/.test(t)) {
    return { tool: 'warroom_view', input: { type: 'focus_panel', panel, league: league ? Number(league[1]) : null } };
  }
  return null;
}
