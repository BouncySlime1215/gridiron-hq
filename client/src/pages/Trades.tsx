import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../api';
import { useLeague } from '../state/league';
import { usePageExplain } from '../components/PageExplainContext';
import { PageLoading, PageError, EmptyState } from '../components/PageState';
import { Chip, PageHeader, Tabs } from '../components/ui/DesignSystem';
import TradesPlanner from '../components/warroom/TradesPlanner';
import { useCoach } from '../state/coach';
import { useWarRoom } from '../components/warroom/useWarRoom';
import ManagerBoard from '../components/brain/ManagerBoard';
import ProposalSlate from '../components/brain/ProposalSlate';
import NewsEdge from '../components/trade/NewsEdge';
import NumbersPeople from '../components/trade/NumbersPeople';
import OfferBudgetLine from '../components/brain/OfferBudgetLine';
import { teamLabelIn } from '../components/warroom/types';
import { isOk } from '../components/warroom/format';
import type { ProfilesResponse, SignalsResponse } from '../components/brain/types';
import { FindDeals, MockTrade, TargetMany, TargetPlayer, TitleTrades, TradeDeskHeader, useTradeDesk } from './TradeLab';

/**
 * Trades (docs/ui/CONSOLIDATION-MAP.md, area 7): one trade area.
 *   Next move  the War Room planner's next-move deck (the plans contract): the source of the next move.
 *   Go get     name one player, or several, and get the packages that land them.
 *   Find deals every realistic trade, ranked overall or by title impact (the same finder).
 *   Build      any two-sided deal, evaluated.
 *   People     who trades with you (the chat pulse, your read beside the measured one) and
 *              "Write proposals" (paid, on request).
 *   News edge  news the league has not priced in yet, as moves (every idea through the rule gate).
 *   Numbers & People  Coach's two lanes (numbers; numbers + stored chat reads) on the plan's key items:
 *              agree / differ / same call for different reasons, now and week by week.
 * The planner's screens draw inside this frame (components/warroom/TradesPlanner): one header, one
 * tab row, the app-wide Coach. Market is Find deals → Flips; League is the League area.
 * Every suggestion comes from the server after RULES-EVERYWHERE's gate; each list says how many
 * ideas your rules hid (components/trade/RulesHidden). Trade Lab's tab strip, Trade Brain's tabs and
 * the classic War Room dashboard are gone; their old URLs redirect here.
 */
type View = 'planner' | 'goget' | 'find' | 'build' | 'people' | 'np' | 'news';
const VIEWS: { id: View; label: string }[] = [
  { id: 'planner', label: 'Next move' }, { id: 'goget', label: 'Go get' }, { id: 'find', label: 'Find deals' },
  { id: 'build', label: 'Build' }, { id: 'people', label: 'People' }, { id: 'np', label: 'Numbers & People' }, { id: 'news', label: 'News edge' }
];
// Old ?view= values from Trade Brain and Trade Lab land on their new homes.
const LEGACY: Record<string, View> = {
  'war-room': 'planner', managers: 'people', proposals: 'people', target: 'goget', targetMany: 'goget',
  title: 'find', mock: 'build', 'news-edge': 'news'
};
const viewOf = (v: string | null): View | null => (v && (VIEWS.some(x => x.id === v) ? v as View : LEGACY[v])) || null;

export default function Trades() {
  const { leagues, activeId, active, loading: leaguesLoading, error: leaguesError, refetch: refetchLeagues } = useLeague();
  const coach = useCoach();
  const [params, setParams] = useSearchParams();
  const warRoom = useWarRoom(activeId);
  const warOn = warRoom.data?.enabled === true;
  const asked = viewOf(params.get('view'));
  // The planner is the default when it is on; asking for it while it is off lands on Find deals.
  const view: View = asked === 'planner' ? (warOn || warRoom.loading ? 'planner' : 'find') : asked ?? (warOn ? 'planner' : 'find');
  const setView = (v: View) => setParams(() => new URLSearchParams(`view=${v}`), { replace: true });
  const [goGetMany, setGoGetMany] = useState(false);
  const [rank, setRank] = useState<'best' | 'title' | 'flips'>(params.get('view') === 'title' ? 'title' : 'best');
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

  const tools = view === 'goget' || view === 'find' || view === 'build';
  const ready = !!desk.active && !!desk.rosters?.teams?.length;
  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader eyebrow="Trades" title="Trades" actions={<TradeDeskHeader desk={desk} />} />
      <div className="mb-5"><Tabs label="Trades views" value={view} onChange={setView} tabs={VIEWS} /></div>

      {view === 'planner' && (warOn && activeId && warRoom.data
        ? <TradesPlanner part="next" view={warRoom.data} leagueId={activeId} onAsk={coach.open} />
        : warRoom.loading ? <PageLoading label="Loading the planner…" />
        : warRoom.error ? <PageError message={warRoom.error} onRetry={warRoom.refetch} />
        : <EmptyState title="The planner is off for this league" description="Find deals, Go get and People still work." actionLabel="Find deals" onAction={() => setView('find')} />)}

      {tools && <>
        {desk.active && !desk.rosters && desk.rostersLoading && <PageLoading label="Loading your roster…" />}
        {desk.active && !desk.rosters && !desk.rostersLoading && desk.rostersError && <PageError message={desk.rostersError} onRetry={desk.refetchRosters} />}
        {desk.active && desk.rosters && !desk.rosters.teams?.length && (
          <EmptyState title="No rosters found for this league" description="Sync it in League → Your leagues, then come back." actionLabel="Your leagues" actionTo="/league?view=leagues" />
        )}
      </>}

      {view === 'goget' && ready && (() => {
        // "Someone else": the name search (one or several players) closes the planner's target list.
        const someoneElse = <>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">Someone else?</h3>
            <div className="flex gap-1.5" role="group" aria-label="How many targets">
              <Chip on={!goGetMany} onClick={() => setGoGetMany(false)}>One player</Chip>
              <Chip on={goGetMany} onClick={() => setGoGetMany(true)}>Several players</Chip>
            </div>
          </div>
          {goGetMany
            ? <TargetMany leagueId={desk.active!} teamId={desk.me} rosters={desk.rosters} untouchable={desk.untouchable} untouchableNames={desk.untouchableNames} />
            : <TargetPlayer leagueId={desk.active!} teamId={desk.me} rosters={desk.rosters} untouchable={desk.untouchable} untouchableNames={desk.untouchableNames} />}
        </>;
        return warOn && activeId && warRoom.data
          ? <TradesPlanner part="goget" view={warRoom.data} leagueId={activeId} onAsk={coach.open} someoneElse={someoneElse} />
          : someoneElse;
      })()}

      {view === 'find' && ready && (() => {
        const controls = (
          <div className="ds-tabs" role="tablist" aria-label="Rank deals by">
            {([['best', 'Best overall'], ['title', 'Title impact'], ...(warOn ? [['flips', 'Flips']] : [])] as [typeof rank, string][]).map(([id, label]) => (
              <button key={id} type="button" role="tab" className="ds-tab" aria-selected={rank === id} onClick={() => setRank(id)}>{label}</button>
            ))}
          </div>
        );
        if (rank === 'title') return <TitleTrades leagueId={desk.active!} teamId={desk.me} controls={controls} />;
        if (rank === 'flips' && warOn && activeId && warRoom.data) return <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs" data-testid="find-controls">{controls}</div>
          <TradesPlanner part="market" view={warRoom.data} leagueId={activeId} onAsk={coach.open} />
        </>;
        return <FindDeals leagueId={desk.active!} teamId={desk.me} rosters={desk.rosters} untouchable={desk.untouchable}
          untouchableNames={desk.untouchableNames} controls={controls} onGoGet={() => setView('goget')} />;
      })()}

      {view === 'build' && ready && (
        <MockTrade leagueId={desk.active!} teamId={desk.me} rosters={desk.rosters} untouchable={desk.untouchable} untouchableNames={desk.untouchableNames} />
      )}

      {view === 'news' && activeId && <NewsEdge leagueId={activeId} teamId={desk.me} />}

      {view === 'np' && activeId && <NumbersPeople leagueId={activeId} onAsk={coach.open} />}

      {view === 'people' && activeId && <div className="space-y-5">
        <OfferBudgetLine view={warOn ? warRoom.data : null}
          nameOf={team => teamLabelIn(isOk(warRoom.data?.teams) ? warRoom.data!.teams!.value : null, team)} />
        <ManagerBoard leagueId={activeId} profiles={profiles} signals={signals} />
        <ProposalSlate leagueId={activeId} />
      </div>}
    </div>
  );
}
