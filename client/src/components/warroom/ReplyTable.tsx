import { useState } from 'react';
import type { Field, Reply } from './types';
import { Val } from './FieldState';
import { pts } from './format';

const ROWS = [['accept', 'Accepts'], ['decline', 'Declines'], ['counter', 'Counters'], ['silence', 'No reply 24 h']] as const;

/**
 * "If he says...": what to do for each answer. Rows with no plan say so ("not computed
 * yet"), never hidden, so it is visible the table is incomplete. Logging the actual
 * answer is WR-3 (request queue); tapping a row here only opens it.
 */
export default function ReplyTable({ replies }: { replies: Record<'accept' | 'decline' | 'counter' | 'silence', Field<Reply>> }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <table className="wr-rt" aria-label="If he says">
      <tbody>
        {ROWS.map(([k, label]) => {
          const f = replies[k];
          return (
            <tr key={k} className={open === k ? 'wr-sel' : undefined} onClick={() => setOpen(open === k ? null : k)}>
              <td className="wr-rt-k">{label}</td>
              <td>
                <Val f={f} fmt={r => r.do} showReason={open === k} />
                {f.status === 'ok' && f.value?.odds_after && (
                  <span className="wr-muted"> · <Val f={f.value.odds_after} fmt={pts} /> for you</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
