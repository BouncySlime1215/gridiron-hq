/**
 * The "N offers this week, over your limit" line is back, in the Trades -> People header
 * (coordinator, #457 review: it went with the retired People Board). It reads the plan's
 * per-manager counts (partners[].offers_logged) and Nick's limit (destination.tolerances
 * max_offers_per_manager_week) and only compares them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadWarRoom } from './helpers/warroom-tsx.mjs';

const wr = await loadWarRoom();
test.after(() => wr.cleanup());
const { offerBudgetOver, offerBudgetText } = await wr.mod('offerBudget');
const { teamLabelIn, teamLabel, setTeamNames } = await wr.mod('types');

const ok = (value, source = 'campaign.plan') => ({ status: 'ok', value, source });
const view = ({ partners, limit = 2 } = {}) => ({
  partners: partners ?? ok([{ team: '2', offers_logged: 1 }, { team: '10', offers_logged: 3 }, { team: '7', offers_logged: 2 }, { team: '9' }]),
  destination: ok({ tolerances: ok(limit == null ? {} : { max_offers_per_manager_week: limit }) }),
});

test('only managers over the limit are listed, with the served count and limit', () => {
  assert.deepEqual(offerBudgetOver(view()), [{ team: '10', used: 3, limit: 2 }], 'at the limit (2 of 2) is not over; no count is not over');
  assert.equal(offerBudgetText('Manager A (Team 10)', 3, 2), '3 offers to Manager A (Team 10) this week, over your 2-a-week limit');
});

test('no counts, no limit, or nobody over: nothing to show', () => {
  assert.deepEqual(offerBudgetOver(null), []);
  assert.deepEqual(offerBudgetOver(view({ limit: null })), []);
  assert.deepEqual(offerBudgetOver(view({ partners: { status: 'unknown', source: 'campaign.plan', reason: 'x' } })), []);
  assert.deepEqual(offerBudgetOver(view({ partners: ok([{ team: '2', offers_logged: 2 }]) })), []);
});

test('teamLabelIn names from a given map; teamLabel still reads the registry', () => {
  const teams = { 10: { name: 'Team 10', manager: 'Manager A' } };
  assert.equal(teamLabelIn(teams, '10'), 'Manager A (Team 10)');
  assert.equal(teamLabelIn(null, '10'), 'Team 10');
  setTeamNames(teams);
  assert.equal(teamLabel('10'), 'Manager A (Team 10)');
  setTeamNames(null);
});

test('the People view mounts the line above the manager cards, from the war-room view', () => {
  const src = fs.readFileSync(new URL('../client/src/pages/Trades.tsx', import.meta.url), 'utf8');
  assert.match(src, /view === 'people'[\s\S]*?<OfferBudgetLine view=\{warOn \? warRoom\.data : null\}[\s\S]*?<ManagerBoard/);
});
