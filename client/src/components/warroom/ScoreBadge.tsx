import type { BlueChipRow, Field, BlueChipBoardData } from './types';

/**
 * PLAYER-SCORE: a player's blue-chip score and label, as the producer wrote them
 * (people/player-score.js). "hurt" marks a high pick whose low score comes from missed
 * games. The client formats only; the score is never recomputed here.
 */
const TONE: Record<string, string> = {
  'Elite blue chip': 'elite', 'Blue chip': 'blue', 'Level below': 'below', 'Solid starter': 'solid',
  Flex: 'flex', Depth: 'depth', Bench: 'bench',
};
const STYLE: Record<string, { background: string; color: string }> = {
  elite: { background: '#1d3fbf', color: '#fff' },
  blue: { background: '#3b6fe0', color: '#fff' },
  below: { background: '#c9d8fb', color: '#10245f' },
  solid: { background: '#dfe7d2', color: '#253a10' },
  flex: { background: '#eee6cf', color: '#4a3a0c' },
  depth: { background: '#e6e6e6', color: '#333' },
  bench: { background: '#f3f3f3', color: '#666' },
};

export default function ScoreBadge({ row, compact }: { row: Pick<BlueChipRow, 'score' | 'label' | 'hurt'> | null | undefined; compact?: boolean }) {
  if (!row) return null;
  const tone = TONE[row.label] ?? 'bench';
  return (
    <span className="wr-tag wr-score" data-score-tone={tone} style={STYLE[tone]}
      title={`Blue-chip score ${row.score}/100: ${row.label}${row.hurt ? ' (hurt: missed games, not a fall-off)' : ''}`}>
      {row.score}{compact ? '' : ` ${row.label}`}{row.hurt ? ' · hurt' : ''}
    </span>
  );
}

/** The board row for a player id, when the board is served; null otherwise (no badge, never a made-up score). */
export function scoreOf(board: Field<BlueChipBoardData> | undefined, id: string): BlueChipRow | null {
  if (!board || board.status !== 'ok' || !board.value) return null;
  return board.value.rows.find(r => r.player === String(id)) ?? null;
}
