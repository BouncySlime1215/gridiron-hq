import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import EspnConnect from '../components/EspnConnect';
import PhoneAccess from '../components/PhoneAccess';
import LeagueChatPull from '../components/LeagueChatPull';
import NumberHealthCard from '../components/NumberHealth';
import { DataFreshnessDetail } from '../components/DataFreshnessBanner';
import { DevPanel } from '../components/DevHub';
import { api } from '../api';
import { sanitizedMessage } from '../lib/errorSanitize';
import { Button, Card, PageHeader, Tabs } from '../components/ui/DesignSystem';
import { useCoach } from '../state/coach';

/**
 * The Settings area (docs/ui/CONSOLIDATION-MAP.md): Connections (sign-in, the one ESPN flow, phone
 * access, league chat, the player database), Health (number health and data freshness, one view),
 * and AI & developer (API key, workspace, usage, identity audit).
 *
 * Model diagnostics (the map's fourth view) is not here: the server no longer serves the routes
 * Model.tsx reads (/model/status, /accuracy, /correlations, /gamescript, /availability, /handcuffs
 * all 404), so reviving it needs a server unit first.
 *
 * This page used to also carry a manual "League ID / season / espn_s2 / SWID" form that saved into
 * a single global settings row nothing read any more; it was removed earlier. ESPN news is pulled in
 * one place, Players → News, so this page no longer has its own "Pull ESPN news".
 */
type View = 'connections' | 'health' | 'dev';
const VIEWS: { id: View; label: string }[] = [
  { id: 'connections', label: 'Connections' }, { id: 'health', label: 'Health' },
  { id: 'dev', label: 'AI & developer' }
];

export default function Settings() {
  const [params, setParams] = useSearchParams();
  const q = params.get('view');
  const view: View = VIEWS.some(v => v.id === q) ? q as View : 'connections';
  const setView = (v: View) => setParams(() => (v === 'connections' ? new URLSearchParams() : new URLSearchParams(`view=${v}`)), { replace: true });

  return (
    <div className="max-w-3xl">
      <PageHeader eyebrow="Settings" title="Settings" description="Connections, the health of every number, and AI and developer settings." />
      <div className="mb-5"><Tabs label="Settings views" value={view} onChange={setView} tabs={VIEWS} /></div>

      {view === 'connections' && <div className="space-y-4">
        <Card className="!p-4">
          <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-[var(--c-green)]" /><h2 className="ds-h">Local sign-in is automatic</h2></div>
          <p className="ds-note mt-1">Gridiron HQ provisions this browser when it connects from your own Mac. There is no token to copy or paste; the server only issues a session over the loopback interface.</p>
        </Card>
        <EspnConnect />
        <PlayerDatabase />
        <PhoneAccess />
        <LeagueChatPull />
      </div>}

      {view === 'health' && <div className="space-y-4">
        <BrainCheck />
        <NumberHealthCard />
        <Card className="!p-4">
          <h2 className="ds-h mb-1">Data freshness</h2>
          <DataFreshnessDetail />
        </Card>
      </div>}

      {view === 'dev' && <Card><DevPanel /></Card>}

    </div>
  );
}

/** ESPN's top-800 fantasy players (rookies included): the source of truth for rosters. News lives in Players → News. */
function PlayerDatabase() {
  const [msg, setMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  return (
    <Card className="!p-4">
      <h2 className="ds-h">Player database</h2>
      <p className="ds-note mt-1">Works before you connect a league: it pulls ESPN&apos;s top-800 fantasy players, rookies included. Re-run it when rosters change. News is pulled in <Link to="/players?view=news" className="text-[var(--c-accent)] underline">Players → News</Link>.</p>
      <Button size="sm" icon="refresh" className="mt-3" disabled={syncing} title={syncing ? 'Pulling from ESPN' : 'Pull the player database from ESPN'}
        onClick={async () => {
          setSyncing(true); setMsg(null);
          try {
            const r = await api('/espn/sync-players', { method: 'POST' });
            setMsg(`Player database pulled from ESPN: ${r.fetched} players (${r.added} new, ${r.updated} updated).`);
          } catch (e: any) { setMsg(sanitizedMessage('Settings.pullPlayers', 'Player sync failed', e.message)); }
          finally { setSyncing(false); }
        }}>{syncing ? 'Pulling…' : 'Pull player database'}</Button>
      {msg && <p role="status" className="ds-note mt-2">{msg}</p>}
    </Card>
  );
}

/** The planner's brain check and number audit (the War Room health sheet), opened from here; the header chip lands on this view. */
function BrainCheck() {
  const { view, openHealth } = useCoach();
  if (!view) return null;
  return (
    <Card className="!p-4">
      <h2 className="ds-h">Brain check</h2>
      <p className="ds-note mt-1">Whether the planner that picks your next move is working: its brain report and the number audit.</p>
      <Button size="sm" variant="quiet" className="mt-3" onClick={openHealth} data-testid="open-brain-check">Open the brain check</Button>
    </Card>
  );
}
