/**
 * WARROOM-LABEL-FIX: a War Room trade card's odds label must read the league's own
 * objective, not assume "title". Bug (Nick, 2026-09-26): league 4 (goal=playoffs, set via
 * objective.set goal=playoffs) showed "Title odds if he says yes" while the number
 * underneath was the playoff delta.
 *
 * The fix: campaign/view.js exposes `destination.goal.metric` / `metric_label`
 * ('title' | 'playoff', "Title odds" | "Playoff odds") from the same `metric` key that
 * decides every title_odds_delta / title_after / title_now field (objectives.js#metricKey),
 * and the client's `oddsIfTheySayYes` (warroom/copy.ts) builds the label from that field
 * instead of a hard-coded string. One test per objective, run end to end (planner -> the
 * plans view -> the actual HeroCard and NextMoveDeck components).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadWarRoom, textOf } from './helpers/warroom-tsx.mjs';

const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');

const wr = await loadWarRoom();
test.after(() => wr.cleanup());
const { default: HeroCard } = await wr.mod('HeroCard');
const { default: NextMoveDeck } = await wr.mod('NextMoveDeck');

/** Plans a made-up league on the given goal and returns its served plans entry. */
function entryFor(goal) {
  const a = makeAdapter();
  const res = planLeague(a, { objective: normaliseObjective({ goal }) });
  return toEntry(res, { names: a.names(), as_of: '2026-10-01T00:00:00Z' });
}

for (const [goal, metric, label] of [['title', 'title', 'Title odds'], ['playoffs', 'playoff', 'Playoff odds']]) {
  test(`objective.set goal=${goal}: destination.goal carries metric '${metric}' / '${label}'`, () => {
    const entry = entryFor(goal);
    assert.equal(entry.destination.status, 'ok');
    const g = entry.destination.value.goal;
    assert.equal(g.status, 'ok');
    assert.equal(g.value.metric, metric, 'the metric the number is scored on');
    assert.equal(g.value.metric_label, label);
  });

  test(`objective.set goal=${goal}: the hero card and the deck card both read "${label} if they say yes"`, () => {
    const entry = entryFor(goal);
    assert.equal(entry.next_move.status, 'ok', entry.next_move.reason);
    const move = entry.next_move.value;
    const view = { ...entry, alternatives: { status: 'ok', value: [move], source: 'plan.path' } };
    const hero = textOf(renderToStaticMarkup(React.createElement(HeroCard, {
      move, view, leagueId: 1, chosen: false, isSent: false, thread: null, onPick() {}, onMarkSent() {},
    })));
    assert.match(hero, new RegExp(`${label} if they say yes`), 'hero card label');
    assert.doesNotMatch(hero, /Title odds if he says yes|Playoff odds if he says yes/, 'never the old, gendered wording');
    const deck = textOf(renderToStaticMarkup(React.createElement(NextMoveDeck, { view, big: true })));
    assert.match(deck, new RegExp(`${label} if they say yes`), 'classic deck card label');
    // The label must never be the OTHER objective's — this is the exact bug: league 4's
    // number was scored on playoff odds while the label still said "Title odds".
    const wrongLabel = label === 'Title odds' ? 'Playoff odds if they say yes' : 'Title odds if they say yes';
    assert.doesNotMatch(hero, new RegExp(wrongLabel));
    assert.doesNotMatch(deck, new RegExp(wrongLabel));
  });
}
