import type { WarRoomView } from './types';
import NoMoveCard from './NoMoveCard';
import Icon from './icons';

/** Friendly names for the risk modes (the served label stays the classic dashboard's). */
export const MODE_LABEL: Record<string, string> = { safe: 'Safe', balanced: 'Balanced', all_in: 'All-in' };

/**
 * The producer's reason can name the closest overpay ("... the closest is A + B for C at +1% market
 * value (your cap: +0%)"). Reads that sentence into one short line; text only, nothing computed.
 */
export function closestMissLine(reason: string | undefined): string | null {
  const m = /closest is (.+?) for (.+?) at \+(\d+)% market value/.exec(reason ?? '');
  if (!m) return null;
  const give = m[1].split(' + ').length, get = m[2].split(' + ').length;
  return `Closest miss: ${give}-for-${get} for ${m[2]}, +${m[3]}% over value.`;
}

/**
 * WAR-ROOM-UI v2: the Today hero when no move clears. One calm headline, one short line on
 * why, the two questions, and the closest-path / all-in cards folded under "See the closest
 * misses" with the planner's full sentence. Coach answers "why" in full.
 */
export default function NoMoveHero({ view, onAsk }: { view: WarRoomView; onAsk?: (q: string) => void }) {
  const reason = view.next_move?.reason;
  const miss = closestMissLine(reason);
  return (
    <article className="wr-nomove-hero" data-testid="no-move-hero" aria-label="This week">
      <span className="wr-nmh-ic"><Icon name="ok" size={22} /></span>
      <h2 className="wr-nmh-h">Keep your roster this week</h2>
      <p className="wr-nmh-why">No trade clears your rules{miss ? '.' : ' this week.'} {miss}</p>
      {onAsk && (
        <div className="wr-nmh-acts">
          <button type="button" className="wr-btn" onClick={() => onAsk('Why is nothing clearing?')}>Why is nothing clearing?</button>
          <button type="button" className="wr-btn" onClick={() => onAsk('Show me the all-in plan')}>Show me the all-in plan</button>
        </div>
      )}
      <details className="wr-nmh-more">
        <summary><span>See the closest misses</span><Icon name="down" size={16} className="wr-nmh-chev" /></summary>
        <div className="wr-nmh-body">
          <NoMoveCard view={view} modeLabel={r => MODE_LABEL[r.mode] ?? r.label} />
          {reason && <p className="wr-nmh-note"><span className="wr-l2">Planner's note</span>{reason}</p>}
        </div>
      </details>
    </article>
  );
}
