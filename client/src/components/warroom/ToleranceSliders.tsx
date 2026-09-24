import { useState } from 'react';
import type { Field } from './types';
import { TOLERANCES, TOLERANCE_KEYS } from './coach/warroomCoach';
import { requestOf } from './controls';
import { isOk } from './format';
import type { RecordFn } from './Sheet';

type Key = typeof TOLERANCE_KEYS[number];
export const TOLERANCE_LABELS: Record<Key, string> = {
  max_assets: 'Max assets per deal',
  max_offers_per_manager_week: 'Max offers per manager per week',
  max_downside_per_step: 'Max downside per step',
  reputation_budget: 'Reputation budget',
  ai_spend: 'AI spend',
};

/**
 * CAMPAIGN-01d tolerance sliders, with the server's ranges (schema.js TOLERANCES). Each
 * slider starts at the value the producer wrote in destination.tolerances; one it did not
 * write says "not set yet". Save is live once the slider moved and records one
 * `tolerance.set`; a failed save shows its cause beside that slider.
 */
export default function ToleranceSliders({ tolerances, onRecord }: {
  tolerances: Field<Record<string, number>> | undefined; onRecord: RecordFn;
}) {
  const now = isOk(tolerances) ? tolerances.value : {};
  const [values, setValues] = useState<Partial<Record<Key, number>>>({});
  const [state, setState] = useState<Partial<Record<Key, { busy?: boolean; saved?: boolean; error?: string }>>>({});

  const save = async (key: Key, value: number) => {
    setState(s => ({ ...s, [key]: { busy: true } }));
    try {
      await onRecord(requestOf({ type: 'set_tolerance', key, value }));
      setState(s => ({ ...s, [key]: { saved: true } }));
      setValues(v => { const { [key]: _done, ...rest } = v; return rest; });
    } catch (e) {
      setState(s => ({ ...s, [key]: { error: e instanceof Error ? e.message : String(e) } }));
    }
  };

  return (
    <div className="wr-tols" role="group" aria-label="Tolerances">
      <div className="wr-cap">Tolerances</div>
      {TOLERANCE_KEYS.map(key => {
        const rule = TOLERANCES[key];
        const current = typeof now[key] === 'number' ? now[key] : undefined;
        const moved = values[key];
        const shown = moved ?? current ?? rule.min;
        const st = state[key] ?? {};
        return (
          <div key={key} className="wr-tol">
            <label className="wr-field">
              <span>{TOLERANCE_LABELS[key]}: <b>{moved ?? current ?? 'not set yet'}</b></span>
              <input type="range" min={rule.min} max={rule.max} step={rule.integer ? 1 : 0.5} value={shown}
                aria-label={TOLERANCE_LABELS[key]}
                onChange={e => { setValues(v => ({ ...v, [key]: Number(e.target.value) })); setState(s => ({ ...s, [key]: {} })); }} />
            </label>
            <button type="button" className="wr-btn wr-sm" disabled={moved == null || moved === current || !!st.busy}
              onClick={() => { if (moved != null) void save(key, moved); }}>
              {st.busy ? 'Saving' : st.saved ? 'Saved' : 'Save'}
            </button>
            {st.error && <span className="wr-hint wr-red" role="status">Not recorded: {st.error}</span>}
          </div>
        );
      })}
    </div>
  );
}
