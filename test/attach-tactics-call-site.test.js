import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Same isolated-DB pattern used across this suite: point GRIDIRON_DB_PATH at a
// throwaway file before anything imports server/db/index.js.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-attach-tactics-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { _attachTactics, _setTacticsReads } = await import('../server/services/trade-engine.js');

afterEach(() => { _setTacticsReads(); });
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/**
 * G10 THE CALL SITE, NOT ONLY THE VOCABULARY.
 *
 * G9 pins `readFault` and the functions that read it. It does not pin
 * `attachTactics`, which is where the three catches are: reverting only
 * trade-engine.js to the bare `timing = new Map()` / `climate = null` /
 * `self = null` left every G9 test green. These drive the real call site with a
 * read that throws, and read the card it produces.
 */
const boom = () => { throw new Error('read exploded'); };

function cardFor() {
  const d = { partner_id: 7, partner: 'Sam',
    i_give: [{ id: 1, name: 'A', value: 100, position: 'RB' }],
    i_get: [{ id: 2, name: 'B', value: 100, position: 'RB' }],
    their_value_pct: 5, edge: { passes: true }, counterparty: null };
  _attachTactics({ id: 1 }, [d], { deals: [d], counterparties: new Map(),
    weekNow: { season: 2026 }, assets: new Map(), teams: [], zero: [], ideaKey: () => 'k' });
  const said = key => d.tactics.find(t => t.key === key)?.why
    ?? d.tactics_absent.find(a => a.key === key)?.reason ?? '';
  return { d, said };
}

test('G10a: a timing read that throws does not say the league has no captured transactions', () => {
  _setTacticsReads({ timingRead: boom });
  const { said } = cardFor();
  assert.doesNotMatch(said('timing'), /no captured transactions|no reason to wait/,
    'a crashed timing read must not arrive on the card as a league with no history');
  assert.match(said('timing'), /could not be read/, 'the card must say the read did not complete');
});

test('G10b: a veto-climate read that throws does not become a fact about the league settings', () => {
  _setTacticsReads({ vetoClimate: boom });
  const { said } = cardFor();
  assert.doesNotMatch(said('veto_proof'), /settings do not carry a veto threshold/,
    'a crashed climate read must not arrive as a statement about ESPN settings');
  assert.match(said('veto_proof'), /could not be read/, 'the card must say the read did not complete');
});

test('G10c: a self read that throws does not become a claim about what Nick has done', () => {
  _setTacticsReads({ selfRead: boom });
  const { said } = cardFor();
  assert.doesNotMatch(said('how_nick_looks'), /never made this manager an offer/,
    'a crashed self read must not arrive as a claim about Nick');
  assert.match(said('how_nick_looks'), /could not be read/, 'the card must say the read did not complete');
});

test('G10 control: reads that complete with nothing still say nothing was captured', () => {
  // The not-applied control: no read throws, each honestly returns empty. The
  // no-history sentences are correct here and must survive the fix.
  _setTacticsReads({ timingRead: () => new Map(), vetoClimate: () => null, selfRead: () => null });
  const { said } = cardFor();
  assert.match(said('timing'), /no captured transactions/);
  assert.match(said('veto_proof'), /settings do not carry a veto threshold/);
  for (const key of ['timing', 'veto_proof', 'how_nick_looks']) {
    assert.doesNotMatch(said(key), /could not be read/, `${key} must not report a fault that did not happen`);
  }
});
