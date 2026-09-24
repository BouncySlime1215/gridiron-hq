// REASON-02 operator command, end to end on the test database: migrations run,
// claims from a plans + panels pair are stored for the named league only, and
// one JSON line carries the C8 row.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Its own temp database, so running this file directly never touches a real one.
process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-reason-02-script-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const { assemblePanel } = await import('../server/services/reasoning/panel.js');
const { cardsForLeague } = await import('../server/services/reasoning/cards.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');
const { main } = await import('../scripts/reasoning/grade-claims.mjs');

const AS_OF = '2026-09-24T12:00:00Z';

function files() {
  // The War Room contract shape (plans-schema.js), as cards.js reads it.
  const okf = value => ({ status: 'ok', value });
  const league = (id) => ({
    league: id, names: {},
    alternatives: okf([{ move_id: `mv-${id}`, steps: [{ partner: 3, give: [101], get: [201], p_yes: okf(0.4),
      reply_table: okf({ decline: okf({ do: 'Move on' }) }) }] }]),
    partners: okf([{ team: 3, roster_holes: ['RB'] }])
  });
  const plans = { generated_at: AS_OF, leagues: [league(4), league(5)] };
  const ok = value => ({ ok: true, violations: [], numbers_checked: 0, value });
  const panels = {
    as_of: AS_OF,
    leagues: plans.leagues.map(l => ({
      league_id: l.league,
      panels: [assemblePanel({
        card: cardsForLeague(l).cards[0], league: l, leagueId: l.league, news: [], omit: [], omitReason: {}, missing: null,
        asOf: AS_OF, fingerprint: 'fp', cost: {},
        grounded: {
          case_for: ok({ claims: [{ text: 'Surplus receiver', cites: ['card.give.0'] }] }),
          his_side: ok({ claims: [{ text: 'He needs a back', cites: ['his.hole.0.pos'] }] }),
          devils_advocate: ok({ claims: [{ text: 'x', cites: ['card.p_yes'] }], would_change: [{ text: 'y', cites: ['card.p_yes'] }] }),
          news_check: ok({ contradictions: [] }),
          counter: ok({ likely: { text: 'He declines', cites: ['reply.decline.action'] }, answer: { text: 'Move on', cites: ['reply.decline.action'] } })
        }
      })]
    }))
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reason-02-'));
  fs.writeFileSync(path.join(dir, 'plans.json'), JSON.stringify(plans));
  fs.writeFileSync(path.join(dir, 'panels.json'), JSON.stringify(panels));
  return dir;
}

test('grade-claims.mjs: on, league-scoped, one JSON line with the C8 row', async () => {
  const dir = files();
  const before = process.env[PREVIEW_ENV];
  process.env[PREVIEW_ENV] = '1';
  const lines = [];
  try {
    const argv = ['node', 'x', '--plans', path.join(dir, 'plans.json'), '--panels', path.join(dir, 'panels.json'), '--league', '4'];
    await main({ argv, now: new Date(AS_OF), log: l => lines.push(l) });
    assert.equal(lines.length, 1);
    const out = JSON.parse(lines[0]);
    assert.equal(out.reasoning_grading, 'on');
    assert.equal(out.recorded.inserted, 6);
    assert.deepEqual(out.stored.map(s => s.kind).sort(), ['counter_with', 'uncheckable', 'wants_position']);
    assert.equal(out.report.check, 'C8');
    assert.equal(out.report.detail.coverage.all, 6);

    const { db } = await import('../server/db/index.js');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM reasoning_claims WHERE league_id = 5').get().n, 0);
  } finally {
    if (before === undefined) delete process.env[PREVIEW_ENV]; else process.env[PREVIEW_ENV] = before;
  }
});

test('grade-claims.mjs: off, it stores nothing and says so', async () => {
  const dir = files();
  const before = process.env[PREVIEW_ENV];
  delete process.env[PREVIEW_ENV];
  const lines = [];
  try {
    const argv = ['node', 'x', '--plans', path.join(dir, 'plans.json'), '--panels', path.join(dir, 'panels.json'), '--league', '5'];
    await main({ argv, now: new Date(AS_OF), log: l => lines.push(l) });
    const out = JSON.parse(lines[0]);
    assert.equal(out.reasoning_grading, 'off');
    assert.equal(out.report.status, 'not_enough_data');
    const { db } = await import('../server/db/index.js');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM reasoning_claims WHERE league_id = 5').get().n, 0);
  } finally {
    if (before !== undefined) process.env[PREVIEW_ENV] = before;
  }
});
