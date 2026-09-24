import { useState } from 'react';
import type { Field, Reply, ReplyKind } from './types';
import { FieldBlock, Val } from './FieldState';
import { pts } from './format';

const ROWS = [['accept', 'Accepts'], ['decline', 'Declines'], ['counter', 'Counters'], ['silence', 'No reply 24 h']] as const;

/**
 * "If he says...": what to do for each answer, from the step's `reply_table`. Rows with
 * no plan say so ("not computed yet"), never hidden, so it is visible the table is
 * incomplete. Once the card is picked, "He did this" logs his actual answer as an
 * `offer.reply` request (onLog); otherwise tapping a row only opens it.
 */
export default function ReplyTable({ replies, onLog }: {
  replies: Field<Record<ReplyKind, Field<Reply>>> | undefined;
  onLog?: (reply: ReplyKind) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [logged, setLogged] = useState<ReplyKind | null>(null);
  return (
    <FieldBlock f={replies} label="The reply plan">
      {table => (
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
                      <button type="button" className="wr-btn wr-sm" disabled={logged != null}
                        onClick={e => { e.stopPropagation(); setLogged(k); onLog(k); }}>
                        {logged === k ? 'Logged' : 'He did this'}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </FieldBlock>
  );
}
