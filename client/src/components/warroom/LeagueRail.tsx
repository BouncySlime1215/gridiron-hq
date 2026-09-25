import type { Attention } from './types';

export interface LeagueChoice { id: number; name: string | null }

/**
 * WR-L4: the target league, leagues.id 4 (the north-star league). An id, not a name.
 * The other connected leagues are training leagues.
 */
export const TARGET_LEAGUE_ID = 4;

/**
 * WR-L4: which league the War Room opens on. The target league (TARGET_LEAGUE_ID)
 * wins once per page load when it is connected;
 * after that, and whenever Nick picks a league himself, his pick stands.
 * Pure so a test can call it: returns the id to switch to, or null to stay.
 */
/** WR-L4: the War Room opens on the target league once per page load; after that Nick's pick stands. */
let openedOnTarget = false;
/** Test hook: forget that this page load already opened on the target league. */
export function __resetOpening() { openedOnTarget = false; }
export const wasOpenedOnTarget = () => openedOnTarget;
export function markOpenedOnTarget() { openedOnTarget = true; }

export function openingLeague(leagues: LeagueChoice[], activeId: number | null, target: number | null | undefined,
  alreadyDefaulted: boolean): number | null {
  if (alreadyDefaulted || target == null) return null;
  if (!leagues.some(l => l.id === target)) return null;
  return activeId === target ? null : target;
}

/** The target league first, then the rest in app order. */
export function railOrder(leagues: LeagueChoice[], target: number | null | undefined) {
  const t = target != null ? leagues.find(l => l.id === target) ?? null : null;
  return { target: t, training: t ? leagues.filter(l => l.id !== t.id) : leagues };
}

/**
 * League rail: the target league first; the other connected leagues fold under
 * "training leagues" (open when one of them is the league on screen). With no target
 * connected it is the flat list it always was. The open league shows its
 * "needs you this week" rank from `attention`, "not ranked yet" until the producer writes it
 * (with only one league ranked, just the reason).
 */
export default function LeagueRail({ leagues, activeId, target, attention, onLeague }: {
  leagues: LeagueChoice[]; activeId: number; target?: number | null; attention: Attention | null; onLeague: (id: number) => void;
}) {
  const { target: t, training } = railOrder(leagues, target);
  const chip = (l: LeagueChoice, isTarget = false) => {
    const a = l.id === activeId ? attention : null;
    // CARD-CLARITY: with one league ranked, "rank 1 of 1" says nothing; show the reason alone.
    const ranked = !!a && a.of > 1;
    return (
      <button key={l.id} type="button" role="tab" aria-selected={l.id === activeId} data-league={l.id}
        data-target={isTarget ? 'true' : undefined}
        className={`wr-lg${l.id === activeId ? ' wr-on' : ''}`} onClick={() => onLeague(l.id)}>
        <span className="wr-lg-n">{a && ranked && <span className={`wr-rk${a.rank > 2 ? ' wr-rk-low' : ''}`}>{a.rank}</span>}{l.name ?? `League ${l.id}`}{isTarget && <span className="wr-muted"> · target</span>}</span>
        <span className="wr-lg-w" title={a?.reason}>{a ? (ranked ? `rank ${a.rank} of ${a.of}: ${a.reason}` : a.reason) : l.id === activeId ? 'not ranked yet' : 'open to see its rank'}</span>
      </button>
    );
  };
  if (!t) {
    return <div className="wr-leagues" role="tablist" aria-label="Leagues, most urgent first">{training.map(l => chip(l))}</div>;
  }
  const trainingOpen = training.some(l => l.id === activeId);
  return (
    <div className="wr-leagues" role="tablist" aria-label="Target league first, then training leagues">
      {chip(t, true)}
      {training.length > 0 && (
        <details className="wr-training" data-testid="training-leagues" open={trainingOpen || undefined}
          style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <summary className="wr-lg" style={{ cursor: 'pointer', listStyle: 'none' }}>
            <span className="wr-lg-n">training leagues</span>
            <span className="wr-lg-w">{training.length} more</span>
          </summary>
          <div style={{ display: 'flex', gap: 4 }}>{training.map(l => chip(l))}</div>
        </details>
      )}
    </div>
  );
}
