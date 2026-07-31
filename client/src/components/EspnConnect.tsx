import { useState } from 'react';
import { api, useApi } from '../api';

/**
 * One-click ESPN connection.
 *
 * The manual route is nine steps in DevTools and most people give up partway. This
 * hands them a bookmarklet that reads the cookies on ESPN's own page and posts them
 * back to localhost, then lists the leagues on the account so nobody has to dig a
 * league id out of a URL.
 */
export default function EspnConnect() {
  const { data: status, refetch } = useApi<any>('/espn-connect/status');
  const { data: bm } = useApi<any>('/espn-connect/bookmarklet');
  const [discovered, setDiscovered] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);

  const discover = async () => {
    setBusy(true); setMsg(null);
    try {
      const d = await api<any>('/espn-connect/discover');
      setDiscovered(d.leagues);
      if (!d.leagues.length) setMsg('Signed in, but no football leagues found for this season.');
    } catch (e: any) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  const add = async (l: any) => {
    setBusy(true); setMsg(null);
    try {
      const r = await api<any>('/espn-connect/add', {
        method: 'POST',
        body: JSON.stringify({ league_id: l.league_id, season: l.season, my_team_id: l.team_id, name: l.name })
      });
      await api(`/leagues/${r.id}/sync`, { method: 'POST' });
      setMsg(`Added and synced ${l.name}.`);
      refetch();
    } catch (e: any) { setMsg(`Added, but sync failed: ${e.message}`); }
    finally { setBusy(false); }
  };

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-1">
        <h3 className="text-sm font-bold text-slate-700">Connect ESPN</h3>
        {status?.connected && (
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-300">
            CONNECTED
          </span>
        )}
      </div>

      {!status?.connected && (
        <>
          <p className="text-xs text-slate-600 mb-3">
            Private ESPN leagues need two browser cookies. Rather than hunting for them in
            DevTools, drag this button to your bookmarks bar, open{' '}
            <a href="https://www.espn.com/fantasy/football/" target="_blank" rel="noreferrer"
              className="text-emerald-600 underline">espn.com</a>{' '}
            signed in, and click it.
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            {bm?.href && (
              // A real anchor so it can be dragged to the bookmarks bar; clicking it here
              // would run the script against this page, where the cookies do not exist.
              <a href={bm.href} onClick={e => e.preventDefault()}
                draggable
                title="Drag me to your bookmarks bar"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold cursor-grab active:cursor-grabbing select-none">
                🔗 Connect Gridiron HQ
              </a>
            )}
            <span className="text-[11px] text-slate-400">← drag this to your bookmarks bar</span>
          </div>

          <button onClick={() => setShowManual(s => !s)}
            className="text-[11px] text-slate-500 hover:text-slate-700 underline mt-3">
            {showManual ? 'Hide' : 'Can’t use bookmarks? Paste a snippet instead'}
          </button>
          {showManual && bm?.console_snippet && (
            <div className="mt-2">
              <p className="text-[11px] text-slate-500 mb-1">
                On espn.com, open the browser console (⌥⌘J on Mac, Ctrl+Shift+J on Windows) and paste this:
              </p>
              <div className="relative">
                <pre className="text-[10px] bg-slate-50 border border-slate-200 rounded-lg p-2 overflow-x-auto max-h-32 text-slate-600">
                  {bm.console_snippet}
                </pre>
                <button className="absolute top-1 right-1 text-[10px] text-emerald-600 bg-white border border-slate-200 rounded px-1.5 py-0.5"
                  onClick={() => navigator.clipboard?.writeText(bm.console_snippet)}>copy</button>
              </div>
            </div>
          )}
          <p className="text-[10px] text-slate-400 mt-3">
            The cookies go from your browser straight to this app on localhost. They are stored in
            the local database and sent only to ESPN.
          </p>
        </>
      )}

      {status?.connected && (
        <>
          <div className="text-[11px] text-slate-500 space-y-0.5 mb-3">
            <div>espn_s2 <span className="font-mono text-slate-600">{status.espn_s2_preview}</span></div>
            <div>SWID <span className="font-mono text-slate-600">{status.swid_preview}</span></div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button className="btn-primary text-xs" onClick={discover} disabled={busy}>
              {busy ? 'Working…' : 'Find my leagues'}
            </button>
            <button className="btn-ghost text-xs"
              onClick={async () => { await api('/espn-connect/cookies', { method: 'DELETE' }); refetch(); setDiscovered(null); }}>
              Disconnect
            </button>
          </div>
        </>
      )}

      {msg && <p className="text-xs text-slate-600 mt-2">{msg}</p>}

      {discovered && discovered.length > 0 && (
        <div className="mt-3 border border-slate-200 rounded-lg divide-y divide-slate-100">
          {discovered.map((l: any) => {
            const already = (status?.leagues ?? []).some((x: any) => String(x.league_id) === String(l.league_id));
            return (
              <div key={l.league_id} className="px-3 py-2 flex items-center gap-2 text-xs">
                <div className="min-w-0">
                  <div className="font-semibold text-slate-800 truncate">{l.name}</div>
                  <div className="text-[10px] text-slate-400">
                    id {l.league_id}{l.team_name ? ` · your team: ${l.team_name}` : ''}
                  </div>
                </div>
                <button className={`ml-auto text-xs ${already ? 'btn-ghost' : 'btn-primary'}`}
                  disabled={busy} onClick={() => add(l)}>
                  {already ? 'Re-sync' : 'Add'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {status?.leagues?.length > 0 && (
        <div className="mt-3">
          <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">Connected leagues</div>
          {status.leagues.map((l: any) => (
            <div key={l.id} className="text-xs text-slate-600">
              {l.name ?? l.league_id} <span className="text-slate-400">· {l.season} · {l.team_count ?? '?'} teams</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
