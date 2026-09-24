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

const panelIn = t => PANEL_WORDS.find(([, rx]) => rx.test(t))?.[0] ?? null;
const posIn = t => POS_WORDS.find(([, rx]) => rx.test(t))?.[0] ?? null;

export function routeIntent(raw) {
  const t = String(raw ?? '').toLowerCase().trim();
  if (!t || t.length > 200) return null;
  if (/\b(send|submit|propose it|message him|text him)\b/.test(t) && !/\b(card|panel)\b/.test(t)) {
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
