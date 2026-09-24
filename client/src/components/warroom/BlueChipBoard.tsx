import { useState } from 'react';
import type { BlueChipBoardData, BlueChipRow, Field, ScoreGap } from './types';
import { teamLabel } from './types';
import { FieldBlock, Val } from './FieldState';
import { whole } from './format';
import { usePager } from './Panel';
import ScoreBadge from './ScoreBadge';

/**
 * PLAYER-SCORE: the "Blue chips" panel. Three views of the producer's board:
 *   others   other teams' players scoring Blue chip or above (who to go get)
 *   risers   anyone FantasyPros ranks high whose score is still mid (buy before he is a blue chip)
 *   mine     Nick's roster; his blue chips are protected (never given without his approval)
 * Each row: score + label badge, owner, our model's value, FantasyPros' rest-of-season rank, gap flags.
 */
export type BoardFilter = 'others' | 'risers' | 'mine';
export const FILTERS: { id: BoardFilter; name: string }[] = [
  { id: 'others', name: "Other teams' blue chips" },
  { id: 'risers', name: 'Risers' },
  { id: 'mine', name: 'My roster' },
];
export const GAP_TEXT: Record<ScoreGap, string> = {
  undervalued_blue_chip: 'FantasyPros high, our value low',
  fading_blue_chip: 'FantasyPros falling',
  riser: 'rising: buy before blue chip',
  we_value_lower: 'we price him lower than FantasyPros',
  we_value_higher: 'we price him higher than FantasyPros',
};

export function boardRows(board: BlueChipBoardData, filter: BoardFilter): BlueChipRow[] {
  if (filter === 'mine') return board.rows.filter(r => r.mine);
  if (filter === 'risers') return board.rows.filter(r => !r.mine && r.gaps.includes('riser'));
  return board.rows.filter(r => !r.mine && r.owner != null && r.score >= 80);
}

export default function BlueChipBoard({ field, big, initial = 'others' }: {
  field: Field<BlueChipBoardData> | undefined; big: boolean; initial?: BoardFilter;
}) {
  const [filter, setFilter] = useState<BoardFilter>(initial);
  const board = field?.status === 'ok' ? field.value : undefined;
  const rows = board ? boardRows(board, filter) : [];
  const pg = usePager(rows.length, big ? 10 : 4);
  return (
    <section className="wr-bluechips" aria-label="Blue chips" data-testid="blue-chips">
      <h3 className="wr-sub">Blue chips</h3>
      <FieldBlock f={field} label="Blue chips">
        {b => (
          <>
            <div className="wr-chips" role="tablist">
              {FILTERS.map(f => (
                <button key={f.id} type="button" role="tab" aria-selected={filter === f.id}
                  className={`wr-chip${filter === f.id ? ' wr-on' : ''}`} onClick={() => setFilter(f.id)}>{f.name}</button>
              ))}
              <span className="wr-sp" />{pg.control}
            </div>
            {!rows.length && <div className="wr-state" role="status">No players in this view.</div>}
            {rows.length > 0 && (
              <table className="wr-table">
                <thead><tr><th style={{ width: '36%' }}>Player</th><th>Owner</th><th>Our value</th><th>FantasyPros ROS</th>{big && <th>Gaps</th>}</tr></thead>
                <tbody>
                  {rows.slice(pg.a, pg.b).map(r => (
                    <tr key={r.player} data-player={r.player}>
                      <td><b>{r.name}</b> <span className="wr-muted">{r.position}</span> <ScoreBadge row={r} compact={!big} />
                        {r.protected && <span className="wr-tag" title="Never given without your approval"> protected</span>}</td>
                      <td>{r.owner == null ? 'Free agent' : r.mine ? 'You' : teamLabel(r.owner)}</td>
                      <td className="wr-num"><Val f={r.model_value} fmt={whole} /></td>
                      <td className="wr-num"><Val f={r.fp_ros_rank} fmt={v => `#${Math.round(v)}`} /></td>
                      {big && <td>{r.gaps.map(g => GAP_TEXT[g]).join('; ')}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="wr-sub wr-muted">
              Score = {Math.round(b.weights.pick * 100)}% draft pick + {Math.round(b.weights.production * 100)}% production ({b.weights.basis}).
              {b.fp.status !== 'ok' && b.fp.reason ? ` FantasyPros: ${b.fp.reason}` : ''}
            </div>
          </>
        )}
      </FieldBlock>
    </section>
  );
}
