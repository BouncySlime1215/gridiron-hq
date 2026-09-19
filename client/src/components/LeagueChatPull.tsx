import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Settings card: pull the league chat, and say how stale it is everywhere else.
 *
 * The league-chat corpus is the only thing the app runs on that cannot be
 * fetched from anywhere — it comes out of Messages on Nick's Mac. So this card
 * has two jobs depending on where it is rendered. On the laptop it is a button
 * that does the whole pull. In a cloud box, where `~/Library/Messages` does not
 * exist, it is a staleness read: the trade cards are priced on this corpus, and
 * the one thing a person needs to know there is whether it is from this week.
 *
 * The server decides which of those this is (`capability.can`), not the client
 * guessing from the hostname, so the button is never offered where it cannot
 * work and the reason is always the real one.
 */

type Status = {
  capability: { can: boolean; reason: string | null; detail: string | null };
  corpus: null | {
    messages: number | null; classified: number | null;
    managers: number | null; sentiment_rows: number | null;
    newest_message: string | null; size_bytes: number;
  };
  last_pull: null | { finished_at: string; ok: boolean; messages: number | null };
  freshness: { state: 'fresh' | 'aging' | 'stale' | 'absent' | 'unknown'; label: string; note: string | null };
};

const DOT: Record<Status['freshness']['state'], string> = {
  fresh: 'bg-emerald-600', aging: 'bg-amber-500', stale: 'bg-red-500',
  absent: 'bg-red-500', unknown: 'bg-slate-300',
};

export default function LeagueChatPull() {
  const [s, setS] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api('/league-chat/status').then(setS).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  const doPull = async () => {
    setBusy(true); setMsg(null); setErr(null);
    try {
      const r = await api('/league-chat/pull', { method: 'POST', body: JSON.stringify({}) });
      setMsg(r.ok
        ? `Pulled — ${r.messages ?? '?'} messages, ${r.classified ?? '?'} classified.`
        : `Pull failed: ${r.detail ?? r.reason ?? 'unknown'}`);
      if (!r.ok) setErr(r.detail ?? r.reason ?? 'unknown');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
      load();
    }
  };

  const f = s?.freshness;
  const c = s?.corpus;

  return (
    <div className="card p-5 mb-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${f ? DOT[f.state] : 'bg-slate-300'}`} />
        <h2 className="text-lg font-bold">League chat</h2>
        {f && <span className="text-xs text-slate-500">{f.label}</span>}
      </div>

      <p className="text-xs leading-5 text-slate-600">
        Everything the Trade Brain knows about how each manager talks — who is high on which player,
        who has soured, when each person actually answers an offer — comes out of this. It is read
        from Messages on your Mac, so it is the one thing that cannot refresh itself in the cloud.
      </p>

      {c && c.messages ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600 sm:grid-cols-4">
          <div><span className="font-mono text-slate-800">{c.messages.toLocaleString()}</span> messages</div>
          <div><span className="font-mono text-slate-800">{(c.classified ?? 0).toLocaleString()}</span> classified</div>
          <div><span className="font-mono text-slate-800">{c.managers ?? 0}</span> managers</div>
          <div><span className="font-mono text-slate-800">{(c.sentiment_rows ?? 0).toLocaleString()}</span> player reads</div>
        </div>
      ) : null}

      {f?.note && <p className="text-xs leading-5 text-amber-700">{f.note}</p>}

      {s?.capability.can ? (
        <>
          <button className="btn-ghost" disabled={busy} onClick={doPull}>
            {busy ? 'Pulling messages…' : 'Pull messages'}
          </button>
          <p className="text-[11px] leading-4 text-slate-500">
            Reads only new messages since the last pull, labels them, and rebuilds the manager
            profiles. Safe to click any time — running it twice changes nothing.
          </p>
        </>
      ) : (
        <div className="rounded border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-600">
          <div className="font-semibold text-slate-700">Pull from the laptop</div>
          <p className="mt-1">{s?.capability.detail ?? 'Checking…'}</p>
          {s?.last_pull?.finished_at && (
            <p className="mt-1">
              Last pulled {new Date(s.last_pull.finished_at).toLocaleString()}
              {s.last_pull.ok ? '' : ' — that pull failed'}.
            </p>
          )}
        </div>
      )}

      {msg && <p className="text-xs text-emerald-700">{msg}</p>}
      {err && <p className="text-xs text-red-600">{err}</p>}
    </div>
  );
}
