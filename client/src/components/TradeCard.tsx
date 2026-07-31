import { useState } from 'react';
import { api } from '../api';
import { usePlayerCard } from './PlayerCard';

/**
 * One scored deal. Both sides are always shown side by side — a trade you can't
 * explain from the other manager's chair is one that never gets accepted.
 */

const VERDICT_TONE: Record<string, string> = {
  'clear win': 'bg-emerald-100 text-emerald-800 border-emerald-300',
  win: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  even: 'bg-slate-100 text-slate-600 border-slate-300',
  'even (value edge)': 'bg-sky-50 text-sky-700 border-sky-200',
  loss: 'bg-amber-50 text-amber-700 border-amber-200',
  'clear loss': 'bg-rose-100 text-rose-800 border-rose-300'
};

const FAIRNESS_TONE: Record<string, string> = {
  'lopsided my way': 'text-emerald-700',
  'slightly my way': 'text-emerald-600',
  'even money': 'text-slate-500',
  'slightly their way': 'text-amber-600',
  'lopsided their way': 'text-rose-600'
};

export const num = (n: number | null | undefined, d = 2) =>
  n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(d)}`;

export function PlayerPill({ p, tone = 'slate' }: { p: any; tone?: 'give' | 'get' | 'slate' }) {
  const open = usePlayerCard();
  const ring = tone === 'give' ? 'border-rose-200 bg-rose-50/60'
    : tone === 'get' ? 'border-emerald-200 bg-emerald-50/60'
    : 'border-slate-200 bg-slate-50';
  return (
    <button
      onClick={() => open(p.id)}
      title={`${p.proj ?? '?'} projected pts · market ${p.value?.toLocaleString() ?? '?'}${p.bye ? ` · bye ${p.bye}` : ''}`}
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-xs hover:border-slate-400 transition-colors ${ring}`}>
      <span className={`text-[9px] font-black pos-${p.position}`}>{p.position}</span>
      <span className="font-semibold text-slate-800">{p.name}</span>
      {p.team_abbr && <span className="text-[10px] text-slate-400">{p.team_abbr}</span>}
      {p.injury === 1 && <span className="text-[10px] text-rose-500" title="injury flag">✚</span>}
      {p.adj_ppg != null && <span className="text-[10px] text-slate-500 tabular-nums">{p.adj_ppg.toFixed(1)}</span>}
    </button>
  );
}

/** One team's outcome. The numbers that matter, in the order they matter. */
function SideBox({ s, mine }: { s: any; mine: boolean }) {
  return (
    <div className={`rounded-xl border p-3 ${mine ? 'border-emerald-200 bg-emerald-50/30' : 'border-slate-200 bg-slate-50/60'}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] font-black uppercase tracking-wide text-slate-400">
          {mine ? 'You' : s.owner}
        </span>
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${VERDICT_TONE[s.verdict] ?? VERDICT_TONE.even}`}>
          {s.verdict}
        </span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className={`text-2xl font-black tabular-nums ${s.ppg_delta > 0 ? 'text-emerald-600' : s.ppg_delta < 0 ? 'text-rose-600' : 'text-slate-400'}`}>
          {num(s.ppg_delta)}
        </span>
        <span className="text-[11px] text-slate-500">ppg to starting lineup</span>
      </div>
      <div className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
        {s.lineup_before} → {s.lineup_after} · {num(s.season_delta, 0)} over the season
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2 text-[11px]">
        <div><dt className="text-slate-400">Playoffs (15–17)</dt>
          <dd className={`tabular-nums font-semibold ${s.playoff_ppg_delta > 0 ? 'text-emerald-600' : s.playoff_ppg_delta < 0 ? 'text-rose-600' : 'text-slate-500'}`}>{num(s.playoff_ppg_delta)} ppg</dd></div>
        <div><dt className="text-slate-400">Market value</dt>
          <dd className={`tabular-nums font-semibold ${s.value_delta > 0 ? 'text-emerald-600' : s.value_delta < 0 ? 'text-rose-600' : 'text-slate-500'}`}>{num(s.value_delta, 0)}</dd></div>
        {s.floor_delta != null && (
          <div><dt className="text-slate-400">Weekly floor</dt>
            <dd className="tabular-nums text-slate-600">{num(s.floor_delta, 1)}</dd></div>
        )}
        {s.ceiling_delta != null && (
          <div><dt className="text-slate-400">Weekly ceiling</dt>
            <dd className="tabular-nums text-slate-600">{num(s.ceiling_delta, 1)}</dd></div>
        )}
      </dl>
      {s.new_holes?.length > 0 && (
        <p className="text-[11px] text-rose-600 mt-1.5">⚠ Leaves an empty {s.new_holes.join(', ')} slot.</p>
      )}
      {s.roster_spots !== 0 && (
        <p className="text-[11px] text-slate-400 mt-1">
          {s.roster_spots > 0 ? `Uses ${s.roster_spots} more roster spot${s.roster_spots > 1 ? 's' : ''}` : `Frees ${-s.roster_spots} roster spot${s.roster_spots < -1 ? 's' : ''}`}
        </p>
      )}
    </div>
  );
}

export default function TradeCard({ deal, leagueId, compact = false, untouchableNames = [] }: {
  deal: any; leagueId: number; compact?: boolean; untouchableNames?: string[];
}) {
  const [copy, setCopy] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [impact, setImpact] = useState<any>(null);
  const [oddsBusy, setOddsBusy] = useState(false);

  /**
   * The number the engine exists to produce. Simulating twice takes a few seconds, so
   * it is on demand rather than computed for every card in the list.
   */
  const odds = async () => {
    setOddsBusy(true); setErr(null);
    try {
      setImpact(await api(`/model/${leagueId}/trade-impact`, {
        method: 'POST',
        body: JSON.stringify({
          my_team_id: deal.me?.roster_id,
          their_team_id: deal.partner_id ?? deal.them?.roster_id,
          i_give: (deal.i_give ?? deal.me?.gives ?? []).map((p: any) => p.id),
          i_get: (deal.i_get ?? deal.me?.gets ?? []).map((p: any) => p.id)
        })
      }));
    } catch (e: any) { setErr(e.message); }
    finally { setOddsBusy(false); }
  };

  const explain = async () => {
    setBusy(true); setErr(null);
    try { setCopy(await api(`/trades/${leagueId}/explain`, { method: 'POST', body: JSON.stringify({ deal, untouchables: untouchableNames }) })); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const give = deal.i_give ?? deal.me?.gives ?? [];
  const get = deal.i_get ?? deal.me?.gets ?? [];

  return (
    <div className={`card p-4 ${deal.mutual ? 'border-emerald-300' : ''}`}>
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <span className="font-bold text-slate-800">{deal.partner ?? deal.them?.owner}</span>
        {deal.mutual && (
          <span className="text-[10px] font-black text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full"
            title="Both starting lineups improve — this is the kind of deal that actually gets accepted">
            BOTH SIDES WIN
          </span>
        )}
        {!deal.mutual && deal.plausible && (
          <span className="text-[10px] font-black text-sky-700 bg-sky-50 border border-sky-200 px-2 py-0.5 rounded-full"
            title="Their lineup doesn't clearly improve, but the trade is fair on market value and doesn't cost them much — a realistic ask, not a lock">
            FAIR ASK
          </span>
        )}
        <span className={`text-[11px] font-semibold ${FAIRNESS_TONE[deal.fairness] ?? 'text-slate-500'}`}>
          {deal.fairness}
        </span>
        {deal.joint_ppg != null && (
          <span className="text-[10px] text-slate-400" title="Combined lineup gain — the surplus that makes a trade possible at all">
            joint {num(deal.joint_ppg)}
          </span>
        )}
      </div>

      <div className="space-y-1.5 mb-3">
        <div className="flex items-start gap-2 flex-wrap">
          <span className="text-[10px] font-black uppercase tracking-wide text-rose-500 w-14 shrink-0 pt-1.5">You give</span>
          <div className="flex gap-1.5 flex-wrap">{give.map((p: any) => <PlayerPill key={p.id} p={p} tone="give" />)}</div>
        </div>
        <div className="flex items-start gap-2 flex-wrap">
          <span className="text-[10px] font-black uppercase tracking-wide text-emerald-600 w-14 shrink-0 pt-1.5">You get</span>
          <div className="flex gap-1.5 flex-wrap">{get.map((p: any) => <PlayerPill key={p.id} p={p} tone="get" />)}</div>
        </div>
      </div>

      {!compact && (
        <div className="grid sm:grid-cols-2 gap-3">
          <SideBox s={deal.me} mine />
          <SideBox s={deal.them} mine={false} />
        </div>
      )}

      <div className="flex items-center gap-2 mt-3 flex-wrap">
        <button className="btn-ghost text-xs" onClick={odds} disabled={oddsBusy}>
          {oddsBusy ? 'Simulating…' : '🏆 Title odds impact'}
        </button>
        <button className="btn-ghost text-xs" onClick={explain} disabled={busy}>
          {busy ? 'Writing…' : '✨ Write the pitch'}
        </button>
        {err && <span className="text-[11px] text-rose-600">{err}</span>}
      </div>

      {impact && !impact.error && (
        <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/40 p-3">
          <div className="text-[10px] font-black uppercase tracking-wide text-emerald-700 mb-2">
            Simulated {impact.runs?.toLocaleString()} seasons, before and after
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            {[impact.me, impact.them].map((s: any, i: number) => (
              <div key={s.roster_id}>
                <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-0.5">
                  {i === 0 ? 'You' : s.owner}
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-sm tabular-nums text-slate-500">{(s.title_before * 100).toFixed(1)}%</span>
                  <span className="text-slate-400">→</span>
                  <span className="text-lg font-black tabular-nums text-slate-800">{(s.title_after * 100).toFixed(1)}%</span>
                  <span className={`text-xs font-bold tabular-nums ${s.title_delta > 0 ? 'text-emerald-600' : s.title_delta < 0 ? 'text-rose-600' : 'text-slate-400'}`}>
                    {s.title_delta > 0 ? '+' : ''}{(s.title_delta * 100).toFixed(1)}
                  </span>
                </div>
                <div className="text-[11px] text-slate-500 tabular-nums">
                  title odds · playoffs {s.playoff_delta > 0 ? '+' : ''}{(s.playoff_delta * 100).toFixed(1)}pts · wins {s.wins_delta > 0 ? '+' : ''}{s.wins_delta}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {impact?.error && <p className="text-[11px] text-rose-600 mt-2">{impact.error}</p>}

      {copy && (
        <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3 space-y-2 text-xs">
          <div className="bg-white rounded-lg border border-slate-200 p-2.5">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Message to send</span>
              <button className="text-[10px] text-emerald-600 hover:underline ml-auto"
                onClick={() => navigator.clipboard?.writeText(copy.pitch)}>copy</button>
            </div>
            <p className="text-slate-700 italic">{copy.pitch}</p>
          </div>
          {copy.their_counter && <p><span className="font-black uppercase text-slate-500">Likely counter </span><span className="text-slate-600">{copy.their_counter}</span></p>}
          {copy.walk_away && <p><span className="font-black uppercase text-rose-600">Walk away </span><span className="text-slate-600">{copy.walk_away}</span></p>}
          {copy.risk && <p><span className="font-black uppercase text-amber-600">Risk </span><span className="text-slate-600">{copy.risk}</span></p>}
        </div>
      )}
    </div>
  );
}
