/**
 * Trades area (docs/ui/CONSOLIDATION-MAP.md, area 7): one area over the planner and the trade tools;
 * RULES-EVERYWHERE's counts on every suggestion list; the retired pages stay retired; the old URLs land.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const exists = p => fs.existsSync(new URL(`../${p}`, import.meta.url));

test('Trades views, with the planner as the source of the next move', () => {
  const t = read('client/src/pages/Trades.tsx');
  assert.match(t, /\{ id: 'planner', label: 'Next move' \}, \{ id: 'goget', label: 'Go get' \}, \{ id: 'find', label: 'Find deals' \}/);
  assert.match(t, /\{ id: 'build', label: 'Build' \}, \{ id: 'people', label: 'People' \}/);
  assert.match(t, /return <WarRoomV2 view=\{warRoom\.data\}/, 'Next move is the War Room planner');
  for (const [old, now] of [['war-room', 'planner'], ['managers', 'people'], ['proposals', 'people'], ['target', 'goget'], ['targetMany', 'goget'], ['title', 'find'], ['mock', 'build']]) {
    assert.match(t, new RegExp(`'?${old}'?: '${now}'`), `old ?view=${old} lands on ${now}`);
  }
});

test('RULES-EVERYWHERE: every suggestion list shows how many ideas the rules hid', () => {
  const lab = read('client/src/pages/TradeLab.tsx');
  for (const v of ['data', 'offer', 'result']) assert.match(lab, new RegExp(`<RulesHidden n=\\{${v}\\?\\.dropped_by_rule\\}`), `${v}.dropped_by_rule is shown`);
  assert.equal((lab.match(/<RulesHidden /g) ?? []).length, 5, 'Find deals, Title impact, sequences, Target a player, Go get them');
  assert.match(read('client/src/components/brain/ProposalSlate.tsx'), /<RulesHidden n=\{result\?\.dropped_by_rule\} \/>/);
  const rh = read('client/src/components/trade/RulesHidden.tsx');
  assert.match(rh, /hidden by your rules/);
  assert.match(rh, /if \(!n \|\| n <= 0\) return null;/, 'nothing is drawn when nothing was hidden');
});

test('an ungated suggestion surface is not rendered: News edge is not a Trades view', () => {
  // The news-edge route (news-lag-trader.js) suggests buys without passing the rule gate, so Trades
  // does not draw it until the server gates it.
  const t = read('client/src/pages/Trades.tsx');
  assert.doesNotMatch(t, /<NewsEdge/);
  assert.doesNotMatch(t, /news-edge/);
});

test('retired: the Trade Lab page, Trade Brain, the classic War Room', () => {
  for (const p of ['client/src/pages/TradeBrain.tsx', 'client/src/components/warroom/WarRoom.tsx',
    'client/src/components/warroom/WarRoomShell.tsx', 'client/src/components/warroom/layoutPref.ts']) assert.ok(!exists(p), `${p} is gone`);
  const lab = read('client/src/pages/TradeLab.tsx');
  assert.doesNotMatch(lab, /export default function TradeLab/, 'no Trade Lab page');
  assert.doesNotMatch(lab, /const TABS = \[/, 'no Trade Lab tab strip');
  assert.doesNotMatch(read('client/src/components/warroom/TopBarV2.tsx'), /Classic layout/);
  const r = read('client/src/components/Redirects.tsx');
  assert.match(r, /'\/trade-lab': \(\) => '\/trades\?view=find'/);
  assert.match(r, /'\/trade-brain':/);
});

test('moved: Defence vs position to Players → NFL teams; post-draft trades point to Find deals; health chip to Settings → Health', () => {
  assert.match(read('client/src/pages/Teams.tsx'), /<DefenceVsPosition \/>/);
  const pdp = read('client/src/components/PostDraftPlan.tsx');
  assert.match(pdp, /href="\/trades\?view=find"/);
  assert.doesNotMatch(pdp, /d\.i_give|Suggested Trades/, 'no trade ideas listed in the post-draft plan');
  assert.match(read('client/src/components/AppCoach.tsx'), /<Link to="\/settings\?view=health"[^>]*data-testid="app-health-chip"/);
  assert.match(read('client/src/pages/Settings.tsx'), /<BrainCheck \/>/);
});
