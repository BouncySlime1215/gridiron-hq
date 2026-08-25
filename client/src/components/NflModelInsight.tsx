import { useEffect, useState } from 'react';
import { api, useApi } from '../api';

/**
 * The ensemble (20 models blended into one line) and the training replay
 * (walk-forward backtest + systematic-error analysis) used to live on their
 * own separate pages, disconnected from the picks they actually explain.
 * This puts both directly on the pages that use them, so "why is the model
 * picking this" and "should I trust it" are answered right where the pick is,
 * not on a page three clicks away.
 */

interface ModelRow {
  id: string; name: string; family: string; note: string;
  margin: number | null; total: number | null;
  margin_weight: number; total_weight: number;
  margin_rmse: number | null; total_rmse: number | null;
}
export interface EnsembleGame {
  season: number; week: number; home: string; away: string;
  ensemble: {
    projected_spread: number | null; projected_margin: number | null; projected_total: number | null;
    market_spread: number | null; market_total: number | null;
    spread_edge: number | null; total_edge: number | null;
    model_disagreement_margin: number | null; model_disagreement_total: number | null;
    models_contributing_margin: number; models_contributing_total: number;
    confidence: string;
  };
  models: ModelRow[];
}
interface Segment {
  dimension: string; segment: string; bets: number;
  win_rate: number | null; units: number; roi: number;
  mean_signed_error: number | null; beats_vig: boolean; z: number;
}
interface SeasonSummary {
  season: number; bets: number; wins: number; losses: number; pushes: number;
  win_rate: number | null; units: number; roi: number; beat_vig: boolean | null; error?: string;
}
interface TrainingData {
  seasons: number[];
  overall: {
    bets: number; wins: number; losses: number; win_rate: number | null;
    units: number; roi: number; break_even_needed: number; beat_vig: boolean | null;
  };
  per_season: SeasonSummary[];
  analysis: { segments: Segment[]; weakest: Segment[]; strongest: Segment[]; note: string };
}

const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const u = (v: number | null | undefined) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}u`);
const num = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
const signed = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}`);

const confTone = (c: string) =>
  c.startsWith('strong') ? 'bg-emerald-100 text-emerald-700 border-emerald-300'
  : c.startsWith('moderate') ? 'bg-sky-100 text-sky-700 border-sky-300'
  : c.startsWith('weak') || c.startsWith('no edge') ? 'bg-slate-100 text-slate-600 border-slate-300'
  : 'bg-amber-100 text-amber-800 border-amber-300';

/** Fetches the week's 20-model ensemble. Season omitted so it matches the same server-side default the board itself uses. */
export function useEnsembleWeek(week: number, season?: number) {
  return useApi<{ season: number; week: number; games: EnsembleGame[] }>(
    `/nfl-betting/ensemble/week?week=${week}${season ? `&season=${season}` : ''}`);
}

export function findEnsembleGame(games: EnsembleGame[] | undefined, home?: string, away?: string) {
  if (!games || !home || !away) return null;
  return games.find(g => g.home === home && g.away === away) ?? null;
}

/** Order-agnostic lookup for contexts (like player props) that know both teams but not which is home. */
export function findEnsembleGameByTeams(games: EnsembleGame[] | undefined, teamA?: string | null, teamB?: string | null) {
  if (!games || !teamA || !teamB) return null;
  return games.find(g => (g.home === teamA && g.away === teamB) || (g.home === teamB && g.away === teamA)) ?? null;
}

/** The per-model table for one game — what backs the projected line. */
export function EnsembleDetail({ game }: { game: EnsembleGame }) {
  const e = game.ensemble;
  return (
    <div className="border-t border-slate-100 p-3 bg-slate-50/50">
      <div className="flex flex-wrap items-center gap-3 mb-2">
        <Cell label="Ensemble" value={signed(e.projected_spread)} strong />
        <Cell label="Market" value={signed(e.market_spread)} />
        <Cell label="Total" value={num(e.projected_total)} />
        <Cell label="Mkt total" value={num(e.market_total)} />
        <Cell label="Disagreement" value={`±${num(e.model_disagreement_margin)}`} />
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${confTone(e.confidence)}`}>
          {e.confidence.split('—')[0].trim()}
        </span>
      </div>
      <p className="text-[11px] text-slate-600 mb-2">{e.confidence}</p>
      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">
        What each model says ({e.models_contributing_margin} with a margin opinion)
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead className="text-slate-400">
            <tr>{['Model', 'Family', 'Margin', 'Total', 'Weight', 'RMSE'].map((h, i) => (
              <th key={i} className="text-left font-semibold px-2 py-1 whitespace-nowrap">{h}</th>
            ))}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {game.models.map(m => (
              <tr key={m.id} title={m.note} className="hover:bg-white">
                <td className="px-2 py-1 font-semibold text-slate-700 whitespace-nowrap">{m.name}</td>
                <td className="px-2 py-1 text-slate-400 whitespace-nowrap">{m.family}</td>
                <td className="px-2 py-1 tabular-nums">{signed(m.margin)}</td>
                <td className="px-2 py-1 tabular-nums">{num(m.total)}</td>
                <td className="px-2 py-1 tabular-nums">
                  <div className="flex items-center gap-1">
                    <div className="w-8 h-1 bg-slate-200 rounded overflow-hidden">
                      <div className="h-full bg-emerald-500"
                        style={{ width: `${Math.min(100, (m.margin_weight || m.total_weight) * 900)}%` }} />
                    </div>
                    <span className="text-slate-500">{((m.margin_weight || m.total_weight) * 100).toFixed(1)}%</span>
                  </div>
                </td>
                <td className="px-2 py-1 tabular-nums text-slate-500">{num(m.margin_rmse ?? m.total_rmse, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Small inline badge for contexts too tight for the full detail table (e.g. a props card). */
export function EnsembleBadge({ game }: { game: EnsembleGame }) {
  const e = game.ensemble;
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${confTone(e.confidence)}`}
      title={e.confidence}>
      {e.confidence.split('—')[0].trim()} · ±{num(e.model_disagreement_margin)}
    </span>
  );
}

/**
 * The training replay, auto-run rather than gated behind a manual button —
 * this is the honest "should I trust this model" context, so it should be
 * visible without someone having to know a separate page exists for it.
 * Collapsed to a verdict strip by default; expands to the full segment table.
 */
export function TrainingSummaryCard({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [data, setData] = useState<TrainingData | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(defaultOpen);

  const run = async () => {
    setBusy(true); setErr(null);
    try {
      setData(await api('/nfl-betting/replay/train?seasons=2021,2022,2023,2024,2025&min_edge=1.5&min_bets=30'));
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  useEffect(() => { run(); }, []);

  const o = data?.overall;

  return (
    <div className="card overflow-hidden mb-4">
      <button onClick={() => setOpen(v => !v)}
        className="w-full text-left p-3 flex items-center gap-3 flex-wrap hover:bg-slate-50 transition-colors">
        <span className="text-sm font-bold text-slate-700">Model training record</span>
        {busy ? (
          <span className="text-xs text-slate-400">Replaying 2022–2025…</span>
        ) : err ? (
          <span className="text-xs text-rose-600">{err}</span>
        ) : o ? (
          <>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
              o.beat_vig ? 'bg-emerald-100 text-emerald-700 border-emerald-300' : 'bg-amber-100 text-amber-800 border-amber-300'}`}>
              {o.beat_vig ? 'Beats the vig' : 'Does not beat the vig'}
            </span>
            <span className="text-xs text-slate-500">
              {pct(o.win_rate)} on {o.bets} bets ({u(o.units)}, {(o.roi * 100).toFixed(1)}% ROI) —
              break-even needs {pct(o.break_even_needed)}
            </span>
          </>
        ) : null}
        <span className="ml-auto text-xs text-slate-400">{open ? 'Hide detail ▲' : 'Show detail ▼'}</span>
      </button>

      {open && o && data && (
        <div className="border-t border-slate-100 p-3">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
            <Metric label="Bets" value={String(o.bets)} />
            <Metric label="Record" value={`${o.wins}-${o.losses}`} />
            <Metric label="Win rate" value={pct(o.win_rate)} />
            <Metric label="Units" value={u(o.units)} tone={o.units > 0 ? 'good' : 'bad'} />
            <Metric label="ROI" value={`${(o.roi * 100).toFixed(1)}%`} tone={o.roi > 0 ? 'good' : 'bad'} />
          </div>

          <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">By season</div>
          <div className="overflow-x-auto mb-4">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-400">
                <tr>{['Season', 'Bets', 'Record', 'Win rate', 'Units', 'Beat vig'].map((h, i) => (
                  <th key={i} className="text-left font-semibold px-3 py-2">{h}</th>
                ))}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.per_season.map(s => (
                  <tr key={s.season}>
                    <td className="px-3 py-1.5 font-semibold text-slate-800">{s.season}</td>
                    <td className="px-3 py-1.5 tabular-nums">{s.bets ?? '—'}</td>
                    <td className="px-3 py-1.5 tabular-nums">{s.error ? '—' : `${s.wins}-${s.losses}`}</td>
                    <td className="px-3 py-1.5 tabular-nums">{pct(s.win_rate)}</td>
                    <td className={`px-3 py-1.5 tabular-nums font-semibold ${(s.units ?? 0) > 0 ? 'text-good' : 'text-crit'}`}>{u(s.units)}</td>
                    <td className="px-3 py-1.5">{s.beat_vig ? '✓' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">
            Where it's systematically wrong (|z| ≥ 1.5 is a real pattern, not chance)
          </div>
          <div className="overflow-x-auto max-h-64 overflow-y-auto mb-2">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-400 sticky top-0">
                <tr>{['Segment', 'Bets', 'Win rate', 'ROI', 'z'].map((h, i) => (
                  <th key={i} className="text-left font-semibold px-3 py-2 whitespace-nowrap">{h}</th>
                ))}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.analysis.segments.map((s, i) => {
                  const real = Math.abs(s.z) >= 1.5;
                  return (
                    <tr key={i} className={real ? '' : 'opacity-50'}>
                      <td className="px-3 py-1.5">
                        <span className="text-slate-400">{s.dimension}:</span>{' '}
                        <span className="font-semibold text-slate-800">{s.segment}</span>
                      </td>
                      <td className="px-3 py-1.5 tabular-nums">{s.bets}</td>
                      <td className={`px-3 py-1.5 tabular-nums font-semibold ${(s.win_rate ?? 0) >= 0.524 ? 'text-good' : 'text-crit'}`}>{pct(s.win_rate)}</td>
                      <td className="px-3 py-1.5 tabular-nums">{(s.roi * 100).toFixed(1)}%</td>
                      <td className={`px-3 py-1.5 tabular-nums ${real ? 'font-bold text-slate-800' : 'text-slate-400'}`}>{s.z > 0 ? '+' : ''}{s.z.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <button className="btn-ghost text-xs" onClick={run} disabled={busy}>
            {busy ? 'Replaying…' : '↻ Re-run replay'}
          </button>
        </div>
      )}
    </div>
  );
}

const Metric = ({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) => (
  <div className="card p-3">
    <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
    <div className={`text-lg font-bold ${tone === 'good' ? 'text-good' : tone === 'bad' ? 'text-crit' : 'text-slate-800'}`}>{value}</div>
  </div>
);

const Cell = ({ label, value, strong }: { label: string; value: string; strong?: boolean }) => (
  <div className="min-w-[70px]">
    <div className="text-[9px] uppercase tracking-wide text-slate-400">{label}</div>
    <div className={`tabular-nums ${strong ? 'text-sm font-bold text-slate-800' : 'text-xs font-semibold text-slate-700'}`}>{value}</div>
  </div>
);
