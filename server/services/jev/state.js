/**
 * JEV-01a state builder: turn an engine snapshot view into the text Jev reads.
 *
 * Input is a snapshot view in the shape /api/engine/state serves (ENGINE-00a):
 *   { as_of, managers: [{id, name}], rows: [{id, entity_type, entity_id, field, value, as_of}],
 *     events: [{id, ts, type, entity_id, text}] }
 *
 * Two rules, both tested:
 *   1. As-of. Nothing stamped after `asOf` enters the pack, whatever the view
 *      carries; the drop count is returned so a leaky view is visible.
 *   2. No names. Managers are pseudonymised (the jevStateFor pattern,
 *      manager-archetypes.js:1254): their ids become MANAGER M<n> and their
 *      names are replaced wherever they appear in a value or an event's text.
 *      Players stay named (EA-08): Jev is asked about football, and the player
 *      is the subject.
 *
 * The pack cites the state rows and events it used, by id, so every answer's
 * reason_chain can name what Jev read.
 */

const ts = v => {
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`Jev state: unreadable timestamp "${v}"`);
  return t;
};

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** { id -> alias } plus a scrubber that replaces every manager name (and each part of it) with the alias. */
export function managerAliases(managers = []) {
  const byId = new Map();
  const subs = [];
  [...managers].sort((a, b) => String(a.id).localeCompare(String(b.id))).forEach((m, i) => {
    const alias = `MANAGER M${i + 1}`;
    byId.set(String(m.id), alias);
    const name = String(m.name ?? '').trim();
    if (!name) return;
    // Whole name first, then each word of it, so "Alex" alone is caught too.
    subs.push([name, alias]);
    for (const part of name.split(/\s+/)) if (part.length > 1) subs.push([part, alias]);
  });
  subs.sort((a, b) => b[0].length - a[0].length);
  const scrub = text => subs.reduce((s, [n, a]) => s.replace(new RegExp(`\\b${escapeRe(n)}\\b`, 'gi'), a), String(text));
  return { alias: id => byId.get(String(id)) ?? null, scrub };
}

function fmt(value) {
  if (value == null) return 'unknown';
  if (typeof value === 'number') return String(Math.round(value * 100) / 100);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function relevant(subject, entityType, entityId) {
  if (!subject) return true;
  if (entityType === 'league') return true;
  if (String(entityId) === String(subject.entity_id)) return true;
  if (subject.counterparty != null && String(entityId) === String(subject.counterparty)) return true;
  return !['player', 'offer'].includes(entityType); // team-level context stays in
}

/**
 * The pack for one subject at `asOf`: { text, stateIds, eventIds, dropped }.
 * `subject` = { entity_type, entity_id, label, counterparty? }.
 */
export function buildJevState(view, { asOf, subject } = {}) {
  if (!view) throw new Error('Jev state needs a snapshot view');
  const cut = ts(asOf ?? view.as_of);
  const { alias, scrub } = managerAliases(view.managers);
  const who = (type, id) => (type === 'league_team' ? (alias(id) ?? 'MANAGER ?') : String(id));

  const dropped = { rows: 0, events: 0 };
  const rows = [];
  for (const r of view.rows ?? []) {
    if (ts(r.as_of) > cut) { dropped.rows++; continue; }
    if (relevant(subject, r.entity_type, r.entity_id)) rows.push(r);
  }
  const events = [];
  for (const e of view.events ?? []) {
    if (ts(e.ts) > cut) { dropped.events++; continue; }
    if (relevant(subject, e.entity_type ?? (alias(e.entity_id) ? 'league_team' : 'player'), e.entity_id)) events.push(e);
  }
  rows.sort((a, b) => a.id - b.id);
  events.sort((a, b) => ts(a.ts) - ts(b.ts) || a.id - b.id);

  const lines = [`ENGINE STATE as of ${new Date(cut).toISOString()}. Redraft fantasy football (ESPN, PPR).`];
  if (subject) {
    const cp = subject.counterparty != null ? `, receiving manager ${alias(subject.counterparty) ?? 'MANAGER ?'}` : '';
    lines.push(`SUBJECT: ${scrub(subject.label)}${cp}.`);
  }
  lines.push('STATE ROWS (id | entity | field | value | as of):');
  for (const r of rows) {
    lines.push(`#${r.id} | ${r.entity_type} ${who(r.entity_type, r.entity_id)} | ${r.field} | ${scrub(fmt(r.value))} | ${r.as_of}`);
  }
  lines.push('EVENTS (id | time | type | about | text):');
  for (const e of events) {
    const about = alias(e.entity_id) ?? String(e.entity_id ?? '');
    lines.push(`#${e.id} | ${e.ts} | ${e.type} | ${about} | ${scrub(e.text ?? '')}`);
  }

  return { text: lines.join('\n'), stateIds: rows.map(r => r.id), eventIds: events.map(e => e.id), dropped };
}
