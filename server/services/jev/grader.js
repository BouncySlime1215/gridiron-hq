/**
 * JEV-01b (engine): grade the stored jev.* answers against their settled truths, and
 * write what they earned as producer 'jev_grader' (ENGINE-SPECS JEV-01b (1), (2), (4)).
 * The rules are pre-registered in
 * docs/evidence/2026-09-24/jev-01b-chat-preregistration-addendum-2.md; change one, change
 * the other by addendum.
 *
 * Answers are JEV-01a's engine_state rows `jev.<qtype>.jev_<arm>` (producer 'jev', lane
 * shadow, value.p). Two types have a truth the app records:
 *   p_accept      offer (trade_outcomes.id)  <-> trade_outcomes settled status; incumbent
 *                                                model_p_accept (the app's P(accept) midpoint)
 *   plays_sunday  player x NFL week          <-> a snap in nfl_snaps that week, once the
 *                                                calendar's nfl.week reads 'final'; no
 *                                                incumbent wired yet
 * Leak rule: an answer is graded only on an outcome stamped after it, and only once that
 * outcome has settled as of the grade time; every excluded answer is counted by reason.
 *
 * The statistics are the chat grader's (calibrate.js, stack.js, chat-grader.js#gradeUnits):
 * one calibration map per question type and arm, one blend weight and score per type on the
 * arms' mean claim. Fields, on entity engine:jev:
 *   jev_cal.<qtype>.<arm>   the map, or null with absence 'thin'
 *   jev_weight.<qtype>      the weight, or null ('thin' | 'no_incumbent')
 *   jev_score.<qtype>       holdout log loss / Brier / CI / leader; Jev alone with no incumbent
 * Nothing serves these fields: JEV-01c (and META-01's Referee) decide what reads them.
 * `gradeJevAnswers` reads only; `writeJevGrades` writes; the engine daemon's nightly hook
 * is meant to call `runJevGrader` (not registered yet).
 */
import { db as appDb } from '../../db/index.js';
import { registerProducer } from '../engine/registry.js';
import { writeState } from '../engine/state.js';
import { normalizeAsOf } from '../engine/events.js';
import { normalizePlayerName } from '../player-identity.js';
import { fitCalibration } from './calibrate.js';
import { logLoss, brier } from './stack.js';
import { gradeUnits, MIN_N, MIN_CLASS } from './chat-grader.js';

export const VERSION = '1';
export const QTYPES = Object.freeze(['p_accept', 'plays_sunday']);
export const ARMS = Object.freeze(['jev_a', 'jev_b']);
const SETTLED = new Set(['accepted', 'declined', 'countered', 'expired']);

const W = registerProducer({ name: 'jev_grader', active: '1', versions: { 1: { prereg_ref: 'docs/evidence/2026-09-24/jev-01b-chat-preregistration-addendum-2.md' } },
  fields: [
    { field: 'jev_cal.p_accept.jev_a', entityTypes: ['engine'], description: 'Calibration map for Jev P(accept), arm a' },
    { field: 'jev_cal.p_accept.jev_b', entityTypes: ['engine'], description: 'Calibration map for Jev P(accept), arm b' },
    { field: 'jev_cal.plays_sunday.jev_a', entityTypes: ['engine'], description: 'Calibration map for Jev plays-Sunday, arm a' },
    { field: 'jev_cal.plays_sunday.jev_b', entityTypes: ['engine'], description: 'Calibration map for Jev plays-Sunday, arm b' },
    { field: 'jev_weight.p_accept', valueType: 'number', entityTypes: ['engine'], description: "Jev's earned blend weight for P(accept)" },
    { field: 'jev_weight.plays_sunday', valueType: 'number', entityTypes: ['engine'], description: "Jev's earned blend weight for plays Sunday" },
    { field: 'jev_score.p_accept', entityTypes: ['engine'], description: 'Holdout score: Jev blend vs the incumbent, P(accept)' },
    { field: 'jev_score.plays_sunday', entityTypes: ['engine'], description: 'Holdout score: Jev blend vs the incumbent, plays Sunday' },
  ],
});

const ms = v => Date.parse(normalizeAsOf(v));
const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
const thin = n => ({ status: 'unknown', reason: 'thin', n });

/** Every jev.<qtype>.jev_<arm> answer stamped at or before `at`, newest version only. */
function readAnswers(database, qtype, at, excluded) {
  const all = database.prepare(`SELECT id, entity_type, entity_id, field, value, as_of FROM engine_state
      WHERE producer = 'jev' AND field IN (?, ?) AND as_of <= ? AND value IS NOT NULL
        AND json_extract(health, '$.status') <> 'failed' ORDER BY as_of, id`)
    .all(...ARMS.map(a => `jev.${qtype}.${a}`), at)
    .map(r => ({ id: Number(r.id), subject: String(r.entity_id), arm: r.field.split('.').at(-1), t: ms(r.as_of),
      value: JSON.parse(r.value) }))
    .filter(r => Number.isFinite(r.value?.p));
  const latest = Math.max(...all.map(r => Number(r.value.question_version ?? 1)));
  return all.filter(r => {
    if (Number(r.value.question_version ?? 1) === latest) return true;
    bump(excluded, 'older_version');
    return false;
  });
}

/**
 * Group answers by (subject, arm) and keep, per group, the last answer before the truth's cut.
 * `truth(subject, answers)` returns {key, y, inc, cluster, cut} or {excluded: reason}.
 */
function unitsOf(answers, truth, excluded) {
  const bySubjectArm = new Map();
  for (const a of answers) {
    const k = `${a.subject}|${a.arm}`;
    (bySubjectArm.get(k) ?? bySubjectArm.set(k, []).get(k)).push(a);
  }
  const perArm = Object.fromEntries(ARMS.map(a => [a, []]));
  for (const group of bySubjectArm.values()) {
    const settled = truth(group);
    if (settled.excluded) { bump(excluded, settled.excluded); continue; }
    // Every answer at or after the cut is excluded and counted, even when an earlier one stands.
    const before = group.filter(a => a.t < settled.cut);
    for (let i = before.length; i < group.length; i++) bump(excluded, settled.late ?? 'outcome_before_answer');
    if (!before.length) continue;
    const last = before.at(-1);
    perArm[last.arm].push({ key: settled.key, subject: last.subject, week: settled.week, t: last.t, claim: last.value.p,
      y: settled.y, inc: settled.inc, cluster: settled.cluster, state_id: last.id, cite: settled.cite ?? [] });
  }
  return perArm;
}

/* ------------------------------------------------------------------ truths */

function pAcceptTruth(database, at) {
  const get = database.prepare(`SELECT id, status, resolved_at, model_p_accept, counterparty_team_id FROM trade_outcomes WHERE id = ?`);
  return group => {
    const o = /^\d+$/.test(group[0].subject) ? get.get(Number(group[0].subject)) : null;
    if (!o) return { excluded: 'unknown_offer' };
    if (!SETTLED.has(o.status) || !o.resolved_at || ms(o.resolved_at) > at) return { excluded: 'unsettled' };
    return { key: String(o.id), cut: ms(o.resolved_at), y: o.status === 'accepted' ? 1 : 0,
      inc: Number.isFinite(o.model_p_accept) ? o.model_p_accept : null, cluster: String(o.counterparty_team_id ?? o.id) };
  };
}

/** The latest nfl.week row per week as of `at`, oldest week first. */
function weeksAsOf(database, at) {
  const latest = new Map();
  for (const r of database.prepare(`SELECT id, entity_id, value FROM engine_state WHERE field = 'nfl.week' AND lane = 'live'
      AND as_of <= ? AND value IS NOT NULL AND json_extract(health, '$.status') <> 'failed' ORDER BY id`).all(at)) {
    latest.set(r.entity_id, { id: Number(r.id), key: r.entity_id, ...JSON.parse(r.value) });
  }
  return [...latest.values()].filter(w => w.first_kickoff && w.last_kickoff)
    .map(w => ({ ...w, first: ms(w.first_kickoff), last: ms(w.last_kickoff) }))
    .sort((a, b) => a.first - b.first);
}

function playsSundayTruth(database, at) {
  const weeks = weeksAsOf(database, at);
  const name = database.prepare('SELECT name FROM players WHERE id = ?');
  const played = new Map(); // 'season:week' -> Set(normalized names) | null (no rows)
  const playedIn = w => {
    if (!played.has(w.key)) {
      const snaps = database.prepare(`SELECT player, offense_snaps, defense_snaps, st_pct FROM nfl_snaps WHERE season = ? AND week = ?`)
        .all(w.season, w.week);
      played.set(w.key, snaps.length ? new Set(snaps.filter(s => (s.offense_snaps ?? 0) > 0 || (s.defense_snaps ?? 0) > 0
        || (s.st_pct ?? 0) > 0).map(s => normalizePlayerName(s.player))) : null);
    }
    return played.get(w.key);
  };
  // Answers for one player can span weeks: split the group by week first (see gradeJevAnswers).
  return group => {
    const w = group.week;
    if (!w) return { excluded: 'no_week' };
    if (w.status !== 'final') return { excluded: 'unsettled' };
    const set = playedIn(w);
    if (!set) return { excluded: 'no_snaps_for_week' };
    const p = /^\d+$/.test(group[0].subject) ? name.get(Number(group[0].subject)) : null;
    if (!p) return { excluded: 'unknown_player' };
    return { key: `${group[0].subject}:${w.key}`, week: w.key, cut: w.first, late: 'asked_after_kickoff',
      y: set.has(normalizePlayerName(p.name)) ? 1 : 0, inc: null, cluster: group[0].subject, cite: [w.id] };
  };
}

/* ------------------------------------------------------------------ grading */

function armGrade(units) {
  const n = units.length;
  const pos = units.reduce((s, u) => s + u.y, 0);
  if (n < MIN_N || pos < MIN_CLASS || n - pos < MIN_CLASS) return thin(n);
  return { status: 'measured', n, positives: pos, calibration: { ...fitCalibration(units.map(u => ({ p: u.claim, y: u.y }))), n } };
}

/** The arms' mean claim per unit key. */
function meanUnits(perArm) {
  const byKey = new Map();
  for (const arm of ARMS) {
    for (const u of perArm[arm]) {
      const m = byKey.get(u.key) ?? byKey.set(u.key, { ...u, claims: [], state_ids: [] }).get(u.key);
      m.claims.push(u.claim);
      m.state_ids.push(u.state_id);
      m.t = Math.max(m.t, u.t);
    }
  }
  return [...byKey.values()].map(({ claims, ...u }) => ({ ...u, claim: claims.reduce((a, b) => a + b, 0) / claims.length }));
}

function blendGrade(units) {
  const n = units.length;
  if (units.some(u => u.inc == null)) {
    if (!n) return thin(0);
    return { status: 'unknown', reason: 'no_incumbent', n,
      alone: { n, incumbent: 'none', log_loss_jev: logLoss(units.map(u => ({ p: u.claim, y: u.y }))),
        brier_jev: brier(units.map(u => ({ p: u.claim, y: u.y }))), text: 'no incumbent wired; Jev scored alone on raw claims' } };
  }
  const g = gradeUnits(units);
  return g.status === 'measured' ? g : thin(n);
}

/**
 * Read-only: the grade of every stored jev.* answer as of `asOf`.
 * { as_of, questions: { <qtype>: { read, units, excluded, graded, arms: {jev_a, jev_b}, blend } } }
 */
export function gradeJevAnswers({ asOf = new Date(), database = appDb } = {}) {
  const atIso = normalizeAsOf(asOf);
  const at = ms(atIso);
  const questions = {};
  for (const qtype of QTYPES) {
    const excluded = {};
    const answers = readAnswers(database, qtype, atIso, excluded);
    let perArm;
    if (qtype === 'p_accept') {
      perArm = unitsOf(answers, pAcceptTruth(database, at), excluded);
    } else {
      // An answer belongs to the week in progress or next: the earliest whose last kickoff is after it.
      const weeks = weeksAsOf(database, atIso);
      const truth = playsSundayTruth(database, at);
      const byWeek = new Map();
      for (const a of answers) {
        const w = weeks.find(x => x.last > a.t) ?? null;
        const k = w?.key ?? 'none';
        (byWeek.get(k) ?? byWeek.set(k, { w, list: [] }).get(k)).list.push(a);
      }
      perArm = Object.fromEntries(ARMS.map(a => [a, []]));
      for (const { w, list } of byWeek.values()) {
        const part = unitsOf(list, group => truth(Object.assign(group, { week: w })), excluded);
        for (const a of ARMS) perArm[a].push(...part[a]);
      }
    }
    const mean = meanUnits(perArm);
    questions[qtype] = {
      read: answers.length, units: mean.length, excluded,
      graded: mean.map(({ key, subject, week, t, claim, y, inc }) => ({ key, subject, week, t, claim, y, inc })),
      arms: Object.fromEntries(ARMS.map(a => [a, armGrade(perArm[a])])),
      blend: blendGrade(mean),
      cite: {
        arms: Object.fromEntries(ARMS.map(a => [a, [...new Set([...perArm[a].map(u => u.state_id), ...perArm[a].flatMap(u => u.cite)])]])),
        all: [...new Set([...mean.flatMap(u => u.state_ids), ...mean.flatMap(u => u.cite)])],
      },
    };
  }
  return { as_of: atIso, questions };
}

function put(field, { value, absence, stateIds, text, asOf }, database) {
  const chain = { contributions: stateIds.length
    ? [{ source: 'jev_grader', kind: 'model', event_ids: [], state_ids: stateIds, text }] : [], baseline: { text } };
  return writeState({ entityType: 'engine', entityId: 'jev', field, asOf, writer: W[field], producerVersion: VERSION,
    reasonChain: chain, stateIds, ...(value == null ? { value: null, absence } : { value }) }, database);
}

/** Write one grade (from gradeJevAnswers) as jev_grader rows. Returns { written, unchanged }. */
export function writeJevGrades(grade, { database = appDb } = {}) {
  let written = 0, unchanged = 0;
  const count = r => { if (r.written) written++; else if (r.unchanged) unchanged++; };
  const asOf = grade.as_of;
  for (const [qtype, q] of Object.entries(grade.questions)) {
    for (const arm of ARMS) {
      const g = q.arms[arm];
      count(put(`jev_cal.${qtype}.${arm}`, { asOf, stateIds: q.cite.arms[arm],
        text: `${arm} calibration on n=${g.n} graded answers`,
        ...(g.status === 'measured' ? { value: g.calibration } : { absence: { status: 'unknown', reason: g.reason } }) }, database));
    }
    const b = q.blend;
    const text = b.text ?? b.alone?.text ?? `${b.reason}: n=${b.n}`;
    count(put(`jev_weight.${qtype}`, { asOf, stateIds: q.cite.all, text,
      ...(b.status === 'measured' ? { value: b.weight } : { absence: { status: 'unknown', reason: b.reason } }) }, database));
    const score = b.status === 'measured'
      ? { n: b.n, positives: b.positives, leader: b.leader, text: b.text, holdout: b.holdout }
      : b.alone ?? null;
    count(put(`jev_score.${qtype}`, { asOf, stateIds: q.cite.all, text,
      ...(score ? { value: score } : { absence: { status: 'unknown', reason: b.reason } }) }, database));
  }
  return { written, unchanged };
}

/** Grade and write in one step: what the engine daemon's nightly hook will call. */
export function runJevGrader({ asOf = new Date(), database = appDb } = {}) {
  const grade = gradeJevAnswers({ asOf, database });
  return { grade, ...writeJevGrades(grade, { database }) };
}
