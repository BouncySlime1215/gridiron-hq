/**
 * VOICE-03: scripts/voice/offer-reference.mjs grades Coach drafts against Nick's own offer texts.
 * Fixtures only: every text below is made up for this file, the chat DB is a temp fixture, and the
 * plans are test/fixtures/warroom-contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts/voice/offer-reference.mjs');

// Made-up texts. OFFERS carry an offer word; CHAT is labelled trade talk without one; OTHER is unlabelled.
const OFFERS = ['Send me a trade', 'U want Alpha for Bravo', 'Lets trade', 'What about Charlie for Delta', 'Ok send it',
  'I can do Echo for Fox', 'Would u do Golf for Hotel', 'Sent u one', 'Any offer', 'Take it or leave it for real'];
const CHAT = ['Nah', 'He is good', 'Maybe later', 'Idk man'];
const OTHER = ['Game was wild', 'U up', 'Lol ok', 'Dinner at 7'];

function fixtureChatDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE messages (msg_id INTEGER, chat_kind TEXT, chat_name TEXT, handle TEXT, name TEXT,
    is_from_me INTEGER, ts_utc TEXT, text TEXT, is_tapback INTEGER, is_reply INTEGER);
    CREATE TABLE messages_ext (msg_id INTEGER, chat_kind TEXT, chat_name TEXT, handle TEXT, name TEXT, is_from_me INTEGER,
    ts_utc TEXT, text TEXT, is_tapback INTEGER, is_reply INTEGER, source_chat_kind TEXT, chat_participants_count INTEGER);
    CREATE TABLE jev_chat_signals (msg_id INTEGER NOT NULL, name TEXT, chat_kind TEXT, mentioned_player TEXT,
    question TEXT NOT NULL, probability REAL, evaluated_at TEXT NOT NULL, PRIMARY KEY (msg_id, question));`);
  const msg = db.prepare('INSERT INTO messages (msg_id, chat_kind, chat_name, is_from_me, ts_utc, text, is_tapback) VALUES (?, ?, ?, ?, ?, ?, 0)');
  const sig = db.prepare("INSERT INTO jev_chat_signals (msg_id, chat_kind, question, probability, evaluated_at) VALUES (?, 'dm', ?, ?, '2026-01-01')");
  let id = 0;
  const ts = () => new Date(Date.UTC(2026, 0, 1) + id * 86_400_000).toISOString();
  for (let round = 0; round < 4; round++) {
    for (const t of OFFERS) { id++; msg.run(id, 'dm', 'thread-a', 1, ts(), `${t} ${round ? 'fr' : ''}`.trim()); sig.run(id, 'topic.argmax:trade_talk', 1); sig.run(id, 'open_to_trade', 0.9); }
    for (const t of CHAT) { id++; msg.run(id, 'dm', 'thread-a', 1, ts(), t); sig.run(id, 'topic.trade_talk', 0.7); }
    for (const t of OTHER) { id++; msg.run(id, 'dm', 'thread-a', 1, ts(), t); sig.run(id, 'topic.argmax:non_fantasy', 1); }
    // A league-mate's offer: never in the reference.
    id++; msg.run(id, 'dm', 'thread-a', 0, ts(), 'Made up partner offer for you'); sig.run(id, 'topic.argmax:trade_talk', 1);
  }
  db.close();
}

const run = (file, extra = []) => JSON.parse(execFileSync(process.execPath, [SCRIPT, '--db', file, ...extra], { encoding: 'utf8' }));

test('offer-reference: counts the offer set (own, labelled, offer word) and the wider trade-talk set', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-offers-')), 'chat.sqlite');
  fixtureChatDb(file);
  const r = run(file);
  assert.equal(r.reference.offer.n, OFFERS.length * 4);
  assert.equal(r.reference.trade_talk.n, (OFFERS.length + CHAT.length) * 4);
  assert.equal(r.reference.offer.train + r.reference.offer.held_out, r.reference.offer.n);
  assert.equal(r.reference.offer.held_out, r.reference.offer.n - Math.floor(r.reference.offer.n * 0.8));
  assert.equal(r.mode, 'held-out (newest 20%)');
  assert.equal(r.chance, '50%');
});

test('offer-reference: unstyled and styled rows per set, accuracies in [0, 1], burst lengths, ungrounded counted', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-offers-')), 'chat.sqlite');
  fixtureChatDb(file);
  const r = run(file);
  assert.equal(r.results.length, 4);
  assert.ok(r.drafts.distinct > 0);
  for (const x of r.results) {
    assert.ok(x.style_acc >= 0 && x.style_acc <= 1 && x.lexical_acc >= 0 && x.lexical_acc <= 1);
    assert.ok(x.n_test > 0 && x.n_test % 2 === 0, 'balanced classes');
    assert.ok(Number.isFinite(x.burst_words.nick_median) && Number.isFinite(x.burst_words.draft_median));
    if (x.drafts === 'unstyled') assert.equal(x.ungrounded, null);
    else assert.ok(Number.isInteger(x.ungrounded) && x.ungrounded <= x.drafts_checked);
  }
});

test('offer-reference: --validate grades inside the train part only', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-offers-')), 'chat.sqlite');
  fixtureChatDb(file);
  const full = run(file), val = run(file, ['--validate']);
  assert.equal(val.reference.offer.n, full.reference.offer.train);
  assert.ok(val.reference.offer.held_from < full.reference.offer.held_from, 'validation grades texts older than the held-out ones');
});

test('offer-reference: prints no message text', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-offers-')), 'chat.sqlite');
  fixtureChatDb(file);
  const out = execFileSync(process.execPath, [SCRIPT, '--db', file], { encoding: 'utf8' });
  for (const t of [...OFFERS, ...CHAT, ...OTHER, 'Made up partner offer for you'].filter(t => t.includes(' '))) assert.ok(!out.includes(t), 'no text in the output');
});
