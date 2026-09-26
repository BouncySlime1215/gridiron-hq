/**
 * Keyboard structure of the app shell (item 58): what a keyboard user needs to move through the
 * seven areas. Each check reads one source file and says what is missing; pure over a reader.
 *   skip-link      the first focusable thing in the shell jumps past the nav to <main id="main">;
 *   seven-areas    every area (Today, Trades, My team, League, Players, Draft, Settings) is a
 *                  NavLink in the primary nav, so Tab reaches all seven;
 *   rail-names     in the collapsed rail the links are icon-only, so each carries aria-label;
 *   drawer-inert   the closed phone drawer is inert (off-screen links are not in the Tab order);
 *   tabs-keys      the Tabs primitive moves with Arrow keys / Home / End and keeps one tab stop;
 *   sheet-focus    the Sheet keeps Tab inside while open and returns focus when it closes.
 */
export const AREAS = Object.freeze(['/', '/trades', '/my-team', '/league', '/players', '/draft', '/settings']);

export function checkStructure(read) {
  const app = read('client/src/App.tsx');
  const nav = read('client/src/navigation.ts');
  const ds = read('client/src/components/ui/DesignSystem.tsx');
  const out = [];
  const need = (id, ok, detail) => { if (!ok) out.push({ rule: id, detail }); };
  const skipAt = app.indexOf('href="#main"'), navAt = app.indexOf('aria-label="Primary navigation"');
  need('skip-link', skipAt >= 0 && navAt >= 0 && skipAt < navAt && /<main[^>]*\bid="main"/.test(app) && /<main[^>]*tabIndex=\{-1\}/.test(app),
    'App.tsx: a "Skip to content" link (href="#main") before the nav, and <main id="main" tabIndex={-1}>');
  for (const to of AREAS) {
    need('seven-areas', new RegExp(`to:\\s*'${to.replace(/[/-]/g, m => `\\${m}`)}'`).test(nav), `navigation.ts: no nav item for ${to}`);
  }
  need('rail-names', /aria-label=\{rail \? item\.label : undefined\}/.test(app), 'App.tsx: rail NavLinks need aria-label={rail ? item.label : undefined}');
  need('drawer-inert', /toggleAttribute\('inert'/.test(app), 'App.tsx: the closed phone drawer must be inert');
  const tabs = ds.slice(ds.indexOf('export function Tabs'), ds.indexOf('export function Section'));
  need('tabs-keys', /onKeyDown=/.test(tabs) && /rovingIndex\(/.test(tabs) && /tabIndex=\{t\.id === value \? 0 : -1\}/.test(tabs),
    'DesignSystem Tabs: Arrow/Home/End via rovingIndex and one tab stop (tabIndex 0 on the selected tab, -1 on the rest)');
  const sheet = ds.slice(ds.indexOf('export function Sheet'), ds.indexOf('export type DataColumn'));
  need('sheet-focus', /trapTab\(/.test(sheet) && /returnTo/.test(sheet), 'DesignSystem Sheet: trap Tab while open and return focus on close');
  return out;
}
