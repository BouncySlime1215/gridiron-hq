import { useEffect, useState } from 'react';
import { api, useApi } from '../api';

export default function Settings() {
  const { data: settings, refetch } = useApi<any>('/espn/settings');
  const [form, setForm] = useState({ league_id: '', season: 2026, team_id: '', espn_s2: '', swid: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (settings) setForm(f => ({ ...f, league_id: settings.league_id ?? '', season: settings.season ?? 2026, team_id: settings.team_id ?? '' }));
  }, [settings]);

  const save = async () => {
    await api('/espn/settings', {
      method: 'PUT',
      body: JSON.stringify({
        league_id: form.league_id, season: Number(form.season),
        team_id: form.team_id ? Number(form.team_id) : null,
        espn_s2: form.espn_s2 || null, swid: form.swid || null
      })
    });
    setMsg('Saved.');
    refetch();
  };

  const sync = async () => {
    setSyncing(true); setMsg(null);
    try {
      const r = await api('/espn/sync', { method: 'POST' });
      setMsg(`Synced — found ${r.teams} teams in your league. Head to My Team.`);
    } catch (e: any) {
      setMsg(`Sync failed: ${e.message}`);
    } finally { setSyncing(false); }
  };

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-1">ESPN League Settings</h1>
      <p className="text-sm text-slate-600 mb-6">Connects directly from your Mac to ESPN — credentials never leave this machine.</p>

      <div className="card p-5 space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <label className="text-xs text-slate-600">League ID
            <input className="input block mt-1 w-full" placeholder="e.g. 1234567"
              value={form.league_id} onChange={e => setForm(f => ({ ...f, league_id: e.target.value }))} />
          </label>
          <label className="text-xs text-slate-600">Season
            <input className="input block mt-1 w-full" type="number"
              value={form.season} onChange={e => setForm(f => ({ ...f, season: Number(e.target.value) }))} />
          </label>
          <label className="text-xs text-slate-600">My team ID <span className="text-slate-400">(optional)</span>
            <input className="input block mt-1 w-full" placeholder="set after first sync"
              value={form.team_id} onChange={e => setForm(f => ({ ...f, team_id: e.target.value }))} />
          </label>
        </div>
        <label className="text-xs text-slate-600 block">espn_s2 cookie {settings?.has_espn_s2 && <span className="text-emerald-600">(saved ✓ — paste to replace)</span>}
          <input className="input block mt-1 w-full font-mono" placeholder="AEB…(very long string)"
            value={form.espn_s2} onChange={e => setForm(f => ({ ...f, espn_s2: e.target.value }))} />
        </label>
        <label className="text-xs text-slate-600 block">SWID cookie {settings?.has_swid && <span className="text-emerald-600">(saved ✓ — paste to replace)</span>}
          <input className="input block mt-1 w-full font-mono" placeholder="{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}"
            value={form.swid} onChange={e => setForm(f => ({ ...f, swid: e.target.value }))} />
        </label>
        <div className="flex gap-2 flex-wrap">
          <button className="btn-primary" onClick={save}>Save settings</button>
          <button className="btn-ghost" onClick={sync} disabled={syncing}>{syncing ? 'Syncing…' : '↻ Sync league now'}</button>
          <button className="btn-ghost" disabled={syncing} onClick={async () => {
            setSyncing(true); setMsg(null);
            try {
              const r = await api('/espn/sync-players', { method: 'POST' });
              setMsg(`Player database pulled from ESPN — ${r.fetched} players (${r.added} new, ${r.updated} updated). Rookies included.`);
            } catch (e: any) { setMsg(`Player sync failed: ${e.message}`); }
            finally { setSyncing(false); }
          }}>⬇ Pull player database</button>
          <button className="btn-ghost" disabled={syncing} onClick={async () => {
            setSyncing(true); setMsg(null);
            try {
              const r = await api('/espn/sync-news', { method: 'POST' });
              setMsg(`Pulled ${r.added} new ESPN headlines into Camp News.`);
            } catch (e: any) { setMsg(`News sync failed: ${e.message}`); }
            finally { setSyncing(false); }
          }}>📰 Pull ESPN news</button>
        </div>
        {msg && <p className="text-sm text-amber-600">{msg}</p>}
        <p className="text-[11px] text-slate-500">“Pull player database” works even before you connect a league — it grabs ESPN&apos;s top-800 fantasy players (rookies included) and becomes the source of truth for rosters. Re-run it any time rosters change.</p>
      </div>

      <div className="card p-5 mt-4 text-sm text-slate-700 space-y-2">
        <h2 className="font-bold text-slate-800">How to find your league ID &amp; cookies (private leagues)</h2>
        <ol className="list-decimal list-inside space-y-1 text-xs text-slate-600">
          <li>Log in to <span className="text-slate-800">fantasy.espn.com</span> and open your league. The URL contains <span className="font-mono text-slate-800">leagueId=XXXXXXX</span> — that&apos;s your League ID.</li>
          <li>In Chrome/Safari, open DevTools (⌥⌘I) → Application/Storage → Cookies → espn.com.</li>
          <li>Copy the value of <span className="font-mono text-slate-800">espn_s2</span> (long string) and <span className="font-mono text-slate-800">SWID</span> (including the curly braces).</li>
          <li>Paste both above, save, then hit Sync. These are read-only session cookies — never your password.</li>
        </ol>
      </div>
    </div>
  );
}
