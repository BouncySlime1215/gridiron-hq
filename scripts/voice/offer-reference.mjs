#!/usr/bin/env node
/**
 * VOICE-03: do Coach's offer texts read like the offers Nick actually sends?
 *
 *   node scripts/voice/offer-reference.mjs --db <chat db copy> [--plans <plans.json> ...] [--seed 7] [--validate]
 *
 * --validate grades inside the train part only (fit on its oldest 80%, grade on the rest), for
 * design choices; the newest 20% stay unseen until the final run without it.
 *
 * Reference set: Nick's own league texts (messages table, is_from_me = 1) that the chat labeller
 * (jev_chat_signals) tagged as trade talk or open-to-trade, and not non-fantasy, AND that carry
 * an offer word (OFFER_WORDS: trade, offer, counter, send, for, would u, how about, ...). A wider
 * set, every labelled trade-talk text, is graded too so the small-n offer result has a neighbour.
 * If voice.js exports readTradeLabels / isOfferText (a candidate styler), those are used instead
 * of the inline rule, so the same command grades a candidate and the incumbent.
 *
 * Held out by time: each reference set is sorted by timestamp; the oldest 80% fit the voice
 * profiles (all of Nick's phone texts up to the cut, and the offer profile from the train
 * offers) AND train the classifier; the newest 20% are only graded. Coach drafts (the COACH-MSG
 * rules phraser's offer + reply texts over the plans files, every phrasing seed and label set)
 * are split by player set (1 in 5 held out). Balanced classes, chance 50%.
 *
 * Classifiers (logistic regression, trained here): STYLE (24 surface features) and LEXICAL (the
 * same plus hashed word unigrams and character trigrams). Player names from the plans' names
 * maps are masked case-insensitively on both sides, so the classifier sees THAT a text names
 * players, never WHICH.
 *
 * Also: ungrounded = styled drafts whose bursts fail message-check.js#checkBursts against the
 * step's outgoing facts (COACH-MSG would fall back to the plain text; must stay 0), and burst
 * length in words. Prints counts, shares and accuracies only; never message text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import * as V from '../../server/services/coach/voice.js';
import { offerText, applyCoachMessages } from '../../server/services/campaign/messages.js';
import { splitName, checkBursts, factsFor } from '../../server/services/campaign/message-check.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const all = k => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));
const dbFile = all('--db')[0];
if (!dbFile) { console.error('usage: --db <chat db copy> [--plans file ...] [--seed n]'); process.exit(1); }
const planFiles = all('--plans').length ? all('--plans') : [path.join(REPO, 'test/fixtures/warroom-contract/producer-plans.json')];
const SEED = Number(all('--seed')[0] ?? 7);
const VALIDATE = args.includes('--validate');
let seed = SEED;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const shuffle = a => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const hash = s => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ---------------------------------------------------------------- corpus */

const chat = new DatabaseSync(dbFile, { readOnly: true });
const phone = V.readMine(chat).filter(r => V.PHONE_REGISTERS.includes(r.register));
const labelled = typeof V.readTradeLabels === 'function' ? V.readTradeLabels(chat) : readTradeLabelsLocal(chat);
const burstsBy = V.readBursts(chat);
chat.close();

/** The reference rule, inline (the incumbent voice.js has no label reader). */
function readTradeLabelsLocal(db) {
  return db.prepare(`SELECT m.ts_utc AS ts, m.chat_name AS thread, m.chat_kind AS kind, m.text,
      (SELECT COUNT(*) FROM jev_chat_signals s WHERE s.msg_id = m.msg_id AND s.question = 'topic.argmax:trade_talk') AS am,
      (SELECT probability FROM jev_chat_signals s WHERE s.msg_id = m.msg_id AND s.question = 'topic.trade_talk') AS tt,
      (SELECT probability FROM jev_chat_signals s WHERE s.msg_id = m.msg_id AND s.question = 'open_to_trade') AS ot,
      (SELECT COUNT(*) FROM jev_chat_signals s WHERE s.msg_id = m.msg_id AND s.question = 'topic.argmax:non_fantasy') AS nf
    FROM messages m WHERE m.is_from_me = 1 AND COALESCE(m.is_tapback, 0) = 0 AND TRIM(COALESCE(m.text, '')) <> ''
    ORDER BY m.ts_utc`).all()
    .filter(r => !r.nf && (r.am > 0 || (r.tt ?? 0) >= 0.5 || (r.ot ?? 0) >= 0.5))
    .map(r => ({ text: r.text, ts: r.ts, thread: r.thread, register: r.kind === 'group' ? 'league_group' : 'league_dm' }));
}
const OFFER_WORDS = /\b(trade|trades|trading|offer|offered|counter|deal|send|sending|sent|for|give|gimme|how about|what about|would u|would you|wanna|u want|you want|interested|fw|package|throw in|add|swap|take|1 for 1|2 for 1)\b/i;
const isOffer = typeof V.isOfferText === 'function' ? V.isOfferText : t => OFFER_WORDS.test(t);
const offers = labelled.filter(r => isOffer(r.text));

/* ---------------------------------------------------------------- features + classifier */

const TRADE = /\b(trade|offer|deal|give|for|do|swap|interested|counter)\b/i;
const SHORT = V.SWAPS.map(([, s]) => s);
const LONG = V.SWAPS.map(([l]) => l);
const count = (t, list) => list.reduce((n, w) => n + (t.toLowerCase().match(new RegExp(`(?<![a-z'])${w.replace(/'/g, "'?")}(?![a-z'])`, 'g')) ?? []).length, 0);
function styleFeatures(t) {
  const w = t.trim().split(/\s+/).filter(Boolean);
  const nw = w.length || 1;
  return [
    Math.log1p(w.length), Math.log1p(t.length), t.length / nw / 10,
    /^[A-Z]/.test(t) ? 1 : 0, /^[a-z]/.test(t) ? 1 : 0, /[A-Z]/.test(t.slice(1)) ? 1 : 0,
    /\.$/.test(t) ? 1 : 0, /!$/.test(t) ? 1 : 0, /\?$/.test(t) ? 1 : 0, (t.match(/[.!?]/g) ?? []).length / nw,
    (t.match(/,/g) ?? []).length / nw, /'/.test(t) ? 1 : 0, /\b(dont|im|cant|thats|wont|didnt)\b/i.test(t) ? 1 : 0,
    count(t, SHORT) / nw, count(t, LONG) / nw, /\p{Extended_Pictographic}/u.test(t) ? 1 : 0,
    (t.match(/[A-Z]/g) ?? []).length / (t.length || 1), w.slice(1).filter(x => /^[A-Z]/.test(x)).length / nw,
    /^(hey|hi|hello)\b/i.test(t) ? 1 : 0, /\b(appreciate|thanks|no worries|sounds good|happy to)\b/i.test(t) ? 1 : 0,
    /\b(would you|could you)\b/i.test(t) ? 1 : 0, /\b(lol|lmao|haha)\b/i.test(t) ? 1 : 0,
    /\b(bro|bruh|dude|yo|bet)\b/i.test(t) ? 1 : 0, /\bi\b/.test(t) ? 1 : 0,
  ];
}
const DIM = 1 << 14;
function lexFeatures(t) {
  const m = new Map();
  const add = k => { const i = hash(k) % DIM; m.set(i, (m.get(i) ?? 0) + 1); };
  for (const w of t.toLowerCase().match(/[a-z0-9']+/g) ?? []) add(`w:${w}`);
  for (let i = 0; i + 3 <= t.length; i++) add(`c:${t.slice(i, i + 3)}`);
  let n = 0; for (const v of m.values()) n += v * v; n = Math.sqrt(n) || 1;
  for (const [k, v] of m) m.set(k, v / n);
  return m;
}
function trainLR(X, y, { lex, epochs = 300, lr = 0.5, l2 = 1e-3 }) {
  const D = X[0].d.length;
  const mu = Array(D).fill(0), sd = Array(D).fill(0);
  for (const x of X) x.d.forEach((v, j) => { mu[j] += v / X.length; });
  for (const x of X) x.d.forEach((v, j) => { sd[j] += (v - mu[j]) ** 2 / X.length; });
  const z = x => x.d.map((v, j) => (v - mu[j]) / (Math.sqrt(sd[j]) || 1));
  const Z = X.map(z);
  const wd = Array(D).fill(0), ws = new Float64Array(lex ? DIM : 0); let b = 0;
  const score = (zd, s) => { let a = b; zd.forEach((v, j) => { a += wd[j] * v; }); if (lex && s) for (const [k, v] of s) a += ws[k] * v; return a; };
  for (let e = 0; e < epochs; e++) {
    const gd = Array(D).fill(0), gs = lex ? new Map() : null; let gb = 0;
    for (let i = 0; i < X.length; i++) {
      const p = 1 / (1 + Math.exp(-score(Z[i], X[i].s))), g = (p - y[i]) / X.length;
      gb += g; Z[i].forEach((v, j) => { gd[j] += g * v; });
      if (lex) for (const [k, v] of X[i].s) gs.set(k, (gs.get(k) ?? 0) + g * v);
    }
    b -= lr * gb; wd.forEach((w, j) => { wd[j] = w - lr * (gd[j] + l2 * w); });
    if (lex) { for (let k = 0; k < DIM; k++) ws[k] *= 1 - lr * l2; for (const [k, g] of gs) ws[k] -= lr * 4 * g; }
  }
  return x => (score(z(x), x.s) > 0 ? 1 : 0);
}

/* ---------------------------------------------------------------- drafts (from the plans files) */

const LABELSETS = [[], ['casual'], ['short_clean'], ['his_call'], ['no_pressure'], ['expect_counter'], ['fair_frame'], ['casual', 'no_pressure']];
const ids = a => (Array.isArray(a) ? a.map(String) : []);
const okv = f => (f && f.status === 'ok' ? f.value : null);
const drafts = new Map(); // text -> { key, names, short, facts }
const nameWords = new Set();
for (const f of planFiles) {
  const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const e of doc.leagues ?? []) {
    if (e.error || e.next_move?.status !== 'ok') continue;
    const names = e.names ?? {};
    const leagueNames = Object.values(names).map(n => splitName(n).name);
    for (const n of leagueNames) { if (n.length >= 3) nameWords.add(n); const sn = n.split(/\s+/).filter(w => !/^(jr\.?|sr\.?|ii|iii|iv|v)$/i.test(w)).pop(); if (sn && sn.length >= 3) nameWords.add(sn); }
    const partners = new Map((okv(e.partners) ?? e.partners?.value ?? []).map(p => [String(p.team), p]));
    const moves = [e.next_move.value, ...(e.alternatives?.value ?? [])];
    const applied = applyCoachMessages(e, { force: true }).entry;
    const appliedMoves = [applied.next_move.value, ...(applied.alternatives?.value ?? [])];
    moves.forEach((m, mi) => m.steps.forEach((s, si) => {
      const give = (s.opening?.status === 'ok' ? s.opening.value.give : s.give).map(String), get = s.get.map(String);
      const key = [...give, ...get].sort().join(',');
      const rung = [...String(okv(okv(s.reply_table)?.counter)?.counter_rules?.counter_with ?? '').split('(')[0].matchAll(/\b\d+\b/g)].map(x => x[0]).filter(id => Object.hasOwn(names, id));
      const allow = [...give, ...get, ...ids(okv(s.walk_away)?.max_give), ...rung];
      const facts = factsFor({ names, ids: allow, holes: partners.get(String(s.partner))?.roster_holes ?? [], numbers: [] });
      const keep = [...facts.allowed].map(id => splitName(names[id]).name);
      const short = V.surnamePairs(leagueNames, keep);
      const partner = partners.get(String(s.partner));
      for (let sd = 0; sd < 4; sd++) for (const L of LABELSETS) {
        const t = offerText({ names, partner, prof: { labels: new Set(L) }, give, get, even: true, seed: sd });
        drafts.set(t, { key, keep, short, facts });
      }
      const rt = appliedMoves[mi].steps[si].reply_table?.value;
      for (const k of ['accept', 'decline', 'counter', 'silence']) if (rt?.[k]?.value?.message) drafts.set(rt[k].value.message, { key, keep, short, facts });
    }));
  }
}
const dList = [...drafts].map(([text, v]) => ({ text, ...v }));
const inTest = d => hash(d.key) % 5 === 0;
const maskRe = nameWords.size
  ? new RegExp(`(?<![A-Za-z0-9])(${[...nameWords].sort((a, b) => b.length - a.length).map(esc).join('|')})(?![A-Za-z0-9])`, 'gi') : null;
const mask = t => (maskRe ? t.replace(maskRe, 'Name') : t);

/* ---------------------------------------------------------------- grading */

const wordsOf = t => t.trim().split(/\s+/).filter(Boolean).length;
const quant = (a, q) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))] : null);
const pct = x => `${(x * 100).toFixed(1)}%`;

function evaluate(nickTrain, draftTrain, nickTest, draftTest) {
  const bal = (a, b) => { const n = Math.min(a.length, b.length); return [shuffle(a).slice(0, n), shuffle(b).slice(0, n)]; };
  const [nt, dt] = bal(nickTrain, draftTrain), [ne, de] = bal(nickTest, draftTest);
  const out = { n_train: nt.length * 2, n_test: ne.length * 2 };
  for (const lex of [false, true]) {
    const f = t => { const m = mask(t); return { d: styleFeatures(m), s: lex ? lexFeatures(m) : null }; };
    const predict = trainLR([...nt, ...dt].map(f), [...nt.map(() => 1), ...dt.map(() => 0)], { lex });
    const hits = ne.filter(t => predict(f(t)) === 1).length + de.filter(t => predict(f(t)) === 0).length;
    const n = ne.length + de.length || 1, acc = hits / n;
    out[lex ? 'lexical' : 'style'] = `${pct(acc)} ±${(196 * Math.sqrt(acc * (1 - acc) / n)).toFixed(1)}`;
    out[lex ? 'lexical_acc' : 'style_acc'] = +acc.toFixed(4);
  }
  return out;
}

const report = { reference: {}, drafts: { distinct: dList.length, test_share: +(dList.filter(inTest).length / (dList.length || 1)).toFixed(2), plan_files: planFiles.length }, chance: '50%', results: [] };
for (const [setName, full] of [['offer', offers], ['trade_talk', labelled]]) {
  const ref = VALIDATE ? full.slice(0, Math.floor(full.length * 0.8)) : full;
  const cut = Math.floor(ref.length * 0.8);
  const refTrain = ref.slice(0, cut), refHeld = ref.slice(cut);
  const cutTs = refHeld[0]?.ts ?? '9999';
  // Profiles see only texts before the first graded one.
  const fitRows = phone.filter(r => String(r.ts) < String(cutTs));
  const offerTs = new Set(refTrain.filter(r => isOffer(r.text)).map(r => `${r.ts}|${r.text}`));
  const rows = fitRows.map(r => ({ ...r, offer: offerTs.has(`${r.ts}|${r.text}`) }));
  const scopes = V.buildVoiceProfiles(rows, { burstsBy });
  const voice = { profiles: new Map(scopes.map(s => [s.scope, s.profile])) };
  const profile = V.resolveProfile(voice, {});
  report.reference[setName] = { n: ref.length, train: refTrain.length, held_out: refHeld.length, held_from: cutTs.slice(0, 10), offer_profile: voice.profiles.has('offer') };
  for (const styled of [false, true]) {
    let ungrounded = 0, checked = 0;
    const units = list => list.flatMap(d => {
      if (!styled) return [d.text];
      const s = V.styleText(d.text, profile, { keep: d.keep, short: d.short });
      checked++;
      if (!checkBursts(s.text, d.facts).ok) ungrounded++;
      return s.bursts;
    });
    const dTrain = units(dList.filter(d => !inTest(d))), dTest = units(dList.filter(inTest));
    const r = evaluate(refTrain.map(r => r.text), dTrain, refHeld.map(r => r.text), dTest);
    const bw = dTest.map(wordsOf), nw = refHeld.map(r => wordsOf(r.text));
    report.results.push({
      reference: setName, drafts: styled ? 'styled (voice.js at this tree)' : 'unstyled',
      ...r,
      ungrounded: styled ? ungrounded : null, drafts_checked: styled ? checked : null,
      burst_words: { draft_median: quant(bw, 0.5), draft_p90: quant(bw, 0.9), draft_le9: +(bw.filter(x => x <= 9).length / (bw.length || 1)).toFixed(3), nick_median: quant(nw, 0.5), nick_p90: quant(nw, 0.9) },
    });
  }
}
report.labelled_trade_texts = labelled.length;
report.phone_texts = phone.length;
report.seed = SEED;
report.mode = VALIDATE ? 'validate (train part only)' : 'held-out (newest 20%)';
console.log(JSON.stringify(report, null, 1));
