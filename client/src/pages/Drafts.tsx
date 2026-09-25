import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, useApi } from '../api';
import { PageData, EmptyState, PageError } from '../components/PageState';
import { Button, Card, Chip } from '../components/ui/DesignSystem';

export default function Drafts() {
  const { data: drafts, loading, error, refetch } = useApi<any[]>('/drafts');
  const { data: sets, error: setsError } = useApi<any[]>('/rankings');
  const nav = useNavigate();
  const [form, setForm] = useState({ name: '', type: 'mock', team_count: 12, rounds: 16, my_slot: 1, ranking_set_id: 0, pick_seconds: 90 });
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const create = async () => {
    setCreateError(null);
    try {
      const d = await api('/drafts', {
        method: 'POST',
        body: JSON.stringify({ ...form, ranking_set_id: form.ranking_set_id || sets?.[0]?.id || null })
      });
      nav(`/draft/${d.id}`);
    } catch (e: any) {
      setCreateError(e.message || 'Failed to create draft');
    }
  };

  return (
    <div>
      <Card className="mb-6">
      <h2 className="ds-h">New board</h2>
      <p className="ds-note mt-0.5 mb-4">A mock draft against the computer, or a manual tracker you fill in as picks come off a real board. Best available follows <em>your</em> rankings.</p>
      <div className="flex flex-wrap gap-3 items-end">
        <label className="text-xs text-slate-600">Name
          <input className="input block mt-1" placeholder="e.g. Main league live draft"
            value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        </label>
        <label className="text-xs text-slate-600">Type
          <select className="input block mt-1" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
            <option value="mock">Mock draft</option>
            {/* Not the ESPN live link (Draft → Live): a board you fill in by hand. */}
            <option value="live_tracking">Manual tracker</option>
          </select>
        </label>
        <label className="text-xs text-slate-600">Teams
          <input type="number" min={2} max={20} className="input block mt-1 w-20" value={form.team_count}
            onChange={e => setForm(f => {
              const team_count = Number(e.target.value);
              return { ...f, team_count, my_slot: Math.min(f.my_slot, team_count) };
            })} />
        </label>
        <label className="text-xs text-slate-600">Rounds
          <input type="number" min={1} max={30} className="input block mt-1 w-20" value={form.rounds}
            onChange={e => setForm(f => ({ ...f, rounds: Number(e.target.value) }))} />
        </label>
        <label className="text-xs text-slate-600">My pick slot
          <input type="number" min={1} max={form.team_count} className="input block mt-1 w-20" value={form.my_slot}
            onChange={e => setForm(f => ({ ...f, my_slot: Number(e.target.value) }))} />
        </label>
        <label className="text-xs text-slate-600">Clock (sec)
          <select className="input block mt-1 w-24" value={form.pick_seconds}
            onChange={e => setForm(f => ({ ...f, pick_seconds: Number(e.target.value) }))}>
            {[30, 60, 90, 120, 180].map(s => <option key={s} value={s}>{s}s</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-600">Ranking set
          <select className="input block mt-1" value={form.ranking_set_id}
            onChange={e => setForm(f => ({ ...f, ranking_set_id: Number(e.target.value) }))}>
            <option value={0}>— default —</option>
            {sets?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {setsError && <span className="block text-[11px] text-rose-600 mt-1">Couldn't load ranking sets: {setsError}</span>}
        </label>
        <Button variant="primary" onClick={create} disabled={!form.name} title={!form.name ? 'Give the draft a name first' : undefined}>Start draft</Button>
      </div>
      </Card>

      {createError && <div className="mb-4"><PageError message={createError} onRetry={create} /></div>}
      {deleteError && <div className="mb-4"><PageError message={deleteError} onRetry={() => setDeleteError(null)} /></div>}

      <PageData data={drafts} loading={loading} error={error} onRetry={refetch}
        loadingLabel="Loading drafts…"
        isEmpty={ds => ds.length === 0}
        empty={<EmptyState title="No drafts yet" description="Start a mock draft or track a live one using the form above." />}>
        {(drafts) => (
          <div className="grid md:grid-cols-2 gap-3">
            {drafts.map(d => (
              <Link key={d.id} to={d.type === 'live' ? `/draft/live/${d.id}` : `/draft/${d.id}`} className="ds-card ds-lift p-4 block">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-semibold">{d.name}</span>
                  <Chip tone={d.type === 'mock' ? 'accent' : 'neutral'}>{d.type === 'mock' ? 'Mock' : d.type === 'live' ? 'ESPN live' : 'Manual tracker'}</Chip>
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  {d.team_count} teams · {d.rounds} rounds · pick {d.my_slot} · {d.picks_made} picks made
                </div>
                <div className="text-xs text-slate-500 mt-0.5">board: {d.ranking_set_name ?? '—'}</div>
                <button
                  className="text-xs text-crit hover:underline mt-2"
                  onClick={async e => {
                    e.preventDefault();
                    if (confirm('Delete this draft?')) {
                      try {
                        await api(`/drafts/${d.id}`, { method: 'DELETE' });
                        refetch();
                      } catch (err: any) {
                        setDeleteError(err.message || 'Failed to delete draft');
                      }
                    }
                  }}>
                  delete
                </button>
              </Link>
            ))}
          </div>
        )}
      </PageData>
    </div>
  );
}
