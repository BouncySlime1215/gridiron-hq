/**
 * PEOPLE-01 profile reader (server/services/people/profile-reader.js) on a fixture chat DB.
 * Made-up people A..D; no real chat data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { readProfiles, parseOverride, valuesTalk, QUIET_MESSAGES, UNKNOWN } = await import('../server/services/people/profile-reader.js');
const { negotiationProfileErrors } = await import('../server/services/counterparty-pricing.js');

const { makeChatDb, richProfile, DAY, T0 } = await import('./fixtures/people-chat.mjs');

const ids = names => new Map(names.map((n, i) => [String(i + 2), { chat_name: n }]));

test('typed unknown: a quiet manager and one with no profile read unknown with a reason, never neutral', () => {
  const chat = makeChatDb({
    negotiation: [{ name: 'A', profile: richProfile() }, { name: 'B', profile: richProfile(), messages_read: QUIET_MESSAGES - 1 }],
    chatProfile: [{ name: 'A', msgs: 300 }, { name: 'B', msgs: 5 }],
  });
  const r = readProfiles({ chat, ids: ids(['A', 'B', 'C']), asOf: T0 + DAY });
  assert.equal(r.status, 'ok');
  const [a, b, c] = ['2', '3', '4'].map(k => r.byRoster.get(k));
  assert.equal(a.status, 'ok');
  assert.equal(a.negotiation.status, 'ok');
  assert.equal(a.chat.msgs, 300);
  assert.equal(b.status, UNKNOWN);
  assert.match(b.negotiation.reason, /quiet: 29 messages/);
  assert.equal(b.chat.status, UNKNOWN);
  assert.equal(c.status, UNKNOWN);
  assert.match(c.reason, /no negotiation profile/);
  for (const e of [b, c]) assert.ok(!('values_talk' in e.negotiation), 'an unknown profile carries no field values');
  chat.close();
});

test('the 9/23 fields are read, not rejected: values_talk, deal_feelings, behaviour_vs_words', () => {
  const p = richProfile({ values_talk: { wants: [{ player: 'P4', at: '2026-09-20T00:00:00Z', n: 3 }], untouchable: ['P11'] },
    deal_feelings: { urgency: 'high' }, behaviour_vs_words: { gap: 'says no, then deals' } });
  assert.ok(negotiationProfileErrors(p).some(e => /unexpected key/.test(e)), 'the old validator rejects the new shape');
  const chat = makeChatDb({ negotiation: [{ name: 'A', profile: p }] });
  const a = readProfiles({ chat, ids: ids(['A']), asOf: T0 + 5 * DAY }).byRoster.get('2');
  assert.equal(a.negotiation.values_talk.status, 'ok');
  assert.deepEqual(a.negotiation.values_talk.wants, [{ player: 'P4', at: Date.parse('2026-09-20T00:00:00Z'), n: 3, dated: true }]);
  assert.equal(a.negotiation.values_talk.untouchable[0].player, 'P11');
  assert.equal(a.negotiation.values_talk.untouchable[0].dated, false, 'an undated mention is dated by the build, and says so');
  assert.deepEqual(a.negotiation.deal_feelings, { urgency: 'high' });
  assert.equal(a.negotiation.changes_since.status, UNKNOWN);
  chat.close();
});

test('roster_read fills untouchable / shopping for a 9/18-shape profile', () => {
  const vt = valuesTalk(richProfile({ roster_read: { really_untouchable: ['P21'], quietly_available: ['P23'] } }), T0);
  assert.equal(vt.source, 'roster_read');
  assert.deepEqual(vt.untouchable.map(m => m.player), ['P21']);
  assert.deepEqual(vt.shopping.map(m => m.player), ['P23']);
  assert.equal(valuesTalk(richProfile(), T0).status, UNKNOWN);
});

test('as_of versioned: a row built after as_of is invisible; the newest visible one serves; older ones are history', () => {
  const chat = makeChatDb({ negotiation: [
    { name: 'A', profile: richProfile({ headline: 'v1', roster_read: { really_untouchable: ['P21'] } }), built_at: T0 },
    { name: 'A', profile: richProfile({ headline: 'v2', roster_read: { really_untouchable: ['P22'] } }), built_at: T0 + 5 * DAY },
  ] });
  const early = readProfiles({ chat, ids: ids(['A']), asOf: T0 + DAY });
  assert.equal(early.byRoster.get('2').negotiation.values_talk.untouchable[0].player, 'P21');
  assert.equal(early.byRoster.get('2').history.length, 1);
  assert.match(early.tables.negotiation_profiles, /1 rows built after as_of/);
  const late = readProfiles({ chat, ids: ids(['A']), asOf: T0 + 6 * DAY });
  assert.equal(late.byRoster.get('2').negotiation.values_talk.untouchable[0].player, 'P22');
  assert.deepEqual(late.byRoster.get('2').history.map(h => h.untouchable[0].player), ['P21', 'P22']);
  const before = readProfiles({ chat, ids: ids(['A']), asOf: T0 - DAY });
  assert.equal(before.byRoster.get('2').status, UNKNOWN, 'before the first build there is no profile');
  chat.close();
});

test('nick_override: column shape and key/value shape both read; exclude / deprioritize / toughen', () => {
  const col = makeChatDb({ notes: [{ name: 'A', override: 'never trade with him' }, { name: 'B', override: '{"deprioritize":true}' }] });
  const r = readProfiles({ chat: col, ids: ids(['A', 'B', 'C']), asOf: T0 + DAY });
  assert.deepEqual([r.byRoster.get('2').override.exclude, r.byRoster.get('2').override.toughen], [true, true]);
  assert.deepEqual([r.byRoster.get('3').override.deprioritize, r.byRoster.get('3').override.toughen], [true, true]);
  assert.equal(r.byRoster.get('4').override.status, 'none');
  col.close();
  const kv = makeChatDb({ notesShape: 'kv', notes: [{ name: 'A', override: 'watch him, he squeezes' }] });
  const o = readProfiles({ chat: kv, ids: ids(['A']), asOf: T0 }).byRoster.get('2').override;
  assert.deepEqual([o.status, o.exclude, o.deprioritize, o.toughen], ['ok', false, true, true]);
  kv.close();
  const none = makeChatDb({ notesShape: null });
  const n = readProfiles({ chat: none, ids: ids(['A']), asOf: T0 }).byRoster.get('2').override;
  assert.equal(n.status, UNKNOWN);
  assert.equal(n.exclude, false);
  none.close();
  assert.equal(parseOverride(null).status, 'none');
  assert.equal(parseOverride({ exclude: true }).exclude, true);
});

test('no chat DB, no identities, and Nick himself: typed absence, and Nick is never a counterparty', () => {
  assert.equal(readProfiles({ chat: null, ids: ids(['A']) }).status, UNKNOWN);
  assert.match(readProfiles({ chat: null, ids: new Map() }).reason, /no confirmed chat identities/);
  const chat = makeChatDb({ negotiation: [{ name: 'A', profile: richProfile() }] });
  const r = readProfiles({ chat, ids: ids(['A', 'ME']), asOf: T0 + DAY, myTeam: '3' });
  assert.deepEqual([...r.byRoster.keys()], ['2']);
  chat.close();
});
