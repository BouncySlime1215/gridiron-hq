import { useEffect, useRef, useState } from 'react';
import { api, useApi } from '../api';
import { sanitizedMessage } from '../lib/errorSanitize';
import { Button, Chip } from './ui/DesignSystem';

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
/**
 * The one ESPN connect flow (docs/ui/CONSOLIDATION-MAP.md section 6): Settings → Connections, the
 * first-run prompt (EspnConnectGate) and League → Your leagues all render this component.
 *   variant 'card' draws its own card; 'bare' draws only the content (a host supplies the frame).
 *   autoAddAll (the first-run prompt): once connected, add and sync every league found, then onDone.
 * Credentials: the pasted cookie field is masked and never echoed back; nothing here logs or renders
 * a cookie value. Disconnect asks before it removes the stored cookies.
 */
export default function EspnConnect({ variant = 'card', autoAddAll = false, onDone }: {
  variant?: 'card' | 'bare'; autoAddAll?: boolean; onDone?: (message: string) => void;
} = {}) {
  const { data: status, refetch } = useApi<any>('/espn-connect/status');
  const { data: bm } = useApi<any>('/espn-connect/bookmarklet');
  const [discovered, setDiscovered] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [paste, setPaste] = useState('');
  const [pasteErr, setPasteErr] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [byId, setById] = useState({ league_id: '', season: new Date().getFullYear() });
  const autoRan = useRef(false);

  /**
   * The always-works path. Bookmarklets are genuinely awkward on Safari, on mobile,
   * and on managed work profiles, and some browsers refuse the cross-origin post
   * outright — pasting whatever `document.cookie` gave them never fails for those
   * reasons, and the server pulls the two values out of the blob.
   */
  const connectFromPaste = async () => {
    setBusy(true); setPasteErr(null); setMsg(null);
    try {
      const r = await api<any>('/espn-connect/cookies', {
        method: 'POST',
        body: JSON.stringify({ raw: paste })
      });
      setPaste('');
      setBanner(r.leagues_found > 0
        ? `Connected! Found ${r.leagues_found} league${r.leagues_found === 1 ? '' : 's'} on your ESPN account below.`
        : 'Connected to ESPN. No leagues showed up yet — try "Find my leagues" below.');
      refetch();
      if (autoAddAll) await addAll(); else discover(true);
    } catch (e: any) {
      // UX-08c: POST /espn-connect/cookies answers 400/401 with its own plain copy
      // (missing cookie, validateCookies() reason) — show that verbatim. Anything
      // else (a 5xx from the route's app_settings/leagues writes falling through to
      // the global handler's raw err.message, or a network failure with no status)
      // is not user copy, so it goes through the sanitizer.
      const status = typeof e?.status === 'number' ? e.status : 0;
      setPasteErr(status >= 400 && status < 500
        ? e.message
        : sanitizedMessage('EspnConnect.paste', "Couldn't save those cookies", e?.message));
    } finally { setBusy(false); }
  };

  const discover = async (silent = false) => {
    if (!silent) setBusy(true);
    setMsg(null);
    try {
      const d = await api<any>('/espn-connect/discover');
      setDiscovered(d.leagues);
      if (!silent && !d.leagues.length) setMsg('Connected, but no fantasy football leagues found on this account for this season.');
      return d.leagues as any[];
    } catch (e: any) {
      setMsg(sanitizedMessage('EspnConnect.discover', silent ? 'ESPN could not refresh your leagues' : 'ESPN league lookup failed', e.message));
    }
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
      setMsg(`Added and synced ${l.name ?? `league ${l.league_id}`}.`);
      refetch();
      return true;
    } catch (e: any) { setMsg(sanitizedMessage('EspnConnect.add', 'Added, but the first sync failed. Try “Sync” in League → Your leagues', e.message)); return false; }
    finally { setBusy(false); }
  };

  /** First-run: add and sync every league on the account (discover + add, the same calls as below), then one sentence. */
  const addAll = async () => {
    const leagues: any[] = (await discover(true)) ?? [];
    let ok = 0;
    for (const l of leagues) if (await add(l)) ok += 1;
    const failed = leagues.length - ok;
    onDone?.(failed
      ? `ESPN is connected. ${ok} league${ok === 1 ? '' : 's'} synced; ${failed} can be retried from League → Your leagues.`
      : `ESPN is connected and ${ok} league${ok === 1 ? '' : 's'} ${ok === 1 ? 'is' : 'are'} ready.`);
  };

  /** A league the lookup did not list (or a public one): add it by id, then sync. */
  const addById = async () => {
    if (!byId.league_id.trim()) return;
    await add({ league_id: byId.league_id.trim(), season: byId.season, team_id: null, name: null });
    setById(b => ({ ...b, league_id: '' }));
  };

  const disconnect = async () => {
    setConfirmDisconnect(false);
    await api('/espn-connect/cookies', { method: 'DELETE' });
    setDiscovered(null); autoRan.current = false;
    refetch();
  };

  const body = (
    <>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="ds-h">Connect ESPN</h3>
        {status?.connected && <Chip tone="good">Connected</Chip>}
      </div>

      {banner && <p role="status" className="ds-chip ds-chip-good mb-3 !whitespace-normal">{banner}</p>}

      {!status?.connected && (
        <>
          <p className="ds-note mb-3">
            Private ESPN leagues need you signed in to ESPN so this app can see them. Three steps, nothing to copy:
          </p>
          <ol className="mb-3 list-inside list-decimal space-y-2 text-sm text-slate-700">
            <li>Drag the button below up to your browser's bookmarks bar.</li>
            <li>
              Open{' '}
              <a href="https://www.espn.com/fantasy/football/" target="_blank" rel="noreferrer"
                className="text-[var(--c-accent)] underline">espn.com</a>{' '}
              and make sure you're signed in.
            </li>
            <li>Click that bookmark. It brings you back here, connected.</li>
          </ol>

          <div className="flex flex-wrap items-center gap-3">
            {bm?.href && (
              // A real anchor so it can be dragged to the bookmarks bar; clicking it here
              // would run the script against this page, where the ESPN cookies do not exist.
              <a href={bm.href} onClick={e => e.preventDefault()} draggable
                title="Drag me to your bookmarks bar"
                className="ds-btn ds-btn-primary cursor-grab select-none active:cursor-grabbing">
                Connect Gridiron HQ
              </a>
            )}
            <span className="ds-note">← drag this up to your bookmarks bar</span>
          </div>
          <p className="ds-note mt-2">
            No bookmarks bar? Press <kbd className="rounded border border-slate-300 px-1">⌘⇧B</kbd> (Mac) or{' '}
            <kbd className="rounded border border-slate-300 px-1">Ctrl⇧B</kbd> (Windows), then try again.
          </p>

          {/* The fallback that works everywhere (Safari, mobile, work laptops). The field is masked:
              what is pasted here is a credential and is never shown back. */}
          <div className="mt-4 border-t border-slate-200 pt-3">
            <p className="mb-1 text-sm font-semibold">Or paste it instead</p>
            <ol className="mb-2 list-inside list-decimal space-y-1.5 text-sm text-slate-700">
              <li>
                On <a href="https://www.espn.com/fantasy/football/" target="_blank" rel="noreferrer"
                  className="text-[var(--c-accent)] underline">espn.com</a>, signed in, press{' '}
                <kbd className="rounded border border-slate-300 px-1">F12</kbd> and open the <b>Console</b> tab.
              </li>
              <li>
                Paste this, press Enter:{' '}
                <code className="whitespace-nowrap rounded bg-[var(--c-soft)] px-1.5 py-0.5 text-xs">copy(document.cookie)</code>{' '}
                <button type="button" className="ds-chip !py-0 align-middle" title="Copy the console line"
                  onClick={() => navigator.clipboard?.writeText('copy(document.cookie)')}>copy</button>
              </li>
              <li>Come back, paste into the box, and press Connect.</li>
            </ol>
            <input type="password" autoComplete="off" spellCheck={false} value={paste}
              onChange={e => { setPaste(e.target.value); setPasteErr(null); }}
              aria-label="Paste your ESPN cookies" data-testid="espn-cookie-paste"
              placeholder="Paste here; the whole cookie string is fine"
              className="input w-full font-mono text-xs" />
            {pasteErr && <p role="alert" className="mt-1 text-xs text-crit">{pasteErr}</p>}
            <Button variant="primary" size="sm" className="mt-2" disabled={busy || !paste.trim()} onClick={connectFromPaste}
              title={!paste.trim() ? 'Paste the cookie string first' : busy ? 'Checking with ESPN' : undefined}>
              {busy ? 'Checking with ESPN…' : 'Connect'}
            </Button>
          </div>

          <button type="button" onClick={() => setShowHelp(v => !v)} className="mt-3 text-xs text-slate-500 underline hover:text-slate-700">
            {showHelp ? 'Hide advanced' : 'Advanced: run the connect script in the console'}
          </button>
          {showHelp && bm?.console_snippet && (
            <div className="mt-2">
              <p className="ds-note mb-1">Same thing the bookmark does: paste this into the console on espn.com instead.</p>
              <div className="relative">
                <pre className="max-h-32 overflow-x-auto rounded-lg bg-[var(--c-soft)] p-2 text-[10px] text-slate-600">{bm.console_snippet}</pre>
                <button type="button" className="ds-chip absolute right-1 top-1 !py-0" title="Copy the script"
                  onClick={() => navigator.clipboard?.writeText(bm.console_snippet)}>copy</button>
              </div>
            </div>
          )}
          <p className="ds-note mt-3">
            Your cookies are checked against ESPN and stored only on this machine. Nothing is sent anywhere else,
            and a failed attempt never touches a connection that already works.
          </p>
        </>
      )}

      {status?.connected && (
        <>
          <p className="ds-note mb-3">
            {discovered === null
              ? 'Looking up the leagues on your ESPN account…'
              : discovered.length
                ? 'Add any league below, or re-sync one you already added.'
                : 'Connected, but no leagues showed up for this account this season.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="quiet" icon="refresh" onClick={() => discover(false)} disabled={busy}
              title={busy ? 'Working' : 'Look up the leagues on this ESPN account again'}>{busy ? 'Working…' : 'Find my leagues again'}</Button>
            {!confirmDisconnect
              ? <Button size="sm" onClick={() => setConfirmDisconnect(true)} title="Remove the stored ESPN cookies from this Mac">Disconnect</Button>
              : <span className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm disconnect">
                  <span className="text-sm">Remove the ESPN cookies from this Mac?</span>
                  <Button size="sm" variant="primary" onClick={disconnect}>Remove</Button>
                  <Button size="sm" onClick={() => setConfirmDisconnect(false)}>Cancel</Button>
                </span>}
          </div>
        </>
      )}

      {msg && <p role="status" className="ds-note mt-2">{msg}</p>}

      {discovered && discovered.length > 0 && (
        <div className="ds-rows mt-3 rounded-[var(--r-tile)] shadow-[0_0_0_1px_var(--c-line)]">
          {discovered.map((l: any) => {
            const already = (status?.leagues ?? []).some((x: any) => String(x.league_id) === String(l.league_id));
            return (
              <div key={l.league_id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{l.name}</div>
                  <div className="ds-note">{l.team_name ? `your team: ${l.team_name}` : `id ${l.league_id}`}</div>
                </div>
                <Button size="sm" variant={already ? 'default' : 'primary'} className="ml-auto" disabled={busy} onClick={() => add(l)}
                  title={already ? 'Pull this league again' : 'Add this league and sync it'}>
                  {already ? 'Re-sync' : 'Add'}
                </Button>
              </div>
            );
          })}
        </div>
      )}

      {status?.connected && (
        // A league the lookup does not list, or a public league: by id, with the cookies already stored.
        <div className="mt-3 flex flex-wrap items-end gap-2" data-testid="espn-add-by-id">
          <label className="text-xs text-slate-600">League not listed? League ID
            <input className="input mt-1 block w-40" inputMode="numeric" value={byId.league_id} placeholder="1234567"
              onChange={e => setById(b => ({ ...b, league_id: e.target.value }))} />
          </label>
          <label className="text-xs text-slate-600">Season
            <input type="number" className="input mt-1 block w-24" value={byId.season}
              onChange={e => setById(b => ({ ...b, season: Number(e.target.value) }))} />
          </label>
          <Button size="sm" disabled={busy || !byId.league_id.trim()} onClick={addById}
            title={!byId.league_id.trim() ? 'Type the league id from the ESPN URL (leagueId=…)' : 'Add this league and sync it'}>Add by ID</Button>
        </div>
      )}
    </>
  );

  return variant === 'bare' ? <div data-testid="espn-connect">{body}</div>
    : <div className="ds-card p-4" data-testid="espn-connect">{body}</div>;
}
