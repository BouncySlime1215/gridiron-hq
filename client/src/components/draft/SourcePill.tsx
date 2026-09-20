import { useEffect, useState } from 'react';
import { api } from '../../api';

interface IngestStatus { active?: boolean; last_seen_at?: string | number | null; frames_seen?: number | null }

/**
 * THE BOOKMARKLET THAT COULD NOT WORK, AND SAID NOTHING.
 *
 * `GET /drafts/:id/capture-bookmarklet` (routes/draft-capture.js:73) answers
 * with nine fields. This component destructured one of them — `href` — and
 * dropped the rest. The one that mattered was `warnings`, which carries, in the
 * server's own words:
 *
 *   "no tunnel is registered; falling back to http://localhost:… The https
 *    ESPN page will block an http script (mixed content) — run `npm run tunnel`
 *    first."
 *
 * The user dragged a bookmarklet to their bookmarks bar, opened their ESPN
 * draft room, clicked it, and nothing happened. The app had been told exactly
 * why and had thrown it away. That is the failure mode this codebase keeps
 * finding: a surface that looks healthy and is not working.
 *
 * It also never requested a key. The route requires `?ingest_key=…`, minted by
 * `POST /drafts/:id/ingest-key` (commissioner only), so every click on "Get the
 * ESPN tab bookmarklet" came back 400 and printed the server's parameter
 * documentation at the user as an error message. Now the component mints the
 * key and passes it, and a non-commissioner gets a sentence rather than a
 * status code.
 *
 * THE KEY IS A CREDENTIAL. It is never rendered, never logged, and never put in
 * component state beyond the one call that spends it. What goes on screen is
 * the href the server built with it, which is the whole point of the href.
 *
 * SERVED-FIELD DECISIONS, one per field, per the served-field rule:
 *   href        rendered — the draggable link.
 *   warnings    rendered, each one, verbatim. The reason this file changed.
 *   tunnel_up   rendered, as the state the warning is about.
 *   origin      rendered — the whole failure is about which origin the https
 *               ESPN page will accept, so naming it is what makes the warning
 *               actionable.
 *   loader_url  rendered beside origin — if the click does nothing, opening
 *               this in the same tab says whether the script is reachable at
 *               all, which is the one check a user can actually run.
 *   href_dry    rendered, as a second link that captures nothing. Finding out
 *               before the draft is the difference between a fixable problem
 *               and a lost draft.
 *   href_bytes  rendered as a plain count. Long bookmarklets are refused by
 *               some browsers; no threshold is asserted here, because this file
 *               does not know any browser's real limit and inventing one would
 *               be a number with nothing behind it.
 *   draft_id    dropped. It is the id this component was handed.
 *   key_source  dropped. It is 'query' by construction now that this component
 *               is the only caller and always passes the key that way.
 */
interface Bookmarklet {
  href?: string;
  href_dry?: string;
  loader_url?: string;
  origin?: string;
  tunnel_up?: boolean;
  href_bytes?: number;
  warnings?: string[];
}

export default function SourcePill({ draftId, sync }: { draftId: string; sync?: { source?: string; paused?: boolean } | null }) {
  const [status, setStatus] = useState<IngestStatus | null>(null);
  const [now, setNow] = useState(Date.now());
  const [bm, setBm] = useState<{ data?: Bookmarklet; error?: string; open: boolean; loading?: boolean }>({ open: false });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let delay = 5000;
      try {
        const s = await api<IngestStatus>(`/drafts/${draftId}/ingest-status`);
        if (!cancelled) setStatus(s);
      } catch {
        if (!cancelled) setStatus(null);
        delay = 30000;   // endpoint absent or unhappy — don't nag it
      }
      if (!cancelled) timer = setTimeout(poll, delay);
    };
    poll();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { cancelled = true; clearTimeout(timer); clearInterval(tick); };
  }, [draftId]);

  const active = !!status?.active || sync?.source === 'espn-page';
  const seenAt = status?.last_seen_at ? new Date(status.last_seen_at).getTime() : null;
  const ago = seenAt != null && Number.isFinite(seenAt) ? Math.max(0, Math.round((now - seenAt) / 1000)) : null;

  const openBookmarklet = async () => {
    if (bm.open) { setBm({ open: false }); return; }
    setBm({ open: true, loading: true });
    try {
      // Minting replaces any previous key for this draft, so a bookmarklet
      // dragged to the bar earlier stops working the moment this runs. That is
      // the server's behaviour (draft-ingest.js:36) and the panel says so.
      const minted = await api<{ key?: string }>(`/drafts/${draftId}/ingest-key`, { method: 'POST' });
      if (!minted?.key) throw new Error('the server did not return a key');
      const data = await api<Bookmarklet>(
        `/drafts/${draftId}/capture-bookmarklet?ingest_key=${encodeURIComponent(minted.key)}`
      );
      setBm({ open: true, data });
    } catch (e: any) {
      setBm({ open: true, error: e?.message ?? 'not available yet' });
    }
  };

  const d = bm.data;
  return (
    <span className="inline-flex items-center gap-2 flex-wrap">
      <span
        title={active ? `Frames captured from your ESPN draft tab${status?.frames_seen != null ? ` · ${status.frames_seen} seen` : ''}` : 'Reading the ESPN draft API every 4 seconds'}
        className={`text-[10px] font-bold px-2 py-0.5 rounded-full border tabular-nums ${active ? 'bg-good-tint text-good border-good' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
        {active
          ? `● Fed by your ESPN tab${ago != null ? ` · ${ago}s ago` : ''}${sync?.paused ? ' · paused' : ''}`
          : 'Polling ESPN'}
      </span>
      <button onClick={openBookmarklet} className="text-[11px] text-sky-700 hover:underline">
        {bm.open ? 'hide bookmarklet' : 'Get the ESPN tab bookmarklet'}
      </button>

      {bm.open && (
        <span className="basis-full capture-panel">
          {bm.loading && <span className="capture-note">Minting a key…</span>}

          {bm.error && (
            <span className="text-crit capture-note">Bookmarklet unavailable — {bm.error}</span>
          )}

          {d?.warnings?.map((w, i) => (
            /* The server's own sentence, word for word. It already names the
               cause and the command that fixes it; rewording it here would put
               a second version of the claim in a second place. */
            <span key={i} className="capture-warning">{w}</span>
          ))}

          {d?.href && (
            <>
              <span className="capture-actions">
                <a href={d.href} draggable onClick={e => e.preventDefault()}
                  className="capture-drag"
                  title="Drag me to your bookmarks bar">
                  ⇢ Gridiron capture
                </a>
                {d.href_dry && (
                  <a href={d.href_dry} draggable onClick={e => e.preventDefault()}
                    className="capture-drag capture-drag-quiet"
                    title="Drag me too. Clicking this in the ESPN tab checks the connection and captures nothing.">
                    ⇢ Test first
                  </a>
                )}
              </span>
              <span className="capture-note">
                Drag the first one to your bookmarks bar. Open the ESPN draft room, click it once, and
                don't reload that tab. The second one checks the connection and captures nothing — worth
                one click before the draft starts.
              </span>
              <span className="capture-note">
                Getting this panel again mints a new key, and the copy already on your bookmarks bar
                stops working. Drag the new one over it.
              </span>
              <span className="capture-detail">
                <span>{d.tunnel_up ? 'over a tunnel' : 'from this machine'}</span>
                {d.origin && <span>{d.origin}</span>}
                {d.loader_url && (
                  <a href={d.loader_url} target="_blank" rel="noreferrer" title="If clicking the bookmarklet does nothing, open this in the ESPN tab: it says whether the script is reachable at all.">
                    loads {d.loader_url}
                  </a>
                )}
                {d.href_bytes != null && <span>{d.href_bytes.toLocaleString()} characters</span>}
              </span>
            </>
          )}
        </span>
      )}
    </span>
  );
}
