import { useState } from 'react';
import { api, headshotUrl } from '../api';
import { usePlayerCard } from './PlayerCard';
import { Headshot } from './PlayerRow';

/**
 * One scored deal. Both sides are always shown side by side — a trade you can't
 * explain from the other manager's chair is one that never gets accepted.
 */

const VERDICT_TONE: Record<string, string> = {
  'clear win': 'bg-good-tint text-good border-good font-semibold',
  win: 'bg-good-tint text-good border-good',
  even: 'bg-black/[.03] text-[var(--muted)] border-[var(--edge)]',
  'even (value edge)': 'bg-[var(--accent-tint)] text-[var(--accent)] border-[var(--accent)]/30',
  loss: 'bg-amber-50 text-amber-700 border-amber-200',
  'clear loss': 'bg-crit-tint text-crit border-crit font-semibold'
};

const SENSE_TONE: Record<string, string> = {
  sound: 'border-good bg-good-tint/40',
  'worth a second look': 'border-[var(--accent)]/40 bg-[var(--accent-tint)]/60',
  risky: 'border-amber-300 bg-amber-50/40',
  lopsided: 'border-crit bg-crit-tint/40'
};

const SENSE_BADGE: Record<string, string> = {
  sound: 'bg-good-tint text-good border-good',
  'worth a second look': 'bg-[var(--accent-tint)] text-[var(--accent)] border-[var(--accent)]/30',
  risky: 'bg-amber-100 text-amber-800 border-amber-300',
  lopsided: 'bg-crit-tint text-crit border-crit'
};

const FAIRNESS_TONE: Record<string, string> = {
  'lopsided my way': 'text-good font-semibold',
  'slightly my way': 'text-good',
  'even money': 'text-[var(--muted)]',
  'slightly their way': 'text-amber-600',
  'lopsided their way': 'text-crit'
};

export const num = (n: number | null | undefined, d = 2) =>
  n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(d)}`;

/**
 * A letter grade from the engine's own already-computed numbers — not a stand-in
 * for a real ESPN/Sleeper trade grade (neither exposes one via API; showing fake
 * numbers under their names would be dishonest). This is our math, relabeled.
 */
function engineGrade(deal: any): { letter: string; tone: 'good' | 'accent' | 'warn' | 'crit' } {
  const holes = deal.them?.new_holes?.length ?? 0;
  const flags = deal.red_flags?.length ?? 0;
  const d = deal.me?.ppg_delta ?? 0;
  if (holes > 0 || deal.plausible === false) return { letter: 'D', tone: 'crit' };
  if (flags > 0) return { letter: d >= 1.5 ? 'B-' : 'C+', tone: 'warn' };
  if (deal.mutual && d >= 2.5) return { letter: 'A', tone: 'good' };
  if (deal.mutual && d >= 1) return { letter: 'A-', tone: 'good' };
  if (deal.mutual) return { letter: 'B+', tone: 'good' };
  if (deal.plausible) return { letter: 'B', tone: 'accent' };
  return { letter: 'C', tone: 'warn' };
}

const GRADE_TONE: Record<string, string> = {
  good: 'text-[var(--good)] bg-[var(--good-tint)]',
  accent: 'text-[var(--accent)] bg-[var(--accent-tint)]',
  warn: 'text-amber-700 bg-amber-50',
  crit: 'text-[var(--crit)] bg-[var(--crit-tint)]'
};

export function PlayerPill({ p, tone = 'slate' }: { p: any; tone?: 'give' | 'get' | 'slate' }) {
  const open = usePlayerCard();
  return (
    <button
      onClick={() => open(p.id)}
      title={`${p.proj ?? '?'} projected pts · market ${p.value?.toLocaleString() ?? '?'}${p.bye ? ` · bye ${p.bye}` : ''}`}
      className="inline-flex items-center gap-2 py-1 pr-2.5 rounded-full border border-[var(--edge)] bg-white/70 text-xs hover:border-slate-400 transition-colors">
      <Headshot src={headshotUrl(p)} pos={p.position} size={26} />
      <span className="font-semibold text-[var(--ink)]">{p.name}</span>
      {p.team_abbr && <span className="text-[10px] text-[var(--muted)]">{p.team_abbr}</span>}
      {p.injury === 1 && <span className="text-[10px] text-[var(--crit)]" title="injury flag">✚</span>}
      {p.adj_ppg != null && <span className="text-[10px] text-[var(--muted)] tabular-nums">{p.adj_ppg.toFixed(1)}</span>}
    </button>
  );
}

/** One team's outcome. The numbers that matter, in the order they matter. */
function SideBox({ s, mine }: { s: any; mine: boolean }) {
  return (
    <div className={`rounded-xl border p-3 ${mine ? 'border-good bg-good-tint/40' : 'border-[var(--edge)] bg-black/[.015]'}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
          {mine ? 'You' : s.owner}
        </span>
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${VERDICT_TONE[s.verdict] ?? VERDICT_TONE.even}`}>
          {s.verdict}
        </span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className={`text-2xl font-bold tabular-nums ${s.ppg_delta > 0 ? 'text-good' : s.ppg_delta < 0 ? 'text-crit' : 'text-[var(--muted)]'}`}>
          {num(s.ppg_delta)}
        </span>
        <span className="text-[11px] text-[var(--muted)]">ppg to starting lineup</span>
      </div>
      <div className="text-[11px] text-[var(--muted)] mt-0.5 tabular-nums">
        {s.lineup_before} → {s.lineup_after} · {num(s.season_delta, 0)} over the season
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2 text-[11px]">
        <div><dt className="text-[var(--muted)]">Playoffs (15–17)</dt>
          <dd className={`tabular-nums font-medium ${s.playoff_ppg_delta > 0 ? 'text-good' : s.playoff_ppg_delta < 0 ? 'text-crit' : 'text-[var(--muted)]'}`}>{num(s.playoff_ppg_delta)} ppg</dd></div>
        <div><dt className="text-[var(--muted)]">Market value</dt>
          <dd className={`tabular-nums font-medium ${s.value_delta > 0 ? 'text-good' : s.value_delta < 0 ? 'text-crit' : 'text-[var(--muted)]'}`}>{num(s.value_delta, 0)}</dd></div>
        {s.floor_delta != null && (
          <div><dt className="text-[var(--muted)]">Weekly floor</dt>
            <dd className="tabular-nums text-[var(--ink)]">{num(s.floor_delta, 1)}</dd></div>
        )}
        {s.ceiling_delta != null && (
          <div><dt className="text-[var(--muted)]">Weekly ceiling</dt>
            <dd className="tabular-nums text-[var(--ink)]">{num(s.ceiling_delta, 1)}</dd></div>
        )}
      </dl>
      {s.new_holes?.length > 0 && (
        <p className="text-[11px] text-crit mt-1.5">⚠ Leaves an empty {s.new_holes.join(', ')} slot.</p>
      )}
      {s.roster_spots !== 0 && (
        <p className="text-[11px] text-[var(--muted)] mt-1">
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
  const [sense, setSense] = useState<any>(null);
  const [senseBusy, setSenseBusy] = useState(false);

  const senseCheck = async () => {
    setSenseBusy(true); setErr(null);
    try { setSense(await api(`/trades/${leagueId}/sense-check`, { method: 'POST', body: JSON.stringify({ deal }) })); }
    catch (e: any) { setErr(e.message); }
    finally { setSenseBusy(false); }
  };

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

  const grade = engineGrade(deal);

  return (
    <div className={`card p-4 ${deal.mutual ? 'border-good' : ''}`}>
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <span className="font-semibold text-[var(--ink)]">{deal.partner ?? deal.them?.owner}</span>
        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${GRADE_TONE[grade.tone]}`}
          title="This engine's own grade — not a real ESPN or Sleeper trade grade, neither exposes one via API">
          {grade.letter}
        </span>
        {deal.mutual && (
          <span className="text-[10px] font-semibold text-good bg-good-tint border border-good px-2 py-0.5 rounded-full"
            title="Both starting lineups improve — this is the kind of deal that actually gets accepted">
            BOTH SIDES WIN
          </span>
        )}
        {!deal.mutual && deal.plausible && (
          <span className="text-[10px] font-semibold text-[var(--accent)] bg-[var(--accent-tint)] border border-[var(--accent)]/30 px-2 py-0.5 rounded-full"
            title="Their lineup doesn't clearly improve, but the trade is fair on market value and doesn't cost them much — a realistic ask, not a lock">
            FAIR ASK
          </span>
        )}
        <span className={`text-[11px] ${FAIRNESS_TONE[deal.fairness] ?? 'text-[var(--muted)]'}`}>
          {deal.fairness}
        </span>
        {deal.joint_ppg != null && (
          <span className="text-[10px] text-[var(--muted)]" title="Combined lineup gain — the surplus that makes a trade possible at all">
            joint {num(deal.joint_ppg)}
          </span>
        )}
        {deal.their_window && (
          <span className="text-[10px] text-[var(--muted)] bg-black/[.03] border border-[var(--edge)] px-2 py-0.5 rounded-full ml-auto"
            title={deal.their_window.stance}>
            their window: {deal.their_window.label}
          </span>
        )}
      </div>

      {deal.red_flags?.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {deal.red_flags.map((f: string, i: number) => (
            <span key={i} className="text-[10px] text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
              ⚠ {f}
            </span>
          ))}
        </div>
      )}

      <div className="space-y-1.5 mb-3">
        <div className="flex items-start gap-2 flex-wrap">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-crit w-14 shrink-0 pt-1.5">You give</span>
          <div className="flex gap-1.5 flex-wrap">{give.map((p: any) => <PlayerPill key={p.id} p={p} tone="give" />)}</div>
        </div>
        <div className="flex items-start gap-2 flex-wrap">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-good w-14 shrink-0 pt-1.5">You get</span>
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
        <button className="btn-ghost text-xs" onClick={senseCheck} disabled={senseBusy}>
          {senseBusy ? 'Checking…' : '🔍 AI sense check'}
        </button>
        {err && <span className="text-[11px] text-rose-600">{err}</span>}
      </div>

      {sense && !sense.error && (
        <div className={`mt-3 rounded-xl border p-3 ${SENSE_TONE[sense.verdict] ?? 'border-slate-200 bg-slate-50/60'}`}>
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border ${SENSE_BADGE[sense.verdict] ?? 'bg-black/[.03] text-[var(--muted)] border-[var(--edge)]'}`}>
              {sense.verdict ?? 'checked'}
            </span>
            <span className="text-[10px] text-[var(--muted)]">
              {sense.agrees_with_engine ? 'agrees with the engine' : 'disagrees with the engine'}
            </span>
          </div>
          <p className="text-sm text-[var(--ink)] font-medium">{sense.headline}</p>
          {sense.concerns?.length > 0 && (
            <ul className="mt-2 space-y-1">
              {sense.concerns.map((c: string, i: number) => (
                <li key={i} className="text-xs text-[var(--ink)]/80 flex gap-1.5">
                  <span className="text-amber-600 shrink-0">⚠</span><span>{c}</span>
                </li>
              ))}
            </ul>
          )}
          {sense.why && <p className="text-xs text-[var(--muted)] mt-2 italic">{sense.why}</p>}
        </div>
      )}
      {sense?.error && <p className="text-[11px] text-crit mt-2">{sense.error}</p>}

      {impact && !impact.error && (
        <div className="mt-3 rounded-xl border border-[var(--accent)]/20 bg-[var(--accent-tint)]/60 p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--accent)] mb-2">
            Simulated {impact.runs?.toLocaleString()} seasons, before and after
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            {[impact.me, impact.them].map((s: any, i: number) => (
              <div key={s.roster_id}>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)] mb-0.5">
                  {i === 0 ? 'You' : s.owner}
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-sm tabular-nums text-[var(--muted)]">{(s.title_before * 100).toFixed(1)}%</span>
                  <span className="text-[var(--muted)]">→</span>
                  <span className="text-lg font-bold tabular-nums text-[var(--ink)]">{(s.title_after * 100).toFixed(1)}%</span>
                  <span className={`text-xs font-semibold tabular-nums ${s.title_delta > 0 ? 'text-good' : s.title_delta < 0 ? 'text-crit' : 'text-[var(--muted)]'}`}>
                    {s.title_delta > 0 ? '+' : ''}{(s.title_delta * 100).toFixed(1)}
                  </span>
                </div>
                <div className="text-[11px] text-[var(--muted)] tabular-nums">
                  title odds · playoffs {s.playoff_delta > 0 ? '+' : ''}{(s.playoff_delta * 100).toFixed(1)}pts · wins {s.wins_delta > 0 ? '+' : ''}{s.wins_delta}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {impact?.error && <p className="text-[11px] text-crit mt-2">{impact.error}</p>}

      {copy && (
        <div className="mt-3 rounded-xl border border-[var(--edge)] bg-black/[.015] p-3 space-y-2 text-xs">
          <div className="bg-white rounded-lg border border-[var(--edge)] p-2.5">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">Message to send</span>
              <button className="text-[10px] text-[var(--accent)] hover:underline ml-auto"
                onClick={() => navigator.clipboard?.writeText(copy.pitch)}>copy</button>
            </div>
            <p className="text-[var(--ink)]/85 italic">{copy.pitch}</p>
          </div>
          {copy.their_counter && <p><span className="font-semibold uppercase text-[var(--muted)]">Likely counter </span><span className="text-[var(--ink)]/80">{copy.their_counter}</span></p>}
          {copy.walk_away && <p><span className="font-semibold uppercase text-crit">Walk away </span><span className="text-[var(--ink)]/80">{copy.walk_away}</span></p>}
          {copy.risk && <p><span className="font-semibold uppercase text-amber-600">Risk </span><span className="text-[var(--ink)]/80">{copy.risk}</span></p>}
        </div>
      )}
    </div>
  );
}
