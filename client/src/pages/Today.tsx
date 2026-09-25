import { Link } from 'react-router-dom';
import { useLeague } from '../state/league';
import { leagueGate } from '../state/leagueGate';
import { useCoach } from '../state/coach';
import { useWarRoom } from '../components/warroom/useWarRoom';
import TodayPanel from '../components/warroom/TodayPanel';
import CommandCenter from '../components/CommandCenter';
import { EmptyState, PageHeader } from '../components/ui/DesignSystem';
import { PageError, PageLoading } from '../components/PageState';

/**
 * Today (docs/ui/CONSOLIDATION-MAP.md): the one place to start. The next move with its
 * Watching list and season progress (the War Room's Today, inline), then this week's
 * actions across every league (the Command Center that used to top League Hub).
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
      <PageHeader eyebrow="Today" title="Today" description={active?.name ? `Your next move in ${active.name}, and what every league needs this week.` : undefined} />
      {wr.data?.enabled === true && activeId != null && (
        <div className="mb-8"><TodayPanel view={wr.data} leagueId={activeId} onAsk={coach.open} /></div>
      )}
      <CommandCenter />
    </div>
  );
}
