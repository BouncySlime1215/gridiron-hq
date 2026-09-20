/**
 * Six client files that no route and no import reached.
 *
 * `Edge.tsx`, `Model.tsx`, `Projections.tsx`, `Rankings.tsx`,
 * `components/StaleBanner.tsx` and `features/model-lab/ModelRegistryPanel.tsx`
 * were in the tree with nothing rendering them. `docs/EXISTING-SYSTEMS-INVENTORY.md`
 * has listed them as "never used" the whole time; listing a thing is not
 * deleting it, and a file that ships in the repository reads to the next person
 * as a feature that exists.
 *
 * This test exists because of a standing rule with history behind it: on
 * 2026-09-16 nine tabs were deleted deliberately (commit 1694694) and the nav
 * is eight destinations. A deleted page that quietly comes back is the exact
 * regression the rule is there to prevent, and nothing else in the suite would
 * notice.
 *
 * The rule is never rebuild a deleted page. So this checks two things: the
 * files are gone, and nothing routes or links to them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const at = rel => new URL(`../${rel}`, import.meta.url);
const read = rel => fs.readFileSync(at(rel), 'utf8');

const DELETED = [
  'client/src/pages/Edge.tsx',
  'client/src/pages/Model.tsx',
  'client/src/pages/Projections.tsx',
  'client/src/pages/Rankings.tsx',
  'client/src/components/StaleBanner.tsx',
  'client/src/features/model-lab/ModelRegistryPanel.tsx'
];

test('the six unreachable client files are gone', () => {
  for (const f of DELETED) {
    assert.equal(fs.existsSync(at(f)), false, `${f} is back`);
  }
});

test('nothing imports or renders a deleted page, anywhere in the client', () => {
  // Written with plain string checks rather than a built RegExp. The first
  // draft of this used new RegExp(`import\\('\\./pages/${name}'\\)`), which is
  // double-escaped into a pattern matching a literal backslash and can never
  // match anything: the mutation that re-added the lazy import to App.tsx went
  // GREEN. A guard that has never been shown to fail is not a guard.
  const files = [];
  const walk = dir => {
    for (const e of fs.readdirSync(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}/${e.name}`);
      else if (/\.tsx?$/.test(e.name)) files.push(`${dir}/${e.name}`);
    }
  };
  walk('client/src');
  assert.ok(files.length > 40, 'the client tree walk found almost nothing — the check would pass vacuously');

  for (const f of files) {
    const src = read(f);
    for (const gone of DELETED) {
      // '.../pages/Rankings.tsx' -> 'pages/Rankings', the shape every import of
      // it must contain whatever the relative prefix is.
      const stem = gone.replace('client/src/', '').replace(/\.tsx$/, '');
      assert.ok(!src.includes(`/${stem}'`) && !src.includes(`/${stem}"`),
        `${f} imports ${stem}, which was deleted`);
    }
    for (const name of ['Edge', 'Rankings', 'Projections', 'StaleBanner', 'ModelRegistryPanel']) {
      assert.doesNotMatch(src, new RegExp(`<${name}[\\s/>]`), `${f} renders ${name}`);
    }
  }
});

test('the palette no longer advertises a page that is not there', () => {
  // /rankings and /projections still RESOLVE — they redirect to League Hub, so
  // an old bookmark works. What is gone is the app offering them by name: a row
  // reading "Your rankings and tiers" that lands on a page with no rankings is
  // the same dead link as one that lands on NotFound, in a politer form.
  const nav = read('client/src/navigation.ts');
  const deep = nav.slice(nav.indexOf('export const DEEP_DESTINATIONS'), nav.indexOf('export const DESTINATIONS'));
  assert.doesNotMatch(deep, /'\/rankings'|'\/projections'/, 'the palette offers a page that was deleted');
  const app = read('client/src/App.tsx');
  assert.match(app, /path="\/rankings" element=\{<Navigate to="\/league"/, 'the bookmark redirect was removed too');
  assert.match(app, /path="\/projections" element=\{<Navigate to="\/league"/, 'the bookmark redirect was removed too');
});

test('the nav is still the eight destinations Nick chose', () => {
  // Nine tabs were deleted on 2026-09-16 (commit 1694694). This pins the count
  // and the names, so a page coming back through the sidebar fails here too.
  const nav = read('client/src/navigation.ts');
  const labels = [...nav.slice(nav.indexOf('export const NAV_GROUPS'), nav.indexOf('NAV_NOTES'))
    // Both quote styles: "X's & O's" is written with double quotes because of
    // the apostrophes, and a single-quote-only match silently drops it — the
    // assertion then fails for a reason that has nothing to do with the nav.
    .matchAll(/label: (?:'([^']+)'|"([^"]+)")/g)].map(m => m[1] ?? m[2]);
  const items = labels.filter(l => !['My team', 'Intelligence', 'Setup'].includes(l));
  assert.deepEqual(items, [
    'League Hub', 'Start/Sit', 'Trade Lab', 'Trade Brain', 'Draft', 'News', "X's & O's", 'Settings'
  ], 'the sidebar destinations changed');
});
