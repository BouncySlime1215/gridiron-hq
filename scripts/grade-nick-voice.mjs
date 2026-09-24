#!/usr/bin/env node
/**
 * VOICE-01 grade: can a classifier tell Nick's real texts from Coach's drafts? Target: chance (50%).
 *
 *   node scripts/grade-nick-voice.mjs --db <chat db copy> [--plans <plans.json> ...] [--seed 7]
 *
 * Held out by time: Nick's league texts (group chat + league-mate DMs) are sorted by timestamp;
 * the oldest 80% fit the voice profiles AND train the classifier, the newest 20% are only graded.
 * Balanced classes, so chance is 50%.
 *
 * Two tests, each before (unstyled) -> after (coach/voice.js#styleText):
 *   A  coach drafts   the COACH-MSG rules phraser's outgoing texts (offer + replies) over the
 *                     plans files, every phrasing seed and label set; split by player set.
 *                     Nick side: all his league texts, and his trade-talk texts only.
 *   B  same content   Nick's own texts rewritten into plain assistant English (neutralize), then
 *                     styled back with the profile of the thread they came from. Half the texts
 *                     stay real, the other half become drafts, so no pair crosses the classes.
 * Two classifiers (logistic regression, trained here): STYLE (24 surface features) and LEXICAL
 * (the same plus hashed word unigrams and character trigrams, names masked).
 *
 * Prints accuracies and counts only; no message text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { buildVoiceProfiles, readMine, readBursts, styleText, resolveProfile, surnamePairs, PHONE_REGISTERS, SWAPS } from '../server/services/coach/voice.js';
import { offerText, applyCoachMessages } from '../server/services/campaign/messages.js';
import { splitName } from '../server/services/campaign/message-check.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const all = k => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));
const dbFile = all('--db')[0];
if (!dbFile) { console.error('usage: --db <chat db copy> [--plans file ...] [--seed n]'); process.exit(1); }
const planFiles = all('--plans').length ? all('--plans') : [path.join(REPO, 'test/fixtures/warroom-contract/producer-plans.json')];
let seed = Number(all('--seed')[0] ?? 7);
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const shuffle = a => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const hash = s => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

/* ---------------------------------------------------------------- corpus + profiles (train only) */

const chat = new DatabaseSync(dbFile, { readOnly: true });
const phone = readMine(chat).filter(r => PHONE_REGISTERS.includes(r.register));
const cut = Math.floor(phone.length * 0.8);
const train = phone.slice(0, cut), held = phone.slice(cut);
const profiles = new Map(buildVoiceProfiles(train, { burstsBy: readBursts(chat) }).map(s => [s.scope, s.profile]));
chat.close();
const voice = { profiles };
const phoneProfile = profiles.get('phone');

/* ---------------------------------------------------------------- features */

const TRADE = /\b(trade|offer|deal|give|for|do|swap|interested|counter)\b/i;
const SHORT = SWAPS.map(([, s]) => s);
const LONG = SWAPS.map(([l]) => l);
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
  const s = t.toLowerCase();
  for (const w of s.match(/[a-z0-9']+/g) ?? []) add(`w:${w}`);
  for (let i = 0; i + 3 <= t.length; i++) add(`c:${t.slice(i, i + 3)}`);
  let n = 0; for (const v of m.values()) n += v * v; n = Math.sqrt(n) || 1;
  for (const [k, v] of m) m.set(k, v / n);
  return m;
}

/** Logistic regression, full-batch gradient descent with L2. x: { d: dense[], s: Map sparse|null }. */
function train_lr(X, y, { lex, epochs = 300, lr = 0.5, l2 = 1e-3 }) {
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

const mask = (t, names) => { let s = t; for (const n of names) s = s.split(n).join('Name'); return s; };
function evaluate(label, nickTrain, draftTrain, nickTest, draftTest, names = []) {
  const bal = (a, b) => { const n = Math.min(a.length, b.length); return [shuffle(a).slice(0, n), shuffle(b).slice(0, n)]; };
  const [nt, dt] = bal(nickTrain, draftTrain), [ne, de] = bal(nickTest, draftTest);
  const out = { test: label, n_train: nt.length * 2, n_test: ne.length * 2 };
  for (const lex of [false, true]) {
    const f = t => { const m = mask(t, names); return { d: styleFeatures(m), s: lex ? lexFeatures(m) : null }; };
    const predict = train_lr([...nt, ...dt].map(f), [...nt.map(() => 1), ...dt.map(() => 0)], { lex });
    const hits = ne.filter(t => predict(f(t)) === 1).length + de.filter(t => predict(f(t)) === 0).length;
    const acc = hits / (ne.length + de.length || 1);
    out[lex ? 'lexical' : 'style'] = `${(acc * 100).toFixed(1)}% ±${(196 * Math.sqrt(acc * (1 - acc) / (ne.length + de.length || 1))).toFixed(1)}`;
  }
  return out;
}

/* ---------------------------------------------------------------- A: coach drafts */

const LABELSETS = [[], ['casual'], ['short_clean'], ['his_call'], ['no_pressure'], ['expect_counter'], ['fair_frame'], ['casual', 'no_pressure']];
const drafts = new Map(); // text -> { key, names, short }
const allNames = new Set();
for (const f of planFiles) {
  const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const e of doc.leagues ?? []) {
    if (e.error || e.next_move?.status !== 'ok') continue;
    const names = e.names ?? {};
    for (const raw of Object.values(names)) allNames.add(splitName(raw).name);
    const partners = new Map((e.partners?.value ?? []).map(p => [String(p.team), p]));
    const moves = [e.next_move.value, ...(e.alternatives?.value ?? [])];
    const applied = applyCoachMessages(e, { force: true }).entry;
    const appliedMoves = [applied.next_move.value, ...(applied.alternatives?.value ?? [])];
    moves.forEach((m, mi) => m.steps.forEach((s, si) => {
      const give = (s.opening?.status === 'ok' ? s.opening.value.give : s.give).map(String), get = s.get.map(String);
      const key = [...give, ...get].sort().join(',');
      const nm = [...give, ...get].map(id => splitName(names[id] ?? '').name).filter(Boolean);
      const short = surnamePairs(Object.values(names).map(n => splitName(n).name), nm);
      for (let sd = 0; sd < 4; sd++) for (const L of LABELSETS) {
        const t = offerText({ names, partner: partners.get(String(s.partner)), prof: { labels: new Set(L) }, give, get, even: true, seed: sd });
        drafts.set(t, { key, names: nm, short });
      }
      const rt = appliedMoves[mi].steps[si].reply_table?.value;
      for (const k of ['accept', 'decline', 'counter', 'silence']) if (rt?.[k]?.value?.message) drafts.set(rt[k].value.message, { key, names: nm, short });
    }));
  }
}
const dList = [...drafts].map(([text, v]) => ({ text, ...v }));
const inTest = d => hash(d.key) % 5 === 0;
const units = (list, styled) => list.flatMap(d => (styled ? styleText(d.text, phoneProfile, { keep: d.names, short: d.short }).bursts : [d.text]));
const names = [...allNames].filter(n => n.length >= 3).sort((a, b) => b.length - a.length);
const nickTrainT = train.map(r => r.text), nickHeldT = held.map(r => r.text);
const tradeOnly = a => a.filter(t => TRADE.test(t));
const results = [];
for (const styled of [false, true]) {
  const tag = styled ? 'after' : 'before';
  results.push(evaluate(`A coach drafts, all Nick texts, ${tag}`, nickTrainT, units(dList.filter(d => !inTest(d)), styled), nickHeldT, units(dList.filter(inTest), styled), names));
  results.push(evaluate(`A coach drafts, Nick trade-word texts, ${tag}`, tradeOnly(nickTrainT), units(dList.filter(d => !inTest(d)), styled), tradeOnly(nickHeldT), units(dList.filter(inTest), styled), names));
}

/* ---------------------------------------------------------------- B: same content */

const EXPAND = [...SWAPS.map(([l, s]) => [s, l]), ['yea', 'yeah'], ['im', "I'm"], ['dont', "don't"], ['cant', "can't"], ['thats', "that's"], ['lol', ''], ['bro', ''], ['bruh', ''], ['nah', 'no']];
/** Plain assistant English: long forms, apostrophes, sentence case, closing punctuation, one message. */
function neutralize(t) {
  let s = ` ${t.trim()} `;
  for (const [a, b] of EXPAND) s = s.replace(new RegExp(`(?<![A-Za-z'])${a}(?![A-Za-z'])`, 'gi'), b);
  s = s.replace(/(?<![A-Za-z'])i(?=$|[\s'.,!?])/g, 'I').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s[0].toUpperCase() + s.slice(1);
  if (!/[.!?]$/.test(s)) s += /^(would|do|does|did|you|what|how|why|when|where|who|are|is|can|could|want|any|should|will)\b/i.test(s) ? '?' : '.';
  return s;
}
const halves = rows => { const a = [], b = []; rows.forEach(r => ((hash(r.ts + r.text) & 1) ? a : b).push(r)); return [a, b]; };
const [trReal, trSrc] = halves(train), [heReal, heSrc] = halves(held);
const bDraft = (rows, styled) => rows.flatMap(r => {
  const n = neutralize(r.text);
  if (!n) return [];
  return styled ? styleText(n, resolveProfile(voice, { thread: r.register === 'league_dm' ? r.thread : null, register: r.register })).bursts : [n];
}).filter(Boolean);
for (const styled of [false, true]) {
  results.push(evaluate(`B same content, ${styled ? 'after' : 'before'}`, trReal.map(r => r.text), bDraft(trSrc, styled), heReal.map(r => r.text), bDraft(heSrc, styled)));
}

console.log(JSON.stringify({
  corpus: { phone_texts: phone.length, train: train.length, held_out: held.length, held_from: held[0]?.ts?.slice(0, 10) },
  drafts: { distinct: dList.length, test_share: +(dList.filter(inTest).length / dList.length).toFixed(2), plan_files: planFiles.length },
  chance: '50%', results,
}, null, 1));
