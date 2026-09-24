#!/usr/bin/env node
/**
 * The contract's producer fixture, written by the real producer
 * (scripts/campaign/produce-plans.mjs#buildPlansFile, the loop its main()
 * runs) on the made-up league in test/fixtures/campaign-league.mjs. No real
 * data.
 *
 * Two refreshes, as the refresh loop runs it: the file is the second run, read
 * against the first (so `ground_lost` and the change diff are real). Five
 * leagues, so the file exercises every branch a consumer reads:
 *   1  title, Nick's stops (get / sell an untouchable / bye / custom),
 *      a safe-until-week-6 mode, an arrive-by week, chat labels on team 3
 *   2  a league whose world failed: the contract's { league, me, names, error }
 *   3  points objective, team 3 nearly out of it (a "desperate" catch-up move
 *      that is also a deck card) and team 4 checked out
 *   4  go get player 21, points side panel at 115 a week (on track: by_week is ok)
 *   5  sliders at zero assets: nothing clears, so next_move is unknown with its reason
 *
 * The FEAS-140 points side panel is switched on (ENV below, never the process env), so
 * every non-points league writes feasibility_points; league 3 writes it as unknown.
 *
 *   node test/fixtures/warroom-contract/make-producer-plans.mjs   # rewrites producer-plans.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeAdapter } from '../campaign-league.mjs';
import { buildPlansFile } from '../../../scripts/campaign/produce-plans.mjs';

const FIRST_AT = '2026-09-24T05:00:00.000Z';
const GENERATED_AT = '2026-09-24T06:00:00.000Z';
const ENV = { GRIDIRON_POINTS_FEASIBILITY: '1' };
const CHAT_OK = { engagement: 'high', tone: 'friendly', open_to_trade: 'high', no_holds: 'no', loves: [], hates: [], messages: 40, source: 'chat', status: 'ok' };

const leagueOf = (id, opts = {}) => {
  const a = makeAdapter(opts);
  a.league = { ...a.league, id };
  return a;
};

export const OBJECTIVES = {
  1: { risk_mode: 'safe', risk_until_week: 6, arrive_by: 6, untouchables: ['2'], version: 3,
    stops: [{ kind: 'get', player: '21' }, { kind: 'sell', player: '2' }, { kind: 'cover_bye', week: 6 }, { kind: 'custom', label: 'Keep a TE' }] },
  3: { kind: 'points', points_per_week: 95 },
  4: { kind: 'player', target: '21', risk_mode: 'all_in', side_points_per_week: 115 },
  5: { tolerances: { max_assets: 0 } },
};

export async function makeProducerPlans() {
  const leagues = [
    { id: 1, load: async () => ({ adapter: leagueOf(1, { managerExtra: { 3: { chat: CHAT_OK } } }) }) },
    { id: 2, load: async () => { const a = leagueOf(2); a.world = () => ({ fail: 'no schedule for this season' }); return { adapter: a }; } },
    { id: 3, load: async () => ({ adapter: leagueOf(3, { managerExtra: { 3: { title_now: 0.01 }, 4: { checked_out: true } } }) }) },
    { id: 4, load: async () => ({ adapter: leagueOf(4) }) },
    { id: 5, load: async () => ({ adapter: leagueOf(5) }) },
  ];
  const first = await buildPlansFile(leagues, { generated_at: FIRST_AT, objectives: OBJECTIVES, clock: () => 0, env: ENV });
  const previous = new Map(first.leagues.map(e => [String(e.league), e]));
  return buildPlansFile(leagues, { generated_at: GENERATED_AT, objectives: OBJECTIVES, previous, clock: () => 0, env: ENV });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'producer-plans.json');
  fs.writeFileSync(out, JSON.stringify(await makeProducerPlans(), null, 1) + '\n');
  console.log(`wrote ${out}`);
}
