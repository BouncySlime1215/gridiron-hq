import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { headshotUrl, useApi } from '../api';
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

const CONF: Record<string, { label: string; bar: string; tone: '' | 'good' | 'accent' | 'warn' }> = {
  clear: { label: 'Clear', bar: 'is-good', tone: 'good' },
  lean: { label: 'Lean', bar: 'is-me', tone: 'accent' },
  'coin flip': { label: 'Coin flip', bar: 'is-warn', tone: 'warn' },
  // A gap between two ceilings or two floors. Clear / Lean / Coin flip were measured on
  // average-projection gaps only, so this gap gets no grade rather than a borrowed one.
  'not measured': { label: 'Not graded', bar: '', tone: '' },
  'only option': { label: 'Only option', bar: '', tone: '' },
  // Other eligible players existed, none of them had a projection. That is not
  // the same call as having only one option, and it should not look like one.
  'no projection': { label: 'Not compared', bar: '', tone: '' },
  // RL-4-2: his game has kicked off, so the slot cannot change. No bar: nothing was compared.
  locked: { label: 'Locked', bar: '', tone: '' }
};

/**
 * My Team hosts this page (docs/ui/CONSOLIDATION-MAP.md): `embedded` drops the page header
 * (My Team's header and tabs stand above it); `view` shows the start/sit calls ('lineup') or
 * the waiver wire and defence streaming ('waivers'); `before` / `after` place My Team's own
 * pieces (this week's lineup-vs-best card, the field view) around the calls; `ceilingDetail`
 * renders under the calls while the ceiling objective is picked (the ceiling lineup's detail).
 * Every request is made the same way in both views, in the same order.
 */
export default function Lineup({ embedded = false, view = 'lineup', before, after, ceilingDetail }: {
  embedded?: boolean; view?: 'lineup' | 'waivers'; before?: ReactNode; after?: ReactNode; ceilingDetail?: () => ReactNode;
} = {}) {
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
  // Also where the call rows get each player's photo (the lineup payload carries no ESPN id).
  const { data: rosters } = useApi<any>(leagueId ? `/trades/${leagueId}/rosters` : null);
  const opponentName: string | null = rosters?.teams
    ?.find((t: any) => String(t.roster_id) === String(opponentId))?.owner ?? null;
  // Rostered players the solver will not start. The waiver board names its cut
  // without saying why, and "drop Patrick Mahomes, 18.6 projected" reads as
  // madness until you know he is flagged out; this is the same list the page
  // already shows under "not being considered".
  const out: OutList = useMemo(() => new Map<string, string>(
    (d?.unavailable ?? []).map((u: any) => [String(u.name).toLowerCase(), String(u.why)])), [d]);
  // One condensed row per slot: the call is the row, the evidence opens under it.
  const shots = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const t of rosters?.teams ?? []) for (const p of t.players ?? []) m.set(String(p.id), headshotUrl(p) ?? null);
    return m;
  }, [rosters]);
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
          actionTo="/league"
        />
      </Shell>
    );
  }

  if (view === 'waivers') {
    return (
      <Shell>
        <WaiverWire key={leagueId} data={waivers.data} loading={waivers.loading} error={waivers.error}
          onRetry={waivers.refetch} out={out} />
        <StreamingBoard key={`streams-${leagueId}`} data={streams.data} loading={streams.loading} error={streams.error}
          onRetry={streams.refetch} />
      </Shell>
    );
  }

  const selected = d?.objectives?.find((o: any) => o.id === objective);

  return (
    <Shell>
      {before}
      {!embedded && <header className="tr-rise">
        <div className="ds-eyebrow">This week</div>
        <h1 className="ds-section-t">Who to start</h1>
        <p className="ds-page-d">Every call carries how close it was: a tie inside the projection&rsquo;s own error is labelled a tie.</p>
      </header>}

      {/* SS-01 dead-starter guard: shown only when a starter set on ESPN will score zero.
          A suggestion; nothing is changed on ESPN from here. */}
      {d?.dead_starters?.items?.length > 0 && (
        <section role="alert" className="ds-card ds-card-pad !p-4 ds-error">
          <h2 className="ds-error-t">
            {d.dead_starters.items.length === 1 ? 'A starter will score zero' : `${d.dead_starters.items.length} starters will score zero`}
          </h2>
          <ul className="mt-2 space-y-1">
            {d.dead_starters.items.map((i: any) => (
              <li key={i.player.id} className="text-sm leading-6">
                {i.why}
                {/* RL-10-1: a projection-based flag names its source and what is not yet tested. */}
                {i.source_label && <span className="ds-note block">{i.source_label}</span>}
              </li>
            ))}
          </ul>
          <p className="ds-note mt-2">Make the swap on ESPN before his game starts.</p>
        </section>
      )}

      {error && !d && <PageError message={error} onRetry={refetch} />}

      {/* This matchup and the best waiver claim stay on top of the calls. */}
      <MatchupPosture data={posture.data} loading={posture.loading} error={posture.error}
        onRetry={posture.refetch} opponentName={opponentName} />
      <WaiverTeaser data={waivers.data} />

      {d && (
        <section className="ds-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="ds-stat-l">
                {/* Named for what was summed: a floor or ceiling total is not a projection. */}
                {d.objective_used === 'floor' ? `Week ${d.week} · sum of bad-week floors`
                  : d.objective_used === 'ceiling' ? `Week ${d.week} · sum of good-week ceilings`
                    : `Week ${d.week} projection`}
              </div>
              <div className="ds-stat-v">{d.projected_points}</div>
            </div>
            <div className="ds-tabs max-w-full !flex-wrap !rounded-[18px]" role="tablist" aria-label="Lineup objective">
              {(d.objectives ?? []).map((o: any) => (
                <button key={o.id} type="button" role="tab" className="ds-tab" aria-selected={objective === o.id}
                  onClick={() => setObjective(o.id)} title={o.when}>{o.label}</button>
              ))}
            </div>
          </div>
          <p className="ds-note mt-2">
            {String(d.confidence_basis ?? '').startsWith('uncalibrated_for_')
              ? `Gaps below are between ${d.objective_used === 'floor' ? 'bad-week floors' : 'good-week ceilings'}, `
                + 'not projections. Our win rates were measured on projections only, so no call is graded.'
              : d.coin_flips > 0
                ? `${d.coin_flips} of these calls are ties inside the model's own error`
                : d.not_compared > 0
                  ? `${d.not_compared} of these slots had no projection to compare against`
                  : 'Every call has a real margin behind it'}
            {selected?.when ? ` · ${selected.when}` : ''}
          </p>
          {d.objective_fallback && (
            <p role="status" className="ds-chip ds-chip-warn mt-2 !whitespace-normal">
              This lineup is the highest-average one: {d.objective_fallback}.
            </p>
          )}
        </section>
      )}

      {loading && !d && <PageLoading label="Solving the lineup…" />}

      {objective === 'ceiling' && ceilingDetail?.()}

      {d?.warnings?.length > 0 && (
        <section className="ds-card p-4">
          <h2 className="ds-h">Check before kickoff</h2>
          <div className="mt-1 space-y-1">
            {d.warnings.map((w: any, i: number) => (
              <p key={i} className="text-sm leading-6">
                <b>{w.player}</b> ({w.slot}) — {w.issue}.
              </p>
            ))}
          </div>
        </section>
      )}

      {d?.holes?.length > 0 && (
        <section className="ds-card p-4">
          <h2 className="ds-h">Empty starting slots</h2>
          <p className="mt-1 text-sm leading-6">
            No eligible player on your roster for {d.holes.join(', ')}. These slots are empty on ESPN too.
          </p>
        </section>
      )}

      {d && d.lineup?.length === 0 ? (
        <EmptyState
          title="No lineup to show"
          description="No rostered players were found for this league — sync your roster first."
          actionLabel="Manage roster"
          actionTo="/league"
        />
      ) : d?.lineup?.length > 0 && (
        <div className="ds-card ds-rows" data-testid="lineup-calls">
          {d.lineup.map((c: any, i: number) => <Slot key={i} c={c} shot={shots.get(String(c.player.id)) ?? null} />)}
        </div>
      )}

      {d?.bench?.length > 0 && (
        <details className="ds-fold">
          <summary className="ds-fold-s"><span className="ds-fold-t">On the bench</span>
            <span className="ds-fold-h">{d.bench.length} player{d.bench.length === 1 ? '' : 's'}</span><Chevron /></summary>
          <div className="ds-fold-b ds-rows">
            {d.bench.map((p: any, i: number) => (
              <div key={i} className="min-w-0 py-2 text-sm">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 truncate font-semibold">{p.name}</span>
                  <span className="ds-note shrink-0">{p.position} · {p.team_abbr}</span>
                  <span className="ds-num ml-auto">{p.week_points}</span>
                </div>
                <RecordLine ev={p.evidence} />
              </div>
            ))}
          </div>
        </details>
      )}

      {notConsidered.length > 0 && (
        <details className="ds-fold">
          <summary className="ds-fold-s">
            <span className="ds-fold-t">
              Why {notConsidered.length} rostered player{notConsidered.length === 1 ? ' is' : 's are'} not
              being considered
            </span><Chevron />
          </summary>
          <div className="ds-fold-b space-y-1.5">
            {notConsidered.map((u: any, i: number) => (
              <p key={i} className="text-sm leading-6">
                <b>{u.name}</b> ({u.position}, {u.team_abbr}) — {u.why}
              </p>
            ))}
          </div>
        </details>
      )}

      {/* Honest degradation, not a confident wrong number. Every chance-to-play number on
          this page comes from the fitted availability model; when that model is not the
          validated role layer the percentages are systematically low for healthy
          starters (a starter with no injury at all reads ~57% against an actual 94.5%),
          so the page says which model is talking and why before anyone acts on one.

          It says so in BOTH states, which is the point. A percentage that looks measured
          and is not is the defect; a percentage that IS measured and goes unlabelled is
          the same defect waiting for the next time the tables go missing, because the
          reader has no way to tell the two apart from the number alone. So the fitted
          path gets a line too — quieter, since nothing is wrong, but present (in the fold below). */}
      {d?.availability_note ? (
        <section role="status" className="ds-card p-4">
          <h2 className="ds-h">
            Chance-to-play numbers are degraded
          </h2>
          {/* UX-08: `inert`, `reason` and `fix` name tables, doc paths and a script
              (contingency.js availabilityDegradation) — operator detail, logged, never
              rendered. `effect` is the plain-words half a reader acts on. */}
          <p className="mt-1 text-sm leading-6">
            The fitted chance-to-play model isn&rsquo;t running right now, so these percentages come from a simpler fallback.
          </p>
          <p className="mt-1 text-sm leading-6">{d.availability_note.effect}.</p>
          <p className="ds-note mt-1">This clears once the availability model is refit.</p>
        </section>
      ) : null}

      <details className="ds-fold">
        <summary className="ds-fold-s"><span className="ds-fold-t">How good are these calls?</span>
          <span className="ds-fold-h">Our projection against ESPN&rsquo;s, week by week</span><Chevron /></summary>
        <div className="ds-fold-b">
          {d?.availability_basis?.basis === 'role' && !d?.availability_note && (
            <p role="status" className="ds-note mb-3">
              Every chance to play on this page is a measured rate from the fitted availability
              model, fit on 2021&ndash;2024 and validated on a held-out 2025.
            </p>
          )}
          {d?.note && <p className="ds-note mb-3">{d.note}</p>}
          {/* Whether starting by our projection beats ESPN's projection, the plan's rule, with
              "start the higher average" as a weaker floor check (plan item C12). League-independent:
              one weekly gate run, stored and read. */}
          <StartSitGate />
        </div>
      </details>

      {after}

      {/* Embedded in My Team, the waiver wire and streaming are their own view (Waivers). */}
      {!embedded && <>
        <WaiverWire key={leagueId} data={waivers.data} loading={waivers.loading} error={waivers.error}
          onRetry={waivers.refetch} out={out} />

        <StreamingBoard key={`streams-${leagueId}`} data={streams.data} loading={streams.loading} error={streams.error}
          onRetry={streams.refetch} />
      </>}
    </Shell>
  );
}

const Chevron = () => (
  <svg className="ds-xrow-chev ds-fold-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
);

/** The first sentence of the call's reason, for the one-line row; the full reason opens under it. */
const firstLine = (why: unknown) => String(why ?? '').split(/(?<=\.)\s/)[0];

function Slot({ c, shot }: { c: any; shot: string | null }) {
  const conf = CONF[c.confidence] ?? CONF.lean;
  // Scaled against the "clear" threshold, so the bar reads as a fraction of a
  // decisive margin rather than as an unanchored number.
  // A call with no margin compared nothing, so it gets no bar. It used to draw a
  // full-width one, which is the visual encoding of certainty at exactly the
  // moment there is none.
  const width = c.margin == null ? 0 : Math.min(100, Math.max(4, (c.margin / 4) * 100));
  const words = String(c.player.name ?? '').split(/\s+/).filter(Boolean);
  const initials = `${words[0]?.[0] ?? '?'}${words.length > 1 ? words[words.length - 1][0] : ''}`.toUpperCase();
  return (
    <details className="ds-xrow">
      <summary>
        <span className="ds-avatar relative" style={{ width: 36, height: 36, fontSize: 13 }} aria-hidden="true">
          {initials}
          {shot && <img src={shot} alt="" width={36} height={36} loading="lazy" decoding="async" className="absolute inset-0"
            onError={e => { e.currentTarget.style.display = 'none'; }} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{c.player.name}</span>
          <span className="ds-note block truncate">
            <b className="font-semibold">{c.slot}</b>{c.slot !== c.player.position ? ` (${c.player.position})` : ''} · {firstLine(c.why)}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          <span className="ds-num">{c.player.week_points}</span>
          <span className={`ds-chip ${conf.tone ? `ds-chip-${conf.tone}` : ''} !px-2 !text-[11px]`} data-call="1">{conf.label}</span>
        </span>
        <Chevron />
      </summary>
      <div className="ds-xrow-b space-y-3">
        <div className="flex items-center gap-2">
          <span className="ds-bar w-full max-w-[220px] !h-1.5"><i className={conf.bar} style={{ width: `${width}%` }} /></span>
          <span className="ds-note font-mono">{c.margin == null ? '—' : `+${c.margin}`}{c.over ? ` over ${c.over.name}` : ''}</span>
          <span className="ds-note ml-auto shrink-0">{c.player.team_abbr}</span>
        </div>
        <p className="text-sm leading-6">{c.why}</p>

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
          <div className="rounded-xl bg-[var(--c-soft)] p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="ds-eyebrow !mb-0">
                The football{c.football.opponent ? ` · vs ${c.football.opponent}` : ''}
              </span>
              <span className={`text-xs font-semibold ${
                c.football.net_lean > 0.8 ? 'text-good'
                  : c.football.net_lean < -0.8 ? 'text-crit' : 'ds-note'}`}>
                {c.football.verdict}
              </span>
            </div>
            <div className="mt-2 space-y-2">
              {c.football.factors.map((f: any, i: number) => (
                <div key={i} className="flex gap-2">
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                    f.direction === 'positive' ? 'bg-[var(--c-green)]' : 'bg-[var(--c-red)]'}`} />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">{f.headline}</div>
                    <div className="ds-note">{f.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {c.vegas && (
          <p className="ds-note">
            <b>Betting market:</b> {c.vegas}
          </p>
        )}
      </div>
    </details>
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
  <div className="mx-auto max-w-[1000px] space-y-3">{children}</div>;
