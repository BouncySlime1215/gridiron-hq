export interface Freshness {
  slate_date: string | null; today?: string; age_days: number | null;
  is_stale: boolean; source_generated_at?: string | null; message?: string | null;
}

/**
 * Warns when the proxied MLB board is not today's slate.
 *
 * This board comes from a separate repo whose pipeline runs on its own
 * schedule, so it can go stale without anything here failing. Showing a
 * two-week-old slate as if it were today's is the worst outcome, so the age is
 * stated plainly whenever it is not current.
 */
export default function StaleBanner({ freshness }: { freshness?: Freshness | null }) {
  if (!freshness?.is_stale) return null;
  return (
    <div className="card p-3 mb-4 border-amber-300 bg-amber-50">
      <div className="flex items-start gap-2">
        <span className="text-base leading-none">⚠️</span>
        <div>
          <div className="text-xs font-bold text-amber-900">
            Not today’s slate — this board is {freshness.age_days} day
            {freshness.age_days === 1 ? '' : 's'} old
          </div>
          <p className="text-[11px] text-amber-800 mt-0.5">{freshness.message}</p>
          <p className="text-[10px] text-amber-700 mt-1">
            Auto-picks are not locked in for a stale slate, so no bets are recorded on games that
            have already finished.
          </p>
        </div>
      </div>
    </div>
  );
}
