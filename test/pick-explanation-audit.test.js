import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-pick-explanation-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { explanationReasoningHash, recordPickExplanation, recentPickExplanations } =
  await import('../server/services/nfl-pick-explanation-audit.js');
const { db } = await import('../server/db/index.js');
test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('post-pick AI translations preserve the frozen deterministic reasoning hash', () => {
  const reasoning = { headline: 'Market disagreement', supporting: [{ key: 'epa', strength: 1 }], opposing: [] };
  assert.equal(explanationReasoningHash(reasoning), explanationReasoningHash(structuredClone(reasoning)));
  const saved = recordPickExplanation({ season: 2026, week: 1, matchup: 'A at B', market: 'spread',
    selection: 'B', reasoning, translation: { paragraph: 'EPA supplied the only support.', factor_keys_used: ['epa'], limitations: ['No news context.'] } });
  assert.equal(saved.authority, 'wording_only');
  assert.match(saved.reasoning_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(saved.sequence, ['deterministic pick selected', 'factor packet frozen and hashed', 'AI translated packet into prose']);
  assert.equal(recentPickExplanations({ limit: 1 })[0].id, saved.id);
});
