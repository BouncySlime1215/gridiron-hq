import { Link } from 'react-router-dom';
import { useLeague } from '../state/league';
import { leagueGate } from '../state/leagueGate';
import { useCoach } from '../state/coach';
import { useWarRoom } from '../components/warroom/useWarRoom';
import TodayPanel from '../components/warroom/TodayPanel';
import CommandCenter from '../components/CommandCenter';
import TodayHeadlines from '../components/TodayHeadlines';
import { Card, EmptyState, PageHeader, Skeleton } from '../components/ui/DesignSystem';
import { PageError, PageLoading } from '../components/PageState';

/**
 * Today (docs/ui/CONSOLIDATION-MAP.md): the one place to start. The next move with its
 * Watching list and season progress (the War Room's Today, inline), then this week's actions
 * across every league (the Command Center that used to top League Hub), then headlines about your
 * players (the three freshest, linked to Players → News).
 */
export default function Today() {
  const { leagues, activeId, active, loading, error, refetch } = useLeague();
  const coach = useCoach();
  const wr = useWarRoom(activeId);
  const gate = leagueGate({ loading, error, leagues });
  if (gate === 'loading') return <PageLoading label="Loading your leagues…" />;
  if (gate === 'error') return <PageError message={error ?? 'Could not load your leagues.'} onRetry={refetch} />;
  if (gate === 'empty') {
    return <div className="max-w-lg"><PageHeader eyebrow="Today" title="Today" />
      <EmptyState icon="house" title="Connect a league" description="Connect a league and Today fills with your next move and what each league needs this week."
        action={<Link to="/league" className="btn-primary inline-block">Connect a league</Link>} /></div>;
  }
  return (
    <div>
      <PageHeader eyebrow="Today" title="Today" description={active?.name?.trim() ? `Your next move in ${active.name.trim()}, and what every league needs this week.` : undefined} />
      {wr.data?.enabled === true && activeId != null && (
        <div className="mb-8"><TodayPanel view={wr.data} leagueId={activeId} onAsk={coach.open} /></div>
      )}
      {/* The plans take a few seconds after a server restart: hold the hero's place at its final
          height so it does not pop in above the week's actions. */}
      {activeId != null && wr.loading && !wr.data && <TodaySkeleton />}
      <CommandCenter />
      {/* Last, so a late answer only extends the page and never pushes the week's actions down. */}
      <div className="mt-8"><TodayHeadlines /></div>
    </div>
  );
}

/** "Do this now" and the Watching / season rows, as placeholders at the size they arrive at (ui.css .today-skel). */
function TodaySkeleton() {
  return (
    <div className="today-skel mb-8" aria-busy="true" aria-label="Loading your next move" data-testid="today-skeleton">
      <Card className="today-skel-hero">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-4 h-8 w-3/4" />
        <Skeleton className="mt-3 h-4 w-full max-w-xl" />
        <Skeleton className="mt-2 h-4 w-2/3 max-w-md" />
        <div className="mt-6 flex gap-3"><Skeleton className="h-10 w-36 !rounded-full" /><Skeleton className="h-10 w-28 !rounded-full" /></div>
      </Card>
      <div className="today-skel-rows">
        <Card><Skeleton className="h-4 w-28" /><Skeleton className="mt-4 h-4 w-full" /><Skeleton className="mt-2 h-4 w-5/6" /></Card>
        <Card><Skeleton className="h-4 w-28" /><Skeleton className="mt-4 h-4 w-full" /><Skeleton className="mt-2 h-4 w-4/6" /></Card>
      </div>
    </div>
  );
}
