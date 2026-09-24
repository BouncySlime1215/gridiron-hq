import { useState } from 'react';
import type { WarRoomView } from './types';
import { RISK_MODES } from './coach/warroomCoach';
import { EDIT, canConfirm, confirmedRequest, reviewOf, type Review } from './controls';
import { isOk } from './format';
import { Sheet, useSubmit, type RecordFn } from './Sheet';
import TradeoffPreview from './TradeoffPreview';
import ToleranceSliders from './ToleranceSliders';

type Mode = typeof RISK_MODES[number];
export const MODE_LABELS: Record<Mode, string> = { safe: 'Safe', balanced: 'Balanced', all_in: "Fuck it, let's go" };
const WEEKS = Array.from({ length: 18 }, (_, i) => i + 1);

/**
 * WR-3 risk mode, with a confirm step: picking a mode (and an optional "until week")
 * records nothing; Review shows the producer's trade-off for it (stop_tradeoffs
 * `mode:<mode>[:until:<wk>]`, or "not computed yet"); only Confirm records one `mode.set`.
 * The tolerance sliders sit under the mode picker; each Save is its own request.
 */
export default function RiskModeSheet({ plans, onRecord, onClose, initial }: {
  plans: WarRoomView; onRecord: RecordFn; onClose: () => void; initial?: Review;
}) {
  const d = isOk(plans.destination) ? plans.destination.value : undefined;
  const now = isOk(d?.risk_mode) ? d.risk_mode.value : null;
  const [mode, setMode] = useState<Mode>(now?.mode ?? 'balanced');
  const [until, setUntil] = useState('');
  const [review, setReview] = useState<Review>(initial ?? EDIT);
  const { busy, error, submit, setError } = useSubmit(onRecord, onClose);

  const toReview = () => {
    try {
      setReview(reviewOf({ type: 'set_risk_mode', mode, until_week: until ? Number(until) : null }, plans));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  if (canConfirm(review)) {
    return (
      <Sheet title="Change risk mode" onClose={onClose} error={error}>
        <div className="wr-ch-t">Trade-off before anything changes</div>
        <TradeoffPreview preview={review.preview} />
        <div className="wr-acts">
          <button type="button" className="wr-btn" onClick={() => setReview(EDIT)} disabled={busy}>Back</button>
          <button type="button" className="wr-btn wr-primary" disabled={busy}
            onClick={() => { void submit(confirmedRequest(review)); }}>{busy ? 'Saving' : 'Confirm'}</button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title="Change risk mode" onClose={onClose} error={error}>
      <div className="wr-choices" role="radiogroup" aria-label="Risk mode">
        {RISK_MODES.map(m => (
          <button key={m} type="button" role="radio" aria-checked={mode === m}
            className={`wr-chip${mode === m ? ' wr-on' : ''}${m === 'all_in' ? ' wr-chip-allin' : ''}`} onClick={() => setMode(m)}>
            {MODE_LABELS[m]}{now?.mode === m ? ' (now)' : ''}
          </button>
        ))}
      </div>
      <label className="wr-field">Until (optional)
        <select value={until} onChange={e => setUntil(e.target.value)}>
          <option value="">No end week</option>
          {WEEKS.map(w => <option key={w} value={w}>Week {w}</option>)}
        </select>
      </label>
      <div className="wr-acts">
        <button type="button" className="wr-btn wr-primary" onClick={toReview}>Review the trade-off</button>
      </div>
      <ToleranceSliders tolerances={d?.tolerances} onRecord={onRecord} />
    </Sheet>
  );
}
