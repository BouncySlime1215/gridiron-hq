import { useState } from 'react';
import { api, useApi } from '../api';
import { usePlayerCard } from '../components/PlayerCard';

const WINDOW_TONE: Record<string, string> = {
  Juggernaut: 'bg-violet-100 text-violet-700 border-violet-300',
  'Win-now': 'bg-amber-100 text-amber-700 border-amber-300',
  Contender: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  Balanced: 'bg-slate-100 text-slate-600 border-slate-300',
  Retool: 'bg-sky-100 text-sky-700 border-sky-300',
  Rebuild: 'bg-blue-100 text-blue-700 border-blue-300',
  Reset: 'bg-rose-100 text-rose-700 border-rose-300'
};

const Chip = ({ label }: { label: string }) => (
  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${WINDOW_TONE[label] ?? WINDOW_TONE.Balanced}`}>
    {label}
  </span>
);

/**
 * Player chip. Shows market price rather than VOR: these are trade assets, and a bench
 * player's VOR is negative by construction (he sits behind a startable player), which
 * reads as though he is worthless.
 */
const P = ({ p }: { p: any }) => {
  const open = usePlayerCard();
  return (
    <button onClick={() => open(p.id)} className="hover:text-emerald-700 hover:underline">
      <span className={`text-[9px] font-black mr-1 pos-${p.position}`}>{p.position}</span>{p.name}
      {p.value > 0 && <span className="text-emerald-700 font-semibold ml-1">{p.value.toLocaleString()}</span>}
      {p.age != null && <span className="text-slate-400 ml-1">{p.age}y</span>}
    </button>
  );
};

export default function TradeLab() {
  const { data: leagues } = useApi<any[]>('/leagues');
  const [lid, setLid] = useState<number | null>(null);
  const active = lid ?? leagues?.[0]?.id ?? null;
  const { data: analysis } = useApi<any>(active ? `/tradelab/${active}/analysis` : null);
  const { data: partners } = useApi<any>(active ? `/tradelab/${active}/partners` : null);
  const { data: trending } = useApi<any[]>('/tradelab/trending');
  const [pitch, setPitch] = useState<any>(null);
  const [pitchFor, setPitchFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const makePitch = async (targetId: any, owner: string) => {
    setBusy(true); setErr(null); setPitchFor(owner);
    try {
      setPitch(await api(`/tradelab/${active}/pitch`, {
        method: 'POST', body: JSON.stringify({ target_id: targetId })
      }));
    } catch (e: any) { setErr(e.message); setPitch(null); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="text-2xl font-bold">Trade Lab</h1>
        {leagues && leagues.length > 1 && (
          <select className="input" value={active ?? ''} onChange={e => setLid(Number(e.target.value))}>
            {leagues.map(l => <option key={l.id} value={l.id}>{l.name ?? l.league_id}</option>)}
          </select>
        )}
        <button className="btn-ghost ml-auto" onClick={async () => { await api('/tradelab/trending/sync', { method: 'POST' }); location.reload(); }}>
          ↻ Sync trending
        </button>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        Every roster scored on contention window and positional need, then partners ranked by two-way fit.
      </p>

      {analysis?.empty && <div className="card p-6 text-sm text-slate-500">{analysis.message}</div>}

      {/* my position + ranked partners */}
      {partners?.me && (
        <div className="card p-4 mb-4 border-emerald-200">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold uppercase tracking-wide text-slate-400">You</span>
            <span className="font-bold text-slate-800">{partners.me.owner}</span>
            <Chip label={partners.me.window.label} />
          </div>
          <p className="text-xs text-slate-600 mt-1">{partners.me.window.stance}</p>
          <div className="flex gap-4 mt-2 text-xs flex-wrap">
            <span><span className="font-bold text-rose-600">Needs:</span> {partners.me.needs.map((n: any) => `${n.position} (gap ${n.gap})`).join(', ') || 'none'}</span>
            <span><span className="font-bold text-emerald-600">Surplus:</span> {partners.me.surplus.map((s: any) => s.position).join(', ') || 'none'}</span>
          </div>
          {partners.me.picks_value > 0 && (
            <div className="flex gap-4 mt-2 text-xs flex-wrap text-slate-600">
              <span title={partners.me.picks.map((p: any) => p.label).join(', ')}>
                <span className="font-bold text-slate-500">Draft capital:</span>{' '}
                {partners.me.picks_value.toLocaleString()} across {partners.me.picks.length} picks
              </span>
              <span>
                <span className="font-bold text-slate-500">Total capital:</span>{' '}
                {partners.me.market_capital.toLocaleString()}
              </span>
            </div>
          )}
        </div>
      )}

      <div className="grid lg:grid-cols-[1fr_320px] gap-4">
        <div className="space-y-3">
          <h2 className="text-sm font-bold text-slate-700">Best trade partners</h2>
          {(partners?.matches ?? []).map((m: any) => (
            <div key={m.roster_id} className={`card p-4 ${m.two_way ? 'border-emerald-300' : ''}`}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-slate-800">{m.owner}</span>
                <Chip label={m.window.label} />
                {m.two_way && <span className="text-[10px] font-black text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full">TWO-WAY FIT</span>}
                <span className="text-[10px] text-slate-400">fit score {m.score}</span>
                <button className="btn-primary ml-auto text-xs" disabled={busy}
                  onClick={() => makePitch(m.roster_id, m.owner)}>
                  {busy && pitchFor === m.owner ? 'Writing…' : '✨ Build the offer'}
                </button>
              </div>
              <p className="text-[11px] text-slate-500 mt-1">{m.window.stance}</p>
              {m.picks_value > 0 && (
                <p className="text-[11px] text-slate-500 mt-1" title={m.picks.map((p: any) => p.label).join(', ')}>
                  draft capital {m.picks_value.toLocaleString()} ({m.picks.length} picks) · total {m.market_capital.toLocaleString()}
                </p>
              )}

              <div className="grid sm:grid-cols-2 gap-3 mt-3">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-600 mb-1">
                    They can send you
                  </div>
                  {m.they_send.length ? m.they_send.map((s: any) => (
                    <div key={s.position} className="text-xs text-slate-600 mb-1">
                      <span className="font-bold">{s.position}</span> ({s.ratio}x avg) —{' '}
                      {s.players.slice(0, 3).map((p: any, i: number) => (
                        <span key={p.id}>{i > 0 && ', '}<P p={p} /></span>
                      ))}
                    </div>
                  )) : <p className="text-xs text-slate-400">nothing at your needs</p>}
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500 mb-1">
                    You can send them
                  </div>
                  {m.i_send.length ? m.i_send.map((s: any) => (
                    <div key={s.position} className="text-xs text-slate-600 mb-1">
                      <span className="font-bold">{s.position}</span> —{' '}
                      {s.players.slice(0, 3).map((p: any, i: number) => (
                        <span key={p.id}>{i > 0 && ', '}<P p={p} /></span>
                      ))}
                    </div>
                  )) : <p className="text-xs text-slate-400">nothing they need</p>}
                </div>
              </div>

              {pitchFor === m.owner && err && <p className="text-xs text-rose-600 mt-3">{err}</p>}
              {pitchFor === m.owner && pitch && (
                <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/40 p-3 space-y-2">
                  {(['anchor', 'fair'] as const).map(k => pitch[k] && (
                    <div key={k} className="text-xs">
                      <span className="font-black uppercase text-emerald-700">{k === 'anchor' ? 'Open with' : 'Settle at'}</span>{' '}
                      <span className="text-slate-700">
                        give {pitch[k].i_give?.join(', ')} → get {pitch[k].i_get?.join(', ')}
                      </span>
                      <div className="text-slate-500">{pitch[k].why}</div>
                    </div>
                  ))}
                  {pitch.walk_away && <div className="text-xs"><span className="font-black uppercase text-rose-600">Walk away</span> <span className="text-slate-600">{pitch.walk_away}</span></div>}
                  {pitch.read && <div className="text-xs"><span className="font-black uppercase text-slate-500">Their likely counter</span> <span className="text-slate-600">{pitch.read}</span></div>}
                  {pitch.pitch && (
                    <div className="bg-white rounded-lg border border-slate-200 p-2.5">
                      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">Message to send</div>
                      <p className="text-xs text-slate-700 italic">{pitch.pitch}</p>
                      <button className="text-[10px] text-emerald-600 mt-1 hover:underline"
                        onClick={() => navigator.clipboard?.writeText(pitch.pitch)}>copy</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {partners && partners.matches?.length === 0 && (
            <div className="card p-6 text-sm text-slate-500">
              No fits right now — nobody has surplus at your needs. Check back after a few waiver moves.
            </div>
          )}
        </div>

        {/* league windows + trending */}
        <div className="space-y-4">
          <div className="card overflow-hidden">
            <div className="px-3 py-2 bg-slate-50 border-b border-slate-200">
              <h3 className="text-sm font-bold text-slate-700">League windows</h3>
            </div>
            <div className="divide-y divide-slate-100 max-h-[40vh] overflow-y-auto">
              {(analysis?.teams ?? []).slice().sort((a: any, b: any) => b.competitiveness - a.competitiveness).map((t: any) => (
                <div key={t.roster_id} className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold truncate flex-1">{t.owner}</span>
                    <Chip label={t.window.label} />
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5">
                    capital {t.competitiveness}x · core age {t.core_age ?? '—'}
                    {t.picks_value > 0 && (
                      <span title={t.picks.map((p: any) => p.label).join(', ')}>
                        {' '}· picks {t.picks_value.toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card overflow-hidden">
            <div className="px-3 py-2 bg-slate-50 border-b border-slate-200">
              <h3 className="text-sm font-bold text-slate-700">Trending (24h, Sleeper)</h3>
            </div>
            <div className="divide-y divide-slate-100 max-h-[40vh] overflow-y-auto">
              {(trending ?? []).slice(0, 20).map(t => (
                <div key={t.player_id} className="px-3 py-1.5 flex items-center gap-2 text-xs">
                  <span className={t.kind === 'add' ? 'text-emerald-600' : 'text-rose-600'}>
                    {t.kind === 'add' ? '▲' : '▼'}
                  </span>
                  <P p={{ id: t.player_id, name: t.name, position: t.position, vor: '' }} />
                  <span className="ml-auto text-slate-400 tabular-nums">{(t.count / 1000).toFixed(0)}k</span>
                </div>
              ))}
              {(trending ?? []).length === 0 && <p className="p-3 text-xs text-slate-500">Hit “Sync trending”.</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
