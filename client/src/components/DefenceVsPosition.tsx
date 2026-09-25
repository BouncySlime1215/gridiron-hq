import { useState } from 'react';
import { useApi } from '../api';
import { PageError, PageLoading } from './PageState';
import { Chip } from './ui/DesignSystem';

/**
 * Players → NFL teams → Defence vs position (moved from Trade Lab's Matchups tab: a team stat, not
 * a trade). Points each defence allows to a position, weighted to recent seasons, over players who
 * cleared a startable score.
 */
export default function DefenceVsPosition() {
  const [pos, setPos] = useState('WR');
  const { data, loading, error, refetch } = useApi<any>(`/trades/dvp?position=${pos}`);
  return (
    <section className="ds-card mt-6 p-4" aria-labelledby="dvp-title">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 id="dvp-title" className="ds-h">Defence vs position</h2>
        <div className="flex gap-1.5" role="group" aria-label="Position">
          {['QB', 'RB', 'WR', 'TE'].map(p => <Chip key={p} on={pos === p} onClick={() => setPos(p)}>{p}</Chip>)}
        </div>
        {data && <span className="ds-note ml-auto">from {data.seasons?.join(', ')} boxscores</span>}
      </div>
      {loading && !data && <PageLoading label="Loading matchup history…" />}
      {error && !data && <PageError message={error} onRetry={refetch} />}
      {data && (
        <div className="grid gap-4 md:grid-cols-2">
          {([['Softest defences: target these', 0, 8, true], ['Toughest defences: fade these', -8, undefined, false]] as const).map(([title, from, to, soft]) => {
            const list = to != null ? (data?.table ?? []).slice(from, to) : (data?.table ?? []).slice(from).reverse();
            return (
              <div key={title}>
                <h3 className="mb-1 text-sm font-semibold">{title}</h3>
                <div className="ds-rows">
                  {list.map((d: any) => (
                    <div key={d.opponent} className="flex items-center gap-2 py-1.5 text-xs">
                      <span className="w-10 font-bold">{d.opponent}</span>
                      <span className="tabular-nums text-slate-600">{d.allowed} ppg allowed</span>
                      <span className="text-slate-500">{d.games}g</span>
                      <span className={`ml-auto font-bold tabular-nums ${soft ? 'text-good' : 'text-crit'}`}>
                        {d.mult > 1 ? '+' : ''}{((d.mult - 1) * 100).toFixed(0)}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="ds-note mt-3">Weighted so recent seasons count more, and only over players who cleared a startable score.</p>
    </section>
  );
}
