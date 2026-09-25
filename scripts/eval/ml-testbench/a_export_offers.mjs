#!/usr/bin/env node
/**
 * ML-TESTBENCH section A, step 1 (docs/tdd/ML-TESTBENCH-PREREG.md): the decided offers, in proposal
 * order, each with the four EXISTING arms' as-of predictions, computed by the production modules
 * themselves (nothing re-implemented):
 *   base      pooled Laplace rate over offers resolved before the proposal (e1-league.js#priorCounts)
 *   baseline  eval/e1.js#activityBaseline
 *   clone     eval/e1-league.js#scoreAsOf (trade-acceptance.js band mid, replayed as of the offer)
 *   blend     p-yes-blend.js#blendState at now = proposed_at, then blendP (as p-yes-blend.js#prequential)
 * plus the offer's terms (ESPN player ids, team ids) for the new arms' features.
 *
 * Writes JSON with ids and counts only (no names, no chat, no credentials).
 * Usage: node scripts/eval/ml-testbench/a_export_offers.mjs --db <copy.sqlite> --out <offers.json>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadDecidedOffers } from '../../../server/services/eval/decided-offers.js';
import { priorCounts, scoreAsOf } from '../../../server/services/eval/e1-league.js';
import { activityBaseline } from '../../../server/services/eval/e1.js';
import { blendState, blendP } from '../../../server/services/p-yes-blend.js';

const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const dbPath = arg('--db');
const out = arg('--out');
if (!dbPath || !out) { console.error('usage: --db <copy.sqlite> --out <offers.json>'); process.exit(2); }
const LIVE = path.join(os.homedir(), 'gridiron-local', 'data.sqlite');
if (fs.realpathSync(dbPath) === fs.realpathSync(LIVE)) { console.error('refusing the live database; pass a copy'); process.exit(2); }

const db = new DatabaseSync(dbPath, { readOnly: true });
const built = loadDecidedOffers(db);

/** Terms as a flat list of { playerId, fromTeamId, toTeamId } (raw items or trade_outcomes give/get). */
function items(o) {
  const t = o.terms;
  if (!t) return null;
  const list = Array.isArray(t) ? t : [...(t.give ?? []), ...(t.get ?? [])];
  const xs = list.filter(i => i && i.playerId != null)
    .map(i => ({ playerId: Number(i.playerId), fromTeamId: Number(i.fromTeamId), toTeamId: Number(i.toTeamId) }));
  return xs.length ? xs : null;
}

function arms(offers) {
  const scored = scoreAsOf(offers); // drops rows the clone cannot score (none expected)
  const priors = priorCounts(scored);
  const base = activityBaseline(scored, priors);
  return scored.map((o, i) => {
    const pr = priors[i];
    const w = blendState(scored, o.league_id, { now: Date.parse(o.proposed_at) }).weights;
    return {
      offer_id: String(o.offer_id ?? `${o.league_id}:${o.espn_tx_id ?? i}`), league_id: String(o.league_id),
      season: Number(o.season), source: o.source, proposal_basis: o.proposal_basis,
      proposer_team_id: o.proposer_team_id == null ? null : String(o.proposer_team_id),
      counterparty_team_id: String(o.counterparty_team_id), proposed_at: o.proposed_at,
      resolved_at: o.resolved_at ?? null, y: o.y, clone_basis: o.basis, items: items(o),
      n_prior: pr.nAll, n_prior_responder: pr.n,
      p: { base: (pr.accAll + 1) / (pr.nAll + 2), baseline: base[i], clone: o.p, blend: blendP(w, { baseline: base[i], clone: o.p }) },
      blend_w_clone: w.clone,
    };
  });
}

const byTime = xs => xs.map((o, i) => ({ o, i })).sort((a, b) => Date.parse(a.o.proposed_at) - Date.parse(b.o.proposed_at) || a.i - b.i).map(x => x.o);

const primary = arms(byTime(built.offers));
// Sensitivity set: orphans whose terms are known, proposal time = answer time (upper bound; never judged).
const orphans = built.orphans.filter(o => items(o) && o.proposed_before)
  .map(o => ({ ...o, proposed_at: o.proposed_before, proposal_basis: 'orphan_answer_time' }));
const sensitivity = arms(byTime([...built.offers, ...orphans]));

const summary = {
  made_at: new Date().toISOString(), sources: built.sources,
  primary_n: primary.length, primary_accepted: primary.reduce((a, o) => a + o.y, 0),
  primary_with_terms: primary.filter(o => o.items).length,
  orphans_total: built.orphans.length, orphans_with_terms: orphans.length,
  sensitivity_n: sensitivity.length, excluded: built.excluded,
  by_league: Object.fromEntries(Object.entries(built.by_league).map(([k, v]) => [k, { offers: v.offers, accepted: v.accepted, orphans: v.orphans }])),
};
fs.writeFileSync(out, JSON.stringify({ summary, primary, sensitivity }, null, 1));
console.log(JSON.stringify(summary));
