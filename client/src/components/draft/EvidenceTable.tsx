import type { Career, CareerSeason, Preseason } from './types';
import { InlineBar, RangeBar } from './SparkBar';
import StreakChips from './StreakChips';

type Col = { key: string; label: string; get: (s: CareerSeason) => number | null | undefined };

const col = (key: string, label: string, get: Col['get']): Col => ({ key, label, get });

/** The 2-4 stats that matter for the position, after the shared season/G/PPR/rank columns. */
function columnsFor(position: string): Col[] {
  switch (position) {
    case 'RB':
      return [col('carries', 'Car', s => s.carries), col('rush_yds', 'Rush', s => s.rush_yds),
        col('rush_td', 'RTD', s => s.rush_td), col('rec', 'Rec', s => s.rec), col('rec_yds', 'RecYd', s => s.rec_yds)];
    case 'WR': case 'TE':
      return [col('targets', 'Tgt', s => s.targets), col('rec', 'Rec', s => s.rec),
        col('rec_yds', 'Yds', s => s.rec_yds), col('rec_td', 'TD', s => s.rec_td)];
    case 'QB':
      return [col('pass_yds', 'Pass', s => s.pass_yds), col('pass_td', 'PTD', s => s.pass_td),
        col('int', 'INT', s => s.int ?? s.pass_int), col('rush_yds', 'Rush', s => s.rush_yds), col('rush_td', 'RTD', s => s.rush_td)];
    default:
      return [];
  }
}

const num = (v: number | null | undefined, digits = 0) =>
  v == null ? '—' : digits ? v.toFixed(digits) : Math.round(v).toLocaleString('en-US');

/**
 * One row per season, newest first: the evidence behind the call. Columns the payload
 * never fills for this player are dropped rather than shown as a column of dashes.
 * No `career` at all → null, so the hero simply reads as it did before the payload grew.
 */
export default function EvidenceTable({ career, preseason, position }:
  { career?: Career | null; preseason?: Preseason | null; position?: string }) {
  const seasons = career?.seasons ?? [];
  const hasRange = preseason?.p20 != null && preseason?.p80 != null;
  if (!seasons.length && !hasRange) return null;

  const cols = columnsFor(position ?? '').filter(c => seasons.some(s => c.get(s) != null));
  const maxPpr = Math.max(...seasons.map(s => s.ppr_points ?? 0), 1);

  return (
    <div className="space-y-2">
      {/* max-h + overflow-y is what makes `sticky top-0` on the header mean
          anything: the header pins against this box, not the page. It only
          engages when a player has more seasons than fit; four or fewer rows
          never reach the cap, so nothing scrolls that didn't before.
          `snap-x` is Tailwind's proximity strictness, not mandatory — a wide
          stat table should scrub freely, not yank from column to column. */}
      {seasons.length > 0 && (
        <div className="overflow-x-auto overflow-y-auto max-h-56 -mx-1 snap-x">
          <table className="w-full text-xs tabular-nums min-w-[20rem]">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-slate-400">
                {/* The season label is the row's identity — it has to survive a
                    horizontal scrub on a phone, so it sticks left while Car/Rush/
                    RTD slide under it. Opaque, not bg-inherit: a transparent
                    sticky cell lets the scrolled columns show through it. */}
                <th className="text-left font-semibold px-1 py-1 sticky left-0 top-0 z-30 bg-white">Season</th>
                <th className="text-right font-semibold px-1 py-1 sticky top-0 z-20 bg-white">G</th>
                <th className="text-right font-semibold px-1 py-1 sticky top-0 z-20 bg-white">PPR</th>
                <th className="text-left font-semibold px-1 py-1 w-[22%] sticky top-0 z-20 bg-white"></th>
                <th className="text-right font-semibold px-1 py-1 sticky top-0 z-20 bg-white">Rank</th>
                {cols.map(c => <th key={c.key} className="text-right font-semibold px-1 py-1 sticky top-0 z-20 bg-white">{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {seasons.map((s, i) => {
                const rank = s.pos_rank;
                const rankTone = rank == null ? 'text-slate-400' : rank <= 12 ? 'text-good font-bold' : rank <= 24 ? 'text-slate-700 font-semibold' : 'text-slate-500';
                return (
                  <tr key={s.season} className={`border-t border-slate-100 hover:bg-slate-50 ${i === 0 ? 'bg-slate-50/60' : ''}`}>
                    <td className={`px-1 py-1 font-semibold text-slate-700 sticky left-0 z-10 ${i === 0 ? 'bg-[#f9fafb]' : 'bg-white'}`}>{s.season}</td>
                    <td className="px-1 py-1 text-right text-slate-600">{num(s.games)}</td>
                    <td className="px-1 py-1 text-right font-bold text-slate-800">
                      {num(s.ppr_points)}
                      {s.ppg != null && <span className="text-[10px] font-normal text-slate-400"> ({num(s.ppg, 1)}/g)</span>}
                    </td>
                    <td className="px-1 py-1 align-middle"><InlineBar value={s.ppr_points ?? 0} max={maxPpr} /></td>
                    <td className={`px-1 py-1 text-right ${rankTone}`}>{rank != null ? `${position ?? ''}${rank}` : '—'}</td>
                    {cols.map(c => <td key={c.key} className="px-1 py-1 text-right text-slate-600">{num(c.get(s))}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <StreakChips career={career} />

      {/* The band as a bar, with the numbers kept as its label. Two numbers alone
          ("212–268 pts") need reading; the bar shows how wide the outcome is and
          where the median sits inside it at a glance, which is the thing that
          actually separates a safe floor from a boom/bust at pick time. The
          scale runs to p80 + 15% so the band never fills the whole track and a
          right-hand tail stays visible. */}
      {hasRange && (
        <div className="space-y-1">
          <RangeBar low={preseason!.p20!} high={preseason!.p80!} mid={preseason?.points ?? null}
            max={preseason!.p80! * 1.15}
            title={`p20–p80: ${Math.round(preseason!.p20!)}–${Math.round(preseason!.p80!)} pts`} />
          <div className="flex items-center gap-2 text-xs text-slate-600 tabular-nums">
            <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">This season</span>
            <span><b className="text-slate-800">{Math.round(preseason!.p20!)}</b>–<b className="text-slate-800">{Math.round(preseason!.p80!)}</b> pts (p20–p80)</span>
            {preseason?.points != null && <span className="text-slate-400">· median {Math.round(preseason.points)}</span>}
            {preseason?.expected_games != null && <span className="text-slate-400">· ~{Math.round(preseason.expected_games)} games</span>}
          </div>
        </div>
      )}
      {(preseason?.drivers?.length ?? 0) > 1 && (
        <ul className="text-[11px] text-slate-500 list-disc pl-4 space-y-0.5">
          {preseason!.drivers!.slice(1, 4).map(d => <li key={d}>{d}</li>)}
        </ul>
      )}
    </div>
  );
}
