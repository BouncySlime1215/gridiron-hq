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
  assert.match(t, /<TradesPlanner part="next" view=\{warRoom\.data\}/, 'Next move is the War Room planner, inside the Trades frame');
  assert.doesNotMatch(t, /<WarRoomV2/, 'no nested War Room shell (its own top bar, tabs, Coach) inside Trades');
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

test('News edge is a Trades view again, drawn only from the gated route, with the hidden count', () => {
  // The news-edge route now passes never-give.js's rule gate (news-lag-trader.js#gateNewsEdge; tested in
  // rules-everywhere.test.js), so Trades draws it again.
  const t = read('client/src/pages/Trades.tsx');
  assert.match(t, /\{ id: 'news', label: 'News edge' \}/);
  assert.match(t, /view === 'news' && activeId && <NewsEdge leagueId=\{activeId\}/);
  const c = read('client/src/components/trade/NewsEdge.tsx');
  assert.match(c, /`\/trades\/\$\{leagueId\}\/news-edge\?hours=/);
  assert.match(c, /<RulesHidden n=\{data\?\.dropped_by_rule\}/);
  assert.doesNotMatch(read('client/src/pages/TradeLab.tsx'), /function NewsEdge|news-edge/, 'one News edge, not two');
  assert.match(read('server/routes/trades.js'), /gateNewsEdge\(out, ruleGate\(/);
});

test('retired: the Trade Lab page, Trade Brain, the classic War Room', () => {
  for (const p of ['client/src/pages/TradeBrain.tsx', 'client/src/components/warroom/WarRoom.tsx',
    'client/src/components/warroom/WarRoomShell.tsx', 'client/src/components/warroom/layoutPref.ts',
    'client/src/components/warroom/WarRoomV2.tsx', 'client/src/components/warroom/TopBarV2.tsx']) assert.ok(!exists(p), `${p} is gone`);
  const lab = read('client/src/pages/TradeLab.tsx');
  assert.doesNotMatch(lab, /export default function TradeLab/, 'no Trade Lab page');
  assert.doesNotMatch(lab, /const TABS = \[/, 'no Trade Lab tab strip');
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
