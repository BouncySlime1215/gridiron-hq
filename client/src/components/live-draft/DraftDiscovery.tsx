import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api';
import {
  discoverLiveDrafts, startOrResumeLiveDraft, type DraftFixture
} from '../../services/liveDraft';

const STATUS_LABEL: Record<DraftFixture['status'], string> = {
  scheduled: 'Scheduled', active: 'In progress', completed: 'Completed'
};
const STATUS_TINT: Record<DraftFixture['status'], string> = {
  scheduled: 'bg-sky-100 text-sky-700', active: 'bg-emerald-100 text-emerald-700',
  completed: 'bg-slate-200 text-slate-600'
};

function formatWhen(iso: string | null) {
  if (!iso) return 'Time not set by ESPN yet';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Time not set by ESPN yet';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Guided team-confirmation control: shown only when ownership can't be proven from ESPN alone. */
function TeamConfirm({ fixture, onConfirmed }: { fixture: DraftFixture; onConfirmed: (teamId: number, slot: number) => void }) {
  const [choice, setChoice] = useState<number | ''>('');
  const options = useMemo(
    () => (fixture.pick_order ?? []).map((espnTeamId, i) => ({ espnTeamId, slot: i + 1 })),
    [fixture.pick_order]
  );

  const confirm = () => {
    if (choice === '') return;
    onConfirmed(Number(choice), options.findIndex(o => o.espnTeamId === Number(choice)) + 1);
  };

  return (
    <div role="group" aria-label="Confirm your ESPN team" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
      <p className="text-xs font-semibold text-amber-900">
        We couldn't confirm which team is yours in this league. Pick it before starting — no roster will be assigned automatically.
      </p>
      <div className="mt-2 flex gap-2 items-center flex-wrap">
        <label htmlFor={`team-${fixture.league_row_id}`} className="sr-only">Your ESPN team</label>
        <select id={`team-${fixture.league_row_id}`} className="input text-xs" value={choice}
          onChange={e => setChoice(e.target.value ? Number(e.target.value) : '')}>
          <option value="">Select your team…</option>
          {options.map(o => <option key={o.espnTeamId} value={o.espnTeamId}>Draft slot {o.slot}</option>)}
        </select>
        <button type="button" className="btn-primary text-xs" disabled={choice === ''} onClick={confirm}>
          Confirm my team
        </button>
      </div>
    </div>
  );
}

function FixtureCard({ fixture, onStarted }: { fixture: DraftFixture; onStarted: (draftId: number) => void }) {
  const [confirmedSlot, setConfirmedSlot] = useState<number | null>(fixture.ownership_confirmed ? fixture.my_slot : null);
  const [confirmedTeamId, setConfirmedTeamId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const canStart = fixture.ownership_confirmed || confirmedSlot != null;
  const actionLabel = fixture.local_draft_id != null
    ? (fixture.status === 'completed' ? 'View draft' : 'Resume Live Draft')
    : 'Start Live Draft';

  const start = async () => {
    setBusy(true); setErr(null);
    try {
      const out = await startOrResumeLiveDraft(fixture.league_row_id, confirmedTeamId ?? undefined);
      onStarted(out.draft_id);
    } catch (e: any) {
      const apiErr = e as ApiError;
      setErr(apiErr.code === 'ESPN_AUTHENTICATION_FAILED' || apiErr.code === 'ESPN_CREDENTIALS_INVALID'
        ? 'ESPN authentication expired — reconnect this league in Settings, then try again.'
        : apiErr.message ?? 'Could not reach ESPN. Try again.');
    } finally { setBusy(false); }
  };

  return (
    <div className="card p-4" data-testid="draft-fixture">
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="font-bold text-sm">{fixture.name}</h3>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${STATUS_TINT[fixture.status]}`}>
          {STATUS_LABEL[fixture.status]}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600">
        <div><dt className="inline text-slate-400">League ID </dt><dd className="inline">{fixture.league_id}</dd></div>
        <div><dt className="inline text-slate-400">Season </dt><dd className="inline">{fixture.season}</dd></div>
        <div><dt className="inline text-slate-400">Scheduled </dt><dd className="inline">{formatWhen(fixture.scheduled_at)}</dd></div>
        <div><dt className="inline text-slate-400">Teams </dt><dd className="inline">{fixture.team_count}</dd></div>
        <div><dt className="inline text-slate-400">Rounds </dt><dd className="inline">{fixture.rounds}</dd></div>
        <div><dt className="inline text-slate-400">Type </dt><dd className="inline">{fixture.draft_type}</dd></div>
        <div><dt className="inline text-slate-400">Pick timer </dt><dd className="inline">{fixture.pick_seconds}s</dd></div>
        <div><dt className="inline text-slate-400">Your team </dt>
          <dd className="inline">{fixture.my_team?.name ?? (confirmedSlot != null ? `Draft slot ${confirmedSlot}` : 'Not confirmed')}</dd></div>
        <div><dt className="inline text-slate-400">Your slot </dt><dd className="inline">{fixture.my_slot ?? confirmedSlot ?? '—'}</dd></div>
        <div className="col-span-2">
          <dt className="inline text-slate-400">Roster </dt>
          <dd className="inline">{Object.entries(fixture.roster_positions).map(([p, n]) => `${n} ${p}`).join(', ') || '—'}</dd>
        </div>
      </dl>

      {!canStart && <TeamConfirm fixture={fixture} onConfirmed={(teamId, slot) => {
        setConfirmedTeamId(teamId);
        setConfirmedSlot(slot);
      }} />}

      {err && <p role="alert" className="text-xs text-rose-700 mt-2">{err}</p>}
      <button type="button" className="btn-primary text-xs mt-3" disabled={!canStart || busy} onClick={start}
        title={!canStart ? 'Confirm your ESPN team before starting' : undefined}>
        {busy ? 'Connecting…' : actionLabel}
      </button>
    </div>
  );
}

export default function DraftDiscovery() {
  const [fixtures, setFixtures] = useState<DraftFixture[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();

  useEffect(() => {
    let cancelled = false;
    discoverLiveDrafts()
      .then(f => { if (!cancelled) setFixtures(f); })
      .catch(e => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Live Draft Hub</h1>
      <p className="text-sm text-slate-600 mb-6">
        Discover your ESPN drafts, confirm your team, and start or resume the live draft room.
      </p>
      {err && <p role="alert" className="text-sm text-rose-600 mb-3">{err}</p>}
      {!fixtures && !err && <p className="text-sm text-slate-500">Looking for your ESPN drafts…</p>}
      {fixtures && !fixtures.length && (
        <p className="text-sm text-slate-500">
          No ESPN drafts found. Connect a league on the Settings page first.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {fixtures?.map(f => (
          <FixtureCard key={f.league_row_id} fixture={f} onStarted={draftId => nav(`/live-draft/${draftId}`)} />
        ))}
      </div>
    </div>
  );
}
