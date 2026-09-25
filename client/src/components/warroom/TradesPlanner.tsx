import { useCallback, useMemo, type ReactNode } from 'react';
import './warroom.css';
import './warroom-v2.css';
import { setTeamNames, type WarRoomView } from './types';
import { isOk } from './format';
import { SourcesContext } from './FieldState';
import { PanelBoundary } from './Panel';
import NextMoveDeck from './NextMoveDeck';
import ScreenGoGet from './ScreenGoGet';
import ScreenMarket from './ScreenMarket';
import { useNegotiations, usePlayerHeadshots } from './useWarRoom';
import { HeadshotContext } from './Avatar';
import { FIXED_QUESTIONS } from './coach/CoachDrawer';
import { postWarRoomRequest, type WarRoomRequest } from './requests';

/**
 * The War Room planner's content inside the Trades frame (like Today's TodayPanel): no War Room top
 * bar, tabs, health chip or second Coach. The app's header, Trades' one tab row and the app-wide
 * Coach (onAsk) are the frame. Same view (the plans contract), same deck, same posts.
 *   'next'    the next-move deck (hero card, pager, closest misses)
 *   'goget'   pick who to go get → paths → the offer; `someoneElse` closes the target list
 *   'market'  the flip map (buy from → sell to), shown inside Find deals
 */
export default function TradesPlanner({ part, view, leagueId, onAsk, someoneElse }: {
  part: 'next' | 'goget' | 'market'; view: WarRoomView; leagueId: number;
  onAsk: (question?: string) => void; someoneElse?: ReactNode;
}) {
  setTeamNames(isOk(view.teams) ? view.teams.value : null);
  const negotiations = useNegotiations(leagueId);
  const players = usePlayerHeadshots();
  const headshots = useMemo(() => {
    const out: Record<string, string> = {};
    // ESPN has no headshot for a negative (team defence) id; those get initials without a failed request.
    for (const p of players.data ?? []) if (p.headshot && !/\/-\d+\.png$/.test(p.headshot)) out[String(p.id)] = p.headshot;
    return out;
  }, [players.data]);
  const send = useCallback((req: WarRoomRequest) => postWarRoomRequest(leagueId, req), [leagueId]);

  return (
    <SourcesContext.Provider value={view.sources ?? {}}>
      <HeadshotContext.Provider value={headshots}>
        <div className="wr-root wr-v2 wr-inline" data-testid={`trades-planner-${part}`}>
          <PanelBoundary name={part === 'next' ? 'Next move' : part === 'goget' ? 'Go get' : 'Market'}>
            {part === 'next' && (
              <NextMoveDeck key={`${leagueId}:${view.snapshot?.id ?? ''}`} view={view} big variant="hero"
                negotiation={negotiations.data} onAskCoach={() => onAsk(FIXED_QUESTIONS[0])} onAsk={q => onAsk(q)} />
            )}
            {part === 'goget' && <ScreenGoGet view={view} leagueId={leagueId} current={null} onRequest={send} someoneElse={someoneElse} compact />}
            {part === 'market' && <ScreenMarket view={view} />}
          </PanelBoundary>
        </div>
      </HeadshotContext.Provider>
    </SourcesContext.Provider>
  );
}
