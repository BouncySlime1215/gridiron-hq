/**
 * Trades cleanup (Nick: "That trade page needs A LOT of work"): the coordinator's seven points, pinned
 * at the source (the browser checks are in the PR). One frame, one Go get, one context bar, Build,
 * People, Find deals, no dev text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const code = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const trades = read('client/src/pages/Trades.tsx');
const lab = read('client/src/pages/TradeLab.tsx');
const planner = read('client/src/components/warroom/TradesPlanner.tsx');
// Part 2: the manager card is its own shared component (ManagerCard); People renders it.
const board = read('client/src/components/brain/ManagerBoard.tsx') + read('client/src/components/brain/ManagerCard.tsx');
const slate = read('client/src/components/brain/ProposalSlate.tsx');

test('1. no nested app: the planner draws inside the Trades frame, with no War Room shell', () => {
  assert.doesNotMatch(trades, /WarRoomV2|TopBarV2/);
  assert.match(planner, /className="wr-root wr-v2 wr-inline"/);
  assert.doesNotMatch(planner, /TopBarV2|CoachDrawer |HealthSheet|role="tablist"/, 'no second top bar, Coach, health chip or tabs');
  assert.match(trades, /<TradesPlanner part="market"/, 'Market is part of Find deals');
  // Part 2: the shell itself is deleted, not just unmounted.
  for (const f of ['WarRoomV2.tsx', 'TopBarV2.tsx', 'TopStrip.tsx', 'LeagueRail.tsx', 'PeopleBoard.tsx', 'ScreenLeague.tsx', 'useDocTheme.ts']) {
    assert.ok(!fs.existsSync(new URL(`../client/src/components/warroom/${f}`, import.meta.url)), `${f} is gone`);
  }
});

test('2. one Go get: the planner\'s target cards, with "Someone else?" closing the list', () => {
  assert.match(trades, /<TradesPlanner part="goget" [^>]*someoneElse=\{someoneElse\}/);
  assert.match(read('client/src/components/warroom/ScreenGoGet.tsx'), /\{someoneElse && <div className="wr-someone" data-testid="goget-someone-else">/);
  assert.match(trades, /Someone else\?/);
});

test('3. one context bar in the page header: values chip, untouchables chip + sheet, Trading as only when needed', () => {
  // AJ-PICK adds its "A.J. allowed for" chip to the same bar (extra), only when A.J. is on Nick's roster.
  assert.match(trades, /<PageHeader eyebrow="Trades" title="Trades" actions=\{<TradeDeskHeader desk=\{desk\}\s+extra=\{ajMine \? <AjAllowedChip [^}]*\} nameOf=\{[^}]*\} \/> : null\} \/>\} \/>/);
  assert.equal((trades.match(/<TradeDeskHeader /g) ?? []).length, 1, 'shown once, not per view');
  assert.match(lab, /<MarketAsOf asOf=\{rosters\?\.market_as_of\} compact \/>/);
  assert.match(lab, /Untouchables: \{locked\.length\}/);
  assert.match(lab, /<Sheet open=\{sheet\} title="Untouchables"/);
  assert.match(lab, /\{rosters\?\.teams && !rosters\?\.my_team_id && \(/, 'Trading as hides when a team is marked yours');
  assert.doesNotMatch(code(lab), /cutoff \{rosters\.model_context\.cutoff\}/, 'no week/cutoff chip');
});

test('4. Build: two cards, tap-to-add rows, K/DEF hidden, capped rows, a summary bar with the rule check', () => {
  assert.match(lab, /<BuildSide title="You send"/);
  assert.match(lab, /<BuildSide title="You get"/);
  assert.match(lab, /aria-pressed=\{on\} onClick=\{\(\) => onToggle\(p\.id\)\}/, 'rows are buttons, not raw checkboxes');
  assert.doesNotMatch(code(lab.slice(lab.indexOf('function BuildSide'))), /type="checkbox"/);
  assert.match(lab, /const \[kdef, setKdef\] = useState\(false\);/);
  assert.match(lab, /title="FantasyCalc trade value">Value</, 'a labelled Value column');
  assert.match(lab, /pool\.slice\(0, cap\)/);
  assert.match(lab, /className="build-bar" data-testid="build-bar"/);
  assert.doesNotMatch(read('client/src/styles/ui.css').match(/\.build-bar \{[^}]*\}/)[0], /sticky|fixed/, 'the bar is in the flow, never over the rows (CLAUDE.md UI rules)');
  assert.ok(lab.indexOf('data-testid="build-bar"') < lab.indexOf('<BuildSide title="You send"'), 'above the cards');
  assert.match(lab, /rules\.ok \? 'Your rules: pass' : `Your rules: no, /);
  assert.match(lab, /Who wins this\?/);
});

test('5. People: no script paths or budget text; one segmented stance control; chatter per card', () => {
  assert.doesNotMatch(code(board), /scripts\/|\.mjs|Where these numbers come from/);
  assert.match(board, /role="radiogroup" aria-label=\{`Tradeability for \$\{owner\}`\}/);
  assert.match(board, /data-testid="manager-chatter"/);
  assert.match(board, /data-testid="manager-measured"/);
  assert.doesNotMatch(code(slate).slice(code(slate).indexOf('return (', code(slate).indexOf('export default function'))), /\{COST_NOTE\}|Sonnet/, 'no model or dollar text on People');
  assert.match(slate, /Write proposals/);
  assert.ok(!fs.existsSync(new URL('../client/src/components/brain/PulseTicker.tsx', import.meta.url)), 'the pulse strip is gone');
});

test('6. Find deals: one control row, rules-hidden kept, a helpful empty state, no debug counters', () => {
  assert.match(lab, /data-testid="find-controls"/);
  assert.match(trades, /\['best', 'Best overall'\], \['title', 'Title impact'\]/);
  assert.match(lab, /Go get someone specific/);
  assert.doesNotMatch(code(lab), /candidates evaluated/);
  assert.match(lab, /<RulesHidden n=\{data\?\.dropped_by_rule\}/);
});
