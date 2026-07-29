import { useState } from 'react';
import { createPortal } from 'react-dom';
import { api, headshotUrl, useApi, Draft } from '../api';
import { Headshot, PosBadge } from './PlayerRow';
import { PlayerName } from './PlayerCard';

const GRADE_TONE = (g?: string) =>
  !g ? 'bg-slate-100 text-slate-600'
  : g.startsWith('A') ? 'bg-emerald-100 text-emerald-700'
  : g.startsWith('B') ? 'bg-sky-100 text-sky-700'
  : g.startsWith('C') ? 'bg-amber-100 text-amber-700'
  : 'bg-rose-100 text-rose-700';

export default function DraftRecap({ draft, open, onClose }: { draft: Draft; open: boolean; onClose: () => void }) {
  const { data: grade, refetch } = useApi<any>(open ? `/drafts/${draft.id}/grade` : null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const myPicks = draft.picks.filter(p => p.team_slot === draft.my_slot);
  const byPos: Record<string, typeof myPicks> = {};
  for (const p of myPicks) (byPos[p.position] ??= []).push(p);
  const order = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

  const analyze = async () => {
    setBusy(true); setErr(null);
    try { await api(`/drafts/${draft.id}/grade`, { method: 'POST' }); refetch(); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-start justify-center p-4 sm:p-8 overflow-y-auto"
      style={{ background: 'rgba(15,23,42,0.45)' }} onClick={onClose}>
      <section onClick={e => e.stopPropagation()} className="card w-full max-w-3xl mt-6 shadow-xl">
        <header className="flex items-center gap-3 px-5 py-4 border-b border-slate-200">
          <h2 className="text-lg font-bold text-slate-800">Draft Recap</h2>
          {grade?.grade && (
            <span className={`text-lg font-black px-3 py-1 rounded-lg ${GRADE_TONE(grade.grade)}`}>{grade.grade}</span>
          )}
          <span className="text-xs text-slate-400">{myPicks.length} picks · {draft.name}</span>
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-700 text-lg leading-none">✕</button>
        </header>

        <div className="p-5 space-y-5">
          {/* roster with headshots */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">Your team</h3>
            <div className="space-y-3">
              {order.filter(pos => byPos[pos]?.length).map(pos => (
                <div key={pos}>
                  <div className="text-[10px] font-bold text-slate-400 mb-1">{pos} ({byPos[pos].length})</div>
                  <div className="flex flex-wrap gap-2">
                    {byPos[pos].map(p => (
                      <div key={p.pick_number}
                        className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5">
                        <Headshot src={headshotUrl(p as any)} pos={p.position} size={30} />
                        <div className="min-w-0">
                          <PlayerName id={p.player_id} className="text-xs font-semibold block truncate max-w-[130px]">
                            {p.name}
                          </PlayerName>
                          <div className="text-[10px] text-slate-400">
                            R{Math.ceil(p.pick_number / draft.team_count)} · {p.team_abbr ?? 'FA'}
                            {p.projected_points != null && ` · ${Math.round(p.projected_points)} pts`}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* AI grade */}
          <div className="border-t border-slate-200 pt-4">
            <div className="flex items-center gap-2 mb-2">
              <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Claude&apos;s draft grade</h3>
              <button className="btn-ghost text-xs ml-auto" onClick={analyze} disabled={busy}>
                {busy ? 'Analyzing…' : grade ? '↻ Re-grade' : '✨ Grade my draft'}
              </button>
            </div>
            {err && <p className="text-xs text-rose-600 mb-2">{err}</p>}
            {grade ? (
              <div className="space-y-3">
                <p className="text-sm text-slate-700 leading-relaxed">{grade.summary}</p>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-600 mb-1">Strengths</div>
                    <ul className="text-xs text-slate-600 space-y-1 list-disc list-inside">
                      {(grade.strengths ?? []).map((x: string, i: number) => <li key={i}>{x}</li>)}
                    </ul>
                  </div>
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wide text-rose-600 mb-1">Weaknesses</div>
                    <ul className="text-xs text-slate-600 space-y-1 list-disc list-inside">
                      {(grade.weaknesses ?? []).map((x: string, i: number) => <li key={i}>{x}</li>)}
                    </ul>
                  </div>
                </div>
                <div className="grid sm:grid-cols-2 gap-3 text-xs">
                  {grade.best_pick && (
                    <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-2">
                      <span className="font-bold text-emerald-700">Best pick · </span>
                      <span className="text-slate-700">{grade.best_pick}</span>
                    </div>
                  )}
                  {grade.reach && (
                    <div className="rounded-lg bg-amber-50 border border-amber-200 p-2">
                      <span className="font-bold text-amber-700">Biggest reach · </span>
                      <span className="text-slate-700">{grade.reach}</span>
                    </div>
                  )}
                </div>
                {grade.generated_at && <p className="text-[10px] text-slate-400">graded {grade.generated_at}</p>}
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                Hit <strong>Grade my draft</strong> for a letter grade and a breakdown of roster construction,
                value, and where you reached. Needs an API key (Dev Hub, top right).
              </p>
            )}
          </div>
        </div>
      </section>
    </div>,
    document.body
  );
}
