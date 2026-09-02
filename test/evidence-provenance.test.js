import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Every timestamp inside a frozen forward payload must precede the kickoff cutoff.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-provenance-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/nfl-expert-council.js');
const prov = await import('../server/services/nfl-evidence-provenance.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const insert = (expert, payload, observed = 1) => run(`INSERT INTO nfl_expert_forward_predictions
  (season,week,home,away,expert_id,horizon,council_version,engine_version,evidence_hash,evidence_cutoff,captured_at,market_margin,observed,forecast_residual,uncertainty,authority,missing_reason,payload_json)
  VALUES (2026,1,'KC','DEN',?,'open','v','e','h','2026-09-13T17:00:00.000Z','2026-09-10T12:00:00Z',3,?,0.5,3,'research_only',NULL,?)`, expert, observed, JSON.stringify(payload));

insert('news_reaction', { home: { claims: [{ published_at: '2026-09-09T20:00:00.000Z' }, { published_at: '2026-09-13T18:30:00.000Z' }] }, cutoff: '2026-09-13T17:00:00.000Z' });
insert('price_shopper', { captured_at: '2026-09-10T11:58:00.000Z', sides: [{ books: 9 }] });
insert('rulebook', { components: 5 });
insert('live_updater', {}, 0);

test('timestamps are collected from nested payloads and late ones are flagged per role', () => {
  const stamps = prov.collectTimestamps({ a: { published_at: '2026-01-01T00:00:00Z' }, list: [{ captured_at: '2026-01-02T00:00:00Z' }], not_a_stamp: '2026-01-03T00:00:00Z' });
  assert.deepEqual(stamps.map(s => s.path), ['a.published_at', 'list[0].captured_at']);
  const report = prov.verifyForwardEvidence({ season: 2026, week: 1 });
  assert.equal(report.rows, 4);
  assert.equal(report.by_expert.news_reaction.late_evidence, 1, 'a claim published after kickoff inside a pregame card');
  assert.equal(report.by_expert.price_shopper.stamped, 1);
  assert.equal(report.by_expert.rulebook.undated, 1, 'an observed row with no stamp is listed, not assumed clean');
  assert.equal(report.by_expert.live_updater.abstained, 1);
  assert.equal(report.flagged_rows, 1);
  assert.equal(report.flagged[0].late[0].path, 'home.claims[1].published_at');
  assert.equal(report.captured_after_cutoff, 0);
  assert.match(report.verdict, /late evidence found/);
});
