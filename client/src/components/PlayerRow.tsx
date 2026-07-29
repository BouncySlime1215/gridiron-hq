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
    <span className={`text-[10px] font-black w-8 shrink-0 text-center py-1 rounded ring-1 ${POS_BG[pos] ?? 'bg-slate-50 text-slate-600 ring-slate-200'}`}>
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
  const points = raw ?? trend ?? null;
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
  right?: ReactNode;
  meta?: ReactNode;
  onClickRow?: () => void;
  action?: ReactNode;
  dense?: boolean;
  /** Hide the position chip when space is tight (the headshot ring already encodes it). */
  hidePos?: boolean;
}

/**
 * One list row. Everything sits in a single flex line with explicit shrink rules
 * so nothing can ever overlap: only the name column flexes, and it truncates.
 */
export default function PlayerRow({
  playerId, rank, name, position, teamAbbr, headshot, tier,
  right, meta, onClickRow, action, dense, hidePos
}: RowProps) {
  const open = usePlayerCard();
  return (
    <div
      onClick={onClickRow}
      className={`group flex items-center gap-2 px-2.5 ${dense ? 'py-1.5' : 'py-2'} overflow-hidden
        ${onClickRow ? 'cursor-pointer hover:bg-emerald-50/60' : 'hover:bg-slate-50'}`}>
      <span className="w-6 shrink-0 text-right text-[11px] font-mono text-slate-400 tabular-nums">{rank}</span>
      {tier != null && (
        <span className="w-1 shrink-0 self-stretch rounded-full" style={{ background: TIER_COLORS[tier] ?? '#cbd5e1' }} title={`Tier ${tier}`} />
      )}
      <Headshot src={headshot} pos={position} size={dense ? 28 : 36} />
      {!hidePos && <PosBadge pos={position} />}
      {/* name gets every remaining pixel; basis-0 stops flex from reserving content width */}
      <div className="flex-1 basis-0 min-w-0">
        <button
          onClick={e => { e.stopPropagation(); open(playerId); }}
          className="block w-full text-left font-semibold text-slate-800 hover:text-emerald-700 truncate"
          title={name}>
          {hidePos && <span className={`text-[10px] font-black mr-1.5 pos-${position}`}>{position}</span>}
          {name}
        </button>
        {meta && <div className="text-[11px] text-slate-400 leading-tight truncate">{meta}</div>}
      </div>
      {teamAbbr && <span className="shrink-0 text-[11px] text-slate-400 font-medium">{teamAbbr}</span>}
      {right}
      {action}
    </div>
  );
}
