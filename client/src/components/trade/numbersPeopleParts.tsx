import { Card, Chip, Fold } from '../ui/DesignSystem';
import { STANCE, type NPItem, type Stance } from './NumbersPeopleCard';

/**
 * NUMBERS-PEOPLE "Going forward": the week-by-week timeline of each lane's stance, and the
 * "which lane was right when they differed" scoreboard (honest n). The item card itself is
 * NumbersPeopleCard (shared with Coach). Everything shown is the server's (view.js).
 */
export interface NPScoreboard {
  n: number; min_n: number; enough: boolean; numbers_right: number; people_right: number; both_right: number; pending: number;
}

const short = (s: Stance | null) => (s ? STANCE[s].label : '–');

export function Timeline({ items }: { items: NPItem[] }) {
  const withHistory = items.filter(i => i.history.length);
  return (
    <Fold title="How Claude's and Jev's calls moved, week by week" hint={`${withHistory.length} items`} testid="np-timeline">
      <ul className="space-y-2">
        {withHistory.map(i => (
          <li key={i.key} className="min-w-0">
            <div className="truncate text-sm font-semibold" title={i.title}>{i.title}</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {i.history.map((h, k) => (
                <Chip key={`${h.week ?? 0}:${k}`} tone={h.verdict === 'differ' ? 'warn' : 'neutral'}
                  title={`Week ${h.week ?? '?'}: Claude ${short(h.numbers)}, Jev ${short(h.people)}`}>
                  Wk {h.week ?? '?'} · Claude {short(h.numbers)} · Jev {short(h.people)}
                </Chip>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {!withHistory.length && <p className="ds-note">One week of reads so far; the timeline fills in as weeks pass.</p>}
    </Fold>
  );
}

export function Scoreboard({ board }: { board: NPScoreboard | null }) {
  if (!board) return null;
  return (
    <Card><div data-testid="np-scoreboard">
      <div className="mb-1 text-sm font-semibold">When Claude and Jev differed, which one was right</div>
      {board.enough
        ? <div className="flex flex-wrap gap-2" data-testid="np-score">
            <Chip tone="accent">Claude right {board.numbers_right}</Chip>
            <Chip tone="accent">Jev right {board.people_right}</Chip>
            <Chip>Both right {board.both_right}</Chip>
            <span className="ds-note self-center">of {board.n} settled</span>
          </div>
        : <p className="ds-note" data-testid="np-score-thin">Not enough outcomes yet: {board.n} of the {board.min_n} settled differences a score needs.
            {board.pending ? ` ${board.pending} still waiting on a result.` : ''}</p>}
      <p className="ds-note mt-1">A trade call settles when the offer is accepted or turned down; a target call when the player's points per game move after the read.</p>
    </div></Card>
  );
}
