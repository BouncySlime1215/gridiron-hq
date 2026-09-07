import { statHeadline } from '../draft/types';
import { hasEvidence, type TradePlayer } from './types';

const n0 = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'));

/**
 * The stat-rooted line under one player on a trade card: the record headline,
 * a compact three-season line (season · G · PPR · pos rank) and this season's
 * p20–p80 band. The offseason read is a chip labelled as risk or upside — it is
 * never applied to the value, and the label says so on hover.
 * Nothing to show → null, so a league without history renders exactly as before.
 */
export default function PlayerEvidence({ p, tone = 'slate', compact = false }:
  { p: TradePlayer; tone?: 'give' | 'get' | 'slate'; compact?: boolean }) {
  if (!hasEvidence(p)) return null;
  const headline = statHeadline(p.career, p.preseason);
  const seasons = p.career?.seasons ?? [];
  const pre = p.preseason;
  const off = p.offseason;
  const hasBand = pre?.p20 != null && pre?.p80 != null;
  const nameTone = tone === 'give' ? 'text-crit' : tone === 'get' ? 'text-good' : 'text-slate-700';

  return (
    <div className="min-w-0 text-[11px] leading-snug">
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        <span className={`font-semibold ${nameTone}`}>{p.name}</span>
        {headline
          ? <span className="text-slate-700">{headline}</span>
          : <span className="text-slate-400">no NFL seasons on record</span>}
      </div>
      {seasons.length > 0 && (
        <div className="flex flex-wrap gap-x-2 gap-y-0.5 tabular-nums text-slate-500">
          {seasons.slice(0, 3).map((s, i) => (
            <span key={s.season} className={i === 0 ? 'text-slate-700' : ''}>
              {s.season} · {n0(s.games)} G · <b className="font-semibold">{n0(s.ppr_points)}</b> PPR
              {s.pos_rank != null && <> · <span className={s.pos_rank <= 12 ? 'text-good font-semibold' : ''}>{p.position}{s.pos_rank}</span></>}
            </span>
          ))}
        </div>
      )}
      {!compact && (hasBand || off) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 tabular-nums text-slate-500">
          {hasBand && (
            <span title="Our preseason model's p20–p80 season band">
              this season <b className="text-slate-700">{n0(pre!.p20)}–{n0(pre!.p80)}</b> pts
              {pre?.points != null && <span className="text-slate-400"> · median {n0(pre.points)}</span>}
            </span>
          )}
          {off && (
            <span
              title={`Offseason-changes model: opportunity ×${off.opportunity_multiplier.toFixed(2)} (${off.confidence ?? 'n/a'} confidence). Shown as ${off.direction ?? 'context'} only — not applied to the value, which already prices the depth chart.`}
              className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-semibold ${
                off.direction === 'upside' ? 'border-good bg-good-tint text-good'
                  : off.direction === 'risk' ? 'border-amber-300 bg-amber-50 text-amber-800'
                    : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
              {off.direction === 'upside' ? 'upside' : off.direction === 'risk' ? 'risk' : 'offseason'} ×{off.opportunity_multiplier.toFixed(2)}
              {off.drivers?.[0] && <span className="font-normal">· {off.drivers[0]}</span>}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
