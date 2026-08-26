import { useState } from 'react';
import EspnConnect from '../components/EspnConnect';
import { api } from '../api';

/**
 * This page used to also carry a manual "League ID / season / espn_s2 / SWID" form
 * that saved into a single global settings row — from before the app supported more
 * than one league. Nothing has read that row since My Team/Trade Lab/the draft tools
 * moved onto the real `leagues` table (see routes/leagues.js), so editing it here had
 * quietly stopped doing anything anywhere else in the app. Removed rather than left
 * as a control that looks like it works and doesn't — manual private-league cookie
 * entry still exists, correctly wired, on the My Leagues page's "Add" form.
 */
export default function Settings() {
  const [msg, setMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  return (
    <div className="max-w-2xl">
      <div className="card p-5 mb-4 space-y-3">
        <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-emerald-600" /><h1 className="text-xl font-bold">Local sign-in is automatic</h1></div>
        <p className="text-xs leading-5 text-slate-600">Gridiron HQ provisions this browser when it connects from your own Mac. There is no bearer token to copy or paste. Protected league, draft, trade and Model Lab calls still require a real session; the server only issues it over the loopback interface.</p>
      </div>
      <EspnConnect />
      <h1 className="text-2xl font-bold mb-1">ESPN Settings</h1>
      <p className="text-sm text-slate-600 mb-6">
        League connections live in the <a href="/league?view=connections" className="text-[var(--accent)] underline">League Hub</a> now.
        What's here is global ESPN data, not tied to any one league.
      </p>

      <div className="card p-5 space-y-4">
        <div className="flex gap-2 flex-wrap">
          <button className="btn-ghost" disabled={syncing} onClick={async () => {
            setSyncing(true); setMsg(null);
            try {
              const r = await api('/espn/sync-players', { method: 'POST' });
              setMsg(`Player database pulled from ESPN — ${r.fetched} players (${r.added} new, ${r.updated} updated). Rookies included.`);
            } catch (e: any) { setMsg(`Player sync failed: ${e.message}`); }
            finally { setSyncing(false); }
          }}>Pull player database</button>
          <button className="btn-ghost" disabled={syncing} onClick={async () => {
            setSyncing(true); setMsg(null);
            try {
              const r = await api('/espn/sync-news', { method: 'POST' });
              setMsg(`Pulled ${r.added} new ESPN headlines into Camp News.`);
            } catch (e: any) { setMsg(`News sync failed: ${e.message}`); }
            finally { setSyncing(false); }
          }}>Pull ESPN news</button>
        </div>
        {msg && <p className="text-sm text-amber-600">{msg}</p>}
        <p className="text-[11px] text-slate-500">“Pull player database” works even before you connect a league — it grabs ESPN&apos;s top-800 fantasy players (rookies included) and becomes the source of truth for rosters. Re-run it any time rosters change.</p>
      </div>

      <div className="card p-5 mt-4 text-sm text-slate-700 space-y-2">
        <h2 className="font-bold text-slate-800">Private league not showing up? Add it manually</h2>
        <p className="text-xs text-slate-600">The "Connect ESPN" bookmarklet above handles most accounts automatically. If a private league still doesn't appear, add it by hand in the <a href="/league?view=connections" className="text-[var(--accent)] underline">League Hub</a>:</p>
        <ol className="list-decimal list-inside space-y-1 text-xs text-slate-600">
          <li>Log in to <span className="text-slate-800">fantasy.espn.com</span> and open your league. The URL contains <span className="font-mono text-slate-800">leagueId=XXXXXXX</span> — that&apos;s your League ID.</li>
          <li>In Chrome/Safari, open DevTools (⌥⌘I) → Application/Storage → Cookies → espn.com.</li>
          <li>Copy the value of <span className="font-mono text-slate-800">espn_s2</span> (long string) and <span className="font-mono text-slate-800">SWID</span> (including the curly braces).</li>
          <li>In League Hub → Connections, pick ESPN, paste the League ID and both cookies, then Add &amp; sync. These are read-only session cookies — never your password.</li>
        </ol>
      </div>
    </div>
  );
}
