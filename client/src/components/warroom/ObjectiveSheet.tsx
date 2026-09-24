import { useState } from 'react';
import type { WarRoomView } from './types';
import { GOALS, previewFor, type CoachAction } from './coach/warroomCoach';
import { requestOf } from './controls';
import { isOk } from './format';
import { Sheet, useSubmit, type RecordFn } from './Sheet';
import TradeoffPreview from './TradeoffPreview';

type Goal = typeof GOALS[number];
export const GOAL_LABELS: Record<Goal, string> = {
  title: 'Win the title', playoffs: 'Make the playoffs', get_player: 'Get a player', points: 'Points per week',
};
const WEEKS = Array.from({ length: 18 }, (_, i) => i + 1);

/**
 * WR-3 objective: title / playoffs / get a player / a points-per-week target, with an
 * optional arrive-by week. One Set goal tap records one `objective.set`. The producer's
 * trade-off for the change shows under the form when it priced one.
 */
export default function ObjectiveSheet({ plans, names, onRecord, onClose }: {
  plans: WarRoomView; names?: Record<string, string>; onRecord: RecordFn; onClose: () => void;
}) {
  const now = isOk(plans.destination) && isOk(plans.destination.value.goal) ? plans.destination.value.goal.value : null;
  const [goal, setGoal] = useState<Goal>(now?.kind ?? 'title');
  const [player, setPlayer] = useState(now?.player_id ?? '');
  const [points, setPoints] = useState(now?.points_per_week != null ? String(now.points_per_week) : '');
  const [arriveBy, setArriveBy] = useState('');
  const { busy, error, submit, setError } = useSubmit(onRecord, onClose);

  const action: CoachAction = {
    type: 'set_objective', goal,
    ...(goal === 'get_player' ? { player_id: player } : {}),
    ...(goal === 'points' ? { points_per_week: Number(points) } : {}),
    ...(arriveBy ? { arrive_by: Number(arriveBy) } : {}),
  };
  let invalid: string | null = null;
  try { requestOf(action); } catch (e) { invalid = e instanceof Error ? e.message : String(e); }

  const set = () => {
    try { void submit(requestOf(action)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <Sheet title="Change the goal" onClose={onClose} error={error}>
      <div className="wr-choices" role="radiogroup" aria-label="Goal">
        {GOALS.map(g => (
          <button key={g} type="button" role="radio" aria-checked={goal === g}
            className={`wr-chip${goal === g ? ' wr-on' : ''}`} onClick={() => setGoal(g)}>{GOAL_LABELS[g]}</button>
        ))}
      </div>
      {goal === 'get_player' && (
        <label className="wr-field">Player
          <select value={player} onChange={e => setPlayer(e.target.value)}>
            <option value="">Pick a player</option>
            {Object.entries(names ?? {}).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
      )}
      {goal === 'points' && (
        <label className="wr-field">Points per week
          <input type="number" min={1} max={400} step={1} value={points} onChange={e => setPoints(e.target.value)} />
        </label>
      )}
      <label className="wr-field">Arrive by (optional)
        <select value={arriveBy} onChange={e => setArriveBy(e.target.value)}>
          <option value="">No set week</option>
          {WEEKS.map(w => <option key={w} value={w}>Week {w}</option>)}
        </select>
      </label>
      {invalid ? <p className="wr-hint">{invalid}</p> : <TradeoffPreview preview={previewFor(action, plans)} />}
      <div className="wr-acts">
        <button type="button" className="wr-btn wr-primary" disabled={!!invalid || busy} onClick={set}>
          {busy ? 'Saving' : 'Set goal'}
        </button>
      </div>
    </Sheet>
  );
}
