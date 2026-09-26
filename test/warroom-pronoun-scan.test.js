/**
 * WARROOM-PRONOUN-FIX: a league-mate is "they" on the War Room and Trades surfaces, never
 * "he"/"his"/"him" (server/services/people/neutral.js's own rule, numbers-people.test.js's
 * "copy: league-mates are 'they'" applies the same check to Numbers & People). This file is
 * the War Room / Trades side of that check, prompted by a real bug: a card's title-odds
 * label read "if he says yes" and the reasoning panel, the reply table, the ladder and His
 * Screen all had the same habit.
 *
 * Two passes:
 *  1. A fresh plan (planLeague -> campaign/view.js#toEntry, no pre-baked fixture) rendered
 *     through the actual War Room card components, scanned for a gendered pronoun in the
 *     visible text. This exercises the live code path end to end, both objectives.
 *  2. Every static string / JSX text literal in the War Room and Trades files this bug (and
 *     its fix) touched, scanned the same way numbers-people.test.js scans its four files.
 *     Files where a real, specifically-named person is the subject (e.g. "A.J. Brown ... for
 *     him") are left out of the static list on purpose; they are not league-mates.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadWarRoom, textOf } from './helpers/warroom-tsx.mjs';

const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');

const GENDERED = /\b(he|him|his|himself|she|her)\b/i;

const wr = await loadWarRoom();
test.after(() => wr.cleanup());
const { default: HeroCard, MoveDetails } = await wr.mod('HeroCard');
const { default: NextMoveDeck } = await wr.mod('NextMoveDeck');

for (const goal of ['title', 'playoffs']) {
  test(`pronoun scan: a freshly-planned ${goal} league's War Room cards carry no gendered pronoun`, () => {
    const a = makeAdapter();
    const res = planLeague(a, { objective: normaliseObjective({ goal }) });
    const entry = toEntry(res, { names: a.names(), as_of: '2026-10-01T00:00:00Z' });
    assert.equal(entry.next_move.status, 'ok', entry.next_move.reason);
    const move = entry.next_move.value;
    const view = { ...entry, alternatives: { status: 'ok', value: [move], source: 'plan.path' } };
    const renders = {
      'HeroCard (hero layout)': () => React.createElement(HeroCard, {
        move, view, leagueId: 1, chosen: false, isSent: false, thread: null, onPick() {}, onMarkSent() {},
      }),
      'NextMoveDeck (big/classic)': () => React.createElement(NextMoveDeck, { view, big: true }),
      'NextMoveDeck (compact)': () => React.createElement(NextMoveDeck, { view, big: false }),
      'MoveDetails': () => React.createElement(MoveDetails, { move, view, leagueId: 1 }),
    };
    for (const [name, make] of Object.entries(renders)) {
      const text = textOf(renderToStaticMarkup(make()));
      const m = text.match(GENDERED);
      assert.equal(m, null, `${name}: "${m?.[0]}" near "${m ? text.slice(Math.max(0, m.index - 40), m.index + 40) : ''}"`);
    }
  });
}

/**
 * Every static string / JSX text literal in these files, comments stripped, line by line so a
 * template-literal `${...}` expression (a variable named `his`, a `his_pct` field access) never
 * gets mistaken for prose. Only literals with a space count as prose — an identifier, CSS class
 * or route slug ("his-screen-toggle", "/trades/:id/his-screen") never contains one.
 */
const STATIC_FILES = [
  'client/src/components/warroom/HeroCard.tsx',
  'client/src/components/warroom/NextMoveDeck.tsx',
  'client/src/components/warroom/ChanceStat.tsx',
  'client/src/components/warroom/ReplyTable.tsx',
  'client/src/components/warroom/Negotiate.tsx',
  'client/src/components/warroom/negotiateModel.ts',
  'client/src/components/warroom/HisScreen.tsx',
  'client/src/components/warroom/types.ts',
  'client/src/components/warroom/copy.ts',
  'client/src/components/warroom/coach/warroomCoach.ts',
  'client/src/components/warroom/BrainCheckCard.tsx',
  'client/src/components/trade/ManagerRead.tsx',
  'server/services/war-room-view.js',
  'server/services/offer-value-gain.js',
  'server/services/campaign/playbook.js',
];

/**
 * copy.ts intentionally keeps a raw, gendered English template ("... if he says yes") as the
 * INPUT to the shared neutral() guard (server/services/people/neutral.js) it imports, so the
 * guard has something to convert at runtime — see warroom-objective-label.test.js and the
 * `objective.set` tests above for proof the guard actually runs before anything is served.
 */
const ALLOW_RAW_TEMPLATE = new Set(['${base} if he says yes', 'Chance he says yes']);

test('pronoun scan: every static War Room / Trades string this bug touched reads "they", not "he"', () => {
  for (const f of STATIC_FILES) {
    const raw = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    for (const line of code.split('\n')) {
      for (const m of line.matchAll(/(['"`])((?:(?!\1).){3,})\1/g)) {
        const s = m[2].replace(/\$\{[^}]*\}/g, '');
        if (!/\s/.test(s) || ALLOW_RAW_TEMPLATE.has(m[2])) continue;
        assert.doesNotMatch(s, GENDERED, `${f}: ${JSON.stringify(m[2])}`);
      }
      for (const m of line.matchAll(/>([^<>{}]{3,})</g)) {
        const s = m[1];
        if (!/\s/.test(s)) continue;
        assert.doesNotMatch(s, GENDERED, `${f}: ${JSON.stringify(s)}`);
      }
    }
  }
});
