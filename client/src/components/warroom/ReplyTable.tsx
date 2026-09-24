import { useState } from 'react';
import type { Field, Reply, ReplyKind } from './types';
import { FieldBlock, Val } from './FieldState';
import { pts } from './format';

const ROWS = [['accept', 'Accepts'], ['decline', 'Declines'], ['counter', 'Counters'], ['silence', 'No reply 24 h']] as const;

/** The counter form: what he countered with, in Nick's words. One Log counter = one `offer.reply`. */
export function CounterForm({ onSubmit, onCancel }: { onSubmit: (note: string) => void; onCancel: () => void }) {
  const [note, setNote] = useState('');
  return (
    <form className="wr-counter" aria-label="Log his counter"
      onSubmit={e => { e.preventDefault(); onSubmit(note.trim()); }}>
      <label className="wr-field">What did he counter with? (optional)
        <textarea rows={2} maxLength={500} value={note} onChange={e => setNote(e.target.value)}
          placeholder="e.g. wants your second-round pick instead" />
      </label>
      <div className="wr-acts">
        <button type="button" className="wr-btn wr-sm" onClick={onCancel}>Cancel</button>
        <button type="submit" className="wr-btn wr-sm wr-primary">Log counter</button>
      </div>
    </form>
  );
}

/**
 * "If he says...": what to do for each answer, from the step's `reply_table`. Rows with
 * no plan say so ("not computed yet"), never hidden, so it is visible the table is
 * incomplete. Once the card is picked, "He did this" logs his actual answer as an
 * `offer.reply` request (onLog); a counter first opens the counter form so the request
 * carries what he asked for. Otherwise tapping a row only opens it.
 */
export default function ReplyTable({ replies, onLog }: {
  replies: Field<Record<ReplyKind, Field<Reply>>> | undefined;
  onLog?: (reply: ReplyKind, note?: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [logged, setLogged] = useState<ReplyKind | null>(null);
  const [countering, setCountering] = useState(false);
  const log = (k: ReplyKind, note?: string) => { setLogged(k); setCountering(false); onLog?.(k, note); };
  return (
    <FieldBlock f={replies} label="The reply plan">
      {table => (
        <>
          <table className="wr-rt" aria-label="If he says">
            <tbody>
              {ROWS.map(([k, label]) => {
                const f = table[k];
                return (
                  <tr key={k} className={open === k ? 'wr-sel' : undefined} onClick={() => setOpen(open === k ? null : k)}>
                    <td className="wr-rt-k">{label}</td>
                    <td>
                      <Val f={f} fmt={r => r.do} showReason={open === k} />
                      {f?.status === 'ok' && f.value?.odds_after && (
                        <span className="wr-muted"> · <Val f={f.value.odds_after} fmt={pts} /> for you</span>
                      )}
                    </td>
                    {onLog && (
                      <td>
                        <button type="button" className="wr-btn wr-sm" disabled={logged != null || (countering && k === 'counter')}
                          onClick={e => { e.stopPropagation(); if (k === 'counter') setCountering(true); else log(k); }}>
                          {logged === k ? 'Logged' : 'He did this'}
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {onLog && countering && logged == null && (
            <CounterForm onSubmit={note => log('counter', note || undefined)} onCancel={() => setCountering(false)} />
          )}
        </>
      )}
    </FieldBlock>
  );
}
