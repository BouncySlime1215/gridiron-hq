import { useState } from 'react';
import { useApi } from '../../api';

/**
 * What the market expects from every offence this week, applied to fantasy.
 *
 * The distinction this page rests on is worth stating plainly, because the rest
 * of this app spends its time failing to beat the market: an efficient line is
 * not an uninformative one. Twenty-two models say the closing number cannot be
 * out-forecast — that is exactly why its implied team total is the best public
 * estimate of how many points an offence will score, and scoring is most of
 * what fantasy measures.
 *
 * So this reads the market rather than betting against it. Fitted on 2,106
 * team-weeks and validated walk-forward: touchdown projections improve 5.0% and
 * yardage 7.4% against a baseline with no game-script knowledge.
 */

interface TeamScript {
  team: string; opponent: string; implied: number; spread?: number;
  td_multiplier: number; yard_multiplier?: number; blended_multiplier: number;
  explanation?: string;
}
interface Slate {
  season: number; week: number; teams: number; league_mean_implied: number | null;
  best_spots: TeamScript[]; worst_spots: TeamScript[]; all: TeamScript[];
  note: string; error?: string; hint?: string;
}
interface Fit {
  fit: {
    fitted_on: { team_weeks: number; from_season: number };
    league_mean_implied: number;
    touchdowns: { pct_per_implied_point: number; correlation: number };
    yards: { pct_per_implied_point: number; correlation: number };
    receptions: { pct_per_implied_point: number; correlation: number };
    pass_share: { per_spread_point: number; correlation: number };
    note: string;
  };
  validation: {
    test_season: number; team_weeks: number;
    touchdowns: { flat_mae: number; adjusted_mae: number; improvement: number; helps: boolean };
    yards: { flat_mae: number; adjusted_mae: number; improvement: number; helps: boolean };
    verdict: string;
  };
}

const mult = (v: number | undefined) =>
  v == null ? '—' : `${v >= 1 ? '+' : ''}${((v - 1) * 100).toFixed(0)}%`;

export default function GameScript() {
  const [week, setWeek] = useState(1);
  const [season, setSeason] = useState(2025);
  const { data, loading } = useApi<Slate>(`/model/game-script?season=${season}&week=${week}`);
  const { data: fit } = useApi<Fit>('/model/game-script-fit');

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <h2 className="font-semibold text-slate-900">Vegas game script</h2>
        <p className="mt-1 text-sm text-slate-600">
          An efficient line is not an uninformative one. The market cannot be beaten on sides here —
          twenty-two models and roughly 2,600 graded bets say so — which is precisely why its implied
          team total is worth <em>reading</em>. It is the best public estimate of how many points an
          offence will score, and scoring is most of what fantasy measures.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-xs font-medium text-slate-500">Season
            <select value={season} onChange={e => setSeason(Number(e.target.value))}
              className="mt-1 block rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900">
              {[2025, 2024, 2023, 2022].map(s => <option key={s}>{s}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-500">Week
            <select value={week} onChange={e => setWeek(Number(e.target.value))}
              className="mt-1 block rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900">
              {Array.from({ length: 18 }, (_, i) => i + 1).map(w => <option key={w}>{w}</option>)}
            </select>
          </label>
        </div>
      </div>

      {fit && (
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-slate-900">How much the market moves a projection</h3>
          <p className="mt-1 text-xs text-slate-500">
            Fitted on {fit.fit.fitted_on.team_weeks.toLocaleString()} team-weeks since{' '}
            {fit.fit.fitted_on.from_season}. Touchdowns and yardage are fitted separately because they
            scale very differently — one flat multiplier would be wrong for both.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <Stat label="Touchdowns" value={`+${(fit.fit.touchdowns.pct_per_implied_point * 100).toFixed(2)}%`}
              sub={`per implied point · r=${fit.fit.touchdowns.correlation}`} />
            <Stat label="Yards" value={`+${(fit.fit.yards.pct_per_implied_point * 100).toFixed(2)}%`}
              sub={`per implied point · r=${fit.fit.yards.correlation}`} />
            <Stat label="Receptions" value={`+${(fit.fit.receptions.pct_per_implied_point * 100).toFixed(2)}%`}
              sub={`per implied point · r=${fit.fit.receptions.correlation}`} />
            <Stat label="Pass share" value={`${(fit.fit.pass_share.per_spread_point * 100).toFixed(2)}%`}
              sub="per point of spread" />
          </div>

          {fit.validation && (
            <div className={`mt-3 rounded-lg p-3 ${
              fit.validation.touchdowns.helps && fit.validation.yards.helps
                ? 'bg-emerald-50' : 'bg-amber-50'}`}>
              <div className="flex flex-wrap gap-4 text-sm">
                <span className="text-slate-800">
                  <strong>TDs</strong> {fit.validation.touchdowns.flat_mae} →{' '}
                  {fit.validation.touchdowns.adjusted_mae}{' '}
                  <span className="text-emerald-700">
                    ({(fit.validation.touchdowns.improvement * 100).toFixed(1)}% better)</span>
                </span>
                <span className="text-slate-800">
                  <strong>Yards</strong> {fit.validation.yards.flat_mae} →{' '}
                  {fit.validation.yards.adjusted_mae}{' '}
                  <span className="text-emerald-700">
                    ({(fit.validation.yards.improvement * 100).toFixed(1)}% better)</span>
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-600">
                Walk-forward on {fit.validation.team_weeks} team-weeks of {fit.validation.test_season},
                fitted only on earlier seasons.
              </p>
            </div>
          )}
        </div>
      )}

      {!data && loading && (
        <div className="card p-6 text-sm text-slate-500">Reading the week's lines…</div>
      )}
      {data?.error && (
        <div className="card p-6">
          <p className="text-sm text-rose-700">{data.error}</p>
          {data.hint && <p className="mt-1 text-xs text-slate-500">{data.hint}</p>}
        </div>
      )}

      {data && !data.error && (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            <SpotList title="Best spots" tone="good" spots={data.best_spots} />
            <SpotList title="Worst spots" tone="bad" spots={data.worst_spots} />
          </div>

          <div className="card overflow-x-auto p-4">
            <h3 className="text-sm font-semibold text-slate-900">
              Every offence, week {data.week}
            </h3>
            <p className="mt-0.5 text-xs text-slate-500">
              League average implied total is {data.league_mean_implied}. Multipliers scale a player's
              projection for the offence they play in.
            </p>
            <table className="mt-3 w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="py-1 text-left">Team</th><th className="text-left">Opp</th>
                  <th className="text-right">Implied</th><th className="text-right">Spread</th>
                  <th className="text-right">TDs</th><th className="text-right">Yards</th>
                  <th className="text-right">Blended</th>
                </tr>
              </thead>
              <tbody>
                {data.all.map(t => (
                  <tr key={t.team} className="border-t border-slate-100">
                    <td className="py-1.5 font-medium text-slate-800">{t.team}</td>
                    <td className="text-slate-500">{t.opponent}</td>
                    <td className="text-right tabular-nums text-slate-900">{t.implied}</td>
                    <td className="text-right tabular-nums text-slate-500">
                      {t.spread == null ? '—' : t.spread > 0 ? `+${t.spread}` : t.spread}</td>
                    <td className={`text-right tabular-nums font-medium ${
                      t.td_multiplier > 1 ? 'text-emerald-700' : 'text-rose-700'}`}>
                      {mult(t.td_multiplier)}</td>
                    <td className={`text-right tabular-nums ${
                      (t.yard_multiplier ?? 1) > 1 ? 'text-emerald-700' : 'text-rose-700'}`}>
                      {mult(t.yard_multiplier)}</td>
                    <td className="text-right tabular-nums text-slate-700">{mult(t.blended_multiplier)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-slate-500">{data.note}</p>
          </div>
        </>
      )}
    </div>
  );
}

function SpotList({ title, tone, spots }: {
  title: string; tone: 'good' | 'bad'; spots: TeamScript[];
}) {
  return (
    <div className="card p-4">
      <h3 className={`text-sm font-semibold ${tone === 'good' ? 'text-emerald-800' : 'text-rose-800'}`}>
        {title}
      </h3>
      <div className="mt-2 space-y-2">
        {spots.map(s => (
          <div key={s.team} className="border-t border-slate-100 pt-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium text-slate-900">{s.team} vs {s.opponent}</span>
              <span className="font-mono text-xs tabular-nums text-slate-600">
                {s.implied} implied · TDs {mult(s.td_multiplier)}
              </span>
            </div>
            {s.explanation && <p className="mt-1 text-xs leading-relaxed text-slate-600">{s.explanation}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}
