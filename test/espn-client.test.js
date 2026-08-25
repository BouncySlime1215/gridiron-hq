import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EspnAuthenticationError, EspnLeagueMismatchError, EspnLeagueNotFoundError, EspnResponseError, EspnTimeoutError,
  buildEspnCookieHeader, espnAccountFingerprint, espnRequest, fetchEspnLeague,
  normalizeEspnS2, normalizeSwid, redactEspnSecrets
} from '../server/services/espn-client.js';

test('normalizes ESPN cookies without double encoding or damaging encoded characters', () => {
  assert.equal(normalizeEspnS2('  token%2Fpart%3D  '), 'token%2Fpart%3D');
  assert.equal(normalizeSwid('%7Babc%2Fdef%7D'), '{abc%2Fdef}');
  assert.equal(normalizeSwid('{abc%2Fdef}'), '{abc%2Fdef}');
  assert.equal(buildEspnCookieHeader({ espn_s2: 'x%2By', swid: 'abc%2Fdef' }),
    'espn_s2=x%2By; SWID={abc%2Fdef}');
});

test('rejects cookie header injection', () => {
  assert.throws(() => normalizeEspnS2('secret; other=value'), /invalid espn_s2 cookie/);
  assert.throws(() => normalizeSwid('abc\r\nInjected: yes'), /invalid SWID cookie/);
});

test('request uses a bounded timeout and performs one fetch only', async () => {
  let calls = 0;
  await assert.rejects(() => espnRequest('https://example.test', { espn_s2: 's2', swid: 'id' }, {
    timeoutMs: 999_999,
    fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(options.signal.constructor.name, 'AbortSignal');
      return { ok: false, status: 500 };
    }
  }), error => error.code === 'ESPN_UPSTREAM_ERROR');
  assert.equal(calls, 1);
});

test('public requests omit cookies while authenticated requests normalize them', async () => {
  const seen = [];
  const fetchImpl = async (_url, options) => {
    seen.push(options.headers);
    return { ok: true, status: 200, json: async () => ({ id: 12, seasonId: 2026 }) };
  };
  await fetchEspnLeague({ leagueId: '12', season: 2026, fetchImpl });
  await fetchEspnLeague({ leagueId: '12', season: 2026,
    espn_s2: ' token ', swid: '%7Bmember%7D', fetchImpl });
  assert.deepEqual(seen[0], { Accept: 'application/json' });
  assert.deepEqual(seen[1], { Accept: 'application/json', Cookie: 'espn_s2=token; SWID={member}' });
});

test('maps authentication, timeout, and malformed JSON to typed errors', async () => {
  await assert.rejects(() => espnRequest('x', { espn_s2: 's2', swid: 'id' }, {
    fetchImpl: async () => ({ ok: false, status: 403 })
  }), EspnAuthenticationError);
  await assert.rejects(() => espnRequest('x', undefined, {
    fetchImpl: async () => ({ ok: false, status: 404 })
  }), EspnLeagueNotFoundError);
  await assert.rejects(() => espnRequest('x', { espn_s2: 's2', swid: 'id' }, {
    fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }
  }), EspnTimeoutError);
  await assert.rejects(() => espnRequest('x', { espn_s2: 's2', swid: 'id' }, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } })
  }), EspnResponseError);
});

test('validates the exact league and season', async () => {
  await assert.rejects(() => fetchEspnLeague({ leagueId: '12', season: 2026, espn_s2: 's2', swid: 'id',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ id: 13, seasonId: 2026 }) })
  }), EspnLeagueMismatchError);
});

test('redacts secrets and fingerprints only ESPN-provided member identity', () => {
  assert.deepEqual(redactEspnSecrets({ espn_s2: 'secret', nested: { SWID: 'id', ok: 1 } }),
    { espn_s2: '[REDACTED]', nested: { SWID: '[REDACTED]', ok: 1 } });
  assert.equal(espnAccountFingerprint({ teams: [] }), null);
  assert.match(espnAccountFingerprint({ members: [{ id: 'b' }, { id: 'a' }] }), /^[a-f0-9]{64}$/);
});
