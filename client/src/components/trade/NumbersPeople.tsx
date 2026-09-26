import { useCallback, useEffect, useState } from 'react';
import { api, useApi } from '../../api';
import { Button, Card, EmptyState, ErrorState, Section, Skeleton } from '../ui/DesignSystem';
import { useHeadshotMap } from '../warroom/useWarRoom';
import NumbersPeopleCard, { type NPItem } from './NumbersPeopleCard';
import { Scoreboard, Timeline, type NPScoreboard } from './numbersPeopleParts';
import { BudgetLink } from '../settings/spendLinks';

/**
 * Trades → Numbers & People (NUMBERS-PEOPLE): what Coach's two lanes think of the plan's key items
 * right now, and how that moves. Numbers reads only the plan; People adds the stored chat reads
 * (ungraded). The server reads both lanes once per refresh window and stores them
 * (services/numbers-people); this view shows the stored reads, DIFFER first. Refresh asks both
 * lanes again now. A refresh the daily AI allowance stops shows the last reads and says so.
 */
interface NPView {
  enabled: boolean; status: 'ok' | 'empty' | 'off'; refreshing?: boolean; read_at?: string; week?: number | null; stale?: boolean;
  notice?: { kind: 'budget' | 'failed'; text: string; at: string } | null;
  summary?: { agree: number; differ: number; same_but: number; no_people_read: number; both_go: number; split: number; both_wait: number; both_avoid: number } | null;
  items: NPItem[]; scoreboard?: NPScoreboard | null; run?: { status: string };
}

const POLL_MS = 8000;
/** Cards shown before "Show all": the list is best first (server order.js), so the fold keeps the best. */
const FIRST = 4;
const timeText = (iso?: string) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '');

function Thinking({ label }: { label: string }) {
  return (
    <div className="wr-thinking" role="status" aria-live="polite" data-testid="np-thinking">
      <span className="wr-think-line">{label}<span className="wr-dots3" aria-hidden><i /><i /><i /></span></span>
    </div>
  );
}

export default function NumbersPeople({ leagueId, onAsk }: { leagueId: number; onAsk: (question?: string) => void }) {
  const path = `/numbers-people/${leagueId}`;
  const res = useApi<NPView>(path);
  const [fresh, setFresh] = useState<NPView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const headshots = useHeadshotMap();
  useEffect(() => { setFresh(null); }, [leagueId]);
  const view = fresh ?? res.data;

  // A background run the view started: look again until it lands.
  const { refetch } = res;
  useEffect(() => {
    if (!view?.refreshing || busy) return;
    const t = setTimeout(() => { setFresh(null); void refetch(); }, POLL_MS);
    return () => clearTimeout(t);
  }, [view?.refreshing, busy, refetch]);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setFresh(await api<NPView>(`/numbers-people/${leagueId}/refresh`, { method: 'POST' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [leagueId]);

  const ask = useCallback(async (item: NPItem) => {
    const move = item.item_type === 'move' ? item.item_id : null;
    try {
      await api(`/coach/thread/${leagueId}/focus`, { method: 'POST', body: JSON.stringify({
        move_id: move, partner: item.partner ?? (item.item_type === 'partner' ? item.item_id : null), players: item.players.map(p => p.id) }) });
    } catch (e) {
      setError(`Coach could not put this item in focus: ${e instanceof Error ? e.message : String(e)}`);
    }
    onAsk(item.verdict === 'differ'
      ? `Claude and Jev disagree on ${item.title}. Which read should I trust, and what would change it?`
      : `What should I do about ${item.title}, and what could change the call?`);
  }, [leagueId, onAsk]);

  if (res.loading && !view) {
    return <div className="space-y-3" aria-busy="true"><Skeleton className="h-[88px] w-full !rounded-[var(--r-card)]" /><Skeleton className="h-[220px] w-full !rounded-[var(--r-card)]" /></div>;
  }
  if (res.error && !view) return <ErrorState message={res.error} retry={() => res.refetch()} />;
  if (!view) return null;
  if (!view.enabled) return <EmptyState title="Numbers & People is off" description="Claude's and Jev's reads are turned off on this server." />;

  const s = view.summary;
  const shown = FIRST;
  const refreshButton = (
    <Button icon="refresh" onClick={refresh} disabled={busy} title={busy ? 'Claude and Jev are reading the plan' : 'Ask Claude and Jev again now'}>
      {busy ? 'Reading…' : 'Refresh'}
    </Button>
  );

  return (
    <div className="space-y-5" data-testid="numbers-people">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {s
              ? <h2 className="text-base font-semibold" data-testid="np-summary">Both say go on {s.both_go} · Split on {s.split} · Both say avoid on {s.both_avoid}</h2>
              : <h2 className="text-base font-semibold">No reads yet</h2>}
            <p className="ds-note">
              {view.read_at ? `Read ${timeText(view.read_at)}${view.week ? ` · week ${view.week}` : ''}` : 'Claude and Jev read the plan\'s key moves, targets and league-mates.'}
              {s?.both_wait ? ` · ${s.both_wait} both say wait` : ''}
              {s?.no_people_read ? ` · ${s.no_people_read} with no chat read` : ''}
            </p>
            <p className="ds-note">Claude reads the plan's numbers. Jev takes Claude's read and weighs what the chat says about each league-mate (ungraded).</p>
          </div>
          {refreshButton}
        </div>
        {(busy || view.refreshing) && <div className="mt-3"><Thinking label="Claude and Jev are reading the plan" /></div>}
      </Card>

      {view.notice && <Card tone="warn"><p className="text-sm" data-testid="np-notice">{view.notice.text}
        {view.notice.kind === 'budget' && <> <BudgetLink budgetKey="numbers_people" /></>}</p></Card>}
      {error && <ErrorState title="Refresh did not finish" message={error} />}

      {view.status === 'empty' && !busy && !view.refreshing && (
        <EmptyState title="No reads yet" description="Refresh asks Claude and Jev about the plan's key items." action={refreshButton} />
      )}

      {!!view.items.length && (
        <Section title="Right now" description="Best first: both say go at the top, both say avoid at the bottom.">
          <div className="grid gap-3 lg:grid-cols-2">
            {view.items.slice(0, all ? undefined : shown).map(item => <NumbersPeopleCard key={item.key} item={item} variant="full" headshots={headshots} onAsk={ask} />)}
          </div>
          {!all && view.items.length > shown && (
            <div className="mt-3 flex justify-center">
              <Button onClick={() => setAll(true)}>Show all {view.items.length}</Button>
            </div>
          )}
        </Section>
      )}

      {!!view.items.length && (
        <Section title="Going forward" description="How each call changes week to week, and which one was right when they split.">
          <div className="space-y-3">
            <Scoreboard board={view.scoreboard ?? null} />
            <Timeline items={view.items} />
          </div>
        </Section>
      )}
    </div>
  );
}
