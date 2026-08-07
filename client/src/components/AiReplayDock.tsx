import { Link } from 'react-router-dom';
import { useApi } from '../api';

interface ReplayRun {
  id: number;
  status: 'running' | 'complete' | 'failed';
  error?: string | null;
  progress: { current: number; total: number; season?: number; week?: number; game?: string; state?: string };
}

export default function AiReplayDock() {
  const { data } = useApi<{ run: ReplayRun | null }>('/nfl-betting/ai-replay/latest');
  const run = data?.run;
  if (!run) return null;
  const active = run.status === 'running';
  const failed = run.status === 'failed';
  const p = run.progress;
  return <Link to="/betting/training" aria-label={`Open AI replay run ${run.id}`}
    className={`fixed bottom-5 right-5 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border bg-white p-4 text-left shadow-2xl transition hover:-translate-y-0.5 ${active ? 'border-blue-300' : failed ? 'border-rose-300' : 'border-emerald-300'}`}>
    <div className={`flex items-center gap-2 text-[10px] font-black uppercase tracking-wide ${active ? 'text-blue-700' : failed ? 'text-rose-700' : 'text-emerald-700'}`}>
      <span className={`h-2.5 w-2.5 rounded-full ${active ? 'animate-pulse bg-blue-600' : failed ? 'bg-rose-500' : 'bg-emerald-500'}`} />
      AI replay #{run.id} · {active ? 'running' : failed ? 'needs attention' : 'complete'}
    </div>
    <div className="mt-1 truncate text-sm font-bold text-slate-900">{active ? (p.state ?? 'Preparing replay') : failed ? (run.error ?? 'Run failed') : 'Report ready'}</div>
    <div className="mt-1 flex items-center justify-between gap-3 text-xs text-slate-500">
      <span>{p.season ? `${p.season}${p.week ? ` · W${p.week}` : ''}` : 'Saved run'}{p.game ? ` · ${p.game}` : ''}</span>
      <span className="shrink-0 font-bold text-slate-700">{active ? 'Reattach' : 'Open logs'} →</span>
    </div>
  </Link>;
}
