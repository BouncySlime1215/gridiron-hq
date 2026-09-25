import { useCallback, useMemo, useState, type ReactNode } from 'react';
import './warroom.css';
import './warroom-v2.css';
import { setTeamNames, type WarRoomView } from './types';
import { isOk } from './format';
import { SourcesContext } from './FieldState';
import { PanelBoundary } from './Panel';
import NextMoveDeck, { type CurrentMove } from './NextMoveDeck';
import { MoveDetails } from './HeroCard';
import { teamLabel } from './types';
import Icon from './icons';
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
  // The deck's current card: its offer (message, walk-away, "If he says…") folds under the deck, and
  // once the card is picked the reply buttons log his answer (offer.reply) from here.
  const [current, setCurrent] = useState<CurrentMove | null>(null);
  const onCurrent = useCallback((c: CurrentMove | null) => setCurrent(c), []);

  return (
    <SourcesContext.Provider value={view.sources ?? {}}>
      <HeadshotContext.Provider value={headshots}>
        <div className="wr-root wr-v2 wr-inline" data-testid={`trades-planner-${part}`}>
          <PanelBoundary name={part === 'next' ? 'Next move' : part === 'goget' ? 'Go get' : 'Market'}>
            {part === 'next' && (
              <>
                <NextMoveDeck key={`${leagueId}:${view.snapshot?.id ?? ''}`} view={view} big variant="hero"
                  negotiation={negotiations.data} onCurrent={onCurrent} onAskCoach={() => onAsk(FIXED_QUESTIONS[0])} onAsk={q => onAsk(q)} />
                {current && (
                  <details className="wr-card2 wr-fold" data-panel="composer" aria-label="The offer" style={{ marginTop: 16 }}>
                    <summary><span className="wr-card2-h">The offer to {teamLabel(current.move.steps[0].partner)}</span>
                      <span className="wr-h-note">message, when to send, walk-away, if he says…</span><Icon name="down" size={16} className="wr-acc-chev" /></summary>
                    <MoveDetails move={current.move} view={view} leagueId={leagueId} onReply={current.onReply} negotiating={current.negotiating} />
                  </details>
                )}
              </>
            )}
            {part === 'goget' && <ScreenGoGet view={view} leagueId={leagueId} current={null} onRequest={send} someoneElse={someoneElse} compact />}
            {part === 'market' && <ScreenMarket view={view} />}
          </PanelBoundary>
        </div>
      </HeadshotContext.Provider>
    </SourcesContext.Provider>
  );
}
