import { ReactNode } from 'react';
import { usePlayerCard } from './PlayerCard';

export const TIER_COLORS = ['', '#f43f5e', '#f59e0b', '#10b981', '#38bdf8', '#a78bfa', '#94a3b8'];

const POS_BG: Record<string, string> = {
  QB: 'bg-rose-50 text-rose-700 ring-rose-200',
  RB: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  WR: 'bg-sky-50 text-sky-700 ring-sky-200',
  TE: 'bg-amber-50 text-amber-700 ring-amber-200',
  K: 'bg-violet-50 text-violet-700 ring-violet-200'
};

export function PosBadge({ pos }: { pos: string }) {
  return (
    <span className={`text-[10px] font-black w-8 text-center py-1 rounded ring-1 ${POS_BG[pos] ?? 'bg-slate-50 text-slate-600 ring-slate-200'}`}>
      {pos}
    </span>
  );
}

export function Headshot({ src, pos, size = 36 }: { src?: string | null; pos: string; size?: number }) {
  return (
    <div className="rounded-full bg-slate-100 overflow-hidden shrink-0 grid place-items-center ring-1 ring-slate-200"
      style={{ width: size, height: size }}>
      {src
        ? <img src={src} alt="" className="w-full h-full object-cover"
            onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
        : <span className="text-[10px] font-black text-slate-400">{pos}</span>}
    </div>
  );
}

/**
 * 30-day market move. Pass either a precomputed percentage (`v`) or the raw
 * FantasyCalc pair (`value` + `trend`, where trend is a point delta, not a %).
 */
export function Trend({ v, raw, value, trend, className = '' }: {
  v?: number | null; raw?: number | null; value?: number | null; trend?: number | null; className?: string;
}) {
  let pct = v ?? null;
  let points = raw ?? trend ?? null;
  if (pct == null && value != null && trend != null && value - trend !== 0) {
    pct = (trend / (value - trend)) * 100;
  }
  if (pct == null) return <span className={`text-slate-300 ${className}`}>—</span>;
  const up = pct > 0.5, down = pct < -0.5;
  return (
    <span title={points != null ? `${points > 0 ? '+' : ''}${Math.round(points)} pts` : undefined}
      className={`tabular-nums ${up ? 'text-emerald-600' : down ? 'text-rose-600' : 'text-slate-400'} ${className}`}>
      {up ? '▲' : down ? '▼' : '·'}{Math.abs(pct).toFixed(1)}%
    </span>
  );
}

interface RowProps {
  playerId: number;
  rank: ReactNode;
  name: string;
  position: string;
  teamAbbr?: string | null;
  headshot?: string | null;
  tier?: number;
  tierBreak?: boolean;
  right?: ReactNode;
  meta?: ReactNode;
  onClickRow?: () => void;
  actionLabel?: string;
  dense?: boolean;
}

/** One list row: headshot, rank, position badge, name (opens pop-out), team, right-side stats. */
export default function PlayerRow({
  playerId, rank, name, position, teamAbbr, headshot, tier, tierBreak,
  right, meta, onClickRow, actionLabel, dense
}: RowProps) {
  const open = usePlayerCard();
  return (
    <div
      onClick={onClickRow}
      className={`group flex items-center gap-3 px-3 ${dense ? 'py-1.5' : 'py-2'} transition-colors
        ${tierBreak ? 'border-t-2 border-t-slate-200' : ''}
        ${onClickRow ? 'cursor-pointer hover:bg-emerald-50/60' : 'hover:bg-slate-50'}`}>
      <span className="w-7 text-right text-xs font-mono text-slate-400 tabular-nums">{rank}</span>
      {tier != null && (
        <span className="w-1 self-stretch rounded-full" style={{ background: TIER_COLORS[tier] ?? '#cbd5e1' }} title={`Tier ${tier}`} />
      )}
      <Headshot src={headshot} pos={position} size={dense ? 30 : 36} />
      <PosBadge pos={position} />
      <div className="min-w-0 flex-1">
        <button
          onClick={e => { e.stopPropagation(); open(playerId); }}
          className="font-semibold text-slate-800 hover:text-emerald-700 hover:underline decoration-dotted underline-offset-2 truncate block text-left">
          {name}
        </button>
        {meta && <div className="text-[11px] text-slate-400 leading-tight">{meta}</div>}
      </div>
      {teamAbbr && <span className="text-xs text-slate-400 font-medium w-9">{teamAbbr}</span>}
      {right}
      {actionLabel && (
        <span className="opacity-0 group-hover:opacity-100 text-emerald-600 text-xs font-bold whitespace-nowrap">
          {actionLabel}
        </span>
      )}
    </div>
  );
}
