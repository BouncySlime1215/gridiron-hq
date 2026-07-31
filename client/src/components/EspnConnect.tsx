import { useEffect, useRef, useState } from 'react';
import { api, useApi } from '../api';

/**
 * One-click ESPN connection.
 *
 * The manual route is nine steps in DevTools and most people give up partway. This
 * hands them one button that reads the cookies on ESPN's own page and posts them back
 * to localhost, then lists every league on the account so nobody has to dig a league
 * id out of a URL.
 *
 * Two things this version fixes over the first pass, both found by watching a real
 * (non-technical) user get stuck on it:
 *   - "Connected" now means connected, whichever way the cookies got here — the old
 *     check only recognised its own bookmarklet and kept telling an already-connected
 *     user to reconnect (server/routes/espn-connect.js: getCookies()).
 *   - When already connected, leagues are looked up automatically. There is nothing
 *     to click for the common case; the button only matters the first time.
 */
export default function EspnConnect() {
  const { data: status, refetch } = useApi<any>('/espn-connect/status');
  const { data: bm } = useApi<any>('/espn-connect/bookmarklet');
  const [discovered, setDiscovered] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const autoRan = useRef(false);

  const discover = async (silent = false) => {
    if (!silent) setBusy(true);
    setMsg(null);
    try {
      const d = await api<any>('/espn-connect/discover');
      setDiscovered(d.leagues);
      if (!silent && !d.leagues.length) setMsg('Connected, but no fantasy football leagues found on this account for this season.');
    } catch (e: any) { if (!silent) setMsg(e.message); }
    finally { setBusy(false); }
  };

  // Just arrived back from the "connect" button — show a plain-English confirmation
  // instead of the browser's own alert() popup, then clean the URL and look up leagues.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('espn_connected') === '1') {
      const found = Number(params.get('found') ?? 0);
      setBanner(found > 0
        ? `Connected! Found ${found} league${found === 1 ? '' : 's'} on your ESPN account below.`
        : 'Connected to ESPN. No leagues showed up yet — try "Find my leagues" below.');
      window.history.replaceState({}, '', location.pathname);
      refetch();
    }
  }, []);

  // Already connected (from any source) and haven't looked up leagues yet this visit —
  // just do it, so the common case ("I already did this") needs zero clicks.
  useEffect(() => {
    if (status?.connected && !autoRan.current) {
      autoRan.current = true;
      discover(true);
    }
  }, [status?.connected]);

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
    } catch (e: any) { setMsg(`Added, but the first sync failed: ${e.message}. Try "Sync" on the My Leagues page.`); }
    finally { setBusy(false); }
  };

  const disconnect = async () => {
    await api('/espn-connect/cookies', { method: 'DELETE' });
    setDiscovered(null); autoRan.current = false;
    refetch();
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

      {banner && (
        <div className="mb-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs px-3 py-2">
          {banner}
        </div>
      )}

      {!status?.connected && (
        <>
          <p className="text-xs text-slate-600 mb-3">
            Private ESPN leagues need you to be signed in to ESPN so this app can see your leagues.
            Three steps, no copying anything:
          </p>
          <ol className="text-xs text-slate-600 space-y-2 mb-3 list-decimal list-inside">
            <li>Drag the green button below up to your browser's bookmarks bar.</li>
            <li>
              Open{' '}
              <a href="https://www.espn.com/fantasy/football/" target="_blank" rel="noreferrer"
                className="text-emerald-600 underline">espn.com</a>{' '}
              and make sure you're signed in.
            </li>
            <li>Click that bookmark. It'll bring you right back here, connected.</li>
          </ol>

          <div className="flex items-center gap-3 flex-wrap">
            {bm?.href && (
              // A real anchor so it can be dragged to the bookmarks bar; clicking it here
              // would run the script against this page, where the ESPN cookies do not exist.
              <a href={bm.href} onClick={e => e.preventDefault()}
                draggable
                title="Drag me to your bookmarks bar"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold cursor-grab active:cursor-grabbing select-none">
                🔗 Connect Gridiron HQ
              </a>
            )}
            <span className="text-[11px] text-slate-400">← drag this up to your bookmarks bar</span>
          </div>

          <p className="text-[11px] text-slate-400 mt-2">
            Don't see a bookmarks bar? Press <kbd className="px-1 py-0.5 rounded border border-slate-300 bg-slate-50 text-slate-600">⌘⇧B</kbd>{' '}
            (Mac) or <kbd className="px-1 py-0.5 rounded border border-slate-300 bg-slate-50 text-slate-600">Ctrl⇧B</kbd>{' '}
            (Windows) to show it, then try again. On a trackpad, click and hold the button until it lifts, then drag.
          </p>

          <button onClick={() => setShowHelp(s => !s)}
            className="text-[11px] text-slate-500 hover:text-slate-700 underline mt-3">
            {showHelp ? 'Hide other option' : "Can't drag to bookmarks? Try this instead"}
          </button>
          {showHelp && bm?.console_snippet && (
            <div className="mt-2">
              <p className="text-[11px] text-slate-500 mb-1">
                While on espn.com, signed in: right-click the page and choose <b>Inspect</b>, click the{' '}
                <b>Console</b> tab at the top of the panel that opens, paste this in, and press Enter:
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
            Nothing is sent anywhere but ESPN and this app running on your own Mac.
          </p>
        </>
      )}

      {status?.connected && (
        <>
          <p className="text-xs text-slate-600 mb-3">
            {discovered === null
              ? 'Looking up the leagues on your ESPN account…'
              : discovered.length
                ? 'Add any league below, or re-sync one you already added.'
                : 'Connected, but no leagues showed up for this account this season.'}
          </p>
          <div className="flex gap-2 flex-wrap">
            <button className="btn-primary text-xs" onClick={() => discover(false)} disabled={busy}>
              {busy ? 'Working…' : '↻ Find my leagues again'}
            </button>
            <button className="btn-ghost text-xs" onClick={disconnect}>
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
                    {l.team_name ? `your team: ${l.team_name}` : `id ${l.league_id}`}
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
    </div>
  );
}
