import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useApi } from '../api';
import { useLeague } from '../state/league';
import EvidenceStrip, { RecordLine } from '../components/lineup/EvidenceStrip';
import { usePageExplain } from '../components/PageExplainContext';
import { PageLoading, PageError, EmptyState, logServerDetail } from '../components/PageState';
import WaiverWire, { WaiverTeaser, onATeam } from '../components/lineup/WaiverWire';
import type { WaiverBoard, OutList } from '../components/lineup/WaiverWire';
import StreamingBoard from '../components/lineup/StreamingBoard';
import type { StreamBoard } from '../components/lineup/StreamingBoard';
import MatchupPosture from '../components/lineup/MatchupPosture';
import type { Posture } from '../components/lineup/MatchupPosture';
import StartSitGate from '../components/lineup/StartSitGate';

/**
 * The week's lineup, with the closeness of each call made visible.
 *
 * The design problem here is that a start/sit page is mostly a list of names,
 * and a list of names hides the one thing that separates a decision from a coin
 * flip: the margin. So the margin is the visual — a bar per slot showing how far
 * clear the starter is, scaled against the threshold where the gap stops being
 * inside the projection's own error. Two slots with identical names and
 * different bars are immediately different decisions, which is the whole point.
 */

const CONF: Record<string, { label: string; bar: string; chip: string }> = {
  clear: { label: 'Clear', bar: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-800 ring-emerald-200' },
  lean: { label: 'Lean', bar: 'bg-sky-500', chip: 'bg-sky-50 text-sky-800 ring-sky-200' },
  'coin flip': { label: 'Coin flip', bar: 'bg-amber-400', chip: 'bg-amber-50 text-amber-900 ring-amber-200' },
  // A gap between two ceilings or two floors. Clear / Lean / Coin flip were measured on
  // average-projection gaps only, so this gap gets no grade rather than a borrowed one.
  'not measured': { label: 'Not graded', bar: 'bg-slate-400', chip: 'bg-slate-100 text-slate-600 ring-slate-200' },
  'only option': { label: 'Only option', bar: 'bg-slate-300', chip: 'bg-slate-100 text-slate-600 ring-slate-200' },
  // Other eligible players existed, none of them had a projection. That is not
  // the same call as having only one option, and it should not look like one.
  'no projection': { label: 'Not compared', bar: 'bg-slate-300', chip: 'bg-slate-100 text-slate-400 ring-slate-200' },
  // RL-4-2: his game has kicked off, so the slot cannot change. No bar: nothing was compared.
  locked: { label: 'Locked', bar: 'bg-slate-300', chip: 'bg-slate-200 text-slate-700 ring-slate-300' }
};

export default function Lineup() {
  const { activeId: leagueId } = useLeague();
  const [objective, setObjective] = useState<'mean' | 'ceiling' | 'floor'>('mean');
  const { data: d, loading, error, refetch } = useApi<any>(
    leagueId ? `/trades/${leagueId}/lineup?objective=${objective}` : null);
  // The waiver wire and this week's matchup. Separate requests, so a slow or
  // failed one never holds the lineup hostage; both follow the active league and
  // default to my own roster, exactly as the lineup request does.
  const waivers = useApi<WaiverBoard>(leagueId ? `/trades/${leagueId}/waivers` : null);
  const posture = useApi<Posture>(leagueId ? `/trades/${leagueId}/posture` : null);
  // Defense streaming (WV-01): same league, same week as the waiver board.
  const streams = useApi<StreamBoard>(leagueId ? `/trades/${leagueId}/streams` : null);
  // Only for the opponent's name; the same cached request the Trade Lab makes.
  const opponentId = posture.data?.opponent_roster_id ?? null;
  const { data: rosters } = useApi<any>(leagueId && opponentId ? `/trades/${leagueId}/rosters` : null);
  const opponentName: string | null = rosters?.teams
    ?.find((t: any) => String(t.roster_id) === String(opponentId))?.owner ?? null;
  // Rostered players the solver will not start. The waiver board names its cut
  // without saying why, and "drop Patrick Mahomes, 18.6 projected" reads as
  // madness until you know he is flagged out; this is the same list the page
  // already shows under "not being considered".
  const out: OutList = useMemo(() => new Map<string, string>(
    (d?.unavailable ?? []).map((u: any) => [String(u.name).toLowerCase(), String(u.why)])), [d]);
  // Everyone the lineup call leaves out, with why: IR (ESPN's IR slot or injured
  // reserve — never started, the same rule as the League Hub card) and players the
  // engine flags out for the season or released.
  const notConsidered: any[] = [...(d?.on_ir ?? []), ...(d?.unavailable ?? [])];

  // The floating assistant otherwise never learns what's on this page and
  // falls back to a generic "this page hasn't told me what's on screen"
  // non-answer on every visit — this is the fix for that, not a cosmetic add.
  // Must run before any early return so hook order never changes between renders.
  usePageExplain('lineup', objective, {
    week: d?.week ?? null, objective,
    projected_points: d?.projected_points ?? null,
    coin_flips: d?.coin_flips ?? null,
    // 'uncalibrated_for_ceiling' / '_floor': the margins are not projection gaps and
    // carry no win rate, so the assistant must not quote one either.
    confidence_basis: d?.confidence_basis ?? null,
    slots: (d?.lineup ?? []).length,
    warnings: (d?.warnings ?? []).length,
    // The assistant answers questions about these percentages too, so it is told the
    // same thing the page prints when the model behind them is not the validated one.
    chance_to_play_degraded: d?.availability_note
      // UX-08: plain words only; the assistant repeats what it is told, so the
      // table/doc-path `reason` stays in the console (logged below), not here.
      ? { reason: 'the fitted chance-to-play model is not running', effect: d.availability_note.effect } : null,
    matchup: posture.data && !posture.data.error && posture.data.win_probability != null
      ? { win_probability_pct: posture.data.win_probability, stance: posture.data.stance ?? null,
          point_edge: posture.data.edge ?? null, swaps_suggested: (posture.data.swaps ?? []).length }
      : null,
    waivers: waiverSummary(waivers.data)
  });

  // UX-08: the degradation note's operator detail (table names, doc and script
  // paths from contingency.js availabilityDegradation) is logged, never rendered.
  if (d?.availability_note) {
    logServerDetail('Lineup availability_note',
      `${d.availability_note.inert} is not running: ${d.availability_note.reason}. To fix: ${d.availability_note.fix}.`);
  }

  if (!leagueId) {
    return (
      <Shell>
        <EmptyState
          title="No league connected"
          description="Connect a league to see this week's start/sit calls."
          actionLabel="Connect a league"
          actionTo="/league?view=connections"
        />
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="tr-rise">
        <div className="text-[11px] font-black uppercase tracking-[.16em] text-emerald-700">This week</div>
        <h1 className="mt-1 text-3xl font-black tracking-tight text-slate-950">Who to start</h1>
        <p className="mt-1.5 max-w-3xl text-sm leading-6 text-slate-600">
          Every call carries how close it was. Starting an 11.4 over an 11.2 and starting a 16 over a
          6 are the same instruction in most tools and they are not the same decision — the first is
          inside the projection's own error, and it is labelled as a tie here rather than dressed up.
        </p>
      </header>

      {/* SS-01 dead-starter guard: shown only when a starter set on ESPN will score zero.
          A suggestion; nothing is changed on ESPN from here. */}
      {d?.dead_starters?.items?.length > 0 && (
        <section role="alert" className="tr-rise rounded-2xl border border-red-300 bg-red-50 p-4">
          <h2 className="text-sm font-black uppercase tracking-wide text-red-800">
            {d.dead_starters.items.length === 1 ? 'A starter will score zero' : `${d.dead_starters.items.length} starters will score zero`}
          </h2>
          <ul className="mt-2 space-y-1">
            {d.dead_starters.items.map((i: any) => (
              <li key={i.player.id} className="text-sm leading-6 text-slate-800">
                {i.why}
                {/* RL-10-1: a projection-based flag names its source and what is not yet tested. */}
                {i.source_label && <span className="block text-xs leading-5 text-red-900/70">{i.source_label}</span>}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs leading-5 text-red-900/70">Make the swap on ESPN before his game starts.</p>
        </section>
      )}

      {error && !d && <PageError message={error} onRetry={refetch} />}

      {d && (
        <section className="tr-rise surface-deep rounded-2xl p-5" style={{ animationDelay: '50ms' }}>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="text-[10px] font-black uppercase tracking-[.15em] text-emerald-300">
                {/* Named for what was summed: a floor or ceiling total is not a projection. */}
                {d.objective_used === 'floor' ? `Week ${d.week} · sum of bad-week floors`
                  : d.objective_used === 'ceiling' ? `Week ${d.week} · sum of good-week ceilings`
                    : `Week ${d.week} projection`}
              </div>
              <div className="mt-1 text-4xl font-black tabular-nums text-white">{d.projected_points}</div>
              <p className="mt-1 text-sm text-slate-400">
                {String(d.confidence_basis ?? '').startsWith('uncalibrated_for_')
                  ? `Gaps below are between ${d.objective_used === 'floor' ? 'bad-week floors' : 'good-week ceilings'}, `
                    + 'not projections. Our win rates were measured on projections only, so no call is graded.'
                  : d.coin_flips > 0
                    ? `${d.coin_flips} of these calls are ties inside the model's own error`
                    : d.not_compared > 0
                      ? `${d.not_compared} of these slots had no projection to compare against`
                      : 'Every call has a real margin behind it'}
              </p>
            </div>
            <div className="flex flex-wrap gap-1 rounded-xl bg-white/10 p-1">
              {(d.objectives ?? []).map((o: any) => (
                <button key={o.id} onClick={() => setObjective(o.id)}
                  title={o.when}
                  className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                    objective === o.id ? 'bg-white text-slate-950' : 'text-slate-300 hover:bg-white/10'}`}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          {d.objective_fallback && (
            <p role="status" className="mt-3 rounded-lg bg-amber-400/15 px-3 py-2 text-sm leading-6 text-amber-100">
              This lineup is the highest-average one: {d.objective_fallback}.
            </p>
          )}
          {d.objectives?.find((o: any) => o.id === objective) && (
            <p className="mt-3 border-t border-white/10 pt-3 text-sm leading-6 text-slate-300">
              {d.objectives.find((o: any) => o.id === objective).when}
            </p>
          )}
        </section>
      )}

      {loading && !d && <PageLoading label="Solving the lineup…" />}

      <MatchupPosture data={posture.data} loading={posture.loading} error={posture.error}
        onRetry={posture.refetch} opponentName={opponentName} />
      <WaiverTeaser data={waivers.data} />

      {/* Honest degradation, not a confident wrong number. Every chance-to-play number on
          this page comes from the fitted availability model; when that model is not the
          validated role layer the percentages are systematically low for healthy
          starters (a starter with no injury at all reads ~57% against an actual 94.5%),
          so the page says which model is talking and why before anyone acts on one.

          It says so in BOTH states, which is the point. A percentage that looks measured
          and is not is the defect; a percentage that IS measured and goes unlabelled is
          the same defect waiting for the next time the tables go missing, because the
          reader has no way to tell the two apart from the number alone. So the fitted
          path gets a line too — quieter, since nothing is wrong, but present. */}
      {d?.availability_note ? (
        <section role="status"
          className="tr-rise rounded-2xl border border-slate-300 bg-slate-50 p-4" style={{ animationDelay: '70ms' }}>
          <h2 className="text-sm font-black uppercase tracking-wide text-slate-700">
            Chance-to-play numbers are degraded
          </h2>
          {/* UX-08: `inert`, `reason` and `fix` name tables, doc paths and a script
              (contingency.js availabilityDegradation) — operator detail, logged, never
              rendered. `effect` is the plain-words half a reader acts on. */}
          <p className="mt-1.5 text-sm leading-6 text-slate-700">
            The fitted chance-to-play model isn&rsquo;t running right now, so these percentages come from a simpler fallback.
          </p>
          <p className="mt-1 text-sm leading-6 text-slate-600">{d.availability_note.effect}.</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">This clears once the availability model is refit.</p>
        </section>
      ) : d?.availability_basis?.basis === 'role' ? (
        <p role="status" className="text-xs leading-5 text-slate-500">
          Every chance to play on this page is a measured rate from the fitted availability
          model, fit on 2021&ndash;2024 and validated on a held-out 2025.
        </p>
      ) : null}

      {d?.warnings?.length > 0 && (
        <section className="tr-rise rounded-2xl border border-amber-200 bg-amber-50/60 p-4" style={{ animationDelay: '80ms' }}>
          <h2 className="text-sm font-black uppercase tracking-wide text-amber-900">Check before kickoff</h2>
          <div className="mt-2 space-y-1">
            {d.warnings.map((w: any, i: number) => (
              <p key={i} className="text-sm leading-6 text-slate-700">
                <b className="text-slate-900">{w.player}</b> ({w.slot}) — {w.issue}.
              </p>
            ))}
          </div>
        </section>
      )}

      {d?.holes?.length > 0 && (
        <section className="tr-rise rounded-2xl border border-amber-200 bg-amber-50/60 p-4" style={{ animationDelay: '90ms' }}>
          <h2 className="text-sm font-black uppercase tracking-wide text-amber-900">Empty starting slots</h2>
          <p className="mt-2 text-sm leading-6 text-slate-700">
            No eligible player on your roster for {d.holes.join(', ')}. These slots are empty on ESPN too.
          </p>
        </section>
      )}

      {d && d.lineup?.length === 0 ? (
        <EmptyState
          title="No lineup to show"
          description="No rostered players were found for this league — sync your roster first."
          actionLabel="Manage roster"
          actionTo="/league?view=connections"
        />
      ) : (
        <div className="space-y-2">
          {d?.lineup?.map((c: any, i: number) => <Slot key={i} c={c} index={i} />)}
        </div>
      )}

      {notConsidered.length > 0 && (
        <details className="tr-rise rounded-xl border border-slate-200 bg-white p-4" style={{ animationDelay: '150ms' }}>
          <summary className="cursor-pointer text-sm font-bold text-slate-700">
            Why {notConsidered.length} rostered player{notConsidered.length === 1 ? ' is' : 's are'} not
            being considered
          </summary>
          <div className="mt-2 space-y-1.5">
            {notConsidered.map((u: any, i: number) => (
              <p key={i} className="text-sm leading-6 text-slate-600">
                <b className="text-slate-900">{u.name}</b> ({u.position}, {u.team_abbr}) — {u.why}
              </p>
            ))}
          </div>
        </details>
      )}

      {d?.bench?.length > 0 && (
        <section className="tr-rise rounded-2xl border border-slate-200 bg-white p-4" style={{ animationDelay: '170ms' }}>
          <h2 className="text-sm font-black uppercase tracking-wide text-slate-500">On the bench</h2>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {d.bench.map((p: any, i: number) => (
              <div key={i} className="min-w-0 text-sm">
                <div className="flex items-baseline gap-2">
                  <span className="font-semibold text-slate-800">{p.name}</span>
                  <span className="text-xs text-slate-400">{p.position} · {p.team_abbr}</span>
                  <span className="ml-auto font-mono text-xs tabular-nums text-slate-600">{p.week_points}</span>
                </div>
                <RecordLine ev={p.evidence} />
              </div>
            ))}
          </div>
        </section>
      )}

      {d?.note && <p className="text-xs leading-5 text-slate-500">{d.note}</p>}

      {/* Whether starting by our projection beats ESPN's projection, the plan's rule, with
          "start the higher average" as a weaker floor check (plan item C12). League-independent:
          one weekly gate run, stored and read. */}
      <StartSitGate />

      <WaiverWire key={leagueId} data={waivers.data} loading={waivers.loading} error={waivers.error}
        onRetry={waivers.refetch} out={out} />

      <StreamingBoard key={`streams-${leagueId}`} data={streams.data} loading={streams.loading} error={streams.error}
        onRetry={streams.refetch} />
    </Shell>
  );
}

function Slot({ c, index }: { c: any; index: number }) {
  const conf = CONF[c.confidence] ?? CONF.lean;
  // Scaled against the "clear" threshold, so the bar reads as a fraction of a
  // decisive margin rather than as an unanchored number.
  // A call with no margin compared nothing, so it gets no bar. It used to draw a
  // full-width one, which is the visual encoding of certainty at exactly the
  // moment there is none.
  const width = c.margin == null ? 0 : Math.min(100, Math.max(4, (c.margin / 4) * 100));
  return (
    <article className="tr-rise rounded-2xl border border-slate-200 bg-white p-4" style={{ animationDelay: `${index * 45}ms` }}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="grid h-9 w-12 shrink-0 place-items-center rounded-lg bg-slate-100 text-[11px] font-black text-slate-600">
          {c.slot}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-base font-black text-slate-950">{c.player.name}</span>
            <span className="text-xs text-slate-400">{c.player.position} · {c.player.team_abbr}</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${conf.chip}`}>
              {conf.label}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1.5 w-full max-w-[220px] overflow-hidden rounded-full bg-slate-100">
              <div className={`h-full rounded-full transition-[width] duration-500 ${conf.bar}`}
                style={{ width: `${width}%` }} />
            </div>
            <span className="font-mono text-[11px] tabular-nums text-slate-500">
              {c.margin == null ? '—' : `+${c.margin}`}
            </span>
          </div>
        </div>
        <span className="shrink-0 font-mono text-lg font-black tabular-nums text-slate-900">
          {c.player.week_points}
        </span>
      </div>

      <p className="mt-2 text-sm leading-6 text-slate-600">{c.why}</p>

      {/* The record behind both names. The projection decides the call; this
          is what it cannot say — startable weeks, floor, the preseason band,
          and whether the summer moved him. Side by side when there is a
          runner-up, so the two floors read against each other. */}
      {(c.player?.evidence || c.over?.evidence) && (
        <div className={`grid gap-2 ${c.over?.evidence ? 'sm:grid-cols-2' : ''}`}>
          <EvidenceStrip ev={c.player.evidence} position={c.player.position} name={c.over ? c.player.name : undefined} />
          {c.over?.evidence && <EvidenceStrip ev={c.over.evidence} position={c.over.position} name={`${c.over.name} (benched)`} />}
        </div>
      )}

      {/* The football case. This is the part that was missing — the page used to
          say "0.31 points ahead" and stop, which is true and decides nothing. */}
      {c.football?.factors?.length > 0 && (
        <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-[10px] font-black uppercase tracking-wide text-slate-500">
              The football{c.football.opponent ? ` · vs ${c.football.opponent}` : ''}
            </span>
            <span className={`text-xs font-bold ${
              c.football.net_lean > 0.8 ? 'text-emerald-700'
                : c.football.net_lean < -0.8 ? 'text-rose-700' : 'text-slate-500'}`}>
              {c.football.verdict}
            </span>
          </div>
          <div className="mt-2 space-y-2">
            {c.football.factors.map((f: any, i: number) => (
              <div key={i} className="flex gap-2">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                  f.direction === 'positive' ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-900">{f.headline}</div>
                  <div className="text-xs leading-5 text-slate-600">{f.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {(c.vegas || c.caution || c.upside) && (
        <div className="mt-2 space-y-1.5 border-t border-slate-100 pt-2">
          {c.vegas && (
            <p className="text-xs leading-5 text-sky-800">
              <b>Betting market:</b> {c.vegas}
            </p>
          )}
          {c.caution && (
            <p className="text-xs leading-5 text-amber-900">
              <b>Running hot:</b> {c.caution}
            </p>
          )}
          {c.upside && (
            <p className="text-xs leading-5 text-emerald-800">
              <b>Due to score:</b> {c.upside}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

/** What the explain assistant is told about the waiver section: the same rows the section shows by default. */
function waiverSummary(w: WaiverBoard | null) {
  if (!w || w.error) return null;
  const claims = (w.immediate ?? []).filter(onATeam);
  const top = claims[0];
  return {
    claims_that_help_this_week: claims.length,
    top_claim: top ? { player: top.player, position: top.position, adds_to_this_weeks_lineup: top.upgrade,
      drop: top.drop_candidate?.player ?? null } : null,
    stashes: (w.stashes ?? []).filter(onATeam).length,
    // Claims that would help this week only by cutting someone worth more over the season.
    held_back: w.held_back_count ?? (w.held_back ?? []).length
  };
}

const Shell = ({ children }: { children: ReactNode }) =>
  <div className="mx-auto max-w-[1000px] space-y-4">{children}</div>;
