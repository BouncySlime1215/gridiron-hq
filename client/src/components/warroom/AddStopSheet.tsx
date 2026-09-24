import { useState } from 'react';
import type { WarRoomView } from './types';
import { STOP_KINDS, type StopInput } from './coach/warroomCoach';
import { EDIT, canConfirm, confirmedRequest, reviewOf, type Review } from './controls';
import { Sheet, useSubmit, type RecordFn } from './Sheet';
import TradeoffPreview from './TradeoffPreview';

type Kind = typeof STOP_KINDS[number];
const KIND_LABELS: Record<Kind, string> = {
  get: 'Get', sell: 'Sell', flip: 'Flip', claim: 'Claim', cover_bye: 'Cover a bye', untouchable: 'Keep (untouchable)', custom: 'Other',
};
const WEEKS = Array.from({ length: 18 }, (_, i) => i + 1);

/**
 * WR-3 add a stop. The form records nothing. "Show the trade-off" reads the producer's
 * stop_tradeoffs entry (`add:<kind>:<player_id | week | label>`) and puts it on screen, or
 * "Trade-off not computed yet" when the key is absent; never a number of its own.
 * Confirm exists only on that step, and records one `stop.add`.
 */
export default function AddStopSheet({ plans, names, onRecord, onClose, initial }: {
  plans: WarRoomView; names?: Record<string, string>; onRecord: RecordFn; onClose: () => void; initial?: Review;
}) {
  const [kind, setKind] = useState<Kind>('get');
  const [player, setPlayer] = useState('');
  const [week, setWeek] = useState('');
  const [label, setLabel] = useState('');
  const [review, setReview] = useState<Review>(initial ?? EDIT);
  const { busy, error, submit, setError } = useSubmit(onRecord, onClose);

  const auto = player ? `${KIND_LABELS[kind]} ${names?.[player] ?? `player ${player}`}`
    : week ? `${KIND_LABELS[kind]} in week ${week}` : '';
  const stop: StopInput = {
    kind, label: label.trim() || auto,
    ...(player ? { player_id: player } : {}),
    ...(week ? { week: Number(week) } : {}),
  };

  const toReview = () => {
    try { setReview(reviewOf({ type: 'add_stop', stop }, plans)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  if (review.phase === 'review') {
    return (
      <Sheet title="Add a stop" onClose={onClose} error={error}>
        <div className="wr-ch-t">Trade-off before anything changes</div>
        {review.preview && <TradeoffPreview preview={review.preview} />}
        <div className="wr-acts">
          <button type="button" className="wr-btn" onClick={() => setReview(EDIT)} disabled={busy}>Back</button>
          {canConfirm(review) && (
            <button type="button" className="wr-btn wr-primary" disabled={busy}
              onClick={() => { void submit(confirmedRequest(review)); }}>{busy ? 'Saving' : 'Confirm'}</button>
          )}
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title="Add a stop" onClose={onClose} error={error}>
      <div className="wr-choices" role="radiogroup" aria-label="Kind of stop">
        {STOP_KINDS.map(k => (
          <button key={k} type="button" role="radio" aria-checked={kind === k}
            className={`wr-chip${kind === k ? ' wr-on' : ''}`} onClick={() => setKind(k)}>{KIND_LABELS[k]}</button>
        ))}
      </div>
      <label className="wr-field">Player (optional)
        <select value={player} onChange={e => setPlayer(e.target.value)}>
          <option value="">No player</option>
          {Object.entries(names ?? {}).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
      <label className="wr-field">Week (optional)
        <select value={week} onChange={e => setWeek(e.target.value)}>
          <option value="">No week</option>
          {WEEKS.map(w => <option key={w} value={w}>Week {w}</option>)}
        </select>
      </label>
      <label className="wr-field">Label
        <input type="text" maxLength={500} value={label} placeholder={auto || 'What is this stop?'} onChange={e => setLabel(e.target.value)} />
      </label>
      <div className="wr-acts">
        <button type="button" className="wr-btn wr-primary" disabled={!stop.label} onClick={toReview}>Show the trade-off</button>
      </div>
    </Sheet>
  );
}
