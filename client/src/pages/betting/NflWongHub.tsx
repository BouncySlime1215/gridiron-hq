import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, useApi } from '../../api';
import { BettingWorkspace, WorkspaceNav } from '../../components/betting/BettingWorkspace';
import { usePageExplain } from '../../components/betting/PageExplainContext';
import { TeamIndexProvider } from '../../components/betting/wong/TeamLogo';
import { WongBoard } from '../../components/betting/wong/WongBoard';
import { WongRecommendedSet } from '../../components/betting/wong/WongRecommendedSet';
import { WongSeasonView } from '../../components/betting/wong/WongSeason';
import { WongSettingsView } from '../../components/betting/wong/WongSettings';
import { BackendNotReady, Loading } from '../../components/betting/wong/shared';
import { dollars } from '../../components/betting/wong/format';
import type {
  WongBoard as Board, WongCapture, WongRefresh, WongSeason, WongSettings
} from '../../components/betting/wong/types';

type View = 'board' | 'set' | 'season' | 'settings';

const DEFAULT_BOOKS = ['draftkings', 'fanduel', 'pinnacle'];

/** The NFL year rolls over in March, not in January. */
function currentSeason(now = new Date()) {
  return now.getMonth() >= 2 ? now.getFullYear() : now.getFullYear() - 1;
}

/**
 * NFL Wong.
 *
 * One hub for the only structurally +EV NFL bet this database can defend: the
 * 6-point teaser through the key numbers. It pulls the week's qualifying legs
 * from several books on demand, compares them side by side with the age and
 * the provenance of every quote attached, lets a ticket be taken in one
 * click, and then tracks the whole season honestly — including the version of
 * the projection that admits the leg rate itself is an estimate.
 *
 * What it deliberately does not do is rank legs. About 4,600 tests found
 * nothing that separates one qualifying leg from another, so there is no
 * confidence score anywhere on this hub; the only real difference between two
 * legs is push exposure, which is read off the teased number itself.
 */
export default function NflWongHub({ initialView = 'board' }: { initialView?: View }) {
  const [view, setView] = useState<View>(initialView);
  const [stakeUnits, setStakeUnits] = useState(1);
  const season = currentSeason();

  const settingsApi = useApi<WongSettings>('/betting/wong/settings');
  const books = useMemo(() => {
    const configured = settingsApi.data?.books;
    return Array.isArray(configured) && configured.length ? configured : DEFAULT_BOOKS;
  }, [settingsApi.data]);

  const boardPath = `/betting/wong/board?books=${encodeURIComponent(books.join(','))}`;
  const boardApi = useApi<Board>(boardPath);
  const seasonApi = useApi<WongSeason>(`/betting/wong/season?season=${season}`);

  // A manual pull answers with the rebuilt board, so it is shown immediately
  // rather than waiting on a second GET. It is dropped whenever the book set
  // changes, since it belongs to the old query.
  const [pulled, setPulled] = useState<Board | null>(null);
  const [captures, setCaptures] = useState<WongCapture[] | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  useEffect(() => { setPulled(null); setCaptures(null); }, [boardPath]);

  const board = pulled ?? boardApi.data;
  const unitSizeDollars = typeof settingsApi.data?.unit_size_dollars === 'number'
    ? settingsApi.data.unit_size_dollars : null;

  const refresh = useCallback(async () => {
    setRefreshing(true); setRefreshError(null);
    try {
      const result = await api<WongRefresh>('/betting/wong/refresh', {
        method: 'POST', body: JSON.stringify({ books })
      });
      setCaptures(result.captures ?? null);
      setRefreshedAt(result.refreshed_at ?? new Date().toISOString());
      if (result.board) setPulled(result.board);
      else await boardApi.refetch();
    } catch (reason: any) {
      setRefreshError(reason?.message ?? 'The refresh failed.');
    } finally { setRefreshing(false); }
  }, [books, boardApi]);

  const tickets = seasonApi.data?.tickets ?? [];
  const openTickets = tickets.filter(ticket => {
    const status = String(ticket.status ?? ticket.result ?? 'open').toLowerCase();
    return !status || status === 'open' || status === 'pending';
  }).length;
  const ticketsOnBoard = (board?.books ?? []).reduce((sum, entry) => sum + (entry.candidates?.length ?? 0), 0);

  usePageExplain('NFL Wong', view, {
    books: books.join(','),
    tickets_on_board: ticketsOnBoard,
    tickets_taken_this_season: tickets.length,
    open_tickets: openTickets,
    unit_size_dollars: unitSizeDollars,
    backend_ready: !!board
  });

  const boardEndpoints = [
    `GET /api/betting/wong/board?books=${books.join(',')}`,
    'POST /api/betting/wong/refresh'
  ];

  return <TeamIndexProvider>
    <BettingWorkspace
      sport="nfl"
      title="NFL Wong"
      description="Six-point teasers through 3 and 7 — the one NFL bet here whose edge comes from the payout structure rather than from out-predicting the market. Pulled from several books on demand, compared with the age and the source of every quote attached, and tracked for the whole season."
      activeStage={view === 'board' ? 'price' : view === 'set' ? 'review' : view === 'season' ? 'track' : 'scan'}
      actions={<span className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold text-slate-100">
        {unitSizeDollars != null ? `1 unit = ${dollars(unitSizeDollars)}` : 'Unit size not set'}
      </span>}
    >
      <WorkspaceNav value={view} onChange={setView} items={[
        { id: 'board', label: 'This week', detail: 'Qualifying legs, every book', count: ticketsOnBoard || undefined },
        { id: 'set', label: 'Recommended set', detail: 'Non-overlapping tickets' },
        { id: 'season', label: 'Season tracker', detail: 'Record, pace, projection', count: openTickets || undefined },
        { id: 'settings', label: 'Staking', detail: 'Unit size, books, caps' }
      ]} />

      {view === 'board' && (
        boardApi.loading && !board ? <Loading label="Reading this week's captured board…" />
          : !board ? <BackendNotReady error={boardApi.error} endpoints={boardEndpoints} onRetry={boardApi.refetch} />
          : <WongBoard
              board={board} refreshing={refreshing} onRefresh={refresh}
              captures={captures} refreshedAt={refreshedAt} refreshError={refreshError}
              stakeUnits={stakeUnits} onStakeChange={setStakeUnits}
              unitSizeDollars={unitSizeDollars} onTracked={seasonApi.refetch} />
      )}

      {view === 'set' && <WongRecommendedSet
        books={books}
        maxTickets={settingsApi.data?.max_tickets_per_week ?? 4}
        stakeUnits={stakeUnits} unitSizeDollars={unitSizeDollars}
        onTracked={seasonApi.refetch} />}

      {view === 'season' && (
        seasonApi.loading && !seasonApi.data ? <Loading label="Reading the season ledger…" />
          : !seasonApi.data ? <BackendNotReady error={seasonApi.error} onRetry={seasonApi.refetch}
              endpoints={[`GET /api/betting/wong/season?season=${season}`, 'POST /api/betting/wong/tickets', 'POST /api/betting/wong/tickets/:id/settle']} />
          : <WongSeasonView season={seasonApi.data} unitSizeDollars={unitSizeDollars} onChanged={seasonApi.refetch} />
      )}

      {view === 'settings' && (
        settingsApi.loading && !settingsApi.data ? <Loading label="Reading your staking settings…" />
          : !settingsApi.data ? <BackendNotReady error={settingsApi.error} onRetry={settingsApi.refetch}
              endpoints={['GET /api/betting/wong/settings', 'PUT /api/betting/wong/settings']} />
          : <WongSettingsView settings={settingsApi.data} onSaved={settingsApi.refetch} />
      )}
    </BettingWorkspace>
  </TeamIndexProvider>;
}
