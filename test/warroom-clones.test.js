/**
 * UI-ENG-4: the War Room clone view (server/services/warroom-clones.js) and the labels it
 * reduces THE one profile reader's entries to (server/services/people/profile-reader.js,
 * FIX-00 #260, RULINGS 1: this PR has no reader of its own).
 *
 *  - enum slots holding sentences reduce to labels by their leading token; no sentence
 *    from the profile reaches the output;
 *  - Nick's override beats the chat-derived read; a quiet manager is 'unknown' but keeps
 *    Nick's labels;
 *  - P(accept) is a band; no record -> "population, not him"; not reachable -> no band;
 *  - "wants player X" is full strength for 7 days, fades to nothing by day 21, and only
 *    ever names a rostered player he does not own;
 *  - his shop-talk credibility comes from his declaration record, then the profile label;
 *  - failed and unknown fields carry no value; no manager name reaches the output.
 * Fixtures are invented SHAPES (keys, sentence-style enum values), not chat text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { peopleProfileEntry, nickBlock, QUIET_MESSAGES } = await import('../server/services/people/profile-reader.js');
const { buildCloneRows, wantsField, credibilityField, warRoomClones, cloneProfile, cloneNick, WANTS_FULL_DAYS, WANTS_GONE_DAYS } =
  await import('../server/services/warroom-clones.js');
const { PREVIEW_ENV, PREVIEW_PREFIX } = await import('../server/services/preview-mode.js');
const { WARROOM_ENV } = await import('../server/services/warroom-flag.js');

const NOW = Date.parse('2026-09-24T12:00:00Z');
const daysAgo = d => new Date(NOW - d * 86400000).toISOString();
const SENTINEL = 'QUOTE-SENTINEL';

/** A rebuilt-profile row SHAPE (schema v2): new top-level keys, sentences in the enum slots. */
function rawProfile(over = {}) {
  return {
    headline: `${SENTINEL} headline`,
    what_moves_him: [], caveats: [], confidence: 'medium',
    praise_means: { reading: 'mixed', why: SENTINEL, evidence: [] },
    as_of: daysAgo(3),
    messages_read: 120,
    says_no: { how: SENTINEL, evidence: [], does_his_no_hold: `rarely (${SENTINEL} is the exception)` },
    calibration: { enthusiasm_scale: SENTINEL, inflation: 'moderate' },
    deal_feelings: { urgency: `high: ${SENTINEL} keeps asking` },
    techniques: [{ name: 'anchors high then counters', how_he_does_it: SENTINEL, how_often: `often (8 ${SENTINEL})` }],
    how_to_approach: `lead with the numbers ${SENTINEL}`,
    behaviour_vs_words: { verdict: `mostly yes: ${SENTINEL}` },
    values_talk: { wants: { players: ['Alpha Runner', { player: 'Bravo Catcher', at: daysAgo(14) }, 'Not A Player Phrase', 'Old Want'], positions: ['TE'] } },
    changes_since_0918: [{ field: 'urgency' }],
    ...over,
  };
}

/** One stored row through THE reader, then the panel's labels. */
const read = (raw, { notes = [] } = {}) => cloneProfile(peopleProfileEntry({ name: 'x', rosterId: '2',
  row: raw ? { profile_json: JSON.stringify(raw), messages_read: raw.messages_read } : null, notes }));

/** Invented rostered players: normalized name -> player. */
const PLAYERS = new Map([
  ['alpha runner', { id: '101', name: 'Alpha Runner', pos: 'RB', owner: '1' }],
  ['bravo catcher', { id: '102', name: 'Bravo Catcher', pos: 'WR', owner: '3' }],
  ['old want', { id: '103', name: 'Old Want', pos: 'QB', owner: '3' }],
  ['his own guy', { id: '104', name: 'His Own Guy', pos: 'TE', owner: '2' }],
]);

test('sentences reduce to labels through the one reader, unparseable -> unknown', () => {
  const t = over => read(rawProfile(over)).traits;
  assert.equal(t({ says_no: { how: 'x', evidence: [], does_his_no_hold: 'mostly yes: firm on his stars' } }).no_holds, 'usually');
  assert.equal(t({ says_no: { how: 'x', evidence: [], does_his_no_hold: 'it depends on the week' } }).no_holds, 'unknown');
  assert.equal(t({ calibration: { enthusiasm_scale: 'x', inflation: 'heavy on his RBs' } }).inflation, 'heavy');
  assert.equal(t({ behaviour_vs_words: 'talks a big game' }).word_match, 'cheap_talk');
  assert.equal(t({ behaviour_vs_words: true }).word_match, 'credible');
  assert.equal(t({ deal_feelings: { urgency: 'low, happy to wait' } }).urgency, 'low');
  assert.equal(t({ deal_feelings: { urgency: 'it depends' } }).urgency, 'unknown');
});

test('a rebuilt profile reads as typed traits and no sentence leaves the reader', () => {
  const p = read(rawProfile());
  assert.equal(p.status, 'ok');
  assert.deepEqual(p.traits, {
    no_holds: 'rarely', inflation: 'mild', urgency: 'high', posture: 'haggler', style: 'numbers',
    word_match: 'credible', buyer: 'unknown', hard_to_deal_with: 'unknown',
  });
  assert.equal(p.sources.no_holds, 'profile');
  assert.equal(p.sources.buyer, 'unknown');
  assert.doesNotMatch(JSON.stringify(p), new RegExp(SENTINEL));
});

test("Nick's override beats the chat read, and his notes are counted, not copied", () => {
  const p = read(rawProfile({ nick_override: { trades: 'probably none', difficulty: 'hard to deal with', note: `${SENTINEL} note` } }),
    { notes: [{ name: 'x', note: `${SENTINEL} said so`, source: 'nick-chat-1', noted_at: 'y' }] });
  assert.equal(p.traits.buyer, false);
  assert.equal(p.sources.buyer, 'nick_override');
  assert.equal(p.traits.hard_to_deal_with, true);
  assert.equal(p.nick.notes_n, 2);
  assert.doesNotMatch(JSON.stringify(p), new RegExp(SENTINEL));
  assert.deepEqual(cloneNick(nickBlock({ contactable: false, active: true, fan_of: 'NYG' })).contactable, false);
  assert.equal(cloneNick(nickBlock({ fan_of: `${SENTINEL} and a long sentence about it` })).fan_of, null, 'a sentence is not a team label');
});

test('a quiet manager is unknown, keeps no traits or wants, but keeps Nick\'s word', () => {
  const p = read(rawProfile({ messages_read: QUIET_MESSAGES - 1, nick_override: { active: true } }));
  assert.equal(p.status, 'unknown');
  assert.match(p.reason, /quiet in chat/);
  assert.ok(Object.values(p.traits).every(v => v === 'unknown'));
  assert.deepEqual(p.wants, []);
  assert.equal(p.nick.active, true);
  assert.equal(read(null).status, 'unknown');
  assert.match(read({ not: 'a v2 profile' }).reason, /schema v2/, 'an invalid stored profile says so');
});

test('wants: full strength for 7 days, fading to nothing by 21, rostered players he does not own only', () => {
  const profile = read(rawProfile({ values_talk: { wants: { players: [
    { player: 'Alpha Runner', at: daysAgo(3) }, { player: 'Bravo Catcher', at: daysAgo(14) },
    { player: 'Old Want', at: daysAgo(25) }, { player: 'His Own Guy', at: daysAgo(1) },
    { player: 'Not A Player Phrase', at: daysAgo(1) },
  ] } } }));
  const f = wantsField(profile, { team: '2', players: PLAYERS, me: '1', now: NOW });
  assert.equal(f.status, 'ok');
  assert.deepEqual(f.value.map(w => [w.player.name, w.state, w.strength, w.you_have]),
    [['Alpha Runner', 'fresh', 1, true], ['Bravo Catcher', 'fading', 0.5, false]]);
  assert.equal(WANTS_FULL_DAYS, 7);
  assert.equal(WANTS_GONE_DAYS, 21);
  assert.equal(wantsField(read(null), { team: '2', players: PLAYERS, now: NOW }).status, 'unknown');
  assert.equal(wantsField(profile, { team: '2', players: null, now: NOW }).status, 'unknown');
});

test('credibility: his declaration record first, the profile label second, unknown when quiet', () => {
  const profile = read(rawProfile({ behaviour_vs_words: 'talks more than he trades' }));
  const rec = credibilityField(profile, { declarations: 6, held: 5, hard_reversals: 1, hedged: 0, credibility: 0.78, confidence: 'thin' });
  assert.deepEqual([rec.status, rec.value.label, rec.value.from, rec.value.held, rec.value.n], ['ok', 'credible', 'record', 5, 6]);
  const low = credibilityField(profile, { declarations: 5, held: 1, hard_reversals: 3, hedged: 1, credibility: 0.3, confidence: 'measured' });
  assert.equal(low.value.label, 'cheap_talk');
  const fromProfile = credibilityField(profile, { declarations: 1, credibility: 0.9 });
  assert.deepEqual([fromProfile.value.label, fromProfile.value.from], ['cheap_talk', 'profile']);
  const quiet = credibilityField(read(rawProfile({ messages_read: 3 })), null);
  assert.equal(quiet.status, 'unknown');
  assert.equal('value' in quiet, false);
});

function league({ profilesAvailable = true, cp = new Map(), cpState } = {}) {
  const byRoster = new Map([
    ['2', read(rawProfile({ nick_override: { active: true, difficulty: 'hard to deal with' } }))],
    ['3', read(rawProfile({ messages_read: 4 }))],
    ['4', read(rawProfile({ nick_override: { contactable: false } }))],
  ]);
  return buildCloneRows({
    teams: ['1', '2', '3', '4', '5'], me: '1',
    profiles: profilesAvailable ? { available: true, byRoster } : { available: false, reason: 'the chat DB is not on this machine', byRoster: new Map() },
    counterparties: cp, cpState, records: new Map([['2', { declarations: 6, held: 5, hard_reversals: 1, hedged: 0, credibility: 0.78, confidence: 'thin' }]]),
    players: PLAYERS, now: NOW,
  });
}

test('one row per league-mate, Nick left out, active first and unreachable last', () => {
  const rows = league();
  assert.deepEqual(rows.map(r => [r.team, r.standing]), [['2', 'active'], ['3', 'normal'], ['5', 'normal'], ['4', 'excluded']]);
  assert.ok(rows.every(r => r.label === `Team ${r.team}`));
});

test('P(accept) is a band: population when he has no record, his own record when he does, none when unreachable', () => {
  const cp = new Map([['2', { accept_rate: 0.5, accept_rate_n: 8, receptiveness: 1 }]]);
  const rows = Object.fromEntries(league({ cp }).map(r => [r.team, r]));
  const his = rows['2'].p_accept;
  assert.equal(his.status, 'ok');
  assert.equal(his.value.basis, 'his_record');
  assert.equal(his.note, 'his record (n=8)');
  assert.ok(his.value.low < his.value.mid && his.value.mid < his.value.high);
  assert.equal(his.guess, true);
  assert.equal(his.value.fitted, false);
  assert.equal(rows['5'].p_accept.value.basis, 'population');
  assert.equal(rows['5'].p_accept.note, 'population, not him');
  assert.equal(rows['4'].p_accept.status, 'unknown');
  assert.match(rows['4'].p_accept.reason, /not reachable/);
  assert.equal('value' in rows['4'].p_accept, false);
});

test('a failed counterparty layer shows as failed on every band, with no value', () => {
  const rows = league({ cp: null, cpState: { status: 'failed', reason: 'The counterparty layer failed: boom' } });
  for (const r of rows.filter(x => x.standing !== 'excluded')) {
    assert.equal(r.p_accept.status, 'failed');
    assert.equal('value' in r.p_accept, false);
  }
});

test('top reasons: largest band factors first, then Nick, then a fresh want; at most 3', () => {
  const rows = Object.fromEntries(league().map(r => [r.team, r]));
  const rs = rows['2'].reasons.value;
  assert.ok(rs.length <= 3);
  assert.equal(rs[0].source, 'clone.accept', 'his no-holds factor from the band');
  assert.equal(rs[0].label, 'his profile says his no rarely holds');
  assert.ok(rs.some(r => r.label === 'Nick: hard to deal with (not priced into this band)'));
  assert.equal(rows['4'].reasons.value[0].label, 'Nick: not reachable, left out of every plan');
});

test('a quiet manager is unknown everywhere but still shows Nick\'s labels; no profiles -> every read says why', () => {
  const rows = Object.fromEntries(league().map(r => [r.team, r]));
  for (const k of ['profile', 'wants', 'credibility']) assert.equal(rows['3'][k].status, 'unknown', k);
  assert.match(rows['3'].profile.reason, /quiet in chat/);
  assert.deepEqual(rows['2'].nick, ['Nick: active trader', 'Nick: hard to deal with']);
  for (const r of league({ profilesAvailable: false })) {
    assert.equal(r.profile.status, 'unknown');
    assert.match(r.profile.reason, /chat DB is not on this machine/);
  }
});

test('labels only: no profile sentence reaches the rows', () => {
  assert.doesNotMatch(JSON.stringify(league()), new RegExp(SENTINEL));
});

test('the loader on a league with no synced rosters: typed unknown, preview prefix under preview', async () => {
  const saved = { p: process.env[PREVIEW_ENV], w: process.env[WARROOM_ENV] };
  process.env[PREVIEW_ENV] = '1'; delete process.env[WARROOM_ENV];
  try {
    const v = await warRoomClones(987654);
    assert.equal(v.enabled, true);
    assert.equal(v.preview, true);
    assert.equal(v.clones.status, 'unknown');
    assert.equal('value' in v.clones, false);
    assert.ok(v.clones.reason.startsWith(PREVIEW_PREFIX));
  } finally {
    if (saved.p === undefined) delete process.env[PREVIEW_ENV]; else process.env[PREVIEW_ENV] = saved.p;
    if (saved.w === undefined) delete process.env[WARROOM_ENV]; else process.env[WARROOM_ENV] = saved.w;
  }
});

test('the loader on a synced league: one row per league-mate, Nick\'s roster left out, profiles say why they are absent', async () => {
  const { run } = await import('../server/db/index.js');
  const { runMigrations } = await import('../server/db/migrate.js');
  await runMigrations();
  const saved = { c: process.env.GRIDIRON_CHAT_DB_PATH, w: process.env[WARROOM_ENV] };
  process.env.GRIDIRON_CHAT_DB_PATH = '/nonexistent/chat.sqlite';
  process.env[WARROOM_ENV] = '1';
  try {
    const entry = (id, name, pos) => ({ playerPoolEntry: { player: { id, fullName: name, defaultPositionId: pos } } });
    run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
         VALUES (8801, 'espn', 'wr-clones-8801', 2026, 'Clones', '1', 3, 1, ?, '2026-09-24 01:00:00')`,
    JSON.stringify({ teams: [{ id: 1, roster: { entries: [entry(11, 'Alpha Runner', 2)] } },
      { id: 2, roster: { entries: [] } }, { id: 3, roster: { entries: [] } }] }));
    const v = await warRoomClones(8801, { now: NOW });
    assert.equal(v.preview, undefined);
    assert.equal(v.clones.status, 'ok');
    assert.deepEqual(v.clones.value.map(r => r.team), ['2', '3']);
    for (const r of v.clones.value) {
      assert.equal(r.profile.status, 'unknown');
      assert.match(r.profile.reason, /no confirmed chat identities/);
      assert.equal(r.p_accept.value.basis, 'population');
    }
  } finally {
    if (saved.c === undefined) delete process.env.GRIDIRON_CHAT_DB_PATH; else process.env.GRIDIRON_CHAT_DB_PATH = saved.c;
    if (saved.w === undefined) delete process.env[WARROOM_ENV]; else process.env[WARROOM_ENV] = saved.w;
  }
});
