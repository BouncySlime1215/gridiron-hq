/**
 * TEAM-NAMES-2: the sentences the server writes (playbook reply rows, itinerary stop labels, the
 * reasoning panels, targets, flips, catch-up, the Coach's reply table) and the Coach footer name the
 * manager through the one label source: the plans entry's `teams` map (server: playbook.js#teamLabel;
 * client: types.ts#teamLabel, mirrored by warroomCoach.ts#coachTeamLabel, pinned equal here).
 * Without a teams map every sentence reads 'Team N' exactly as before.
 *
 * PUBLIC REPO: every name here is synthetic ('Manager A', 'Team 7'); the last test checks that the
 * files this unit touches carry no other team or manager literal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-team-names-2-'));
process.env.GRIDIRON_DB_PATH ??= path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');
const { applyCoachMessages } = await import('../server/services/campaign/messages.js');
const { teamLabel, replyTable } = await import('../server/services/campaign/playbook.js');
const { buildItinerary } = await import('../server/services/campaign/itinerary.js');
const types = await import('../client/src/components/warroom/types.ts');
const coach = await import('../client/src/components/warroom/coach/warroomCoach.ts');

const letter = i => String.fromCharCode(65 + i);
/** Synthetic managers only: the label is 'Manager X', so any 'Team N' left in a sentence is a miss. */
const managersFor = ids => Object.fromEntries(ids.map((id, i) => [String(id), { manager: `Manager ${letter(i)}` }]));

/** Every string in an entry a person reads (not the names / teams maps, not the producer's _run memory). */
function strings(entry) {
  const out = [];
  const walk = v => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!['names', 'teams', '_run'].includes(k)) walk(x);
  };
  walk(entry);
  return out;
}
const teamN = (texts, named) => texts.flatMap(t => [...t.matchAll(/\bTeam ([A-Za-z0-9_]+)\b/g)].map(m => m[1])).filter(id => named.has(id));

test('one rule: server teamLabel, client teamLabel and the Coach footer label agree on every case', () => {
  const map = { 7: { name: 'Team Seven', manager: 'Manager A' }, 8: { manager: ' Manager B ' }, 9: { name: 'Team Nine' }, 10: {}, 12: { name: '  ' } };
  types.setTeamNames(map);
  try {
    for (const id of ['7', '8', '9', '10', '11', '12', 7, null, undefined]) {
      const want = types.teamLabel(id);
      assert.equal(teamLabel(map, id), want, `server map, id ${id}`);
      assert.equal(teamLabel({ status: 'ok', source: 'campaign.plan', value: map }, id), want, `server Field, id ${id}`);
      assert.equal(coach.coachTeamLabel({ status: 'ok', source: 'campaign.plan', value: map }, id), want, `coach, id ${id}`);
    }
  } finally { types.setTeamNames(null); }
  assert.equal(teamLabel(map, '7'), 'Manager A (Team Seven)');
  assert.equal(teamLabel(null, '7'), 'Team 7');
  assert.equal(teamLabel({ status: 'unknown', reason: 'x' }, '8'), 'Team 8', 'an unknown section reads Team N');
  assert.equal(coach.coachTeamLabel({ status: 'unknown', reason: 'x' }, '8'), 'Team 8');
});

test('playbook reply rows and itinerary stops name the manager; without teams they read Team N as before', () => {
  const teams = { 7: { manager: 'Manager A' } };
  const next = { team: '7', give: ['1'], get: ['2'] };
  const backup = { step: { team: '7', give: ['3'], get: ['4'] }, expected: 0.01 };
  const named = replyTable(next, { next, backup, teams });
  const bare = replyTable(next, { next, backup });
  assert.equal(named.find(r => r.kind === 'accept').do, 'Send the next step to Manager A.');
  assert.equal(named.find(r => r.kind === 'decline').do, 'Log the reason, then offer Manager A instead.');
  assert.equal(bare.find(r => r.kind === 'accept').do, 'Send the next step to Team 7.');
  assert.equal(bare.find(r => r.kind === 'decline').do, 'Log the reason, then offer Team 7 instead.');

  const plan = { steps: [{ team: '7', give: ['1'], get: ['2'] }, { team: '8', give: ['2'], get: ['3'] }] };
  const names = { 2: 'P2', 3: 'P3' };
  const it = buildItinerary(plan, {}, { names, teams });
  assert.deepEqual(it.stops.map(s => s.label), ['Flip P2 from Manager A', 'Get P3 from Team 8']);
  assert.deepEqual(buildItinerary(plan, {}, { names }).stops.map(s => s.label), ['Flip P2 from Team 7', 'Get P3 from Team 8']);
});

test('the served entry + Coach: no Team N for a roster the teams map names; the entry still validates', () => {
  const a = makeAdapter();
  const res = planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced' }) });
  const others = [...a.rosters.keys()].map(String).filter(t => t !== String(a.league.me));
  const teams = managersFor(others);
  const named = new Set(Object.keys(teams));
  const opts = { names: a.names(), as_of: '2026-09-24T00:00:00Z' };

  const bareEntry = applyCoachMessages(toEntry(res, opts), { force: true }).entry;
  const entry = applyCoachMessages(toEntry(res, { ...opts, teams }), { force: true }).entry;
  assert.deepEqual(validateLeague(entry).errors, []);

  const footers = e => {
    const deck = e.alternatives?.status === 'ok' ? e.alternatives.value : [];
    return deck.map((_, j) => coach.coachFooter(e, { league: 'L', deck: { L: j } }).text);
  };
  const before = teamN([...strings(bareEntry), ...footers(bareEntry)], named);
  const after = teamN([...strings(entry), ...footers(entry)], named);
  assert.ok(before.length > 0, 'the fixture writes Team N sentences without a teams map');
  assert.deepEqual(after, [], `Team N left for a named roster: ${after.join(', ')}`);

  const all = [...strings(entry), ...footers(entry)].join('\n');
  assert.match(all, /Manager [A-Z]/, 'the sentences name the managers');
  // The Coach footer's next move names him (the first deck card's first partner).
  const first = entry.alternatives.value[0]?.steps?.[0];
  if (first) assert.match(footers(entry)[0], new RegExp(`send ${teamLabel(teams, first.partner)} `));

  // Sections this unit does not own are byte-identical (only labels move).
  for (const k of ['destination', 'speed_curve', 'risk_modes', 'partners', 'names']) assert.deepEqual(entry[k], bareEntry[k], k);
});

test('PUBLIC REPO: the files this unit touches carry no team or manager literal but synthetic ones', () => {
  const files = [
    'client/src/components/warroom/coach/warroomCoach.ts', 'server/services/campaign/playbook.js',
    'server/services/campaign/itinerary.js', 'server/services/campaign/messages.js', 'server/services/campaign/view.js',
    'test/warroom-team-names-2.test.js',
  ];
  const SYNTHETIC = /^(Team|Manager) [A-Za-z0-9 ]{1,12}$/;
  let seen = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/\b(?:manager|name)\s*:\s*'([^'$]*)'/g)) {
      if (!/^[A-Z]/.test(m[1])) continue; // not a person or team label (e.g. keys, reasons)
      seen++;
      assert.match(m[1], SYNTHETIC, `${f}: '${m[1]}' must be synthetic`);
    }
  }
  assert.ok(seen > 0, 'the check saw the synthetic labels in this file');
});
