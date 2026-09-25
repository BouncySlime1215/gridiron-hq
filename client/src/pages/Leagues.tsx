import { useState } from 'react';
import { api, useApi } from '../api';
import { useLeague } from '../state/league';
import { PlayerName } from '../components/PlayerCard';
import { PageError, PageLoading } from '../components/PageState';
import { Button, Card, Chip, EmptyState } from '../components/ui/DesignSystem';

const POS_ORDER = ['QB', 'RB', 'WR', 'TE'];

type ScoringId = { statId: number; points: number };
type ScoringSummary = { source: string; reason: string | null; unscored: ScoringId[]; unmapped: ScoringId[] };

/**
 * What an ESPN sync says about scoring rules the app cannot apply
 * (routes/leagues.js syncEspnLeague → services/espn-scoring-report.js). Printed
 * in the sync message so a paid stat that no projection counts is named, not
 * silently left out. The full report is GET /api/leagues/:id/scoring.
 */
function scoringNote(scoring?: ScoringSummary | null): string {
  if (!scoring) return '';
  const ids = (list: ScoringId[]) => list.map(u => `${u.statId} (${u.points} pt)`).join(', ');
  const parts: string[] = [];
  if (scoring.source !== 'league') parts.push(`league scoring unreadable (${scoring.reason}), using the PPR default`);
  if (scoring.unscored.length) parts.push(`${scoring.unscored.length} paid stat ids not applied to player projections: ${ids(scoring.unscored)}`);
  if (scoring.unmapped.length) parts.push(`${scoring.unmapped.length} unknown stat ids: ${ids(scoring.unmapped)}`);
  return parts.length ? ` Scoring: ${parts.join('; ')}.` : '';
}

function StatusPill({ status, ratio }: { status: string; ratio: number | null }) {
  // 'unknown' means nobody in the league has a trade value at this position, so
  // there is no ratio to show. It used to arrive as a ratio of 0, which read as
  // a bright red NEED 0% for every team at once.
  if (status === 'unknown' || ratio == null) {
    return <Chip>Not priced</Chip>;
  }
  return <Chip tone={status === 'need' ? 'bad' : status === 'surplus' ? 'good' : 'neutral'}>
    {status === 'need' ? 'Need' : status === 'surplus' ? 'Surplus' : 'OK'} {(ratio * 100).toFixed(0)}%
  </Chip>;
}

/**
 * League → Your leagues (`view="leagues"`: connect, the league cards, sync, disconnect) and
 * League → Roster strength (`view="rosters"`: every roster's needs and surplus). LeagueHub draws
 * the one title and the tabs; this page draws no heading of its own.
 */
export default function Leagues({ view = 'leagues' }: { view?: 'leagues' | 'rosters' } = {}) {
  // Shared with the header switcher — clicking a league card here to view its
  // analysis also makes it the active league on My Team, Trade Lab, etc.
  const { leagues, loading: leaguesLoading, error: leaguesError, refetch, activeId: sel, setActiveId: setSel } = useLeague();
  const { data: analysis, refetch: refetchAnalysis } = useApi<any>(sel && view === 'rosters' ? `/leagues/${sel}/analysis` : null);
  const [form, setForm] = useState({ platform: 'sleeper', league_id: '', season: 2026, espn_s2: '', swid: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [removal, setRemoval] = useState<null | { id: number; name: string; drafts: number; draft_picks: number; draft_names: string[] }>(null);

  const add = async () => {
    if (!form.league_id) return;
    setBusy(true); setMsg(null);
    try {
      const lg = await api('/leagues', { method: 'POST', body: JSON.stringify(form) });
      const s = await api(`/leagues/${lg.id}/sync`, { method: 'POST' });
      setMsg(`Added and synced — ${s.teams} teams${s.fell_back ? `, using ${s.season_used} rosters (this season hasn’t drafted yet)` : ''}.${scoringNote(s.scoring)}`);
      setForm(f => ({ ...f, league_id: '', espn_s2: '', swid: '' }));
      refetch();
      setSel(lg.id);
    } catch (e: any) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  const sync = async (id: number) => {
    setBusy(true); setMsg(null);
    try {
      const s = await api(`/leagues/${id}/sync`, { method: 'POST' });
      setMsg(`Synced ${s.teams} teams · ${s.roster_players ?? 0} rostered players${s.fell_back ? ` (from ${s.season_used} — this season hasn’t drafted yet)` : ''}.${scoringNote(s.scoring)}`);
      refetch(); refetchAnalysis();
    }
    catch (e: any) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  const inspectRemoval = async (id: number, name: string) => {
    setBusy(true); setMsg(null);
    try {
      const impact = await api<any>(`/leagues/${id}/removal-impact`);
      setRemoval({ id, name, ...impact });
    } catch (e: any) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  const disconnect = async () => {
    if (!removal) return;
    setBusy(true);
    try {
      await api(`/leagues/${removal.id}`, { method: 'DELETE' });
      setMsg(`Disconnected ${removal.name}. Draft history and league data were retained.`);
      setRemoval(null); refetch();
    } catch (e: any) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      {view === 'leagues' && <>
      <Card>
        <h2 className="ds-h">Connect a league</h2>
        <p className="ds-note mt-0.5">Sleeper needs only the league id; a private ESPN league also needs its two cookies.</p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-600">Platform
            <select className="input block mt-1" value={form.platform}
              onChange={e => setForm(f => ({ ...f, platform: e.target.value }))}>
              <option value="sleeper">Sleeper</option>
              <option value="espn">ESPN</option>
            </select>
          </label>
          <label className="text-xs text-slate-600">League ID
            <input className="input block mt-1 w-48" placeholder={form.platform === 'sleeper' ? '1124...' : '1234567'}
              value={form.league_id} onChange={e => setForm(f => ({ ...f, league_id: e.target.value }))} />
          </label>
          <label className="text-xs text-slate-600">Season
            <input type="number" className="input block mt-1 w-24" value={form.season}
              onChange={e => setForm(f => ({ ...f, season: Number(e.target.value) }))} />
          </label>
          {form.platform === 'espn' && (
            <>
              <label className="text-xs text-slate-600">espn_s2
                <input className="input block mt-1 w-56 max-w-full font-mono" value={form.espn_s2}
                  onChange={e => setForm(f => ({ ...f, espn_s2: e.target.value }))} />
              </label>
              <label className="text-xs text-slate-600">SWID
                <input className="input block mt-1 w-48 max-w-full font-mono" value={form.swid}
                  onChange={e => setForm(f => ({ ...f, swid: e.target.value }))} />
              </label>
            </>
          )}
          <Button variant="primary" icon="refresh" onClick={add} disabled={busy || !form.league_id}
            title={!form.league_id ? 'Enter a league id first' : undefined}>{busy ? 'Working…' : 'Add and sync'}</Button>
        </div>
        {msg && <p role="status" className="ds-note mt-3">{msg}</p>}
      </Card>

      {leaguesLoading && !leagues.length && <PageLoading label="Loading your leagues…" />}
      {leaguesError && !leagues.length && <PageError message={leaguesError} onRetry={refetch} />}

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {leagues?.map(lg => {
          const on = sel === lg.id;
          return (
          <Card key={lg.id} className={`!p-4 ${on ? '!shadow-[0_0_0_2px_var(--c-accent)]' : ''}`}>
            <button type="button" className="block w-full min-w-0 text-left" aria-pressed={on} onClick={() => setSel(lg.id)}
              title={on ? 'The active league' : 'Make this the active league'}>
              <span className="flex min-w-0 items-center gap-2">
                <Chip tone={lg.platform === 'sleeper' ? 'accent' : 'bad'}>{lg.platform === 'sleeper' ? 'Sleeper' : 'ESPN'}</Chip>
                <span className="min-w-0 truncate font-semibold">{lg.name?.trim() ?? `League ${lg.league_id}`}</span>
                {on && <span className="ml-auto shrink-0"><Chip tone="good">Active</Chip></span>}
              </span>
              <span className="ds-note mt-1 block">
                {lg.team_count ?? '?'} teams · {lg.season}{lg.superflex ? ' · superflex' : ''}{lg.ppr === 1 ? ' · PPR' : lg.ppr === 0.5 ? ' · half-PPR' : ''}
                {' · '}{lg.fetched_at ? `synced ${new Date(`${lg.fetched_at}Z`).toLocaleString()}` : 'never synced'}
              </span>
            </button>
            {lg.connection_status && lg.connection_status !== 'connected' && (
              <p className="ds-chip ds-chip-warn mt-2 !whitespace-normal">
                {lg.connection_status === 'needs_reconnect' ? 'Credentials disconnected — reconnect to sync' : `Sync failed${lg.sync_error ? `: ${lg.sync_error}` : ''}`}
              </p>
            )}
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="quiet" icon="refresh" disabled={busy} onClick={() => sync(lg.id)}
                title={busy ? 'Another sync is running' : 'Pull rosters, scores and settings again'}>Sync</Button>
              <Button size="sm" disabled={busy} onClick={() => inspectRemoval(lg.id, lg.name ?? `League ${lg.league_id}`)}
                title={busy ? 'Another sync is running' : 'Stop syncing this league (its data stays)'}>Disconnect</Button>
            </div>
          </Card>
          );
        })}
      </div>
      {!leaguesLoading && !leaguesError && leagues?.length === 0 && <Card><EmptyState title="No leagues connected yet" description="Add one above; everything else in the app follows it." /></Card>}
      </>}

      {view === 'rosters' && <>
      {analysis?.league?.payload_season != null
        && analysis.league.payload_season !== analysis.league.season && (
        <Card className="!p-4 text-sm text-warn">
          These rosters are from the {analysis.league.payload_season} season, not {analysis.league.season}.
          ESPN returned no rosters for {analysis.league.season}, so the sync fell back to last year.
        </Card>
      )}

      {(analysis?.empty || analysis?.values_missing) && (
        <Card className="text-sm text-slate-500">
          <p>{analysis.message}</p>
          {analysis.coverage?.rostered_in_payload > 0 && (
            <p className="mt-2 text-xs text-slate-500">
              {analysis.coverage.matched_to_player_table} of {analysis.coverage.rostered_in_payload} rostered
              players matched the local player table, {analysis.coverage.priced} of them with a trade value.
            </p>
          )}
        </Card>
      )}

      {!analysis && <PageLoading label="Pricing every roster…" />}

      {analysis && !analysis.empty && !analysis.values_missing && (
        <Card pad={false} className="overflow-hidden">
          <div className="px-4 py-4 sm:px-5">
            <h2 className="ds-h">Roster strength by position</h2>
            <p className="ds-note mt-0.5">Starter value vs league average, priced off real FantasyCalc trade values. Under 80% = need, over 115% = surplus.</p>
            {analysis.coverage && analysis.coverage.matched_to_player_table < analysis.coverage.rostered_in_payload && (
              <p className="text-xs text-warn mt-1">
                Only {analysis.coverage.matched_to_player_table} of {analysis.coverage.rostered_in_payload} rostered
                players matched the local player table — the rest are missing from the rows below, so depth and
                starter value are both understated.
              </p>
            )}
          </div>
          {/* Desktop/tablet: the full comparison table. Hidden below sm because a
              wide table can only ever horizontal-scroll on a phone (UI-STANDARD #7
              rules that out) — the sm:hidden card list below is the phone view of
              the same data, not a scroll target. */}
          <div className="hidden sm:block overflow-x-auto">
            <table className="ds-table">
              <thead>
                <tr>
                  <th className="text-left px-4 py-2">Team</th>
                  {POS_ORDER.map(p => <th key={p} className="text-left px-3 py-2">{p}</th>)}
                  <th className="text-left px-4 py-2">Needs</th>
                </tr>
              </thead>
              <tbody>
                {analysis.rosters.map((ro: any) => (
                  <tr key={ro.roster_id} className="align-top">
                    <td className="px-4 py-2 font-medium whitespace-nowrap">{ro.owner}</td>
                    {POS_ORDER.map(pos => (
                      <td key={pos} className="px-3 py-2">
                        <StatusPill status={ro.positions[pos].status} ratio={ro.positions[pos].ratio} />
                        <div className="mt-1 space-y-0.5">
                          {ro.positions[pos].starters.slice(0, 3).map((s: any) => (
                            <div key={s.id} className="text-xs text-slate-600">
                              <PlayerName id={s.id}>{s.name}</PlayerName>
                            </div>
                          ))}
                        </div>
                      </td>
                    ))}
                    <td className="px-4 py-2 text-xs">
                      {ro.needs.length ? <span className="text-crit font-medium">{ro.needs.join(', ')}</span> : <span className="text-slate-500">balanced</span>}
                      {ro.surplus.length > 0 && <div className="text-good">has: {ro.surplus.join(', ')}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Phone: one card per team, stacked, no fixed-width row to overflow. */}
          <div className="sm:hidden ds-rows">
            {analysis.rosters.map((ro: any) => (
              <div key={ro.roster_id} className="p-4">
                <div className="font-medium text-sm mb-2">{ro.owner}</div>
                <div className="grid grid-cols-2 gap-3">
                  {POS_ORDER.map(pos => (
                    <div key={pos}>
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-[10px] font-bold text-slate-500">{pos}</span>
                        <StatusPill status={ro.positions[pos].status} ratio={ro.positions[pos].ratio} />
                      </div>
                      <div className="space-y-0.5">
                        {ro.positions[pos].starters.slice(0, 3).map((s: any) => (
                          <div key={s.id} className="text-xs text-slate-600 break-words">
                            <PlayerName id={s.id}>{s.name}</PlayerName>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-2 text-xs">
                  {ro.needs.length ? <span className="text-crit font-medium">Needs: {ro.needs.join(', ')}</span> : <span className="text-slate-500">balanced</span>}
                  {ro.surplus.length > 0 && <div className="text-good">has: {ro.surplus.join(', ')}</div>}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      </>}

      {removal && (
        <div className="ds-scrim grid place-items-center p-4" role="presentation" onMouseDown={() => !busy && setRemoval(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="disconnect-title" className="ds-card ds-card-pad w-full max-w-lg" onMouseDown={e => e.stopPropagation()}>
            <div className="ds-eyebrow">Safe disconnect</div>
            <h2 id="disconnect-title" className="ds-section-t">Disconnect {removal.name}?</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">ESPN cookies will be removed and live syncing will stop. The league itself stays in Gridiron HQ so nothing silently disappears.</p>
            <div className="mt-4 rounded-[var(--r-tile)] bg-[var(--c-soft)] p-4 text-sm">
              <div className="font-semibold">What will be retained</div>
              <ul className="mt-2 space-y-1 text-slate-600">
                <li>League settings and cached roster data</li>
                <li>{removal.drafts} draft{removal.drafts === 1 ? '' : 's'} and {removal.draft_picks} recorded pick{removal.draft_picks === 1 ? '' : 's'}</li>
                {removal.draft_names.slice(0, 3).map(name => <li key={name} className="truncate">“{name}”</li>)}
              </ul>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button onClick={() => setRemoval(null)} disabled={busy}>Cancel</Button>
              <Button variant="primary" onClick={disconnect} disabled={busy}>{busy ? 'Disconnecting…' : 'Disconnect credentials'}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
