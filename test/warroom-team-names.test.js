/**
 * TEAM-NAMES: the War Room names the people, not numbers. The league adapter reads each
 * roster's ESPN team name and manager from the league payload at run time (Nick's trusted
 * chat name wins over ESPN's first name), the producer writes it as the optional `teams`
 * section, the view passes it through, and TodayPanel and TradesPlanner fill the registry every teamLabel
 * call site reads: 'Manager (Team name)' when known, else 'Team N'.
 *
 * PUBLIC REPO: every name here is synthetic ('Manager A', 'Team 7'), and the last test
 * checks that no committed plans fixture carries anything but synthetic team labels.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plannerRenderer } from './helpers/warroom-planner.mjs';
import { loadWarRoom } from './helpers/warroom-tsx.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-team-names-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { teamNames } = await import('../scripts/campaign/league-adapter.mjs');
const { validateLeague, validatePlans, schemaPaths, writtenPaths, SECTIONS, OPTIONAL_SECTIONS } = await import('../server/services/campaign/plans-schema.js');
const { buildWarRoomView } = await import('../server/services/war-room-view.js');

const wr = await loadWarRoom();
test.after(() => { wr.cleanup(); fs.rmSync(temp, { recursive: true, force: true }); });
const types = await wr.mod('types');
const planner = await plannerRenderer(wr);

const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'warroom-contract', 'producer-plans.json'), 'utf8'));
const ON = { enabled: true, preview: false };
const plansOf = (...entries) => ({ status: 'ok', entries: structuredClone(entries), as_of: '2026-09-24T07:29:00.000Z', id: 'plans@1' });
/** Today, Next move, Go get and Market as the app mounts them (the shell is retired). */
const room = view => planner(view, { leagueId: view.league });

/** Every roster the entry mentions (flip legs, target owners, deck partners). */
function rostersIn(entry) {
  const ids = new Set();
  for (const f of entry.flip_map?.value ?? []) { ids.add(String(f.buy_from)); ids.add(String(f.sell_to)); }
  for (const t of entry.targets?.value ?? []) ids.add(String(t.owner));
  for (const m of entry.alternatives?.value ?? []) for (const s of m.steps ?? []) ids.add(String(s.partner));
  ids.delete('undefined');
  return [...ids];
}
const letter = i => String.fromCharCode(65 + i);
const syntheticTeams = ids => Object.fromEntries(ids.map((id, i) => [id, { name: `Team ${id}`, manager: `Manager ${letter(i)}` }]));

test('teamNames: ESPN team name + owner first name; the trusted chat name wins; an empty roster is left out', () => {
  const payload = {
    teams: [
      { id: 7, name: 'Team 7', primaryOwner: '{M1}' },
      { id: 8, location: 'Team', nickname: '8', owners: ['{M2}'] },
      { id: 9, name: '  ', primaryOwner: '{M3}' },
      { id: 10 },
    ],
    members: [
      { id: '{M1}', firstName: 'Manager', displayName: 'managerA' },
      { id: '{M2}', firstName: '', displayName: 'Manager B' },
      { id: '{M3}', firstName: 'Manager C' },
    ],
  };
  assert.deepEqual(teamNames(payload), {
    7: { name: 'Team 7', manager: 'Manager' },
    8: { name: 'Team 8', manager: 'Manager B' },
    9: { manager: 'Manager C' },
  });
  assert.deepEqual(teamNames(payload, new Map([['7', 'Manager A']]))['7'], { name: 'Team 7', manager: 'Manager A' },
    "Nick's chat name for a roster wins over ESPN's first name");
  assert.deepEqual(teamNames({}), {});
  assert.deepEqual(teamNames(null), {});
});

test('contract: teams is an optional typed section; a bad key or value is caught; paths stay in the contract', () => {
  const entry = structuredClone(FIXTURE.leagues[0]);
  assert.ok(Object.hasOwn(SECTIONS, 'teams') && OPTIONAL_SECTIONS.includes('teams'));
  assert.deepEqual(validateLeague(entry).errors, []);
  const without = structuredClone(entry);
  delete without.teams;
  assert.deepEqual(validateLeague(without).errors, [], 'a file written before TEAM-NAMES still validates');
  entry.teams = { status: 'ok', source: 'campaign.plan', value: syntheticTeams(rostersIn(entry)) };
  assert.deepEqual(validateLeague(entry).errors, []);
  const doc = { ...structuredClone(FIXTURE), leagues: [entry, ...structuredClone(FIXTURE.leagues.slice(1))] };
  assert.equal(validatePlans(doc).ok, true);
  const contract = schemaPaths();
  const teamPaths = [...writtenPaths(doc)].filter(p => p.startsWith('leagues[].teams'));
  assert.ok(teamPaths.includes('leagues[].teams.value{}.manager'));
  assert.deepEqual(teamPaths.filter(p => !contract.has(p)), [], 'every teams path is a contract path');
  const bad = structuredClone(entry);
  bad.teams.value['bad key!'] = { name: 'Team X' };
  bad.teams.value[String(rostersIn(entry)[0])] = { name: 7 };
  assert.equal(validateLeague(bad).ok, false);
  const unknown = { ...structuredClone(entry), teams: { status: 'unknown', source: 'campaign.plan', reason: 'no payload' } };
  assert.deepEqual(validateLeague(unknown).errors, []);
});

test('teamLabel: Manager (Team name) when known, whichever is known, else Team N', () => {
  types.setTeamNames({ 7: { name: 'Team Seven', manager: 'Manager A' }, 8: { manager: 'Manager B' }, 9: { name: 'Team Nine' }, 10: {} });
  assert.equal(types.teamLabel('7'), 'Manager A (Team Seven)');
  assert.equal(types.teamLabel('8'), 'Manager B');
  assert.equal(types.teamLabel('9'), 'Team Nine');
  assert.equal(types.teamLabel('10'), 'Team 10');
  assert.equal(types.teamLabel('11'), 'Team 11');
  assert.equal(types.teamLabel(null), '');
  types.setTeamNames(null);
  assert.equal(types.teamLabel('7'), 'Team 7');
});

test('the served view passes teams through and the War Room cards name the manager', () => {
  const entry = structuredClone(FIXTURE.leagues[0]);
  delete entry.teams;
  const ids = rostersIn(entry);
  assert.ok(ids.length >= 2, 'the fixture mentions other rosters');

  const bare = buildWarRoomView(entry.league, plansOf(entry), ON);
  assert.equal(bare.teams.status, 'unknown', 'no teams written -> unknown, never a value');
  const before = room(bare);
  assert.doesNotMatch(before, /Manager [A-Z]/);
  assert.match(before, /Team \d+/);

  const named = { ...entry, teams: { status: 'ok', source: 'campaign.plan', value: syntheticTeams(ids) } };
  const view = buildWarRoomView(entry.league, plansOf(named), ON);
  assert.equal(view.teams.status, 'ok');
  assert.deepEqual(view.teams.value, named.teams.value);
  const html = room(view);
  const shown = ids.filter((id, i) => html.includes(`Manager ${letter(i)} (Team ${id})`));
  assert.ok(shown.length >= 1, 'at least one card names its manager');
  // Sentences the producer wrote into the plans file (playbook, itinerary labels) still say 'Team N';
  // only teamLabel call sites read the registry, so the bare count drops but need not reach zero.
  const bareN = h => (h.replace(/Manager [A-Z] \(Team \d+\)/g, '').match(/Team \d+/g) ?? []).length;
  assert.ok(bareN(html) < bareN(before), `bare Team N: ${bareN(before)} before, ${bareN(html)} after`);

  // A league with no names falls back to numbers again (the registry follows the view).
  assert.doesNotMatch(room(bare), /Manager [A-Z]/);
});

test('PUBLIC REPO: committed plans fixtures carry no team or manager names except synthetic ones', () => {
  const SYNTHETIC = /^(Team|Manager) [A-Z0-9]{1,4}$/;
  const dir = path.join(HERE, 'fixtures');
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith('.json')) files.push(p);
  } };
  walk(dir);
  let checked = 0;
  const visit = (v, where) => {
    if (Array.isArray(v)) { v.forEach((x, i) => visit(x, `${where}[${i}]`)); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (k === 'teams' && x && typeof x === 'object' && x.status && x.value && typeof x.value === 'object') {
        for (const [rid, t] of Object.entries(x.value)) {
          for (const f of ['name', 'manager']) {
            if (t?.[f] == null) continue;
            checked++;
            assert.match(String(t[f]), SYNTHETIC, `${path.relative(HERE, where)} teams.${rid}.${f} must be synthetic`);
          }
        }
      } else visit(x, where);
    }
  };
  for (const f of files) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    visit(doc, f);
  }
  assert.ok(files.length > 0);
  assert.ok(checked >= 0);
});
