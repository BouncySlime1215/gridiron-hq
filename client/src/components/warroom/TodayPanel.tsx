import './warroom.css';
import './warroom-v2.css';
import { setTeamNames, type WarRoomView } from './types';
import { isOk } from './format';
import { SourcesContext } from './FieldState';
import { PanelBoundary } from './Panel';
import NextMoveDeck from './NextMoveDeck';
import ScreenToday from './ScreenToday';
import { useHeadshotMap, useNegotiations, useSpendAnomaly } from './useWarRoom';
import { HeadshotContext } from './Avatar';
import { FIXED_QUESTIONS } from './coach/CoachDrawer';

/**
 * UI consolidation, Today: the War Room's "Do this now" hero, Watching and season progress,
 * drawn inside the app (a `.wr-v2.wr-inline` scope) instead of the full-screen War Room.
 * The same view (the plans contract), the same deck and the same posts; Coach is the
 * app-wide drawer (onAsk).
 */
export default function TodayPanel({ view, leagueId, onAsk }: {
  view: WarRoomView; leagueId: number; onAsk: (question?: string) => void;
}) {
  setTeamNames(isOk(view.teams) ? view.teams.value : null);
  const negotiations = useNegotiations(leagueId);
  const headshots = useHeadshotMap();
  // SPEND-UI: a spend anomaly is one Watching row (the served line; nothing computed here).
  const spendAnomaly = useSpendAnomaly();
  const deck = (
    <PanelBoundary name="Next move">
      <NextMoveDeck key={`${leagueId}:${view.snapshot?.id ?? ''}`} view={view} big variant="hero"
        negotiation={negotiations.data} onAskCoach={() => onAsk(FIXED_QUESTIONS[0])} onAsk={q => onAsk(q)} />
    </PanelBoundary>
  );
  return (
    <SourcesContext.Provider value={view.sources ?? {}}>
      <HeadshotContext.Provider value={headshots}>
        <div className="wr-root wr-v2 wr-inline" data-testid="today-panel">
          <ScreenToday view={view} negotiations={negotiations.data} deck={deck} spendAnomaly={spendAnomaly} />
        </div>
      </HeadshotContext.Provider>
    </SourcesContext.Provider>
  );
}
