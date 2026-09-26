/**
 * Live-app report (coordinator, 2026-09-25, after #439): the Trades -> Next move hero showed
 * INITIALS instead of player photos and the "Value edge" stat stayed a skeleton. On live data
 * the id -> ESPN headshot mapping (GET /api/players, espn_id) and the precomputed his-screen
 * both answer (checked in the browser); what failed was a read that was briefly unavailable or
 * slow and never recovered. Pinned here:
 *   1. the headshot list is re-read after a failure instead of leaving initials for the visit;
 *   2. a picture that failed once is tried again when a new URL arrives;
 *   3. a value edge that has not answered in time reads "not available" with the reason,
 *      never an endless skeleton, and a late answer still replaces it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, domRenderer, textOf, one, all, fire, DomEvent, waitFor } from './helpers/warroom-render.js';

installDom();
const { loadWarRoom } = await import('./helpers/warroom-tsx.mjs');
const wr = await loadWarRoom();
const { React, mount } = await domRenderer();
const { useHeadshotMap } = await wr.mod('useWarRoom');
const { ValueEdge } = await wr.mod('HeroCard');
const { default: TradeSides } = await wr.mod('TradeSides');
const h = React.createElement;
const mounted = [];
test.afterEach(() => { delete globalThis.__warRoomUseApi; delete globalThis.__warRoomApi; while (mounted.length) mounted.pop().unmount(); });
test.after(() => wr.cleanup());

const ESPN = id => `https://a.espncdn.com/i/headshots/nfl/players/full/${id}.png`;

test('1: a failed player-list read is retried, and the pictures arrive', async () => {
  let reads = 0;
  let ok = false;
  const listeners = new Set();
  globalThis.__warRoomUseApi = p => {
    const [, force] = React.useState(0);
    React.useEffect(() => { const f = () => force(x => x + 1); listeners.add(f); return () => listeners.delete(f); }, []);
    if (p !== '/players') return { data: null, loading: false, error: null, refetch() {} };
    return ok
      ? { data: [{ id: 293, headshot: ESPN(3929645) }, { id: -16, headshot: ESPN(-16) }, { id: 7, headshot: 'https://sleepercdn.com/x.jpg' }], loading: false, error: null, refetch() {} }
      : { data: null, loading: false, error: '503 Service Unavailable', refetch() { reads++; ok = true; for (const f of listeners) f(); } };
  };
  let map = null;
  const Probe = () => { map = useHeadshotMap(20); return null; };
  mounted.push(mount(h(Probe)));
  await waitFor(() => map && map['293'], 2000, 'the retried list');
  assert.equal(reads, 1, 'one retry after the failure');
  assert.deepEqual(map, { 293: ESPN(3929645) }, 'ESPN pictures only; a team defence (negative id) gets none');
});

test('2: a picture that failed is tried again when a new URL arrives', async () => {
  const side = headshot => ({ id: '293', name: 'Player 293', pos: 'TE', team: null, headshot, title: 'Player 293 (TE)' });
  let setShot = null;
  const Host = () => { const [s, set] = React.useState(ESPN(1)); setShot = set; return h(TradeSides, { give: [side(s)], get: [side(null)] }); };
  const ui = mount(h(Host));
  mounted.push(ui);
  const img = await waitFor(() => all(ui.container, e => e.localName === 'img')[0], 2000, 'the first picture');
  fire(img, new DomEvent('error'));
  await waitFor(() => all(ui.container, e => e.localName === 'img').length === 0, 2000, 'initials after the failure');
  setShot(ESPN(3929645));
  const again = await waitFor(() => all(ui.container, e => e.localName === 'img')[0], 2000, 'the new picture');
  assert.equal(again.getAttribute('src'), ESPN(3929645));
});

test('3: a value edge that never answers says "not available" with the reason; a late answer replaces it', async () => {
  const offer = { partner: '2', give: ['293', '288'], get: ['46'] };
  let answer = null;
  const listeners = new Set();
  globalThis.__warRoomUseApi = () => {
    const [, force] = React.useState(0);
    React.useEffect(() => { const f = () => force(x => x + 1); listeners.add(f); return () => listeners.delete(f); }, []);
    return answer ? { data: answer, loading: false, error: null, refetch() {} } : { data: null, loading: true, error: null, refetch() {} };
  };
  const ui = mount(h(ValueEdge, { leagueId: 4, offer, waitMs: 30 }));
  mounted.push(ui);
  const cell = () => one(ui.container, 'data-testid', 'hero-value');
  await waitFor(() => cell() && one(cell(), 'role', 'status'), 2000, 'the skeleton while it loads');
  const unk = await waitFor(() => one(cell(), 'data-state', 'unknown'), 2000, 'the time limit');
  assert.match(textOf(cell()), /not available/);
  assert.match(unk.getAttribute('title'), /has not answered in 0 s|has not answered in \d+ s/);
  assert.equal(one(cell(), 'role', 'status'), null, 'no skeleton after the limit');
  answer = { enabled: true, market: { pct: -8 } }; // pct is his side over ours, in percent: -8 = Nick gets 8% more
  for (const f of listeners) f();
  await waitFor(() => /\+8%/.test(textOf(cell())), 2000, 'the late answer');
});
