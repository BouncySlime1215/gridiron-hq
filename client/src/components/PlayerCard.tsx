import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi } from '../api';
import { Trend } from './PlayerRow';

const Ctx = createContext<(id: number) => void>(() => {});
export const usePlayerCard = () => useContext(Ctx);

/** Any player name, anywhere. Renders as a clickable chip that opens the pop-out. */
export function PlayerName({ id, children, className = '' }: { id: number; children: ReactNode; className?: string }) {
  const open = usePlayerCard();
  return (
    <button onClick={e => { e.preventDefault(); e.stopPropagation(); open(id); }}
      className={`text-left hover:text-emerald-700 hover:underline decoration-dotted underline-offset-2 ${className}`}>
      {children}
    </button>
  );
}

const VERDICT_STYLE: Record<string, string> = {
  BUY: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  SELL: 'bg-rose-100 text-rose-700 border-rose-300',
  HOLD: 'bg-slate-100 text-slate-600 border-slate-300'
};

function Card({ id, onClose }: { id: number; onClose: () => void }) {
  const { data: p, loading, refetch } = useApi<any>(`/players/${id}`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const analyze = async () => {
    setBusy(true); setErr(null);
    try { await api(`/players/${id}/analyze`, { method: 'POST' }); refetch(); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const m = p?.metrics ?? {};

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8 overflow-y-auto"
      style={{ background: 'rgba(15,23,42,0.4)' }} onClick={onClose}>
      <div className="card w-full max-w-2xl mt-8 shadow-xl" onClick={e => e.stopPropagation()}>
        {loading || !p ? (
          <div className="p-8 text-sm text-slate-500">Loading player…</div>
        ) : (
          <>
            <div className="flex items-start gap-4 p-5 border-b border-slate-200">
              <div className="w-16 h-16 rounded-full bg-slate-100 overflow-hidden shrink-0 grid place-items-center">
                {p.headshot
                  ? <img src={p.headshot} alt="" className="w-full h-full object-cover"
                      onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  : <span className="text-lg font-black text-slate-400">{p.position}</span>}
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-xl font-bold leading-tight">{p.name}</h2>
                <div className="text-xs text-slate-500 mt-0.5">
                  <span className={`font-bold pos-${p.position}`}>{p.position}</span>
                  {p.team_abbr && <> · <Link to={`/teams/${p.team_abbr}`} onClick={onClose}
                    className="hover:text-emerald-700 hover:underline">{p.team_name}</Link></>}
                  {p.head_coach && <> · HC {p.head_coach}</>}
                </div>
                {p.ranks?.length > 0 && (
                  <div className="text-xs text-slate-600 mt-1">
                    {p.ranks.map((rk: any) => <span key={rk.set_name} className="mr-3">
                      <span className="font-bold text-emerald-700">#{rk.rank}</span> on {rk.set_name}
                    </span>)}
                  </div>
                )}
              </div>
              <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-lg leading-none">✕</button>
            </div>

            <div className="grid grid-cols-4 gap-px bg-slate-200 border-b border-slate-200">
              {[['Market value', m.fc_value != null ? Math.round(m.fc_value) : '—'],
                ['30-day trend', <Trend value={m.fc_value} trend={m.fc_trend30} />],
                ['ADP', m.ffc_adp != null ? m.ffc_adp.toFixed(1) : m.fc_adp != null ? m.fc_adp.toFixed(1) : '—'],
                ['Sleeper rank', m.sleeper_rank != null ? Math.round(m.sleeper_rank) : '—']].map(([label, val], i) => (
                <div key={i} className="bg-white px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
                  <div className="text-sm font-bold text-slate-800">{val as any}</div>
                </div>
              ))}
            </div>

            <div className="p-5 space-y-4">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="text-sm font-bold text-slate-700">Buy or Sell — 2026</h3>
                  {p.verdict?.verdict && (
                    <span className={`text-xs font-black px-2 py-0.5 rounded border ${VERDICT_STYLE[p.verdict.verdict] ?? ''}`}>
                      {p.verdict.verdict}
                    </span>
                  )}
                  <button className="btn-ghost text-xs ml-auto" onClick={analyze} disabled={busy}>
                    {busy ? 'Analyzing…' : p.verdict ? '↻ Re-analyze' : '✨ Get verdict'}
                  </button>
                </div>
                {err && <p className="text-xs text-rose-600 mb-2">{err}</p>}
                {p.verdict?.reasoning ? (
                  <p className="text-sm text-slate-700 leading-relaxed">{p.verdict.reasoning}</p>
                ) : (
                  <p className="text-xs text-slate-500">No verdict yet — hit “Get verdict” for a buy/sell call grounded in his scheme fit, depth chart competition, market trend and recent news.</p>
                )}
                {p.verdict?.generated_at && <p className="text-[10px] text-slate-400 mt-1">as of {p.verdict.generated_at}</p>}
              </div>

              {p.off_scheme_detail && (
                <div>
                  <h3 className="text-sm font-bold text-slate-700 mb-1">Scheme &amp; situation</h3>
                  <p className="text-sm text-slate-600 leading-relaxed">{p.off_scheme_detail}</p>
                </div>
              )}

              <div>
                <h3 className="text-sm font-bold text-slate-700 mb-1">Recent news</h3>
                {(p.news ?? []).length === 0 ? (
                  <p className="text-xs text-slate-500">No stories mentioning {p.name.split(' ').slice(-1)[0]} yet.</p>
                ) : (
                  <div className="space-y-2">
                    {p.news.slice(0, 6).map((n: any) => (
                      <div key={n.id} className="border-l-2 border-slate-200 pl-3">
                        <div className="text-[11px] text-slate-400">{n.date}{n.source && ` · ${n.source}`}</div>
                        <div className="text-sm text-slate-700">{n.headline}</div>
                        {n.fantasy_impact && <div className="text-xs text-amber-600 mt-0.5">🎯 {n.fantasy_impact}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <Link to={`/players/${p.id}`} onClick={onClose}
                className="text-xs text-emerald-600 hover:underline inline-block">
                full page (X&apos;s and O&apos;s, unit analysis) →
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function PlayerCardProvider({ children }: { children: ReactNode }) {
  const [id, setId] = useState<number | null>(null);
  const open = useCallback((pid: number) => setId(pid), []);
  return (
    <Ctx.Provider value={open}>
      {children}
      {id != null && <Card id={id} onClose={() => setId(null)} />}
    </Ctx.Provider>
  );
}
