import { Link } from 'react-router-dom';
import { useApi } from '../api';
import { Card, Chip } from './ui/DesignSystem';
import { SIGNAL_CHIP, SIGNAL_LABEL, freshestHeadlines, type NewsSignal } from '../features/news/signalLabels';

/**
 * Today → "Your players' headlines": the three freshest checked news items about players on your
 * rosters (GET /news/signals, scoped to your rosters by the server), with a link to Players → News.
 * Drawn only when the feed is scoped to your players; nothing when there is no news for them.
 */
export default function TodayHeadlines() {
  const { data } = useApi<{ scope: string; signals: NewsSignal[] }>('/news/signals');
  if (!data || data.scope !== 'my_roster') return null;
  const top = freshestHeadlines(data.signals, 3);
  if (!top.length) return null;
  return (
    <section aria-labelledby="today-headlines-h" data-testid="today-headlines">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id="today-headlines-h" className="text-base font-semibold">Your players' headlines</h2>
        <Link to="/players?view=news" className="text-sm font-semibold text-[var(--c-accent)] hover:underline">All news</Link>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {top.map(s => (
          <Card key={`${s.player_name}-${s.status}`} className="!p-4" as="article">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 break-words font-semibold">{s.player_name}</span>
              {s.team && <span className="ds-note">{s.team}</span>}
              <Chip tone={SIGNAL_CHIP[s.status] ?? 'neutral'}>{SIGNAL_LABEL[s.status] ?? s.status.replace(/_/g, ' ')}</Chip>
            </div>
            {/* The story's own headline; the checked quote ("ruled out") is the proof under it. */}
            {s.story_headline && <p className="mt-2 line-clamp-3 break-words text-sm">{s.story_headline}</p>}
            {s.evidence_span && <p className="ds-note mt-1 break-words italic">“{s.evidence_span}”</p>}
            <p className="ds-note mt-2">{[s.source, s.published_at?.slice(0, 10)].filter(Boolean).join(' · ')}
              {s.story_url && /^https?:\/\//.test(s.story_url) && <> · <a href={s.story_url} target="_blank" rel="noreferrer" className="text-[var(--c-accent)] hover:underline">story</a></>}</p>
          </Card>
        ))}
      </div>
    </section>
  );
}
