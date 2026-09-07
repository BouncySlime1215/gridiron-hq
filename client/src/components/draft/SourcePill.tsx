import { useEffect, useState } from 'react';
import { api } from '../../api';

interface IngestStatus { active?: boolean; last_seen_at?: string | number | null; frames_seen?: number | null }

/**
 * Where the board is coming from: the user's own ESPN tab (the capture bookmarklet
 * feeding frames to /ingest) or our own 4s ESPN poll. The ingest-status endpoint is
 * being built alongside this — a 404 or any error just reads as "Polling ESPN".
 */
export default function SourcePill({ draftId, sync }: { draftId: string; sync?: { source?: string; paused?: boolean } | null }) {
  const [status, setStatus] = useState<IngestStatus | null>(null);
  const [now, setNow] = useState(Date.now());
  const [bm, setBm] = useState<{ href?: string; error?: string; open: boolean }>({ open: false });

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
    try {
      const out = await api<{ href?: string }>(`/drafts/${draftId}/capture-bookmarklet`);
      setBm({ open: true, href: out?.href });
    } catch (e: any) {
      setBm({ open: true, error: e?.message ?? 'not available yet' });
    }
  };

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
        <span className="basis-full text-[11px] text-slate-600 flex items-center gap-2 flex-wrap">
          {bm.href ? (
            <>
              <a href={bm.href} draggable onClick={e => e.preventDefault()}
                className="font-bold px-2 py-0.5 rounded border border-sky-300 bg-sky-50 text-sky-800 cursor-grab select-none"
                title="Drag me to your bookmarks bar">
                ⇢ Gridiron capture
              </a>
              <span>Drag this to your bookmarks bar. Open the ESPN draft room, click it once, and don't reload that tab.</span>
            </>
          ) : (
            <span className="text-rose-600">Bookmarklet unavailable — {bm.error}</span>
          )}
        </span>
      )}
    </span>
  );
}
