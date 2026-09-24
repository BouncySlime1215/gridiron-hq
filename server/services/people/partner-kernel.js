/**
 * PARTNER-KERNEL (RL-46-1, R&D r46 IDEA-134, prereg sha256 3fd1ad05...): who trades with whom.
 *
 * Fitted on Sleeper 2021-22 (1,601 two-team trades), graded held-out on 2023 and 2024:
 * +0.14 / +0.11 nats per trade over a uniform partner choice (league-cluster CIs above 0).
 * The fitted form, for a proposer i choosing among partners j (i's own term cancels):
 *
 *   w_j = (trade_ends_j + LAM x prev_season_j + C) x (1 + A x repeat_ij)
 *
 *   trade_ends_j   completed trades j was part of this season, strictly before now
 *   prev_season_j  j's completed trades last season (manager-level; 0 when not stored)
 *   repeat_ij      1 when i and j traded in an earlier season (manager-level)
 *
 * C is an additive pseudo-count, not an exponent (r46_IDEA-134_check.py: log(deg + c)).
 * Constants are the checker's refit with the manager-level repeat (prev_ts_id pairs);
 * the tester's 0.906 / 0.157 / 0.383 used a league-chain repeat and are withdrawn.
 *
 * Product use (campaign/partners.js#rankPartners): the ranking multiplies each partner's
 * P(responds) by tilt_j = w_j / mean(w) over the league's other teams, for ORDER only.
 * P(responds) itself is not changed. Nick's notes stay hard overrides: an excluded manager
 * is never tilted; a deprioritised (non-buyer) manager can sink but never rise.
 *
 * Flag: GRIDIRON_PARTNER_KERNEL=1 on, =0 off (vetoes preview); unset = on only under
 * preview mode (preview-mode.js#previewUnconfirmed), labelled preview. Default off.
 * Transfer caveat: fitted on Sleeper; the ESPN 2026 check is descriptive only.
 */
import { previewUnconfirmed } from '../preview-mode.js';

/** RL-46-1 constants (checker refit, /rnd/loop/data/r46-IDEA-134-check/check.out). */
export const KERNEL_C = 0.899;
export const KERNEL_A = 0.124;
export const KERNEL_LAM = 0.358;
export const KERNEL_SOURCE = 'RL-46-1 degree kernel (r46 IDEA-134; Sleeper 2021-22 fit, held-out 2023/2024)';
export const PARTNER_KERNEL_ENV = 'GRIDIRON_PARTNER_KERNEL';
export const PARTNER_KERNEL_REASON = 'partner kernel fitted on Sleeper; on ESPN it is a descriptive forward check only';
/** Tilt bands for the reason shown on a partner (display only). */
export const TRADES_A_LOT_TILT = 1.25;
export const FEW_TRADES_TILT = 0.8;

export function partnerKernelFlag() {
  const v = process.env[PARTNER_KERNEL_ENV];
  if (v === '1') return { on: true, preview: false };
  if (v === '0') return { on: false, preview: false };
  const preview = previewUnconfirmed();
  return { on: preview, preview };
}

const num = x => (Number.isFinite(Number(x)) ? Number(x) : 0);

/** Raw kernel weight of one partner. */
export const kernelWeight = (tradeEnds, prevSeason = 0, repeat = false) =>
  (num(tradeEnds) + KERNEL_LAM * num(prevSeason) + KERNEL_C) * (1 + KERNEL_A * (repeat ? 1 : 0));

/**
 * candidates: team ids (Nick excluded); tradeEnds / prevSeason: Map team -> count; repeat: Set of teams
 * Nick traded with in an earlier season. Returns Map team -> { weight, tilt, trade_ends, prev_season, repeat, reasons }.
 * tilt = weight / mean weight over the candidates, so a league with no trades yet tilts nobody.
 */
export function kernelWeights({ candidates, tradeEnds = new Map(), prevSeason = new Map(), repeat = new Set() }) {
  const ids = [...new Set((candidates ?? []).map(String))];
  const raw = ids.map(t => [t, kernelWeight(tradeEnds.get(t), prevSeason.get(t), repeat.has(t))]);
  const mean = raw.length ? raw.reduce((s, [, w]) => s + w, 0) / raw.length : 1;
  return new Map(raw.map(([t, w]) => {
    const tilt = w / mean;
    const reasons = [];
    if (tilt >= TRADES_A_LOT_TILT) reasons.push('trades a lot');
    if (repeat.has(t)) reasons.push('traded with you before');
    if (tilt <= FEW_TRADES_TILT) reasons.push('few trades so far');
    return [t, { weight: w, tilt, trade_ends: num(tradeEnds.get(t)), prev_season: num(prevSeason.get(t)), repeat: repeat.has(t), reasons }];
  }));
}

/**
 * Kernel inputs from completed trades. trades: [{ season, at (ISO), teams: [id, id] }] with team ids
 * already mapped to this season's roster ids (manager-level). Only trades strictly before `now` count;
 * `season` is the current season, `season - 1` gives prev_season, any earlier season with Nick gives repeat.
 */
export function kernelFromTrades({ me, candidates, trades = [], season, now }) {
  const cutoff = typeof now === 'string' ? now : new Date(now).toISOString();
  const tradeEnds = new Map(), prevSeason = new Map(), repeat = new Set();
  const bump = (m, t) => m.set(t, (m.get(t) ?? 0) + 1);
  for (const tr of trades) {
    const teams = [...new Set((tr.teams ?? []).map(String))];
    const s = Number(tr.season);
    if (s === Number(season)) {
      if (!(String(tr.at) < cutoff)) continue;
      teams.forEach(t => bump(tradeEnds, t));
    } else if (s < Number(season)) {
      if (s === Number(season) - 1) teams.forEach(t => bump(prevSeason, t));
      if (teams.includes(String(me))) teams.filter(t => t !== String(me)).forEach(t => repeat.add(t));
    }
  }
  return kernelWeights({ candidates, tradeEnds, prevSeason, repeat });
}

/**
 * ESPN league_transactions_raw rows -> completed trades. A trade that went through is the proposer's
 * TRADE_ACCEPT / PROCESS / EXECUTED row, which carries the items (manager-signals.js#completedTrades).
 */
export function completedTradesFromEspn(rows) {
  const out = [];
  for (const t of rows ?? []) {
    if (t.type !== 'TRADE_ACCEPT' || t.execution_type !== 'PROCESS' || t.status !== 'EXECUTED') continue;
    let items;
    try { items = JSON.parse(t.items_json || '[]'); } catch (err) {
      throw new Error(`league_transactions_raw ${t.tx_id}: items_json is not JSON (${err.message})`);
    }
    const teams = [...new Set(items.flatMap(i => [i.fromTeamId, i.toTeamId]).filter(x => Number(x) > 0).map(String))];
    if (teams.length) out.push({ season: Number(t.season), at: t.processed_at ?? t.proposed_at, teams });
  }
  return out;
}
