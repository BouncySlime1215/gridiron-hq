import { useState } from 'react';
import type { ReactNode } from 'react';
import { api, useApi } from '../api';
import { useLeague } from '../state/league';

/**
 * One page that answers "what do I actually do to win this league".
 *
 * The ordering on this page is the argument it is making. Where you stand comes
 * first because every recommendation below is relative to it. Who will trade
 * with you comes second, because it is the constraint that decides which of the
 * moves below are real. The moves come last, ranked by how likely they are to
 * happen rather than by how much they would help — which is the whole reason
 * this exists separately from the trade finder.
 */

type Tier = 'never' | 'hard' | 'fair';

const TIER_STYLE: Record<Tier, string> = {
  never: 'bg-rose-50 text-rose-800 ring-rose-200',
  hard: 'bg-amber-50 text-amber-900 ring-amber-200',
  fair: 'bg-emerald-50 text-emerald-800 ring-emerald-200'
};
const TIER_SHORT: Record<Tier, string> = {
  never: 'Never trades',
  hard: 'Hard to deal with',
  fair: 'Will trade if fair'
};

export default function LeagueBrain() {
  const { activeId: leagueId } = useLeague();
  const [tab, setTab] = useState<'plan' | 'managers'>('plan');
  const plan = useApi<any>(leagueId ? `/trades/${leagueId}/brain/plan?limit=10` : null);
  const managers = useApi<any>(leagueId ? `/trades/${leagueId}/brain/managers` : null);

  if (!leagueId) return <Empty>Connect a league first.</Empty>;
  if (plan.error) return <Empty>{plan.error}</Empty>;

  const d = plan.data;

  return (
    <div className="mx-auto max-w-[1240px] space-y-5">
      <header>
        <div className="text-[11px] font-black uppercase tracking-[.16em] text-emerald-700">League brain</div>
        <h1 className="mt-1 text-3xl font-black tracking-tight text-slate-950">How you win this league</h1>
        <p className="mt-1.5 max-w-3xl text-sm leading-6 text-slate-600">
          Ranked by what will actually happen, not by what would help most. A trade that would
          add four points a week is worth nothing if the manager on the other end never
          answers — so every move here is scored as its gain multiplied by the odds it gets signed.
        </p>
      </header>

      {/* Where you stand */}
      {d && (
        <section className="surface-deep rounded-2xl p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[10px] font-black uppercase tracking-[.15em] text-emerald-300">Where you stand</div>
              <div className="mt-1.5 flex items-baseline gap-3">
                <span className="text-4xl font-black tabular-nums text-white">{d.rank}<span className="text-lg text-slate-400">/{d.of}</span></span>
                <span className="text-sm text-slate-300">{d.lineup_points} pts/wk · {d.gap_to_first} behind first</span>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">{d.summary}</p>
            </div>
            {/* Every position, always — a dash where a label happened not to
                fire tells you nothing about the roster. */}
            <div className="grid grid-cols-4 gap-px overflow-hidden rounded-xl bg-white/10">
              {(d.position_ranks ?? []).slice().sort((a: any, b: any) =>
                ['QB', 'RB', 'WR', 'TE'].indexOf(a.position) - ['QB', 'RB', 'WR', 'TE'].indexOf(b.position)
              ).map((p: any) => (
                <div key={p.position} className="bg-slate-900/80 px-3.5 py-2 text-center">
                  <div className="text-[10px] font-black uppercase tracking-wide text-slate-400">{p.position}</div>
                  <div className={`mt-0.5 text-sm font-black tabular-nums ${
                    p.status === 'weakness' ? 'text-rose-300'
                      : p.status === 'strength' ? 'text-emerald-300' : 'text-slate-200'}`}>
                    {p.rank != null ? `${p.rank}/${p.of}` : '—'}
                  </div>
                  {p.position === d.biggest_need &&
                    <div className="mt-0.5 text-[9px] font-black uppercase tracking-wide text-amber-300">Target</div>}
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <nav className="flex gap-1 border-b border-slate-200">
        {([['plan', 'The plan'], ['managers', 'Who will trade']] as [typeof tab, string][]).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-bold transition ${
              tab === id ? 'border-emerald-500 text-emerald-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
            {label}
          </button>
        ))}
      </nav>

      {tab === 'plan' && (
        <div className="space-y-3">
          {d?.ranking_note && (
            <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-700">
              {d.ranking_note}
            </p>
          )}
          {!plan.loading && !d?.moves?.length && (
            <Empty>
              No deal on the board improves your lineup and stands a real chance of being accepted.
              That is a finding, not a failure — it usually means your roster has no exploitable
              mismatch with anyone right now. Check back after the next injury report.
            </Empty>
          )}
          {d?.moves?.map((m: any, i: number) => <Move key={i} m={m} rank={i + 1} />)}
          {d?.unreachable?.length > 0 && (
            <p className="text-xs text-slate-500">
              Skipped entirely: <b>{d.unreachable.join(', ')}</b> — marked as never trading.
            </p>
          )}
          {d?.assumptions && (
            <details className="rounded-xl border border-slate-200 bg-white p-4">
              <summary className="cursor-pointer text-sm font-bold text-slate-700">What this is assuming</summary>
              <ul className="mt-2 space-y-1.5 text-sm leading-6 text-slate-600">
                {d.assumptions.map((a: string, i: number) => <li key={i} className="flex gap-2"><span className="text-slate-300">—</span>{a}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* Both refetches, deliberately: the whole point of setting a tier is that
          the plan re-ranks around it, and refreshing only the manager list left
          the plan showing recommendations for someone just marked unreachable. */}
      {tab === 'managers' && <Managers leagueId={leagueId}
        data={managers.data}
        refetch={() => { managers.refetch(); plan.refetch(); }} />}
    </div>
  );
}

function Move({ m, rank }: { m: any; rank: number }) {
  const [open, setOpen] = useState(rank === 1);
  const acc = Math.round(m.accept_probability * 100);
  return (
    <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <button onClick={() => setOpen(v => !v)} className="flex w-full items-center gap-4 p-4 text-left hover:bg-slate-50">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-900 text-sm font-black text-white">{rank}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="font-bold text-rose-700">{m.you_send.map((p: any) => p.name).join(' + ')}</span>
            <span className="text-slate-400">→</span>
            <span className="font-bold text-emerald-700">{m.you_get.map((p: any) => p.name).join(' + ')}</span>
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            with <b className="text-slate-700">{m.partner}</b>
            <span className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-bold ring-1 ${TIER_STYLE[m.tier as Tier]}`}>
              {TIER_SHORT[m.tier as Tier]}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-5 text-right">
          <Metric label="You gain" value={`+${m.my_ppg_gain}`} unit="ppg" tone="good" />
          <Metric label="They sign it" value={`${acc}%`} tone={acc >= 50 ? 'good' : acc >= 25 ? 'warn' : 'bad'} />
          <Metric label="Worth" value={String(m.expected_value)} unit="ppg" />
        </div>
      </button>
      {open && (
        <div className="space-y-3 border-t border-slate-100 bg-slate-50 px-4 py-4">
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <div className="text-[10px] font-black uppercase tracking-wide text-slate-400">Send this</div>
            <p className="mt-1 text-sm leading-6 text-slate-800">{m.pitch.text}</p>
            <p className="mt-1.5 border-t border-slate-100 pt-1.5 text-xs text-slate-500">{m.pitch.reasoning}</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-4">
            <Detail label="Their lineup" value={`${m.their_ppg_gain >= 0 ? '+' : ''}${m.their_ppg_gain} ppg`}
              hint={m.their_ppg_gain > 0 ? 'It helps them too — that is why it can be signed' : 'It costs them, so expect a counter'} />
            <Detail label="Value split" value={`${m.their_value_edge_pct >= 0 ? '+' : ''}${m.their_value_edge_pct}% to them`}
              hint="Share of the value crossing the table" />
            <Detail label="Mutual surplus" value={m.nash_product > 0 ? String(m.nash_product) : 'none'}
              hint={m.nash_product > 0 ? 'Both lineups improve — the range deals get signed in' : 'Only one side gains, so this is an ask'} />
            <Detail label="Hurts a threat" value={m.denial_value > 0 ? String(m.denial_value) : '—'}
              hint="Weighted by how likely they were to beat you" />
          </div>
        </div>
      )}
    </article>
  );
}

function Metric({ label, value, unit, tone }: { label: string; value: string; unit?: string; tone?: 'good' | 'warn' | 'bad' }) {
  const color = tone === 'good' ? 'text-emerald-700' : tone === 'warn' ? 'text-amber-700' : tone === 'bad' ? 'text-rose-700' : 'text-slate-900';
  return (
    <div className="hidden sm:block">
      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`text-sm font-black tabular-nums ${color}`}>{value}{unit && <span className="ml-0.5 text-[10px] font-bold text-slate-400">{unit}</span>}</div>
    </div>
  );
}

function Detail({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-[10px] font-black uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-0.5 text-sm font-black tabular-nums text-slate-900">{value}</div>
      <div className="mt-0.5 text-[11px] leading-4 text-slate-500">{hint}</div>
    </div>
  );
}

function Managers({ leagueId, data, refetch }: { leagueId: string | number; data: any; refetch: () => void }) {
  const [saving, setSaving] = useState<string | null>(null);

  const set = async (rosterId: string, tier: Tier, owner: string) => {
    setSaving(rosterId);
    try {
      await api(`/trades/${leagueId}/brain/managers/${rosterId}`, {
        method: 'POST', body: JSON.stringify({ tradeability: tier, owner })
      });
      refetch();
    } finally { setSaving(null); }
  };

  if (!data) return <Empty>Loading managers…</Empty>;

  return (
    <div className="space-y-3">
      <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-700">
        You know things about these people that no model can find in the data — there is not
        enough trade history in any fantasy league to learn it. Set each one here and the plan
        re-ranks around it. Anyone marked <b>never trades</b> is dropped from planning entirely
        rather than shown at the bottom of a list.
      </p>
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        {data.managers?.filter((m: any) => m.roster_id !== data.my_roster_id).map((m: any) => (
          <div key={m.roster_id} className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-3 last:border-0">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-slate-900">{m.owner}</div>
              <div className="text-[11px] text-slate-400">{m.is_set ? 'Set by you' : 'Default — assumed tradeable'}</div>
            </div>
            <div className="flex gap-1" role="group" aria-label={`Tradeability for ${m.owner}`}>
              {(['fair', 'hard', 'never'] as Tier[]).map(t => (
                <button key={t} onClick={() => set(m.roster_id, t, m.owner)} disabled={saving === m.roster_id}
                  aria-pressed={m.tradeability === t}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-bold ring-1 transition disabled:opacity-50 ${
                    m.tradeability === t ? TIER_STYLE[t] : 'bg-white text-slate-500 ring-slate-200 hover:bg-slate-50'}`}>
                  {TIER_SHORT[t]}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const Empty = ({ children }: { children: ReactNode }) =>
  <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm leading-6 text-slate-500">{children}</div>;
