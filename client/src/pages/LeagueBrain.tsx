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
        {d?.model_context && <p className="mt-2 inline-flex rounded-full bg-sky-50 px-3 py-1 text-[11px] font-bold text-sky-800 ring-1 ring-sky-200">
          Live Week {d.model_context.week} board · evidence through {d.model_context.cutoff}
        </p>}
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
        <div className="space-y-4">
          {/* The single best move, whatever kind it is. A waiver claim needing
              nobody's consent routinely beats every trade, and burying that
              under a list of deals is how the old page hid its best answer. */}
          {d?.all_moves?.length > 0 && <TopMove m={d.all_moves[0]} note={d.best_move_note} />}

          {d?.all_moves?.length > 1 && (
            <section>
              <SectionHead title="Everything else, ranked together"
                detail="Waiver claims and trades on one scale, because the only question is what a move is worth times the odds it happens." />
              <div className="space-y-2">
                {d.all_moves.slice(1).map((m: any, i: number) => <Move key={i} m={m} rank={i + 2} />)}
              </div>
            </section>
          )}

          {!plan.loading && !d?.all_moves?.length && (
            <Empty>
              Nothing on the board improves your lineup right now — no free agent cracks it and no
              trade survives the filters. That is a finding, not a failure. The near misses below
              show what came closest.
            </Empty>
          )}

          {d?.near_misses?.length > 0 && (
            <section>
              <SectionHead title="Considered and refused"
                detail={`${d.considered} packages were scored. These came closest, with the gate that stopped each one — if you disagree with a call, this is the deal to go and negotiate by hand.`} />
              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                {d.near_misses.map((n: any, i: number) => (
                  <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-100 px-4 py-3 last:border-0">
                    <div className="min-w-0 flex-1 text-sm">
                      <span className="font-semibold text-rose-700">{n.you_send.map((p: any) => p.name).join(' + ')}</span>
                      <span className="mx-1.5 text-slate-400">→</span>
                      <span className="font-semibold text-emerald-700">{n.you_get.map((p: any) => p.name).join(' + ')}</span>
                      <span className="ml-2 text-xs text-slate-400">{n.partner}</span>
                      <div className="mt-0.5 text-xs leading-5 text-slate-500">{n.detail}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-sm font-black tabular-nums text-slate-400">+{n.my_ppg_gain}</span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600">
                        {n.blocked_by}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {d?.sell_high?.length > 0 && (
            <section>
              <SectionHead title="Sell high"
                detail="The mirror of buy-low, and the half almost nobody plays. Value is fitted per position as a curve on production; these sit above their own." />
              <div className="space-y-2">
                {d.sell_high.map((s: any, i: number) => (
                  <div key={i} className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-base font-black text-slate-900">{s.name}</span>
                      <span className="text-xs font-bold text-slate-500">{s.position}</span>
                      <span className="ml-auto rounded-full bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800 ring-1 ring-amber-200">
                        {s.confidence}
                      </span>
                    </div>
                    <p className="mt-1 text-sm leading-6 text-slate-700">{s.why}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {d?.drop_candidates?.length > 0 && (
            <details className="rounded-xl border border-slate-200 bg-white p-4">
              <summary className="cursor-pointer text-sm font-bold text-slate-700">
                Roster space — who to drop first ({d.drop_candidates.length})
              </summary>
              <div className="mt-3 space-y-2">
                {d.drop_candidates.map((p: any, i: number) => (
                  <div key={i} className="flex items-baseline gap-2 text-sm">
                    <span className="font-semibold text-slate-800">{p.name}</span>
                    <span className="text-xs text-slate-400">{p.position}</span>
                    <span className="ml-auto text-xs text-slate-500">{p.why}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

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
                {d.playoff_weight != null && (
                  <li className="flex gap-2"><span className="text-slate-300">—</span>
                    Players are valued {Math.round(d.playoff_weight * 100)}% on their weeks 15–17 schedule
                    and {Math.round((1 - d.playoff_weight) * 100)}% on the rest of the season. That weight
                    climbs as the season runs, because points banked in October only buy a playoff berth.
                  </li>
                )}
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

function SectionHead({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-lg font-black tracking-tight text-slate-950">{title}</h2>
      <p className="mt-0.5 max-w-3xl text-sm leading-6 text-slate-500">{detail}</p>
    </div>
  );
}

/**
 * The one move to make, given its own space.
 *
 * Kept visually distinct from the ranked list below because it answers a
 * different question. The list answers "what are my options"; this answers "what
 * do I do", and on most weeks the honest answer is a waiver claim that would
 * otherwise be item four in a list headed by trades nobody will sign.
 */
function TopMove({ m, note }: { m: any; note?: string }) {
  const isWaiver = m.kind === 'waiver';
  return (
    <section className="surface-deep overflow-hidden rounded-2xl">
      <div className="p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-black uppercase tracking-[.15em] text-emerald-300">
            {isWaiver ? 'Do this first — no negotiation needed' : 'Do this first'}
          </span>
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-200">
            {isWaiver ? 'Waiver claim' : 'Trade'}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {m.you_send?.length > 0 && <>
            <span className="text-lg font-bold text-rose-300">{m.you_send.map((p: any) => p.name).join(' + ')}</span>
            <span className="text-slate-500">→</span>
          </>}
          <span className="text-2xl font-black tracking-tight text-white">
            {m.you_get.map((p: any) => p.name).join(' + ')}
          </span>
        </div>
        {note && <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">{note}</p>}
        {m.pitch?.text && !isWaiver && (
          <div className="mt-3 rounded-xl bg-white/[.07] p-3">
            <div className="text-[10px] font-black uppercase tracking-wide text-slate-400">Send this to {m.partner}</div>
            <p className="mt-1 text-sm leading-6 text-slate-100">{m.pitch.text}</p>
          </div>
        )}
        {isWaiver && m.replaces && (
          <p className="mt-2 text-sm text-slate-400">
            Starts over <b className="text-slate-200">{m.replaces.name}</b> the moment he is added.
          </p>
        )}
      </div>
      <div className="grid grid-cols-3 gap-px border-t border-white/10 bg-white/10">
        <Cell label="You gain" value={`+${m.my_ppg_gain}`} unit="ppg" />
        <Cell label={isWaiver ? 'Nobody has to agree' : 'They sign it'}
          value={`${Math.round(m.accept_probability * 100)}%`} />
        <Cell label="Worth" value={String(m.expected_value)} unit="ppg" />
      </div>
    </section>
  );
}

function Cell({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="bg-slate-900/80 px-4 py-3">
      <div className="text-[10px] font-black uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-0.5 text-xl font-black tabular-nums text-white">
        {value}{unit && <span className="ml-1 text-[10px] font-bold text-slate-400">{unit}</span>}
      </div>
    </div>
  );
}

function Move({ m, rank }: { m: any; rank: number }) {
  const isWaiver = m.kind === 'waiver';
  const [open, setOpen] = useState(false);
  const acc = Math.round(m.accept_probability * 100);
  return (
    <article className={`overflow-hidden rounded-2xl border bg-white ${isWaiver ? 'border-emerald-200' : 'border-slate-200'}`}>
      <button onClick={() => setOpen(v => !v)} className="flex w-full items-center gap-4 p-4 text-left hover:bg-slate-50">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-black text-white ${
          isWaiver ? 'bg-emerald-700' : 'bg-slate-900'}`}>{rank}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            {m.you_send?.length > 0 && <>
              <span className="font-bold text-rose-700">{m.you_send.map((p: any) => p.name).join(' + ')}</span>
              <span className="text-slate-400">→</span>
            </>}
            <span className="font-bold text-emerald-700">{m.you_get.map((p: any) => p.name).join(' + ')}</span>
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            {isWaiver ? (
              <>free agent{m.you_send?.length > 0 && <> · drop {m.you_send[0].name}</>}</>
            ) : (
              <>with <b className="text-slate-700">{m.partner}</b>
                {m.tier && <span className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-bold ring-1 ${TIER_STYLE[m.tier as Tier]}`}>
                  {TIER_SHORT[m.tier as Tier]}
                </span>}
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-5 text-right">
          <Metric label="You gain" value={`+${m.my_ppg_gain}`} unit="ppg" tone="good" />
          <Metric label={isWaiver ? 'Just claim him' : 'They sign it'} value={`${acc}%`}
            tone={acc >= 50 ? 'good' : acc >= 25 ? 'warn' : 'bad'} />
          <Metric label={m.grade ?? 'Worth'} value={String(m.expected_value)} unit="ppg"
            tone={m.grade === 'SMASH' ? 'good' : undefined} />
        </div>
      </button>
      {open && (
        <div className="space-y-3 border-t border-slate-100 bg-slate-50 px-4 py-4">
          {m.pitch && (
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="text-[10px] font-black uppercase tracking-wide text-slate-400">
                {isWaiver ? 'Why him' : `Send this to ${m.partner}`}
              </div>
              <p className="mt-1 text-sm leading-6 text-slate-800">{m.pitch.text}</p>
              {m.pitch.reasoning && (
                <p className="mt-1.5 border-t border-slate-100 pt-1.5 text-xs text-slate-500">{m.pitch.reasoning}</p>
              )}
            </div>
          )}
          {/* The trade breakdown is meaningless for a waiver claim — there is no
              counterparty to have a lineup, a value split, or a surplus with. */}
          {isWaiver ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <Detail label="Replaces" value={m.replaces?.name ?? 'nobody yet'}
                hint={m.replaces ? 'Comes out of your starting lineup the moment he is added' : 'Slots into an open spot'} />
              <Detail label="Cost to you" value={m.you_send?.length ? `Drop ${m.you_send[0].name}` : 'A roster spot'}
                hint="No negotiation, no counterparty — this is why it ranks where it does" />
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-4">
              <Detail label="Their lineup" value={`${m.their_ppg_gain >= 0 ? '+' : ''}${m.their_ppg_gain} ppg`}
                hint={m.their_ppg_gain > 0 ? 'It helps them too — that is why it can be signed' : 'It costs them, so expect a counter'} />
              <Detail label="Value split" value={`${m.their_value_edge_pct >= 0 ? '+' : ''}${m.their_value_edge_pct}% to them`}
                hint="Share of the value crossing the table" />
              <Detail label="Mutual surplus" value={m.nash_product > 0 ? String(m.nash_product) : 'none'}
                hint={m.nash_product > 0 ? 'Both lineups improve — the range deals get signed in' : 'Only one side gains, so this is an ask'} />
              <Detail label="Contender tax" value={m.rival_tax > 0 ? `-${m.rival_tax} ppg` : 'none'}
                hint="Their gain discounted more when they are already ahead of you" />
            </div>
          )}
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
