import { useState } from 'react';
import { api, useApi } from '../../api';
import { sanitizedMessage } from '../../lib/errorSanitize';

/** GET /trades/:leagueId/offers/sent: whether the offer loop is on (FIX-10). */
interface OfferLoopFlag { enabled: boolean; preview?: boolean; preview_reason?: string; reason?: string }

/**
 * CLONE-01b b1: Nick sent this deal on ESPN himself. Logs it with the band the card
 * showed, so the post-sync job can grade it against his reply. The app never sends
 * the offer.
 *
 * FIX-10: renders only when GRIDIRON_OFFER_LOOP is on (or preview mode), and says
 * "Preview (unconfirmed forward)" when it is on only through preview mode. Every card
 * on a page reads the same path, so the flag is fetched once.
 */
export default function SentOfferButton({ deal, leagueId, onError }: {
  deal: any; leagueId: number; onError: (msg: string | null) => void;
}) {
  const { data: flag } = useApi<OfferLoopFlag>(`/trades/${leagueId}/offers/sent`, { staleTime: 5 * 60 * 1000 });
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only a deal with a band can be graded; the server refuses the rest.
  if (flag?.enabled !== true || deal?.partner_id == null || deal?.acceptance?.band?.mid == null) return null;

  const markSent = async () => {
    setBusy(true); onError(null);
    try {
      const r = await api(`/trades/${leagueId}/offers/sent`, { method: 'POST', body: JSON.stringify({ deal }) });
      setSent(r?.state === 'already_sent' ? 'Already logged' : 'Logged — graded when ESPN shows the reply');
    } catch (e: any) { onError(sanitizedMessage('TradeCard.markSent', "Couldn't log the offer", e.message)); }
    finally { setBusy(false); }
  };

  return <button className="btn-ghost text-xs" onClick={markSent} disabled={busy || sent != null}
    title={flag.preview ? flag.preview_reason : 'You proposed this on ESPN — log it so the reply is graded'}>
    {sent ?? (busy ? 'Logging…' : '📨 I sent this')}
    {flag.preview && <span data-preview className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-semibold text-amber-800">Preview (unconfirmed forward)</span>}
  </button>;
}
