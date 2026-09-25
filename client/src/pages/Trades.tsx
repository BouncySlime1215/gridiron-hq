import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../api';
import { useLeague } from '../state/league';
import { usePageExplain } from '../components/PageExplainContext';
import { PageLoading, PageError, EmptyState } from '../components/PageState';
import { Chip, PageHeader, Tabs } from '../components/ui/DesignSystem';
import WarRoomV2 from '../components/warroom/WarRoomV2';
import { useWarRoom } from '../components/warroom/useWarRoom';
import ManagerBoard from '../components/brain/ManagerBoard';
import ProposalSlate from '../components/brain/ProposalSlate';
import PulseTicker from '../components/brain/PulseTicker';
import type { ProfilesResponse, SignalsResponse } from '../components/brain/types';
import { FindDeals, MockTrade, TargetMany, TargetPlayer, TitleTrades, TradeDeskHeader, useTradeDesk } from './TradeLab';

/**
 * Trades (docs/ui/CONSOLIDATION-MAP.md, area 7): one trade area.
 *   Next move  the War Room planner (the plans contract): today's move, Go get, Market and League
 *              screens, full screen as before. It is the source of the next move.
 *   Go get     name one player, or several, and get the packages that land them.
 *   Find deals every realistic trade, ranked overall or by title impact (the same finder).
 *   Build      any two-sided deal, evaluated.
 *   People     who trades with you (the chat pulse, your read beside the measured one) and
 *              "Write proposals" (paid, on request).
 * Every suggestion comes from the server after RULES-EVERYWHERE's gate; each list says how many
 * ideas your rules hid (components/trade/RulesHidden). Trade Lab's tab strip, Trade Brain's tabs and
 * the classic War Room dashboard are gone; their old URLs redirect here.
 */
type View = 'planner' | 'goget' | 'find' | 'build' | 'people';
const VIEWS: { id: View; label: string }[] = [
  { id: 'planner', label: 'Next move' }, { id: 'goget', label: 'Go get' }, { id: 'find', label: 'Find deals' },
  { id: 'build', label: 'Build' }, { id: 'people', label: 'People' }
];
// Old ?view= values from Trade Brain and Trade Lab land on their new homes.
const LEGACY: Record<string, View> = {
  'war-room': 'planner', managers: 'people', proposals: 'people', target: 'goget', targetMany: 'goget',
  title: 'find', mock: 'build'
};
const viewOf = (v: string | null): View | null => (v && (VIEWS.some(x => x.id === v) ? v as View : LEGACY[v])) || null;

export default function Trades() {
  const { leagues, activeId, active, setActiveId, loading: leaguesLoading, error: leaguesError, refetch: refetchLeagues } = useLeague();
  const [params, setParams] = useSearchParams();
  const warRoom = useWarRoom(activeId);
  const warOn = warRoom.data?.enabled === true;
  const asked = viewOf(params.get('view'));
  // The planner is the default when it is on; asking for it while it is off lands on Find deals.
  const view: View = asked === 'planner' ? (warOn || warRoom.loading ? 'planner' : 'find') : asked ?? (warOn ? 'planner' : 'find');
  const setView = (v: View) => setParams(() => new URLSearchParams(`view=${v}`), { replace: true });
  const [goGetMany, setGoGetMany] = useState(false);
  const [byTitle, setByTitle] = useState(params.get('view') === 'title');
  const desk = useTradeDesk();

  // Two independent requests on the People view: the measured signal layer may not exist on this
  // server, and the hand-set tiers always work; neither holds the other hostage.
  const signals = useApi<SignalsResponse>(activeId && view === 'people' ? `/trades/${activeId}/managers/signals` : null);
  const profiles = useApi<ProfilesResponse>(activeId && view === 'people' ? `/trades/${activeId}/brain/managers` : null);

  usePageExplain('trades', view, {
    view, league: active?.name ?? null, planner_on: warOn, team_selected: !!desk.me,
    untouchable_count: desk.untouchable.length, proposals: 'written on request only'
  });

  if (leaguesLoading && !leagues.length) return <PageLoading label="Loading your leagues…" />;
  if (leaguesError && !leagues.length) return <PageError message={leaguesError} onRetry={refetchLeagues} />;
  if (!leagues.length) {
    return <div className="max-w-lg"><PageHeader eyebrow="Trades" title="Trades" />
      <EmptyState title="Connect a league to start trading" description="Trades needs a synced league: rosters to price, partners to read, a plan to follow."
        actionLabel="Connect a league" actionTo="/league?view=leagues" /></div>;
  }

  // The planner draws full screen, as the War Room always has; its menu returns to People.
  if (view === 'planner' && warOn && activeId && warRoom.data) {
    return <WarRoomV2 view={warRoom.data} activeId={activeId} onLeague={setActiveId} onExit={() => setView('people')}
      leagues={leagues.map(l => ({ id: l.id, name: l.name }))} />;
  }

  const tools = view === 'goget' || view === 'find' || view === 'build';
  const ready = !!desk.active && !!desk.rosters?.teams?.length;
  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader eyebrow="Trades" title="Trades" description="The planner's next move, the players you want, every realistic deal, and the people on the other side." />
      <div className="mb-5 ds-tabs-wrap"><Tabs label="Trades views" value={view} onChange={setView} tabs={VIEWS} /></div>

      {view === 'planner' && (warRoom.loading ? <PageLoading label="Loading the planner…" />
        : warRoom.error ? <PageError message={warRoom.error} onRetry={warRoom.refetch} />
        : <EmptyState title="The planner is off for this league" description="Find deals, Go get and People still work." actionLabel="Find deals" onAction={() => setView('find')} />)}

      {tools && <>
        <TradeDeskHeader desk={desk} />
        {desk.active && !desk.rosters && desk.rostersLoading && <PageLoading label="Loading your roster…" />}
        {desk.active && !desk.rosters && !desk.rostersLoading && desk.rostersError && <PageError message={desk.rostersError} onRetry={desk.refetchRosters} />}
        {desk.active && desk.rosters && !desk.rosters.teams?.length && (
          <EmptyState title="No rosters found for this league" description="Sync it in League → Your leagues, then come back." actionLabel="Your leagues" actionTo="/league?view=leagues" />
        )}
      </>}

      {view === 'goget' && ready && <>
        <div className="mb-3 flex gap-1.5" role="group" aria-label="How many targets">
          <Chip on={!goGetMany} onClick={() => setGoGetMany(false)}>One player</Chip>
          <Chip on={goGetMany} onClick={() => setGoGetMany(true)}>Several players</Chip>
        </div>
        {goGetMany
          ? <TargetMany leagueId={desk.active!} teamId={desk.me} rosters={desk.rosters} untouchable={desk.untouchable} untouchableNames={desk.untouchableNames} />
          : <TargetPlayer leagueId={desk.active!} teamId={desk.me} rosters={desk.rosters} untouchable={desk.untouchable} untouchableNames={desk.untouchableNames} />}
      </>}

      {view === 'find' && ready && <>
        <div className="mb-3 flex gap-1.5" role="group" aria-label="Rank deals by">
          <Chip on={!byTitle} onClick={() => setByTitle(false)}>Best overall</Chip>
          <Chip on={byTitle} onClick={() => setByTitle(true)}>Title impact</Chip>
        </div>
        {byTitle
          ? <TitleTrades leagueId={desk.active!} teamId={desk.me} />
          : <FindDeals leagueId={desk.active!} teamId={desk.me} rosters={desk.rosters} untouchable={desk.untouchable} untouchableNames={desk.untouchableNames} />}
      </>}

      {view === 'build' && ready && (
        <MockTrade leagueId={desk.active!} teamId={desk.me} rosters={desk.rosters} untouchable={desk.untouchable} untouchableNames={desk.untouchableNames} />
      )}

      {view === 'people' && activeId && <div className="space-y-5">
        <PulseTicker leagueId={activeId} />
        <ManagerBoard leagueId={activeId} profiles={profiles} signals={signals} />
        <ProposalSlate leagueId={activeId} />
      </div>}
    </div>
  );
}
