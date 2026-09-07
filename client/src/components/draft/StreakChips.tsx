import type { Career } from './types';

const STAT_LABEL: Record<string, string> = {
  rec_yds: 'rec yds', rush_yds: 'rush yds', pass_yds: 'pass yds', ppr_points: 'PPR pts',
  rec: 'catches', targets: 'targets', rush_td: 'rush TD', rec_td: 'rec TD', pass_td: 'pass TD',
  games: 'games', ppg: 'PPG'
};

const fmt = (n: number) => n >= 1000 ? n.toLocaleString('en-US') : String(n);

/**
 * "1,000+ rec yds × 3 straight" / "top-12 finish 3 of 4" — the consistency story in
 * chips. Streaks of one season are noise, so only 2+ is shown. Nothing to say → null.
 */
export default function StreakChips({ career, compact = false }: { career?: Career | null; compact?: boolean }) {
  if (!career) return null;
  const chips: { text: string; tone: 'good' | 'neutral' }[] = [];
  for (const s of career.streaks ?? []) {
    if (!s || (s.seasons ?? 0) < 2) continue;
    chips.push({ text: `${fmt(s.threshold)}+ ${STAT_LABEL[s.stat] ?? s.stat} × ${s.seasons} straight`, tone: 'good' });
  }
  const c = career.consistency;
  const n = career.seasons?.length ?? 0;
  if (c?.seasons_top12 != null && n > 0 && c.seasons_top12 > 0) {
    chips.push({ text: `top-12 finish ${c.seasons_top12} of ${n}`, tone: c.seasons_top12 >= Math.ceil(n / 2) ? 'good' : 'neutral' });
  } else if (c?.seasons_top24 != null && n > 0 && c.seasons_top24 > 0) {
    chips.push({ text: `top-24 finish ${c.seasons_top24} of ${n}`, tone: 'neutral' });
  }
  if (!compact && c?.min_games != null && n > 1) {
    chips.push({ text: `never fewer than ${c.min_games} games`, tone: c.min_games >= 15 ? 'good' : 'neutral' });
  }
  if (!compact && c?.cv_points != null) {
    chips.push({ text: `season-to-season swing ±${Math.round(c.cv_points * 100)}%`, tone: c.cv_points <= 0.2 ? 'good' : 'neutral' });
  }
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {chips.slice(0, compact ? 2 : 6).map(ch => (
        <span key={ch.text}
          className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border tabular-nums ${ch.tone === 'good' ? 'bg-good-tint text-good border-good' : 'bg-slate-50 text-slate-600 border-slate-200'}`}>
          {ch.text}
        </span>
      ))}
    </div>
  );
}
