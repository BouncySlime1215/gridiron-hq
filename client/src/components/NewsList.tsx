import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { sanitizedMessage } from '../lib/errorSanitize';
import { Button, Chip } from './ui/DesignSystem';

/**
 * The one news list (docs/ui/CONSOLIDATION-MAP.md section 6): Players → News, a team page and a
 * player page all render stories through this, so a story looks and behaves the same everywhere.
 * Each story: team, date, importance and source; the headline and body; what it means for the team
 * and for your team when read; "What does this mean?" (POST /news/:id/explain) and, where the page
 * allows it, delete. Pulling news lives in one place, Players → News.
 */
export interface NewsItem {
  id: number; date?: string | null; team_abbr?: string | null; primary_color?: string | null;
  importance?: number | null; source?: string | null; headline: string; body?: string | null;
  ai_analysis?: string | null; fantasy_impact?: string | null;
}

export default function NewsList({ items, onChanged, canDelete = false, max, teamLinks = true }: {
  items: NewsItem[]; onChanged: () => void; canDelete?: boolean; max?: number; teamLinks?: boolean;
}) {
  const shown = max ? items.slice(0, max) : items;
  return (
    <div className="ds-rows" data-testid="news-list">
      {shown.map(n => <Story key={n.id} n={n} onChanged={onChanged} canDelete={canDelete} teamLinks={teamLinks} />)}
    </div>
  );
}

function Story({ n, onChanged, canDelete, teamLinks }: { n: NewsItem; onChanged: () => void; canDelete: boolean; teamLinks: boolean }) {
  const [delErr, setDelErr] = useState<string | null>(null);
  const remove = async () => {
    setDelErr(null);
    try { await api(`/news/${n.id}`, { method: 'DELETE' }); onChanged(); }
    catch (e: any) { setDelErr(sanitizedMessage('NewsList.delete', "Couldn't delete that story", e.message)); }
  };
  return (
    <article className="py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
        {n.team_abbr && (teamLinks
          ? <Link to={`/players/teams/${n.team_abbr}`} className="ds-chip !px-2 font-bold" title={`${n.team_abbr} team page`}>{n.team_abbr}</Link>
          : <Chip>{n.team_abbr}</Chip>)}
        {n.date && <span className="text-slate-500">{n.date}</span>}
        {n.importance === 3 && <Chip tone="bad">Major</Chip>}
        {n.importance === 1 && <span className="text-slate-500">minor</span>}
        {n.source && <span className="min-w-0 truncate text-slate-500">{n.source}</span>}
        {canDelete && (
          <button type="button" className="ds-icon-btn ml-auto !h-7 !w-7 text-slate-500" onClick={remove}
            aria-label={`Delete "${n.headline}"`} title="Delete this story">✕</button>
        )}
      </div>
      <h3 className="mt-1 font-semibold leading-snug">{n.headline}</h3>
      {n.body && <p className="mt-1 text-sm text-slate-600">{n.body}</p>}
      {(n.ai_analysis || n.fantasy_impact) && (
        <div className="mt-2 space-y-2">
          {n.ai_analysis && (
            <div className="border-l-2 border-slate-300 pl-3">
              <div className="ds-note font-semibold">What it means for {n.team_abbr ?? 'the team'}</div>
              <p className="text-sm text-slate-700">{n.ai_analysis}</p>
            </div>
          )}
          {n.fantasy_impact && (
            <div className="border-l-2 border-[var(--c-accent)] pl-3">
              <div className="ds-note font-semibold !text-[var(--c-accent)]">What it means for your team</div>
              <p className="text-sm text-slate-700">{n.fantasy_impact}</p>
            </div>
          )}
        </div>
      )}
      <ExplainButton newsId={n.id} again={!!n.ai_analysis} onDone={onChanged} />
      {delErr && <p className="mt-1 text-xs text-crit">{delErr}</p>}
    </article>
  );
}

/** Per-story "what does this mean" (POST /news/:id/explain). Errors are shown in plain words only (UX-08). */
function ExplainButton({ newsId, again, onDone }: { newsId: number; again: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Button size="sm" variant="quiet" disabled={busy} title={busy ? 'Reading the story' : 'Ask for what this story means for the team and for yours'}
        onClick={async () => {
          setBusy(true); setErr(null);
          try { await api(`/news/${newsId}/explain`, { method: 'POST' }); onDone(); }
          catch (e: any) { setErr(sanitizedMessage('NewsList.ExplainButton', "Couldn't explain that", e.message)); }
          finally { setBusy(false); }
        }}>
        {busy ? 'Reading…' : again ? 'Read it again' : 'What does this mean?'}
      </Button>
      {err && <span className="text-xs text-crit">{err}</span>}
    </div>
  );
}
